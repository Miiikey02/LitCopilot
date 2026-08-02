import React from 'react'
import { useTranslation } from 'react-i18next'

// Recent searches, click to re-run. `history` is the list from GET /api/history.
export default function HistoryList({ history, onPick, onClear }) {
  const { t } = useTranslation()
  if (!history || history.length === 0) {
    return <p className="text-sm text-slate-400">{t('historyEmpty')}</p>
  }
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-700">{t('recentSearches')}</h3>
        <button
          onClick={onClear}
          className="text-xs text-slate-400 hover:text-slate-600"
        >
          {t('clearHistory')}
        </button>
      </div>
      <ul className="divide-y divide-slate-100">
        {history.map((h) => (
          <li key={h.id}>
            <button
              onClick={() => onPick(h.query)}
              className="flex w-full items-center justify-between gap-3 py-2 text-left hover:bg-slate-50"
            >
              <span className="truncate text-sm text-slate-700">{h.query}</span>
              <span className="shrink-0 text-xs text-slate-400">
                {t('resultsUnit', { count: h.result_count })} · {h.created_at.replace('T', ' ')}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
