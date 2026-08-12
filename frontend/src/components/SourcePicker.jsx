import React, { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Icon from './Icon'

// Which databases a search asks. They are not interchangeable, and which ones
// you want depends on the question: PubMed is curated and clinical, bioRxiv is
// unreviewed and current, OpenAlex and Semantic Scholar are broad. A reviewer
// checking clinical evidence and someone tracking a fast-moving preprint field
// want different sets.
export const ALL_SOURCES = ['pubmed', 'semantic_scholar', 'openalex', 'biorxiv']

const META = {
  pubmed: { label: 'PubMed', note: 'sourceNotePubmed' },
  semantic_scholar: { label: 'Semantic Scholar', note: 'sourceNoteS2' },
  openalex: { label: 'OpenAlex', note: 'sourceNoteOpenAlex' },
  biorxiv: { label: 'bioRxiv', note: 'sourceNoteBiorxiv' },
}

export default function SourcePicker({ value, onChange }) {
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

  const toggle = (key) => {
    const next = value.includes(key)
      ? value.filter((k) => k !== key)
      : [...ALL_SOURCES.filter((k) => value.includes(k) || k === key)]
    // Searching nothing has no meaning, so the last one cannot be turned off.
    if (next.length) onChange(next)
  }

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-slate-700 transition-colors hover:border-blue-400"
      >
        <Icon name="library" className="mr-1" />
        {t('sourcesLabel')} · {value.length}/{ALL_SOURCES.length}
        <Icon name="chevronDown" className="ml-0.5" />
      </button>
      {open && (
        <div className="animate-expand absolute left-0 z-20 mt-1 w-72 overflow-hidden rounded-md border border-slate-200 bg-white py-1 shadow-lg">
          {ALL_SOURCES.map((key) => {
            const on = value.includes(key)
            const only = on && value.length === 1
            return (
              <label
                key={key}
                title={only ? t('sourceKeepOne') : ''}
                className={`flex items-start gap-2 px-3 py-2 text-left ${
                  only ? 'cursor-not-allowed opacity-70' : 'cursor-pointer hover:bg-slate-50'
                }`}
              >
                <input
                  type="checkbox"
                  checked={on}
                  disabled={only}
                  onChange={() => toggle(key)}
                  className="mt-0.5 h-3.5 w-3.5 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                />
                <span className="min-w-0">
                  <span className="block text-sm text-slate-800">{META[key].label}</span>
                  <span className="block text-xs leading-5 text-slate-500">
                    {t(META[key].note)}
                  </span>
                </span>
              </label>
            )
          })}
        </div>
      )}
    </div>
  )
}
