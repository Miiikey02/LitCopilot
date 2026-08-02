import React from 'react'
import { useTranslation } from 'react-i18next'

// Status → badge color. Anything unmapped falls back to slate.
const statusColor = (status) => {
  const s = (status || '').toUpperCase()
  if (s.includes('RECRUITING')) return 'bg-green-100 text-green-800'
  if (s.includes('COMPLETED')) return 'bg-blue-100 text-blue-800'
  if (s.includes('TERMINATED') || s.includes('WITHDRAWN')) return 'bg-red-100 text-red-700'
  return 'bg-slate-100 text-slate-600'
}

export default function TrialsList({ trials }) {
  const { t } = useTranslation()
  if (!trials) return null
  if (trials.length === 0) {
    return <p className="text-sm text-slate-500">{t('trialsEmpty')}</p>
  }
  return (
    <div className="space-y-3">
      {trials.map((tr) => (
        <div
          key={tr.nct_id}
          className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm"
        >
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs text-slate-500">{tr.nct_id}</span>
            <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusColor(tr.status)}`}>
              {tr.status}
            </span>
            {tr.phases.map((p) => (
              <span
                key={p}
                className="rounded-full bg-purple-100 px-2 py-0.5 text-xs font-medium text-purple-700"
              >
                {p}
              </span>
            ))}
          </div>
          <p className="text-sm font-medium leading-6 text-slate-800">{tr.title}</p>
          {tr.conditions.length > 0 && (
            <p className="mt-1 text-xs text-slate-500">{tr.conditions.join(' · ')}</p>
          )}
          <a
            href={tr.url}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-block text-sm font-medium text-blue-600 hover:text-blue-800 hover:underline"
          >
            {t('viewTrial')} →
          </a>
        </div>
      ))}
    </div>
  )
}
