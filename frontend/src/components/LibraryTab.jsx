import React, { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import * as api from '../lib/api'
import LibraryChat from './LibraryChat'
import Icon from './Icon'
import CiteButton from './CiteButton'
import BulkExport from './BulkExport'
import WorkspaceBar from './WorkspaceBar'

const sourceLabel = {
  pubmed: 'PubMed',
  semantic_scholar: 'Semantic Scholar',
  openalex: 'OpenAlex',
  biorxiv: 'bioRxiv',
}

// A paper you uploaded is identified by its upload id rather than a DOI, and
// 精读模式 resolves that identifier directly.
const isUpload = (paper) =>
  paper.source === 'upload' || (paper.source_id || '').startsWith('upload:')

// Which identifier 精读模式 should open this paper with.
//
// An upload carries the DOI of the published article, because that is what
// makes it cite correctly — but the DOI locates the *publisher's* copy, which
// is usually paywalled and resolves to an abstract. The file the reader
// actually has is the upload, so for an upload the upload id always wins.
const readerIdFor = (paper) =>
  isUpload(paper) ? paper.source_id : paper.doi || paper.source_id

function UploadPdf({ teamId, folderId, onDone }) {
  const { t } = useTranslation()
  const input = useRef(null)
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState('')

  // An uploaded PDF joins the library as a paper in its own right: it is
  // identified by its upload id, which 精读模式 resolves the same way it
  // resolves a DOI, so everything downstream works without a special case.
  const take = async (file) => {
    if (!file || busy) return
    if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
      return setError(t('uploadNotPdf'))
    }
    setBusy(true)
    setError('')
    try {
      const up = await api.paperUpload(file)
      // The server resolves the DOI printed on the PDF against the same index
      // the search uses, so the card carries real authors, journal, year and
      // citation key. The fallback only matters for a paper that resolves to
      // nothing at all.
      const card = up.paper || {
        source: 'upload',
        source_id: up.identifier,
        title: up.title || file.name.replace(/\.pdf$/i, ''),
        title_zh: '',
        authors: [],
        year: null,
        venue: '',
        url: '',
        doi: '',
        citation_key: (up.title || file.name).slice(0, 40),
        relevance_zh: '',
        has_full_text: true,
      }
      await api.saveLibrary(card, teamId || null)
      onDone()
    } catch (err) {
      setError(err.message || t('uploadFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        take(e.dataTransfer.files?.[0])
      }}
      className={`mb-4 rounded-xl border-2 border-dashed px-4 py-3 text-sm transition-colors ${
        dragging
          ? 'border-blue-400 bg-blue-50/60'
          : 'border-slate-200 bg-slate-50/60 hover:border-slate-300'
      }`}
    >
      <input
        ref={input}
        type="file"
        accept="application/pdf,.pdf"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          e.target.value = ''
          take(f)
        }}
      />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <button
          onClick={() => input.current?.click()}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white transition-all hover:bg-slate-800 active:scale-[0.98] disabled:opacity-60"
        >
          <Icon name="filePlus" />
          {busy ? t('uploadingPdf') : t('uploadPdf')}
        </button>
        <span className="text-slate-500">{t('uploadDropHint')}</span>
      </div>
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
    </div>
  )
}


function LibraryCard({ paper, folders = [], teamId, onChanged }) {
  const { t } = useTranslation()
  const [newTag, setNewTag] = useState('')
  const [note, setNote] = useState(paper.notes || '')
  const [editingNote, setEditingNote] = useState(false)
  const [savingNote, setSavingNote] = useState(false)

  const moveTo = async (value) => {
    await api.movePaper(paper.id, value === '' ? null : Number(value), teamId)
    onChanged()
  }

  const saveNote = async () => {
    setSavingNote(true)
    try {
      await api.setNotes(paper.id, note, teamId)
      setEditingNote(false)
      onChanged()
    } finally {
      setSavingNote(false)
    }
  }

  const addTag = async (e) => {
    e.preventDefault()
    const tag = newTag.trim()
    if (!tag) return
    await api.addTag(paper.id, tag, teamId)
    setNewTag('')
    onChanged()
  }

  const removeTag = async (tag) => {
    await api.removeTag(paper.id, tag, teamId)
    onChanged()
  }

  const remove = async () => {
    await api.deletePaper(paper.id, teamId)
    onChanged()
  }

  return (
    <div className="card-hover rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
          {isUpload(paper) ? t('uploadedPdf') : sourceLabel[paper.source] || paper.source}
        </span>
        <span className="text-xs font-medium text-blue-700">[{paper.citation_key}]</span>
      </div>

      {paper.retraction_status && (
        <div
          className={`mb-2 flex items-start gap-1.5 rounded-md border px-2 py-1.5 text-xs ${
            paper.retraction_status === 'retracted'
              ? 'border-red-200 bg-red-50 text-red-800'
              : 'border-amber-200 bg-amber-50 text-amber-900'
          }`}
        >
          <Icon name="alert" className="mt-0.5 shrink-0" />
          <span>
            <span className="font-semibold">
              {paper.retraction_status === 'retracted'
                ? t('retracted')
                : t('concernRaised')}
            </span>
            {' · '}
            {t('retractedHint')}
          </span>
        </div>
      )}
      {paper.title_zh && (
        <h3 className="mb-0.5 font-semibold leading-6 text-slate-900">{paper.title_zh}</h3>
      )}
      <p className="text-sm leading-6 text-slate-600">{paper.title}</p>
      <p className="mt-2 text-xs text-slate-500">
        {paper.authors.slice(0, 4).join(', ')}
        {paper.authors.length > 4 ? ' et al.' : ''}
        {paper.year ? ` · ${paper.year}` : ''}
        {paper.venue ? ` · ${paper.venue}` : ''}
      </p>
      {/* In a shared lab library, show who contributed the paper. */}
      {teamId && paper.added_by && (
        <p className="mt-1 text-xs text-slate-400">
          {t('addedBy', { who: paper.added_by })}
        </p>
      )}

      {/* Your own note on this paper — also used by library chat as evidence */}
      <div className="mt-3">
        {editingNote ? (
          <div>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              autoFocus
              placeholder={t('notePlaceholder')}
              className="w-full rounded-md border border-slate-300 p-2 text-sm text-slate-800 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <div className="mt-1 flex gap-2">
              <button
                onClick={saveNote}
                disabled={savingNote}
                className="rounded-md bg-blue-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {t('saveNote')}
              </button>
              <button
                onClick={() => {
                  setNote(paper.notes || '')
                  setEditingNote(false)
                }}
                className="rounded-md border border-slate-300 px-2.5 py-1 text-xs text-slate-600 hover:bg-slate-50"
              >
                {t('cancel')}
              </button>
            </div>
          </div>
        ) : paper.notes ? (
          <button
            onClick={() => setEditingNote(true)}
            className="w-full rounded-md bg-amber-50 p-2 text-left text-sm text-amber-900 hover:bg-amber-100"
            title={t('editNote')}
          >
            <span className="font-medium"><Icon name="note" className="mr-1" />{t('myNote')}：</span>
            {paper.notes}
          </button>
        ) : (
          <button
            onClick={() => setEditingNote(true)}
            className="text-xs text-slate-400 hover:text-slate-700"
          >
            <Icon name="note" className="mr-1" />{t('addNote')}
          </button>
        )}
      </div>

      {/* Tags */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {paper.tags.map((tag) => (
          <span
            key={tag}
            className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2 py-0.5 text-xs text-blue-700"
          >
            {tag}
            <button
              type="button"
              onClick={() => removeTag(tag)}
              className="text-blue-400 hover:text-blue-700"
              aria-label="remove tag"
            >
              ×
            </button>
          </span>
        ))}
        <form onSubmit={addTag} className="inline-flex">
          <input
            value={newTag}
            onChange={(e) => setNewTag(e.target.value)}
            placeholder={t('addTagPlaceholder')}
            className="w-44 rounded-l-md border border-slate-300 px-2 py-0.5 text-xs focus:border-blue-500 focus:outline-none"
          />
          <button
            type="submit"
            className="rounded-r-md border border-l-0 border-slate-300 bg-slate-50 px-2 py-0.5 text-xs text-slate-600 hover:bg-slate-100"
          >
            {t('addTag')}
          </button>
        </form>
      </div>

      <div className="mt-3 flex items-center gap-4">
        {paper.url && !isUpload(paper) && (
          <a
            href={paper.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm font-medium text-blue-600 hover:text-blue-800 hover:underline"
          >
            {t('viewSource')} <Icon name="externalLink" className="ml-0.5" />
          </a>
        )}
        {/* Close reading belongs to papers you have kept, not to a list of
            search hits — it opens the paper in its own window to read. */}
        <CiteButton paper={paper} />
        {readerIdFor(paper) && (
          <button
            type="button"
            onClick={() =>
              window.open(
                `/read?id=${encodeURIComponent(readerIdFor(paper))}`,
                '_blank',
                'noopener'
              )
            }
            className="text-sm font-medium text-slate-600 transition-colors hover:text-blue-700"
          >
            <Icon name="bookOpen" className="mr-1" />
            {t('openReader')}
          </button>
        )}
        <label className="flex items-center gap-1 text-xs text-slate-500">
          <Icon name="folder" />
          <select
            value={paper.folder_id ?? ''}
            onChange={(e) => moveTo(e.target.value)}
            title={t('moveToFolder')}
            className="max-w-[9rem] rounded border border-slate-300 bg-white px-1 py-0.5 text-xs text-slate-700 focus:border-blue-500 focus:outline-none"
          >
            <option value="">{t('unfiled')}</option>
            {folders.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={remove}
          className="ml-auto text-sm font-medium text-red-500 hover:text-red-700"
        >
          {t('delete')}
        </button>
      </div>
    </div>
  )
}

// Left-hand folder navigation: all / per-folder / unfiled, plus create-rename-delete.
function FolderSidebar({ folders, active, onPick, onChanged, total, teamId }) {
  const { t } = useTranslation()
  const [newName, setNewName] = useState('')
  const [error, setError] = useState('')

  const named = folders.filter((f) => f.id !== null)
  const unfiled = folders.find((f) => f.id === null)

  const create = async (e) => {
    e.preventDefault()
    const name = newName.trim()
    if (!name) return
    try {
      await api.createFolder(name, teamId)
      setNewName('')
      setError('')
      onChanged()
    } catch {
      setError(t('folderExists'))
    }
  }

  const rename = async (folder) => {
    const name = window.prompt(t('renameFolder'), folder.name)
    if (!name || name.trim() === folder.name) return
    try {
      await api.renameFolder(folder.id, name.trim(), teamId)
      onChanged()
    } catch {
      setError(t('folderExists'))
    }
  }

  const remove = async (folder) => {
    if (!window.confirm(t('deleteFolderConfirm', { name: folder.name }))) return
    await api.deleteFolder(folder.id, teamId)
    if (active === String(folder.id)) onPick(null)
    onChanged()
  }

  const itemClass = (isActive) =>
    `group flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-sm ${
      isActive ? 'bg-blue-50 font-medium text-blue-700' : 'text-slate-600 hover:bg-slate-50'
    }`

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3">
      <h3 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
        {t('foldersTitle')}
      </h3>

      <button onClick={() => onPick(null)} className={itemClass(active === null)}>
        <span className="flex-1 text-left"><Icon name="library" className="mr-1.5" />{t('allPapers')}</span>
        <span className="text-xs text-slate-400">{total}</span>
      </button>

      {named.map((f) => (
        <div key={f.id} className="flex items-center">
          <button
            onClick={() => onPick(String(f.id))}
            className={itemClass(active === String(f.id))}
          >
            <span className="flex-1 truncate text-left"><Icon name="folder" className="mr-1.5" />{f.name}</span>
            <span className="text-xs text-slate-400">{f.count}</span>
          </button>
          <div className="ml-1 flex shrink-0 gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 hover:opacity-100">
            <button
              onClick={() => rename(f)}
              title={t('renameFolder')}
              className="text-xs text-slate-400 hover:text-slate-700"
            >
              <Icon name="pencil" />
            </button>
            <button
              onClick={() => remove(f)}
              title={t('deleteFolder')}
              className="text-xs text-slate-400 hover:text-red-600"
            >
              ×
            </button>
          </div>
        </div>
      ))}

      {unfiled && unfiled.count > 0 && (
        <button
          onClick={() => onPick('unfiled')}
          className={itemClass(active === 'unfiled')}
        >
          <span className="flex-1 text-left"><Icon name="inbox" className="mr-1.5" />{t('unfiled')}</span>
          <span className="text-xs text-slate-400">{unfiled.count}</span>
        </button>
      )}

      <form onSubmit={create} className="mt-3 border-t border-slate-100 pt-3">
        <div className="flex">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder={t('newFolderPlaceholder')}
            className="w-full min-w-0 rounded-l-md border border-slate-300 px-2 py-1 text-xs focus:border-blue-500 focus:outline-none"
          />
          <button
            type="submit"
            className="shrink-0 rounded-r-md border border-l-0 border-slate-300 bg-slate-50 px-2 py-1 text-xs text-slate-600 hover:bg-slate-100"
          >
            {t('createFolder')}
          </button>
        </div>
        {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
      </form>
    </div>
  )
}

export default function LibraryTab() {
  const { t } = useTranslation()
  const [papers, setPapers] = useState([])
  const [tags, setTags] = useState([])
  const [folders, setFolders] = useState([])
  const [activeTag, setActiveTag] = useState(null)
  const [activeFolder, setActiveFolder] = useState(null) // null | id string | 'unfiled'
  const [query, setQuery] = useState('')
  const [teams, setTeams] = useState([])
  // null = personal library; otherwise the active team's id (as a string).
  const [activeTeam, setActiveTeam] = useState(null)

  const [loadError, setLoadError] = useState('')

  const load = async () => {
    try {
      const [ps, ts, fs] = await Promise.all([
        api.listLibrary(activeTag, activeFolder, query, activeTeam),
        api.listTags(activeTeam),
        api.listFolders(activeTeam),
      ])
      setPapers(ps)
      setTags(ts)
      setFolders(fs)
      setLoadError('')
    } catch {
      // Surface the failure instead of silently rendering an empty library,
      // which would look like the user had lost their saved papers.
      setLoadError(t('libraryLoadError'))
    }
  }

  useEffect(() => {
    // Debounce so typing in the search box doesn't fire a request per keystroke.
    const id = setTimeout(load, query ? 250 : 0)
    return () => clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTag, activeFolder, query, activeTeam])

  const loadTeams = async () => {
    try {
      setTeams(await api.listTeams())
    } catch {
      /* teams are optional; personal library still works */
    }
  }

  useEffect(() => {
    loadTeams()
  }, [])

  // Switching workspace resets filters, which belong to the old one.
  const switchWorkspace = (teamId) => {
    setActiveTeam(teamId)
    setActiveTag(null)
    setActiveFolder(null)
    setQuery('')
  }

  const total = folders.reduce((n, f) => n + f.count, 0)

  return (
    <div>
      <WorkspaceBar
        teams={teams}
        activeTeam={activeTeam}
        onSwitch={switchWorkspace}
        onTeamsChanged={loadTeams}
      />
      <div className="grid grid-cols-1 gap-5 md:grid-cols-[13rem_1fr]">
      <aside>
        <FolderSidebar
          folders={folders}
          active={activeFolder}
          onPick={setActiveFolder}
          onChanged={load}
          total={total}
          teamId={activeTeam}
        />
      </aside>

      <div>
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="shrink-0 text-lg font-semibold text-slate-900">
            {t('libraryTitle')}
          </h2>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('librarySearchPlaceholder')}
            className="w-full max-w-xs rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
          <span className="shrink-0 text-sm text-slate-500">
            {t('savedCount', { count: papers.length })}
          </span>
          {/* Exports whatever the folder/tag/search filters currently show, so
              "everything in this folder" is one click rather than a selection. */}
          <BulkExport papers={papers} queryLabel={t('libraryTitle')} />
        </div>

        <UploadPdf
          teamId={activeTeam}
          folderId={activeFolder}
          onDone={load}
        />

        {/* Ask questions across the papers you've saved */}
        <LibraryChat
          teamId={activeTeam}
          folder={activeFolder}
          scopeLabel={
            activeFolder === null
              ? t('allPapers')
              : activeFolder === 'unfiled'
              ? t('unfiled')
              : folders.find((f) => String(f.id) === activeFolder)?.name || ''
          }
          paperCount={
            activeFolder === null
              ? folders.reduce((n, f) => n + f.count, 0)
              : folders.find(
                  (f) =>
                    (activeFolder === 'unfiled' && f.id === null) ||
                    String(f.id) === activeFolder
                )?.count ?? 0
          }
        />


        {/* Tag filter bar */}
        {tags.length > 0 && (
          <div className="mb-4 flex flex-wrap gap-2">
            <button
              onClick={() => setActiveTag(null)}
              className={`rounded-full px-3 py-1 text-sm ${
                activeTag === null
                  ? 'bg-blue-600 text-white'
                  : 'bg-white text-slate-600 border border-slate-300 hover:bg-slate-50'
              }`}
            >
              {t('allTags')}
            </button>
            {tags.map(({ tag, count }) => (
              <button
                key={tag}
                onClick={() => setActiveTag(tag)}
                className={`rounded-full px-3 py-1 text-sm ${
                  activeTag === tag
                    ? 'bg-blue-600 text-white'
                    : 'bg-white text-slate-600 border border-slate-300 hover:bg-slate-50'
                }`}
              >
                {tag} ({count})
              </button>
            ))}
          </div>
        )}

        {loadError ? (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            {loadError}{' '}
            <button onClick={load} className="font-medium underline">
              {t('retry')}
            </button>
          </div>
        ) : papers.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-300 bg-white p-10 text-center text-slate-500">
            {query ? t('libraryNoMatch') : t('libraryEmpty')}
          </div>
        ) : (
          <div className="stagger grid grid-cols-1 gap-3 xl:grid-cols-2">
            {papers.map((p) => (
              <LibraryCard
                key={p.id}
                paper={p}
                folders={folders.filter((f) => f.id !== null)}
                teamId={activeTeam}
                onChanged={load}
              />
            ))}
          </div>
        )}
      </div>
    </div>
    </div>
  )
}
