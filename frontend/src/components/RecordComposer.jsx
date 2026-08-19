import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import * as api from '../lib/api'
import Icon from './Icon'

// Write the minimum; get a record worth keeping.
//
// Nobody fills in a five-field form at the bench. What people actually write is
// a fragment — "8/14 按 Tanaka 2019 做了 RGC 计数，n=24/组，处理组 62% 对照 38%" —
// in whatever order it came to mind. This turns that into a structured record
// and hands it back to be checked.
//
// The one rule it works under: complete, never invent. Expanding "n=24" into a
// sentence is completing; writing a sample size nobody gave is fabricating, and
// a fabricated lab record is worse than no record at all. What is genuinely
// absent comes back as 还缺 — the useful half of the job, since the whole
// premise is that the researcher wrote only the minimum.

const FIELDS = [
  ['aim', 'recordAim', 2],
  ['method', 'recordMethod', 4],
  ['result', 'recordResult', 3],
]

export default function RecordComposer({ teamId, papers = [], onSaved }) {
  const { t, i18n } = useTranslation()
  const [note, setNote] = useState('')
  const [draft, setDraft] = useState(null)
  const [drafting, setDrafting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const write = async () => {
    if (!note.trim() || drafting) return
    setDrafting(true)
    setError('')
    try {
      setDraft(await api.draftRecord(note.trim(), teamId, i18n.language))
    } catch {
      setError(t('recordDraftFailed'))
    } finally {
      setDrafting(false)
    }
  }

  const save = async () => {
    if (!draft?.title?.trim() || saving) return
    setSaving(true)
    setError('')
    try {
      await api.createRecord({
        title: draft.title,
        kind: draft.kind || 'experiment',
        happened_on: draft.happened_on || null,
        aim: draft.aim,
        method: draft.method,
        result: draft.result,
        paper_ids: draft.paper_ids || [],
        team_id: teamId ? Number(teamId) : null,
      })
      setDraft(null)
      setNote('')
      onSaved?.()
    } catch {
      setError(t('recordSaveFailed'))
    } finally {
      setSaving(false)
    }
  }

  const linked = (draft?.paper_ids || [])
    .map((id) => papers.find((p) => p.id === id))
    .filter(Boolean)

  return (
    <div className="mb-4 rounded-xl border border-slate-200 bg-white p-4">
      {!draft ? (
        <>
          <label className="mb-1 block text-sm font-medium text-slate-700">
            {t('recordQuickTitle')}
          </label>
          <p className="mb-2 text-xs leading-5 text-slate-500">{t('recordQuickHint')}</p>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) write()
            }}
            rows={3}
            placeholder={t('recordQuickPlaceholder')}
            className="w-full resize-y rounded-lg border border-slate-200 p-2.5 text-sm leading-6 text-slate-800 outline-none transition-colors focus:border-blue-400"
          />
          <div className="mt-2 flex items-center gap-2">
            <button
              onClick={write}
              disabled={drafting || !note.trim()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white transition-all hover:bg-slate-800 active:scale-[0.98] disabled:opacity-50"
            >
              <Icon name="sparkles" />
              {drafting ? t('recordDrafting') : t('recordWriteIt')}
            </button>
            <span className="text-xs text-slate-400">{t('composerHint')}</span>
          </div>
        </>
      ) : (
        <div className="space-y-2">
          <p className="text-xs font-medium text-slate-600">{t('recordDraftReady')}</p>
          <input
            value={draft.title}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            className="w-full rounded-lg border border-slate-200 p-2 text-sm font-medium outline-none focus:border-blue-400"
          />
          <input
            type="date"
            value={draft.happened_on || ''}
            onChange={(e) => setDraft({ ...draft, happened_on: e.target.value })}
            className="rounded-lg border border-slate-200 p-2 text-sm outline-none focus:border-blue-400"
          />
          {FIELDS.map(([key, label, rows]) => (
            <div key={key}>
              <label className="mb-0.5 block text-xs font-medium text-slate-600">
                {t(label)}
              </label>
              <textarea
                value={draft[key] || ''}
                onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
                rows={rows}
                placeholder={key === 'result' ? t('recordNoResult') : ''}
                className="w-full resize-y rounded-lg border border-slate-200 p-2 text-sm leading-6 outline-none focus:border-blue-400"
              />
            </div>
          ))}

          {linked.length > 0 && (
            <p className="text-xs text-slate-500">
              <Icon name="library" className="mr-1 text-slate-400" />
              {linked.map((p) => p.citation_key || p.title).join('、')}
            </p>
          )}

          {/* What it could not fill in. Shown rather than guessed — the whole
              point of writing the minimum is that something is missing, and
              being told which thing is more useful than a plausible sentence. */}
          {draft.missing?.length > 0 && (
            <div className="rounded-lg bg-amber-50 p-2.5">
              <p className="text-xs font-medium text-amber-800">{t('recordMissing')}</p>
              <ul className="mt-1 space-y-0.5">
                {draft.missing.map((m, i) => (
                  <li key={i} className="text-xs leading-5 text-amber-800">
                    · {m}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {error && <p className="text-xs text-red-600">{error}</p>}
          <div className="flex items-center gap-2">
            <button
              onClick={save}
              disabled={saving || !draft.title?.trim()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white transition-all hover:bg-slate-800 disabled:opacity-50"
            >
              <Icon name="check" />
              {saving ? t('saving') : t('save')}
            </button>
            <button
              onClick={() => setDraft(null)}
              className="rounded-lg px-2 py-1.5 text-sm text-slate-500 hover:text-slate-800"
            >
              {t('recordRewrite')}
            </button>
          </div>
        </div>
      )}
      {!draft && error && <p className="mt-2 text-xs text-red-600">{error}</p>}
    </div>
  )
}
