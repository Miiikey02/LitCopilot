import React, { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Icon from './Icon'
import { BULK_FORMATS, downloadText } from '../lib/citation'

// One-click download of the whole result set: all citations as .bib/.ris, or a
// plain titles list. Metadata only — never abstract text.
export default function BulkExport({ papers, queryLabel }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const run = (fmt) => {
    const safe = (queryLabel || 'gaze').replace(/[^\w一-鿿-]+/g, '_').slice(0, 40)
    downloadText(`gaze-${safe}.${fmt.ext}`, fmt.build(papers), fmt.mime)
    setOpen(false)
  }

  if (!papers?.length) return null

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
      >
        <Icon name="download" className="mr-1" /> {t('downloadAll')} ▾
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-1 w-52 overflow-hidden rounded-md border border-slate-200 bg-white py-1 shadow-lg">
          {BULK_FORMATS.map((fmt) => (
            <button
              key={fmt.key}
              type="button"
              onClick={() => run(fmt)}
              className="block w-full px-3 py-1.5 text-left text-sm text-slate-700 hover:bg-slate-50"
            >
              {fmt.key === 'titles'
                ? t('downloadTitles')
                : t('downloadAllAs', { format: fmt.label })}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
