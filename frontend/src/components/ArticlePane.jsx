import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Icon from './Icon'

// The original article, on the left of 精读模式.
//
// Two jobs beyond rendering text: mark the sentences the close reading drew
// each of its claims from, and let the reader select any passage and ask about
// it. Both exist so the appraisal on the right is never something you have to
// take on trust — you can always see the sentence it came from.

const collapse = (s) => (s || '').replace(/\s+/g, ' ').trim()

// Scrolling a container is done by hand rather than with scrollIntoView or
// `behavior: 'smooth'`: both are no-ops in some renderers (verified — a smooth
// scrollTo left scrollTop at 0 while a direct assignment moved it), and a
// highlight the reader never sees is the same as no highlight at all.
function easeScroll(box, to, ms = 420) {
  const from = box.scrollTop
  const delta = Math.max(0, to) - from
  if (Math.abs(delta) < 2) return
  const t0 = performance.now()
  const step = (now) => {
    const p = Math.min((now - t0) / ms, 1)
    box.scrollTop = from + delta * (1 - Math.pow(1 - p, 3))
    if (p < 1) requestAnimationFrame(step)
  }
  requestAnimationFrame(step)
}

// Locate each quote in a block. The model is asked to copy the sentence
// exactly, but it drops a trailing clause often enough that an all-or-nothing
// match would leave most findings unanchored; falling back to the opening of
// the quote recovers those without ever highlighting an unrelated sentence.
function findRanges(text, highlights) {
  const hay = text.toLowerCase()
  const found = []
  for (const h of highlights) {
    const q = collapse(h.quote)
    if (q.length < 12) continue
    const needle = q.toLowerCase()
    let start = hay.indexOf(needle)
    let len = needle.length
    if (start < 0) {
      const head = needle.slice(0, Math.max(24, Math.floor(needle.length * 0.55)))
      start = hay.indexOf(head)
      len = head.length
    }
    if (start >= 0) found.push({ ...h, start, end: start + len })
  }
  // Overlapping marks would nest badly; keep the earliest, then the longest.
  found.sort((a, b) => a.start - b.start || b.end - a.end)
  const out = []
  for (const r of found) {
    if (!out.length || r.start >= out[out.length - 1].end) out.push(r)
  }
  return out
}

const KIND_STYLE = {
  finding: 'bg-blue-100/80 hover:bg-blue-200/80 decoration-blue-400',
  limitation: 'bg-amber-100/80 hover:bg-amber-200/80 decoration-amber-400',
  not_established: 'bg-rose-100/80 hover:bg-rose-200/80 decoration-rose-400',
}

function Marked({ text, highlights, activeId, onMarkClick }) {
  const ranges = useMemo(() => findRanges(text, highlights), [text, highlights])
  if (!ranges.length) return text

  const parts = []
  let last = 0
  ranges.forEach((r, i) => {
    if (r.start > last) parts.push(text.slice(last, r.start))
    const active = activeId === r.id
    parts.push(
      <mark
        key={i}
        data-hl={r.id}
        onClick={() => onMarkClick?.(r)}
        title={r.text}
        className={`cursor-pointer rounded-sm px-0.5 underline decoration-2 underline-offset-4 transition-colors ${
          KIND_STYLE[r.kind] || KIND_STYLE.finding
        } ${active ? 'ring-2 ring-blue-400 ring-offset-1' : ''}`}
      >
        {text.slice(r.start, r.end)}
      </mark>
    )
    last = r.end
  })
  if (last < text.length) parts.push(text.slice(last))
  return parts
}

export default function ArticlePane({
  blocks,
  highlights = [],
  activeId,
  onAsk,
  onMarkClick,
  license,
  warning,
  loading,
}) {
  const { t } = useTranslation()
  const scroller = useRef(null)
  const [sel, setSel] = useState(null) // {text, x, y}

  // Bring the highlighted sentence into view when the right pane asks for it.
  useEffect(() => {
    if (!activeId || !scroller.current) return
    const box = scroller.current
    const el = box.querySelector(`[data-hl="${activeId}"]`)
    if (!el) return
    const top =
      el.getBoundingClientRect().top -
      box.getBoundingClientRect().top +
      box.scrollTop -
      box.clientHeight / 2
    easeScroll(box, top)
  }, [activeId])

  const captureSelection = () => {
    const s = window.getSelection()
    const text = collapse(s?.toString())
    if (!text || text.length < 2 || !scroller.current) return setSel(null)
    const range = s.getRangeAt(0)
    if (!scroller.current.contains(range.commonAncestorContainer)) return setSel(null)
    const r = range.getBoundingClientRect()
    const box = scroller.current.getBoundingClientRect()
    setSel({
      text,
      // Positioned within the pane, clamped so the menu never leaves it.
      x: Math.min(Math.max(r.left - box.left + r.width / 2, 130), box.width - 130),
      y: r.top - box.top + scroller.current.scrollTop - 8,
    })
  }

  const ask = (intent) => {
    onAsk?.(sel.text, intent)
    setSel(null)
    window.getSelection()?.removeAllRanges()
  }

  if (loading) {
    return (
      <div className="space-y-3 p-8">
        {[...Array(8)].map((_, i) => (
          <div
            key={i}
            className="skeleton h-4 rounded"
            style={{ width: `${95 - (i % 3) * 12}%` }}
          />
        ))}
      </div>
    )
  }

  return (
    <div
      ref={scroller}
      onMouseUp={captureSelection}
      className="relative h-full overflow-y-auto bg-white px-8 py-7"
    >
      {warning && (
        <div className="mb-5 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm leading-6 text-amber-900">
          {warning}
        </div>
      )}

      <article className="mx-auto max-w-[46rem]">
        {blocks.map((b) =>
          b.type === 'heading' ? (
            <h3
              key={b.id}
              className={`mb-2 mt-7 font-semibold text-slate-900 ${
                b.level <= 1 ? 'text-lg' : 'text-[15px]'
              }`}
            >
              {b.text}
            </h3>
          ) : b.type === 'figure' || b.type === 'table' ? (
            <figure
              key={b.id}
              className="my-4 rounded-lg border border-slate-200 bg-slate-50/70 p-4"
            >
              <figcaption className="text-sm leading-7 text-slate-600">
                <span className="mr-1.5 font-semibold text-slate-800">{b.label}</span>
                <Marked
                  text={b.text}
                  highlights={highlights}
                  activeId={activeId}
                  onMarkClick={onMarkClick}
                />
              </figcaption>
              {/* Figures are the most-asked-about part of a paper and we only
                  have the caption, so make asking about one a single click. */}
              <button
                onClick={() => onAsk?.(`${b.label}. ${b.text}`, 'explain')}
                className="mt-2 inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-slate-600 transition-colors hover:border-blue-300 hover:text-blue-700"
              >
                <Icon name="sparkles" />
                {t('askAboutFigure')}
              </button>
            </figure>
          ) : (
            <p key={b.id} className="mb-4 text-[15px] leading-8 text-slate-700">
              <Marked
                text={b.text}
                highlights={highlights}
                activeId={activeId}
                onMarkClick={onMarkClick}
              />
            </p>
          )
        )}

        {license && (
          <p className="mt-8 border-t border-slate-100 pt-3 text-xs text-slate-400">
            {t('articleLicense')}: {license}
          </p>
        )}
      </article>

      {/* Selection menu. The four things people actually ask of a sentence in a
          second-language paper: what it says, what it means, why it matters,
          and anything else. */}
      {sel && (
        <div
          className="animate-rise absolute z-20 -translate-x-1/2 -translate-y-full"
          style={{ left: sel.x, top: sel.y }}
        >
          <div className="flex items-center gap-0.5 rounded-lg border border-slate-200 bg-white p-1 shadow-lg">
            {[
              ['translate', 'selTranslate', 'globe'],
              ['explain', 'selExplain', 'sparkles'],
              ['biology', 'selBiology', 'flask'],
              ['free', 'selAsk', 'send'],
            ].map(([intent, key, icon]) => (
              <button
                key={intent}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => ask(intent)}
                className="flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-medium text-slate-600 transition-colors hover:bg-blue-50 hover:text-blue-700"
              >
                <Icon name={icon} />
                {t(key)}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
