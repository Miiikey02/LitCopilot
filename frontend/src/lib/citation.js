// Build citation strings (BibTeX / RIS / APA) from paper metadata only.
// No verbatim abstract text is ever included — consistent with the app's
// storage/export guardrail.

function bibKey(paper) {
  const surname = (paper.authors?.[0] || 'anon').split(/[ ,]/)[0]
  return `${surname}${paper.year || ''}`.replace(/[^A-Za-z0-9]/g, '') || 'ref'
}

export function toBibtex(paper) {
  const fields = [
    ['title', paper.title],
    ['author', (paper.authors || []).join(' and ')],
    ['year', paper.year],
    ['journal', paper.venue],
    ['doi', paper.doi],
    ['url', paper.url],
  ].filter(([, v]) => v)
  const body = fields.map(([k, v]) => `  ${k} = {${v}}`).join(',\n')
  return `@article{${bibKey(paper)},\n${body}\n}`
}

export function toRis(paper) {
  const lines = ['TY  - JOUR']
  ;(paper.authors || []).forEach((a) => lines.push(`AU  - ${a}`))
  if (paper.title) lines.push(`TI  - ${paper.title}`)
  if (paper.year) lines.push(`PY  - ${paper.year}`)
  if (paper.venue) lines.push(`JO  - ${paper.venue}`)
  if (paper.doi) lines.push(`DO  - ${paper.doi}`)
  if (paper.url) lines.push(`UR  - ${paper.url}`)
  lines.push('ER  - ')
  return lines.join('\n')
}

export function toApa(paper) {
  const authors = (paper.authors || []).join(', ')
  const year = paper.year ? ` (${paper.year}).` : '.'
  const title = paper.title ? ` ${paper.title}` : ''
  const venue = paper.venue ? ` ${paper.venue}.` : ''
  const locator = paper.doi
    ? ` https://doi.org/${paper.doi}`
    : paper.url
    ? ` ${paper.url}`
    : ''
  return `${authors}${year}${title}${venue}${locator}`.trim()
}

export const CITATION_FORMATS = [
  { key: 'bibtex', label: 'BibTeX', build: toBibtex },
  { key: 'ris', label: 'RIS (EndNote/Zotero)', build: toRis },
  { key: 'apa', label: 'APA', build: toApa },
]

// --- Bulk export (one click for the whole result set) ---

export function allBibtex(papers) {
  return papers.map(toBibtex).join('\n\n')
}

export function allRis(papers) {
  return papers.map(toRis).join('\n\n')
}

// Titles-only list, for quickly scanning or pasting into notes.
export function allTitles(papers) {
  return papers
    .map((p, i) => {
      const authors = (p.authors || []).slice(0, 3).join(', ')
      const etal = (p.authors || []).length > 3 ? ' et al.' : ''
      const meta = [authors + etal, p.year, p.venue].filter(Boolean).join(' · ')
      const zh = p.title_zh ? `\n   ${p.title_zh}` : ''
      return `${i + 1}. ${p.title}${zh}\n   ${meta}\n   ${p.url}`
    })
    .join('\n\n')
}

export function downloadText(filename, text, mime = 'text/plain;charset=utf-8') {
  const blob = new Blob([text], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

export const BULK_FORMATS = [
  {
    key: 'bibtex',
    label: 'BibTeX (.bib)',
    ext: 'bib',
    build: allBibtex,
    mime: 'application/x-bibtex;charset=utf-8',
  },
  {
    key: 'ris',
    label: 'RIS (.ris)',
    ext: 'ris',
    build: allRis,
    mime: 'application/x-research-info-systems;charset=utf-8',
  },
  {
    key: 'titles',
    label: 'titles',
    ext: 'md',
    build: allTitles,
    mime: 'text/markdown;charset=utf-8',
  },
]

// Copy text to the clipboard, with a fallback for non-secure contexts.
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    document.body.removeChild(ta)
  }
}
