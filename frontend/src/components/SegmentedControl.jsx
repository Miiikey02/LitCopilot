import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import Icon from './Icon'

// A segmented switch whose selected "thumb" slides between options instead of
// snapping. Widths are measured rather than assumed, because the labels differ
// in length between Chinese and English and change when the language toggles.
export default function SegmentedControl({ options, value, onChange, size = 'md' }) {
  const wrap = useRef(null)
  const refs = useRef({})
  const [thumb, setThumb] = useState({ left: 0, width: 0, ready: false })

  const measure = () => {
    const el = refs.current[String(value)]
    const parent = wrap.current
    if (!el || !parent) return
    const a = el.getBoundingClientRect()
    const b = parent.getBoundingClientRect()
    setThumb({ left: a.left - b.left, width: a.width, ready: true })
  }

  // Measure before paint so the thumb never flashes at the wrong position.
  useLayoutEffect(measure, [value, options.length])

  useEffect(() => {
    // Re-measure when the label text reflows (language switch, font load).
    const ro = new ResizeObserver(measure)
    if (wrap.current) ro.observe(wrap.current)
    window.addEventListener('resize', measure)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', measure)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])

  const pad = size === 'sm' ? 'px-2.5 py-1' : 'px-3 py-1.5'

  return (
    <div
      ref={wrap}
      className="relative inline-flex rounded-lg border border-slate-200 bg-slate-100/80 p-0.5"
    >
      {/* The sliding thumb. Transform-based so it animates on the compositor. */}
      <div
        aria-hidden="true"
        className="rounded-md bg-white shadow-sm ring-1 ring-slate-200/70"
        style={{
          // Geometry set inline (a div, not a span) so nothing in the utility
          // layer can collapse it — an absolutely positioned span measured 0
          // wide here regardless of an explicit width.
          position: 'absolute',
          top: 2,
          bottom: 2,
          // Animate left/width rather than transform: a translated thumb did
          // not move in testing, while left/width apply reliably. For a two-
          // option control the layout cost is irrelevant.
          left: `${thumb.left}px`,
          width: `${thumb.width}px`,
          opacity: thumb.ready ? 1 : 0,
          transition: thumb.ready
            ? 'left 300ms cubic-bezier(0.22,1,0.36,1), width 300ms cubic-bezier(0.22,1,0.36,1)'
            : 'none',
        }}
      />
      {options.map((o) => {
        const selected = String(o.value) === String(value)
        return (
          <button
            key={String(o.value)}
            type="button"
            ref={(el) => (refs.current[String(o.value)] = el)}
            onClick={() => onChange(o.value)}
            className={`relative z-10 flex items-center gap-1.5 rounded-md text-sm font-medium transition-colors duration-200 active:scale-[0.97] ${pad} ${
              selected ? 'text-blue-700' : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            {o.icon && (
              <Icon
                name={o.icon}
                className={`transition-transform duration-300 ${
                  selected ? 'scale-110' : 'scale-100'
                }`}
              />
            )}
            {o.label}
          </button>
        )
      })}
    </div>
  )
}
