// Reading and tidying a folder of PDFs on the reader's own computer.
//
// A web page cannot see the filesystem, and should not be able to. What it can
// do — in Chromium browsers — is ask for one directory by name, which the user
// picks in the operating system's own dialog. That grant is the whole security
// model here: Gaze sees the folder that was handed to it and nothing else, and
// the handle can be revoked from the browser at any time.
//
// The handle survives in IndexedDB, so coming back is one click to re-confirm
// rather than hunting for the folder again. It cannot be turned into a path —
// there is deliberately no way to learn where on disk it actually is, and the
// server never learns anything about it either. Only what we extract from the
// PDFs (a DOI, a title) is ever sent anywhere.
//
// Everything destructive is avoided rather than confirmed: nothing is deleted,
// unmatched files are moved aside rather than removed, and every rename or
// move is written to a log inside the folder so it can be undone by hand.

const DB_NAME = 'gaze-local'
const STORE = 'handles'
const KEY = 'papers-folder'

export const GAZE_DIR = '_Gaze'
export const UNMATCHED_DIR = '未匹配'
export const LOG_FILE = '操作记录.json'

export function isSupported() {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function'
}

// --- Remembering the folder between visits --------------------------------

function idb() {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, 1)
    open.onupgradeneeded = () => open.result.createObjectStore(STORE)
    open.onsuccess = () => resolve(open.result)
    open.onerror = () => reject(open.error)
  })
}

async function idbSet(value) {
  const db = await idb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(value, KEY)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

async function idbGet() {
  const db = await idb()
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readonly')
    const get = tx.objectStore(STORE).get(KEY)
    get.onsuccess = () => resolve(get.result || null)
    get.onerror = () => resolve(null)
  })
}

export async function forgetFolder() {
  const db = await idb()
  const tx = db.transaction(STORE, 'readwrite')
  tx.objectStore(STORE).delete(KEY)
}

export async function pickFolder() {
  // readwrite up front: asking for read now and write later would mean a
  // second permission prompt in the middle of applying a plan, which is the
  // worst possible moment to interrupt someone.
  const handle = await window.showDirectoryPicker({ mode: 'readwrite', id: 'gaze-papers' })
  await idbSet(handle)
  return handle
}

/** The folder from last time, if the grant still stands. `null` otherwise. */
export async function restoreFolder({ prompt = false } = {}) {
  const handle = await idbGet()
  if (!handle) return null
  const opts = { mode: 'readwrite' }
  let state = await handle.queryPermission(opts)
  // Chromium drops the grant between sessions; re-requesting is one click, but
  // it has to happen inside a user gesture, hence the explicit flag.
  if (state !== 'granted' && prompt) state = await handle.requestPermission(opts)
  return state === 'granted' ? handle : null
}

// --- Walking it -----------------------------------------------------------

const isPdf = (name) => /\.pdf$/i.test(name) && !name.startsWith('.')

/**
 * Every PDF under `dir`, depth-first, as {name, path, handle, dirPath}.
 * Skips our own working directory so a second scan does not pick up the files
 * a first one moved aside.
 */
export async function scanPdfs(dir, { path = '', onProgress } = {}) {
  const found = []
  for await (const [name, handle] of dir.entries()) {
    if (name === GAZE_DIR) continue
    const childPath = path ? `${path}/${name}` : name
    if (handle.kind === 'directory') {
      found.push(...(await scanPdfs(handle, { path: childPath, onProgress })))
    } else if (isPdf(name)) {
      found.push({ name, path: childPath, dirPath: path, handle })
      onProgress?.(found.length)
    }
  }
  return found
}

// --- Reading just enough of a PDF to identify it --------------------------

let pdfjsPromise = null
function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const pdfjs = await import('pdfjs-dist')
      const worker = await import('pdfjs-dist/build/pdf.worker.mjs?url')
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default
      return pdfjs
    })()
  }
  return pdfjsPromise
}

// The same rule the server uses on uploads: only look near the front. A
// reference list is full of other people's DOIs, and picking one of those
// would confidently label the file as an entirely different paper.
const DOI_RE = /\b10\.\d{4,9}\/[^\s"'<>,;\]]+/i
const DOI_TRAILING = /[.,;:)\]}>]+$/

/** {doi, title} read from the first pages, as far as they can be read. */
export async function identify(fileHandle) {
  const pdfjs = await loadPdfjs()
  const file = await fileHandle.getFile()
  const data = new Uint8Array(await file.arrayBuffer())
  let doc = null
  try {
    doc = await pdfjs.getDocument({ data, isEvalSupported: false }).promise
    const meta = await doc.getMetadata().catch(() => null)
    const pages = []
    for (let i = 1; i <= Math.min(2, doc.numPages); i += 1) {
      const page = await doc.getPage(i)
      const text = await page.getTextContent()
      pages.push(text.items.map((x) => x.str).join(' '))
      page.cleanup()
    }
    const body = pages.join('\n')
    const metaDoi = meta?.info?.Subject || meta?.info?.Keywords || ''
    const hit = DOI_RE.exec(`${metaDoi}\n${body}`)
    const metaTitle = (meta?.info?.Title || '').trim()
    return {
      doi: hit ? hit[0].replace(DOI_TRAILING, '').toLowerCase() : '',
      title: metaTitle.length > 8 && !/\.pdf$/i.test(metaTitle) ? metaTitle : firstLine(body),
      pages: doc.numPages,
    }
  } catch {
    // Encrypted, damaged, or a scan with no text layer. Not an error — the
    // file simply cannot be identified, and the plan will say so.
    return { doi: '', title: '', pages: 0 }
  } finally {
    doc?.destroy?.()
  }
}

function firstLine(body) {
  const line = (body || '').split(/\s{3,}|\n/).map((s) => s.trim()).find((s) => s.length > 15)
  return (line || '').slice(0, 220)
}

// --- Changing things ------------------------------------------------------

/** Characters a filename cannot carry on Windows or macOS. */
const ILLEGAL = /[\\/:*?"<>|\n\r\t]/g

export function safeName(text, max = 110) {
  return (text || '')
    .replace(ILLEGAL, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .replace(/[. ]+$/, '')
}

async function dirFor(root, path, { create = false } = {}) {
  let dir = root
  for (const part of path.split('/').filter(Boolean)) {
    dir = await dir.getDirectoryHandle(part, { create })
  }
  return dir
}

/**
 * Move/rename one PDF within the granted folder.
 *
 * `FileSystemFileHandle.move` does it atomically where it exists; elsewhere we
 * copy and then remove, in that order, so a failure halfway leaves the original
 * where it was rather than nowhere at all.
 */
export async function moveFile(root, fromPath, toPath) {
  const fromDirPath = fromPath.split('/').slice(0, -1).join('/')
  const fromName = fromPath.split('/').pop()
  const toDirPath = toPath.split('/').slice(0, -1).join('/')
  const toName = toPath.split('/').pop()

  const fromDir = await dirFor(root, fromDirPath)
  const toDir = await dirFor(root, toDirPath, { create: true })
  const fileHandle = await fromDir.getFileHandle(fromName)

  if (typeof fileHandle.move === 'function') {
    await fileHandle.move(toDir, toName)
    return
  }
  const file = await fileHandle.getFile()
  const target = await toDir.getFileHandle(toName, { create: true })
  const writable = await target.createWritable()
  await writable.write(file)
  await writable.close()
  await fromDir.removeEntry(fromName)
}

export async function writeTextFile(root, path, text) {
  const dirPath = path.split('/').slice(0, -1).join('/')
  const name = path.split('/').pop()
  const dir = await dirFor(root, dirPath, { create: true })
  const handle = await dir.getFileHandle(name, { create: true })
  const writable = await handle.createWritable()
  await writable.write(text)
  await writable.close()
}

export async function readTextFile(root, path) {
  try {
    const dirPath = path.split('/').slice(0, -1).join('/')
    const name = path.split('/').pop()
    const dir = await dirFor(root, dirPath)
    const handle = await dir.getFileHandle(name)
    return await (await handle.getFile()).text()
  } catch {
    return ''
  }
}

/** Whether `path` already exists, so a plan never silently overwrites. */
export async function exists(root, path) {
  try {
    const dirPath = path.split('/').slice(0, -1).join('/')
    const name = path.split('/').pop()
    const dir = await dirFor(root, dirPath)
    await dir.getFileHandle(name)
    return true
  } catch {
    return false
  }
}

// --- Deciding what to do ---------------------------------------------------

/**
 * What should change, given the files found and what the library recognised.
 *
 * Deliberately mechanical rather than model-written. Turning a match into
 * "Tribble, 2021 - CRISPR Cas9 therapeutics.pdf" is a string transformation
 * with one right answer; handing it to a language model would make it slower,
 * cost money, and occasionally invent a different filename for the same paper.
 * The model's judgement is worth paying for when the question is *which folder
 * does this belong in* — and that has already been decided, in the library.
 */
export function buildPlan(files, matchByKey, { intoFolders = true, moveUnmatched = false } = {}) {
  const plan = []
  const taken = new Set(files.map((f) => f.path))

  for (const file of files) {
    const match = matchByKey.get(file.path)
    let dir
    let name

    if (match?.paper_id) {
      const stem = match.citation_key
        ? `${match.citation_key} - ${match.title}`
        : match.title
      name = `${safeName(stem)}.pdf`
      dir = intoFolders && match.folder ? safeName(match.folder, 60) : file.dirPath
    } else if (moveUnmatched) {
      name = file.name
      dir = `${GAZE_DIR}/${UNMATCHED_DIR}`
    } else {
      continue
    }

    let path = dir ? `${dir}/${name}` : name
    if (path === file.path) continue
    // Two files can legitimately resolve to one name — the same paper
    // downloaded twice, or a supplement alongside its article. Number them
    // rather than have one silently overwrite the other.
    if (taken.has(path)) {
      const base = path.replace(/\.pdf$/i, '')
      let n = 2
      while (taken.has(`${base} (${n}).pdf`)) n += 1
      path = `${base} (${n}).pdf`
    }
    taken.add(path)
    plan.push({
      from: file.path,
      to: path,
      matched: Boolean(match?.paper_id),
      label: match?.title || file.name,
    })
  }
  return plan
}

/**
 * Append to the folder's own record of what Gaze did to it.
 *
 * Written inside the folder rather than into the app, because the person who
 * needs it most is the one looking at a directory whose filenames all changed
 * and wondering what happened. It is plain JSON, and every entry has both
 * paths, so any move can be reversed by hand.
 */
export async function appendLog(root, entries) {
  const path = `${GAZE_DIR}/${LOG_FILE}`
  let existing = []
  try {
    existing = JSON.parse(await readTextFile(root, path)) || []
  } catch {
    existing = []
  }
  const next = [
    ...(Array.isArray(existing) ? existing : []),
    { at: new Date().toISOString(), changes: entries },
  ]
  await writeTextFile(root, path, JSON.stringify(next, null, 1))
}
