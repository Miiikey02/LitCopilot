import React, { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CITATION_FORMATS, copyText } from '../lib/citation'

// Per-paper "Cite" control: pick a format (BibTeX / RIS / APA) and copy it to
// the clipboard, ready to paste into a reference manager.
export default function CiteButton({ paper }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const copy = async (fmt) => {
    await copyText(fmt.build(paper))
    setOpen(false)
    setCopied(true)
    setTimeout(() => setCopied(false), 1600)
  }

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={
          copied
            ? 'text-sm font-medium text-green-600'
            : 'text-sm font-medium text-slate-600 hover:text-slate-900'
        }
      >
        {copied ? `✓ ${t('citeCopied')}` : `❝ ${t('cite')} ▾`}
      </button>
      {open && (
        <div className="absolute left-0 z-20 mt-1 w-56 overflow-hidden rounded-md border border-slate-200 bg-white py-1 shadow-lg">
          {CITATION_FORMATS.map((fmt) => (
            <button
              key={fmt.key}
              type="button"
              onClick={() => copy(fmt)}
              className="block w-full px-3 py-1.5 text-left text-sm text-slate-700 hover:bg-slate-50"
            >
              {t('copyAs', { format: fmt.label })}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
