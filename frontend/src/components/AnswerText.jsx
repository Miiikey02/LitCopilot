import React from 'react'

// Renders the synthesized answer, turning [Author, Year] citations that match a
// known source into clickable buttons that highlight the matching source card.
export default function AnswerText({ text, citationKeys, onCite, inline = false }) {
  if (!text) return null

  const keySet = new Set(citationKeys)
  const paragraphs = text.split(/\n{2,}/)

  // Match bracketed tokens like [Smith, 2021] or [Smith, 2021; Lee, 2020].
  const bracket = /\[([^\]]+)\]/g

  // The model writes **emphasis** unprompted, and unrendered asterisks in the
  // middle of a sentence read as a bug. Handle the one markdown construct it
  // actually uses rather than pulling in a markdown renderer.
  const withBold = (str, keyPrefix) => {
    const out = []
    let last = 0
    const bold = /\*\*(.+?)\*\*/g
    let m
    while ((m = bold.exec(str)) !== null) {
      if (m.index > last) out.push(str.slice(last, m.index))
      out.push(
        <strong key={`${keyPrefix}-b${m.index}`} className="font-semibold">
          {m[1]}
        </strong>
      )
      last = m.index + m[0].length
    }
    if (last < str.length) out.push(str.slice(last))
    return out
  }

  const renderParagraph = (para, pIdx) => {
    const parts = []
    let last = 0
    let m
    bracket.lastIndex = 0
    while ((m = bracket.exec(para)) !== null) {
      if (m.index > last)
        parts.push(...withBold(para.slice(last, m.index), `${pIdx}-${m.index}`))
      const inner = m[1]
      // A bracket may hold several citations separated by ; or ，
      const tokens = inner.split(/[;；]/).map((t) => t.trim())
      parts.push(
        <span key={`${pIdx}-${m.index}`}>
          [
          {tokens.map((tok, i) => {
            const known = keySet.has(tok)
            return (
              <React.Fragment key={i}>
                {i > 0 && '; '}
                {/* Only a button where there is a source list to jump to —
                    PaperView shows citations without one, and a button that
                    throws on click is worse than plain text. */}
                {known && onCite ? (
                  <button
                    type="button"
                    onClick={() => onCite(tok)}
                    className="text-blue-600 hover:text-blue-800 hover:underline font-medium"
                  >
                    {tok}
                  </button>
                ) : known ? (
                  <span className="font-medium text-blue-700">{tok}</span>
                ) : (
                  <span className="text-slate-500">{tok}</span>
                )}
              </React.Fragment>
            )
          })}
          ]
        </span>
      )
      last = m.index + m[0].length
    }
    if (last < para.length) parts.push(...withBold(para.slice(last), `${pIdx}-end`))
    // `inline` renders inside an existing list item or sentence, so it must
    // not introduce block-level paragraphs or bottom margin.
    if (inline) return <span key={pIdx}>{parts}</span>
    return (
      <p key={pIdx} className="mb-4 leading-8 text-slate-800">
        {parts}
      </p>
    )
  }

  if (inline) return <>{paragraphs.map(renderParagraph)}</>
  return <div className="reveal">{paragraphs.map(renderParagraph)}</div>
}
