import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import * as api from '../lib/api'
import Icon from './Icon'

// New papers in the field one folder covers.
//
// The folder is the unit because it already says what the field is — its name
// and the papers in it are the description — and a paper worth keeping has an
// obvious place to go. So switching it on takes one button, and keeping a
// finding takes one more.
//
// Everything shown here has been screened against the folder's contents, with
// a sentence on why it belongs. A raw keyword feed for a field is dozens of
// papers a week, half of them beside the point, and a list like that is one
// people stop opening by the second week.

function ago(iso, t) {
  if (!iso) return ''
  const hours = (Date.now() - new Date(iso).getTime()) / 36e5
  if (hours < 1) return t('watchJustNow')
  if (hours < 24) return t('watchHoursAgo', { n: Math.floor(hours) })
  return t('watchDaysAgo', { n: Math.floor(hours / 24) })
}

function Hit({ hit, teamId, onDone }) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState('')
  const c = hit.card || {}

  const act = async (kind) => {
    setBusy(kind)
    try {
      if (kind === 'save') await api.saveWatchHit(hit.id, teamId)
      else await api.dismissWatchHit(hit.id, teamId)
      onDone(kind)
    } catch {
      setBusy('')
    }
  }

  return (
    <li className="rounded-lg border border-slate-200 bg-white p-3">
      <a
        href={c.url || (c.doi ? `https://doi.org/${c.doi}` : undefined)}
        target="_blank"
        rel="noreferrer"
        className="font-medium leading-6 text-slate-900 hover:text-blue-700"
      >
        {c.title}
      </a>
      <p className="mt-0.5 text-xs text-slate-500">
        {(c.authors || []).slice(0, 3).join(', ')}
        {(c.authors || []).length > 3 ? ' et al.' : ''}
        {c.venue ? ` · ${c.venue}` : ''}
        {c.pub_date ? ` · ${c.pub_date}` : ''}
      </p>
      {hit.why && <p className="mt-1.5 text-sm leading-6 text-slate-700">{hit.why}</p>}
      <div className="mt-2 flex items-center gap-2">
        <button
          onClick={() => act('save')}
          disabled={!!busy}
          className="inline-flex items-center gap-1 rounded-md bg-slate-900 px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-slate-800 disabled:opacity-50"
        >
          <Icon name="plus" />
          {busy === 'save' ? t('saving') : t('watchKeep')}
        </button>
        <button
          onClick={() => act('dismiss')}
          disabled={!!busy}
          className="rounded-md px-2 py-1 text-xs text-slate-500 transition-colors hover:text-slate-800 disabled:opacity-50"
        >
          {t('watchDismiss')}
        </button>
      </div>
    </li>
  )
}

// Daily for a fast field someone reads every morning; weekly for one they
// review on Mondays. Either way a check covers everything since the last one.
function Frequency({ value, onChange, disabled }) {
  const { t } = useTranslation()
  return (
    <span className="inline-flex shrink-0 overflow-hidden rounded-md border border-slate-200 text-xs">
      {[1, 7].map((d) => (
        <button
          key={d}
          onClick={() => d !== value && onChange(d)}
          disabled={disabled}
          className={`px-2 py-1 transition-colors disabled:opacity-50 ${
            value === d ? 'bg-slate-900 text-white' : 'bg-white text-slate-600 hover:text-blue-700'
          }`}
        >
          {t(d === 1 ? 'watchDaily' : 'watchWeekly')}
        </button>
      ))}
    </span>
  )
}

// Everything this folder has been sent, by the day it arrived, including what
// was already filed or dismissed. Someone back after two months finds those
// two months here; someone who dismissed a paper too quickly can take it back.
function History({ watchId, teamId, onChanged }) {
  const { t, i18n } = useTranslation()
  const [items, setItems] = useState([])
  const [more, setMore] = useState(false)
  const [busy, setBusy] = useState(0)

  const load = async (offset = 0) => {
    try {
      const page = await api.watchHistory(watchId, teamId, offset)
      setItems((prev) => (offset ? [...prev, ...page] : page))
      setMore(page.length === 50)
    } catch {
      /* the history is a convenience; the waiting list still works */
    }
  }

  useEffect(() => {
    load(0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchId, teamId])

  const keep = async (hit) => {
    setBusy(hit.id)
    try {
      await api.saveWatchHit(hit.id, teamId)
      setItems((prev) => prev.map((x) => (x.id === hit.id ? { ...x, status: 'saved' } : x)))
      onChanged(true)
    } finally {
      setBusy(0)
    }
  }

  const day = (iso) =>
    new Date(iso).toLocaleDateString(i18n.language === 'zh' ? 'zh-CN' : 'en', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    })
  const groups = []
  for (const it of items) {
    const d = day(it.found_at)
    if (!groups.length || groups[groups.length - 1].day !== d) groups.push({ day: d, items: [] })
    groups[groups.length - 1].items.push(it)
  }

  if (!items.length) {
    return <p className="mt-3 text-xs text-slate-500">{t('watchHistoryEmpty')}</p>
  }

  return (
    <div className="mt-3 space-y-3">
      {groups.map((g) => {
        const saved = g.items.filter((x) => x.status === 'saved').length
        const dismissed = g.items.filter((x) => x.status === 'dismissed').length
        return (
          <div key={g.day}>
            <p className="mb-1 text-xs font-medium text-slate-600">
              {t('watchHistoryDay', { day: g.day, n: g.items.length, saved, dismissed })}
            </p>
            <ul className="space-y-1">
              {g.items.map((h) => (
                <li
                  key={h.id}
                  className="flex items-start gap-2 rounded-md bg-white px-2.5 py-1.5 text-sm"
                >
                  <a
                    href={h.card?.url || (h.card?.doi ? `https://doi.org/${h.card.doi}` : undefined)}
                    target="_blank"
                    rel="noreferrer"
                    title={h.why || ''}
                    className="min-w-0 flex-1 leading-6 text-slate-800 hover:text-blue-700"
                  >
                    {h.card?.title}
                  </a>
                  <span
                    className={`mt-1 shrink-0 rounded-full px-1.5 text-[11px] leading-4 ${
                      h.status === 'saved'
                        ? 'bg-emerald-50 text-emerald-700'
                        : h.status === 'dismissed'
                        ? 'bg-slate-100 text-slate-500'
                        : 'bg-blue-50 text-blue-700'
                    }`}
                  >
                    {t(
                      h.status === 'saved'
                        ? 'watchStatusSaved'
                        : h.status === 'dismissed'
                        ? 'watchStatusDismissed'
                        : 'watchStatusWaiting'
                    )}
                  </span>
                  {h.status !== 'saved' && (
                    <button
                      onClick={() => keep(h)}
                      disabled={busy === h.id}
                      className="mt-0.5 shrink-0 text-xs text-blue-700 hover:underline disabled:opacity-50"
                    >
                      {busy === h.id ? t('saving') : t('watchKeep')}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )
      })}
      {more && (
        <button
          onClick={() => load(items.length)}
          className="text-xs text-blue-700 hover:underline"
        >
          {t('watchHistoryMore')}
        </button>
      )}
    </div>
  )
}

export default function WatchPanel({ folder, teamId, onChanged }) {
  const { t, i18n } = useTranslation()
  const [watch, setWatch] = useState(null)
  const [hits, setHits] = useState([])
  const [open, setOpen] = useState(true)
  const [busy, setBusy] = useState('')
  const [editing, setEditing] = useState(false)
  const [query, setQuery] = useState('')
  const [note, setNote] = useState('')
  const [everyDays, setEveryDays] = useState(1)
  const [showHistory, setShowHistory] = useState(false)

  const load = async () => {
    if (!folder?.watch_id) {
      setWatch(null)
      setHits([])
      return
    }
    try {
      const [ws, hs] = await Promise.all([
        api.listWatches(teamId),
        api.watchHits(folder.watch_id, teamId),
      ])
      const w = ws.find((x) => x.id === folder.watch_id) || null
      setWatch(w)
      setQuery(w?.query || '')
      setHits(hs)
    } catch {
      /* the folder still works without its watch */
    }
  }

  useEffect(() => {
    setNote('')
    setEditing(false)
    setShowHistory(false)
    setOpen(true)
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folder?.id, folder?.watch_id, teamId])

  const start = async () => {
    setBusy('start')
    setNote('')
    try {
      await api.watchFolder(folder.id, teamId, i18n.language, everyDays)
      setOpen(true)
      onChanged()
    } catch {
      setNote(t('watchFailed'))
    } finally {
      setBusy('')
    }
  }

  const checkNow = async () => {
    setBusy('check')
    setNote('')
    try {
      const r = await api.checkWatch(watch.id, teamId)
      setNote(r.error ? t('watchFailed') : t('watchChecked', { n: r.added }))
      setOpen(true)
      await load()
      onChanged()
    } catch {
      setNote(t('watchFailed'))
    } finally {
      setBusy('')
    }
  }

  const saveQuery = async () => {
    if (!query.trim()) return
    setBusy('query')
    try {
      await api.updateWatch(watch.id, { query: query.trim() }, teamId)
      setEditing(false)
    } finally {
      setBusy('')
    }
    // Run the new search straight away, so its effect is seen, not trusted.
    await checkNow()
  }

  const setFrequency = async (d) => {
    setBusy('freq')
    try {
      await api.updateWatch(watch.id, { every_days: d }, teamId)
      setWatch({ ...watch, every_days: d })
    } catch {
      setNote(t('watchFailed'))
    } finally {
      setBusy('')
    }
  }

  const stop = async () => {
    if (!window.confirm(t('watchStopConfirm', { name: folder.name }))) return
    await api.unwatch(watch.id, teamId)
    onChanged()
  }

  if (!folder?.id) return null

  if (!folder.watch_id) {
    return (
      <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-dashed border-slate-300 px-4 py-3">
        <Icon name="bell" className="text-blue-600" />
        <p className="min-w-0 flex-1 text-sm leading-6 text-slate-600">
          {t('watchOffer', { name: folder.name })}
        </p>
        <Frequency value={everyDays} onChange={setEveryDays} disabled={!!busy} />
        <button
          onClick={start}
          disabled={!!busy}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-slate-800 disabled:opacity-60"
        >
          {busy === 'start' ? t('watchStarting') : t('watchStart')}
        </button>
        {note && <p className="w-full text-xs text-red-600">{note}</p>}
      </div>
    )
  }

  return (
    <div className="mb-4 rounded-xl border border-blue-100 bg-blue-50/40 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <button
          onClick={() => setOpen(!open)}
          className="flex min-w-0 items-center gap-1.5 text-sm font-medium text-slate-900"
        >
          <Icon name="bell" className="text-blue-600" />
          {hits.length ? t('watchWaiting', { n: hits.length }) : t('watchNothing')}
          {hits.length > 0 && (
            <Icon
              name="chevronDown"
              className={`text-slate-400 transition-transform ${open ? '' : '-rotate-90'}`}
            />
          )}
        </button>
        <span className="text-xs text-slate-500">
          {watch?.last_checked ? t('watchLastChecked', { when: ago(watch.last_checked, t) }) : ''}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-1">
          {watch && (
            <Frequency
              value={watch.every_days || 1}
              onChange={setFrequency}
              disabled={!!busy}
            />
          )}
          <button
            onClick={() => setShowHistory(!showHistory)}
            className={`rounded-md px-2 py-1 text-xs transition-colors hover:bg-white hover:text-blue-700 ${
              showHistory ? 'text-blue-700' : 'text-slate-600'
            }`}
          >
            {t('watchHistory')}
          </button>
          <button
            onClick={checkNow}
            disabled={!!busy}
            className="rounded-md px-2 py-1 text-xs text-slate-600 transition-colors hover:bg-white hover:text-blue-700 disabled:opacity-50"
          >
            {busy === 'check' ? t('watchChecking') : t('watchCheckNow')}
          </button>
          <button
            onClick={() => setEditing(!editing)}
            className="rounded-md px-2 py-1 text-xs text-slate-600 transition-colors hover:bg-white hover:text-blue-700"
          >
            {t('watchQuery')}
          </button>
          <button
            onClick={stop}
            className="rounded-md px-2 py-1 text-xs text-slate-500 transition-colors hover:bg-white hover:text-red-600"
          >
            {t('watchStop')}
          </button>
        </div>
      </div>

      {note && <p className="mt-1 text-xs text-slate-600">{note}</p>}
      {watch?.last_error && !note && (
        <p className="mt-1 text-xs text-amber-700">{t('watchLastFailed')}</p>
      )}

      {/* The search is shown, and editable, because it is the one thing a
          researcher can judge at a glance and the model can get wrong. */}
      {editing && (
        <div className="mt-2">
          <p className="mb-1 text-xs leading-5 text-slate-500">{t('watchQueryHint')}</p>
          <textarea
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            rows={3}
            className="w-full resize-y rounded-lg border border-slate-200 bg-white p-2 font-mono text-xs leading-5 outline-none focus:border-blue-400"
          />
          <button
            onClick={saveQuery}
            disabled={busy === 'query' || !query.trim()}
            className="mt-1 rounded-lg bg-slate-900 px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
          >
            {busy === 'query' ? t('saving') : t('save')}
          </button>
        </div>
      )}

      {showHistory && watch && (
        <History
          watchId={watch.id}
          teamId={teamId}
          onChanged={(filed) => {
            load()
            onChanged(filed)
          }}
        />
      )}

      {!showHistory && open && hits.length > 0 && (
        <ul className="mt-3 space-y-2">
          {hits.map((h) => (
            <Hit
              key={h.id}
              hit={h}
              teamId={teamId}
              onDone={(kind) => {
                setHits((prev) => prev.filter((x) => x.id !== h.id))
                // A kept paper changes the folder's list and count; a
                // dismissed one only the badge.
                onChanged(kind === 'save')
              }}
            />
          ))}
        </ul>
      )}
    </div>
  )
}
