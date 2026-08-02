// Build a Markdown document from a search result and trigger a file download.
// No external dependencies — the reference list is assembled from the metadata
// we already hold (we never store or export verbatim abstract text).

export function resultToMarkdown(result) {
  const lines = []
  lines.push(`# LitCopilot — ${result.original_query}`)
  lines.push('')
  lines.push(`_${result.detected_lang === 'zh' ? '识别语言' : 'Detected language'}: ${result.detected_lang} · 检索用词 (English): ${result.english_query}_`)
  lines.push('')
  lines.push('## 综合回答 / Synthesized answer')
  lines.push('')
  lines.push(result.answer || '(no answer)')
  lines.push('')
  lines.push('## 参考文献 / References')
  lines.push('')
  result.sources.forEach((s, i) => {
    const authors = s.authors.slice(0, 6).join(', ') + (s.authors.length > 6 ? ' et al.' : '')
    const titleZh = s.title_zh ? ` （${s.title_zh}）` : ''
    lines.push(
      `${i + 1}. [${s.citation_key}] ${authors}${s.year ? ` (${s.year})` : ''}. ` +
        `*${s.title}*${titleZh}. ${s.venue || ''}. ${s.url}`
    )
  })
  lines.push('')
  lines.push('---')
  lines.push('_本回答基于检索到的摘要生成，不构成医学建议。/ Grounded in retrieved abstracts; not medical advice._')
  return lines.join('\n')
}

function download(filename, text, mime) {
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

export function exportMarkdown(result) {
  const safe = (result.original_query || 'litcopilot').replace(/[^\w一-鿿-]+/g, '_').slice(0, 40)
  download(`litcopilot-${safe}.md`, resultToMarkdown(result), 'text/markdown;charset=utf-8')
}

// PDF export uses the browser's native print-to-PDF. A print stylesheet
// (see index.css @media print) hides the app chrome so only the answer +
// references are printed.
export function exportPdf() {
  window.print()
}
