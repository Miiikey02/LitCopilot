import React, { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import * as api from '../lib/api'
import Icon from './Icon'

// Notes on a paper, in a panel rather than inline.
//
// A note used to be a textarea wedged into the card, which made the list jump
// as it grew and gave a paragraph of thinking the same room as a tag. Writing
// about a paper deserves its own space, and — since a note is the one thing
// here nobody else can reproduce — deleting one asks first.
export default function NotePanel({ paper, teamId, onClose, onSaved }) {
  const { t, i18n } = useTranslation()
  const [text, setText] = useState(paper.notes || '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  // Past versions, loaded on demand. In a lab library the note is one shared
  // text anyone can rewrite; this is how an overwritten one comes back.
  const [history, setHistory] = useState(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const area = useRef(null)

  const dirty = text !== (paper.notes || '')

  useEffect(() => {
    area.current?.focus()
    const onKey = (e) => {
      if (e.key === 'Escape') onClose()
      // Cmd/Ctrl+Enter saves, the convention everywhere else you write.
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') save()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text])

  const save = async () => {
    if (saving) return
    setSaving(true)
    setError('')
    try {
      await api.setNotes(paper.id, text, teamId)
      onSaved()
      onClose()
    } catch {
      setError(t('errorNetwork'))
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    if (!window.confirm(t('deleteNoteConfirm'))) return
    setSaving(true)
    try {
      await api.setNotes(paper.id, '', teamId)
      onSaved()
      onClose()
    } catch {
      setError(t('errorNetwork'))
      setSaving(false)
    }
  }

  const toggleHistory = async () => {
    const next = !historyOpen
    setHistoryOpen(next)
    if (next && history === null) {
      try {
        setHistory(await api.noteHistory(paper.id, teamId))
      } catch {
        setHistory([])
      }
    }
  }

  // Restoring puts the old text back in the editor rather than saving it
  // straight away: the reader sees what they are about to reinstate, and the
  // save that follows is itself recorded, so a restore can be undone too.
  const restore = (version) => {
    setText(version.old_notes)
    setHistoryOpen(false)
    area.current?.focus()
  }

  const when = (iso) => {
    try {
      return new Date(iso).toLocaleString(i18n.language.startsWith('zh') ? 'zh-CN' : 'en', {
        month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
      })
    } catch {
      return iso
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div
        className="absolute inset-0 bg-slate-900/20"
        onClick={() => (dirty ? window.confirm(t('discardNote')) && onClose() : onClose())}
      />
      <aside className="animate-from-right relative flex h-full w-full max-w-md flex-col border-l border-slate-200 bg-white shadow-xl">
        <header className="flex items-start gap-3 border-b border-slate-100 px-5 py-4">
          <div className="min-w-0 flex-1">
            <h3 className="flex items-center gap-1.5 text-sm font-semibold text-slate-900">
              <Icon name="note" className="text-blue-600" />
              {t('myNote')}
            </h3>
            <p className="mt-1 line-clamp-2 text-xs leading-5 text-slate-500">
              {paper.title}
            </p>
          </div>
          <button
            onClick={toggleHistory}
            className={`shrink-0 rounded-md px-2 py-1 text-xs transition-colors ${
              historyOpen ? 'bg-blue-50 text-blue-700' : 'text-slate-500 hover:bg-slate-50 hover:text-slate-800'
            }`}
          >
            <Icon name="clock" className="mr-1" />
            {t('noteHistoryOpen')}
          </button>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-slate-400 transition-colors hover:bg-slate-50 hover:text-slate-700"
          >
            <Icon name="x" />
          </button>
        </header>

        {historyOpen && (
          <div className="max-h-[45%] overflow-y-auto border-b border-slate-100 bg-slate-50 px-5 py-3">
            <p className="mb-2 text-xs font-medium text-slate-600">{t('noteHistoryTitle')}</p>
            {history === null && <p className="text-xs text-slate-400">{t('saving')}</p>}
            {history?.length === 0 && (
              <p className="text-xs leading-5 text-slate-400">{t('noteHistoryEmpty')}</p>
            )}
            <ul className="space-y-2">
              {(history || []).map((v) => (
                <li key={v.id} className="rounded-lg border border-slate-200 bg-white p-2.5">
                  <p className="text-xs text-slate-500">
                    <span className="font-medium text-slate-700">{v.by || t('noteHistorySomeone')}</span>
                    {' · '}
                    {when(v.at)}
                    {' · '}
                    {v.new_notes ? t('noteHistoryEdited') : t('noteHistoryCleared')}
                  </p>
                  <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-xs leading-5 text-slate-400">
                    <span className="text-slate-500">{t('noteHistoryBefore')}</span>
                    {v.old_notes || t('noteHistoryWasEmpty')}
                  </p>
                  {v.old_notes && v.old_notes !== text && (
                    <button
                      onClick={() => restore(v)}
                      className="mt-1 text-xs text-blue-700 hover:underline"
                    >
                      {t('noteHistoryRestore')}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        <textarea
          ref={area}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={t('notePlaceholder')}
          className="min-h-0 flex-1 resize-none px-5 py-4 text-[15px] leading-7 text-slate-800 focus:outline-none"
        />

        {error && <p className="px-5 pb-2 text-sm text-red-600">{error}</p>}

        <footer className="flex items-center gap-2 border-t border-slate-100 px-5 py-3">
          <button
            onClick={save}
            disabled={saving || !dirty}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            {saving ? t('saving') : t('save')}
          </button>
          {paper.notes && (
            <button
              onClick={remove}
              disabled={saving}
              className="rounded-lg px-3 py-2 text-sm text-red-600 transition-colors hover:bg-red-50 disabled:opacity-50"
            >
              <Icon name="trash" className="mr-1" />
              {t('deleteNote')}
            </button>
          )}
          <span className="ml-auto text-xs text-slate-400">{t('noteSaveHint')}</span>
        </footer>
      </aside>
    </div>
  )
}
