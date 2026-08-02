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
