import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import * as api from '../lib/api'
import Icon from './Icon'
import RecordComposer from './RecordComposer'

// The lab notebook the library kept pointing at.
//
// Most records will arrive by dictation — "记一条实验：按 Tanaka 2019 的方法…" —
// because that is faster than any form. This view exists so they can be read,
// corrected and finished afterwards: an experiment is usually written before
// its result is known, and coming back to fill that in is the normal case, not
// an edge one.

function RecordCard({ record, papers, onChanged }) {
  const { t } = useTranslation()
  const [editing, setEditing] = useState(false)
  const [result, setResult] = useState(record.result || '')
  const [busy, setBusy] = useState(false)

  const save = async () => {
    setBusy(true)
    try {
      await api.updateRecord(record.id, { result })
      setEditing(false)
      onChanged()
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!window.confirm(t('recordDeleteConfirm', { name: record.title }))) return
    await api.deleteRecord(record.id)
    onChanged()
  }

  const linked = (record.paper_ids || [])
    .map((id) => papers.find((p) => p.id === id))
    .filter(Boolean)

  return (
    <div className="card-hover rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="font-semibold leading-6 text-slate-900">{record.title}</h3>
          <p className="mt-0.5 text-xs text-slate-500">
            {record.happened_on || t('recordDate')}
            {record.kind && record.kind !== 'experiment' ? ` · ${record.kind}` : ''}
          </p>
        </div>
        <button
          onClick={remove}
          title={t('delete')}
          className="shrink-0 rounded p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-red-600"
        >
          <Icon name="trash" />
        </button>
      </div>

      {record.aim && (
        <p className="mt-2 text-sm leading-6 text-slate-700">
          <span className="font-medium text-slate-500">{t('recordAim')}：</span>
          {record.aim}
        </p>
      )}
      {record.method && (
        <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-slate-700">
          <span className="font-medium text-slate-500">{t('recordMethod')}：</span>
          {record.method}
        </p>
      )}

      {/* The result is the field most likely to be empty and most likely to
          need filling in later, so it edits in place rather than in a panel. */}
      <div className="mt-2">
        <span className="text-sm font-medium text-slate-500">{t('recordResult')}：</span>
        {editing ? (
          <div className="mt-1">
            <textarea
              value={result}
              onChange={(e) => setResult(e.target.value)}
              rows={3}
              className="w-full resize-y rounded-lg border border-slate-200 p-2 text-sm leading-6 outline-none focus:border-blue-400"
            />
            <button
              onClick={save}
              disabled={busy}
              className="mt-1 rounded-lg bg-slate-900 px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
            >
              {busy ? t('saving') : t('save')}
            </button>
          </div>
        ) : (
          <button
            onClick={() => setEditing(true)}
            className="text-left text-sm leading-6 text-slate-700 hover:text-blue-700"
          >
            {record.result || (
              <span className="text-slate-400">{t('recordNoResult')}</span>
            )}
          </button>
        )}
      </div>

      {linked.length > 0 && (
        <div className="mt-2 border-t border-slate-100 pt-2">
          <p className="text-xs text-slate-400">{t('recordLinked', { n: linked.length })}</p>
          <ul className="mt-1 space-y-0.5">
            {linked.map((p) => (
              <li key={p.id} className="truncate text-xs text-slate-600">
                <Icon name="library" className="mr-1 text-slate-400" />
                {p.citation_key ? `${p.citation_key} — ` : ''}
                {p.title}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

export default function RecordsList({ teamId, papers = [] }) {
  const { t } = useTranslation()
  const [records, setRecords] = useState([])
  const [query, setQuery] = useState('')
  const [error, setError] = useState('')

  const load = async () => {
    try {
      setRecords(await api.listRecords(teamId, query))
    } catch {
      setError(t('libraryLoadError'))
    }
  }

  useEffect(() => {
    const id = setTimeout(load, query ? 250 : 0)
    return () => clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamId, query])

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-semibold text-slate-900">{t('recordsTitle')}</h2>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('librarySearchPlaceholder')}
          className="w-full max-w-xs rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-900 focus:border-blue-500 focus:outline-none"
        />
        <span className="text-sm text-slate-500">{records.length}</span>
      </div>

      {/* Writing comes before reading here: the reason to open this view is
          usually that something just happened at the bench. */}
      <RecordComposer teamId={teamId} papers={papers} onSaved={load} />

      {error && <p className="text-sm text-red-600">{error}</p>}
      {!records.length && !error && (
        <p className="text-sm leading-6 text-slate-500">{t('recordsEmpty')}</p>
      )}

      <div className="space-y-3">
        {records.map((r) => (
          <RecordCard key={r.id} record={r} papers={papers} onChanged={load} />
        ))}
      </div>
    </div>
  )
}
