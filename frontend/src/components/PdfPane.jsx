import React, { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Icon from './Icon'

// The published PDF, rendered by us rather than by the browser's built-in
// viewer.
//
// The built-in viewer is a browser-internal document: JavaScript cannot read a
// selection inside it, so "select any phrase to ask about it" silently did
// nothing in this pane while working fine in the reading view. Drawing the
// pages ourselves and laying transparent, positioned text over them gives back
// a real selection — the same gesture, the same menu, on the published layout.
//
// pdf.js is loaded on demand: it is larger than the rest of the app, and a
// reader who never opens a PDF should not pay for it.

const collapse = (s) => (s || '').replace(/\s+/g, ' ').trim()

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

// Never render narrower than this. A pane measured mid-layout can report a
// width of zero, and a page drawn to fit "zero" is a thumbnail nobody can read
// — and, since rendering happens once, it would stay that way.
const MIN_WIDTH = 360

export default function PdfPane({ src, onAsk }) {
  const { t } = useTranslation()
  const scroller = useRef(null)
  const pagesHost = useRef(null)
  const [status, setStatus] = useState('loading') // loading | ready | failed
  const [sel, setSel] = useState(null)
  // Re-render when the split is dragged: a canvas does not reflow, so a wider
  // pane would otherwise keep showing the page drawn for the narrower one.
  const [width, setWidth] = useState(0)

  useEffect(() => {
    const box = scroller.current
    if (!box) return
    const measure = () => {
      const w = Math.max(box.clientWidth - 32, MIN_WIDTH)
      // Only worth redrawing for a change a reader would notice.
      setWidth((prev) => (Math.abs(w - prev) > 48 ? w : prev))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(box)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    let cancelled = false
    const host = pagesHost.current
    if (!host || !src || !width) return
    host.replaceChildren()
    setStatus('loading')
    ;(async () => {
      try {
        const pdfjs = await loadPdfjs()
        // One plain fetch rather than byte-range requests: the upload route
        // serves the whole file and does not advertise range support, and a
        // failed range dance shows up as a stream of aborted connections.
        const doc = await pdfjs.getDocument({
          url: src,
          disableRange: true,
          disableStream: true,
        }).promise
        if (cancelled) return

        // Fit the page to the pane, and draw at device resolution so text is
        // sharp on a retina screen without inflating the layout size.
        const available = width
        const dpr = Math.min(window.devicePixelRatio || 1, 2)

        for (let n = 1; n <= doc.numPages; n++) {
          if (cancelled) return
          const page = await doc.getPage(n)
          const base = page.getViewport({ scale: 1 })
          const scale = Math.max(available / base.width, 0.3)
          const viewport = page.getViewport({ scale })

          const wrap = document.createElement('div')
          wrap.className =
            'relative mx-auto mb-4 bg-white shadow-sm ring-1 ring-slate-200'
          wrap.style.width = `${viewport.width}px`
          wrap.style.height = `${viewport.height}px`

          const canvas = document.createElement('canvas')
          canvas.width = Math.floor(viewport.width * dpr)
          canvas.height = Math.floor(viewport.height * dpr)
          canvas.style.width = `${viewport.width}px`
          canvas.style.height = `${viewport.height}px`
          wrap.appendChild(canvas)

          const textLayer = document.createElement('div')
          textLayer.className = 'pdf-text-layer'
          // pdf.js positions its spans from this custom property.
          textLayer.style.setProperty('--scale-factor', String(scale))
          wrap.appendChild(textLayer)
          host.appendChild(wrap)

          await page.render({
            canvasContext: canvas.getContext('2d'),
            viewport,
            transform: dpr === 1 ? null : [dpr, 0, 0, dpr, 0, 0],
          }).promise
          if (cancelled) return

          const layer = new pdfjs.TextLayer({
            textContentSource: await page.getTextContent(),
            container: textLayer,
            viewport,
          })
          await layer.render()
          if (n === 1) setStatus('ready')
        }
        if (!cancelled) setStatus('ready')
      } catch {
        if (!cancelled) setStatus('failed')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [src, width])

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
      x: Math.min(Math.max(r.left - box.left + r.width / 2, 130), box.width - 130),
      y: r.top - box.top + scroller.current.scrollTop - 8,
    })
  }

  const ask = (intent) => {
    onAsk?.(sel.text, intent)
    setSel(null)
    window.getSelection()?.removeAllRanges()
  }

  return (
    <div
      ref={scroller}
      onMouseUp={captureSelection}
      className="relative h-full overflow-y-auto bg-slate-100 px-4 py-4"
    >
      {status === 'loading' && (
        <p className="py-6 text-center text-sm text-slate-400">{t('pdfLoading')}</p>
      )}
      {status === 'failed' && (
        <div className="m-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          {t('pdfFailed')}
        </div>
      )}
      <div ref={pagesHost} />

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
