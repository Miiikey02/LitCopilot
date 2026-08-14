import React, { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import * as api from '../lib/api'
import AnswerText from './AnswerText'
import Icon from './Icon'

// An agent that can tidy the library, rather than only describe it.
//
// The whole design rests on one rule: it proposes, you apply. Every change it
// wants to make arrives as a listed action with an explicit button, and until
// that button is pressed the library is untouched. An agent that re-filed three
// hundred papers on its own would be unusable even when it was right — the one
// time it was wrong there would be no way to see what it had done.
//
// Showing the plan is also the honest form of explanation. "Create 青光眼, file
// 3 papers into it" is checkable in a way that a paragraph describing the same
// intention is not.

const ICONS = {
  create_folder: 'folder',
  move_papers: 'library',
  add_tags: 'star',
  write_note: 'note',
}

function ActionList({ actions, applied, busy, onApply, onDismiss }) {
  const { t } = useTranslation()
  const label = (a) => {
    if (a.kind === 'create_folder') {
      return a.parent
        ? t('actCreateFolderIn', { name: a.name, parent: a.parent })
        : t('actCreateFolder', { name: a.name })
    }
    if (a.kind === 'move_papers') {
      return a.folder?.toLowerCase() === 'unfiled'
        ? t('actUnfile', { n: a.paper_ids.length })
        : t('actMovePapers', { n: a.paper_ids.length, folder: a.folder })
    }
    if (a.kind === 'add_tags') {
      return t('actAddTags', { n: a.paper_ids.length, tags: (a.tags || []).join('、') })
    }
    if (a.kind === 'write_note') return t('actWriteNote')
    return a.kind
  }

  return (
    <div className="mt-2 rounded-xl border border-slate-200 bg-slate-50 p-3">
      <p className="mb-2 text-xs font-medium text-slate-600">
        {applied ? t('agentApplied', { n: actions.length }) : t('agentProposes')}
      </p>
      <ul className="space-y-1.5">
        {actions.map((a, i) => (
          <li key={i} className="flex items-start gap-2 text-sm text-slate-700">
            <Icon name={ICONS[a.kind] || 'check'} className="mt-0.5 shrink-0 text-slate-400" />
            <div className="min-w-0">
              <span>{label(a)}</span>
              {/* A note is the one action whose content matters more than its
                  label — show the text that would be saved. */}
              {a.kind === 'write_note' && (
                <p className="mt-0.5 whitespace-pre-wrap text-xs leading-5 text-slate-500">
                  {a.note}
                </p>
              )}
            </div>
          </li>
        ))}
      </ul>
      {!applied && (
        <div className="mt-3 flex items-center gap-2">
          <button
            onClick={onApply}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white transition-all hover:bg-slate-800 active:scale-[0.98] disabled:opacity-60"
          >
            <Icon name="check" />
            {busy ? t('agentApplying') : t('agentApply')}
          </button>
          <button
            onClick={onDismiss}
            className="rounded-lg px-2 py-1.5 text-sm text-slate-500 transition-colors hover:text-slate-800"
          >
            {t('agentDiscard')}
          </button>
        </div>
      )}
    </div>
  )
}

const SUGGESTIONS = ['agentEg1', 'agentEg2', 'agentEg3']

export default function LibrarianPanel({ teamId, onClose, onChanged }) {
  const { t, i18n } = useTranslation()
  const [turns, setTurns] = useState([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [applying, setApplying] = useState(-1)
  const [error, setError] = useState('')
  const box = useRef(null)
  const area = useRef(null)

  useEffect(() => {
    area.current?.focus()
    const onKey = (e) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    box.current?.scrollTo({ top: box.current.scrollHeight })
  }, [turns, busy])

  const ask = async (text) => {
    const message = (text ?? input).trim()
    if (!message || busy) return
    setInput('')
    setError('')
    setBusy(true)
    const history = turns
      .filter((x) => x.content)
      .map((x) => ({ role: x.role, content: x.content }))
    setTurns((prev) => [...prev, { role: 'user', content: message }])
    try {
      const r = await api.libraryAgent(message, teamId, i18n.language, history)
      setTurns((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: r.answer || '',
          actions: r.actions || [],
          applied: false,
          warning: r.warning,
        },
      ])
    } catch {
      setError(t('agentFailed'))
    } finally {
      setBusy(false)
    }
  }

  const apply = async (index) => {
    const turn = turns[index]
    if (!turn?.actions?.length) return
    setApplying(index)
    setError('')
    try {
      const r = await api.libraryAgentApply(turn.actions, teamId)
      setTurns((prev) =>
        prev.map((x, i) => (i === index ? { ...x, applied: true, result: r } : x))
      )
      onChanged?.()
    } catch {
      setError(t('agentApplyFailed'))
    } finally {
      setApplying(-1)
    }
  }

  const discard = (index) =>
    setTurns((prev) => prev.map((x, i) => (i === index ? { ...x, actions: [] } : x)))

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <div className="absolute inset-0 bg-slate-900/25" onClick={onClose} />
      <div className="animate-rise relative flex h-[88vh] w-full max-w-2xl flex-col rounded-t-2xl border border-slate-200 bg-white shadow-xl sm:h-[80vh] sm:rounded-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-5 py-4">
          <div className="min-w-0">
            <h2 className="flex items-center gap-1.5 text-base font-semibold text-slate-900">
              <Icon name="sparkles" className="text-blue-500" />
              {t('agentTitle')}
            </h2>
            <p className="mt-0.5 text-xs leading-5 text-slate-500">{t('agentSubtitle')}</p>
          </div>
          <button
            onClick={onClose}
            className="shrink-0 rounded-md p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
            title={t('close')}
          >
            <Icon name="x" />
          </button>
        </div>

        <div ref={box} className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {turns.length === 0 && (
            <div>
              <p className="text-sm leading-6 text-slate-500">{t('agentEmpty')}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {SUGGESTIONS.map((key) => (
                  <button
                    key={key}
                    onClick={() => ask(t(key))}
                    className="rounded-full border border-slate-200 px-3 py-1.5 text-xs text-slate-600 transition-colors hover:border-blue-300 hover:text-blue-700"
                  >
                    {t(key)}
                  </button>
                ))}
              </div>
            </div>
          )}

          {turns.map((turn, i) =>
            turn.role === 'user' ? (
              <div key={i} className="flex justify-end">
                <p className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-blue-50 px-3 py-2 text-sm text-slate-800">
                  {turn.content}
                </p>
              </div>
            ) : (
              <div key={i} className="max-w-[95%]">
                {turn.content && (
                  <div className="text-sm leading-6 text-slate-700">
                    <AnswerText text={turn.content} />
                  </div>
                )}
                {turn.warning && (
                  <p className="text-sm leading-6 text-amber-700">{turn.warning}</p>
                )}
                {turn.actions?.length > 0 && (
                  <ActionList
                    actions={turn.actions}
                    applied={turn.applied}
                    busy={applying === i}
                    onApply={() => apply(i)}
                    onDismiss={() => discard(i)}
                  />
                )}
                {turn.applied && turn.result?.failed > 0 && (
                  <p className="mt-1 text-xs text-amber-700">
                    {t('agentSomeFailed', { n: turn.result.failed })}
                  </p>
                )}
              </div>
            )
          )}

          {busy && (
            <p className="text-sm text-slate-400">{t('agentThinking')}</p>
          )}
          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>

        <div className="border-t border-slate-100 p-3">
          <div className="flex items-end gap-2">
            <textarea
              ref={area}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  ask()
                }
              }}
              rows={2}
              placeholder={t('agentPlaceholder')}
              className="min-w-0 flex-1 resize-none rounded-xl border border-slate-200 p-2.5 text-sm text-slate-800 outline-none transition-colors focus:border-blue-400"
            />
            <button
              onClick={() => ask()}
              disabled={busy || !input.trim()}
              className="shrink-0 rounded-xl bg-slate-900 p-2.5 text-white transition-all hover:bg-slate-800 active:scale-[0.98] disabled:opacity-40"
              title={t('ask')}
            >
              <Icon name="send" />
            </button>
          </div>
          <p className="mt-1 px-1 text-xs text-slate-400">{t('agentSafety')}</p>
        </div>
      </div>
    </div>
  )
}
