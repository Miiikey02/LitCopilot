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
  const { t } = useTranslation()
  const [text, setText] = useState(paper.notes || '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
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
            onClick={onClose}
            className="rounded-md p-1 text-slate-400 transition-colors hover:bg-slate-50 hover:text-slate-700"
          >
            <Icon name="x" />
          </button>
        </header>

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
