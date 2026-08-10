import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import * as api from '../lib/api'
import ConversationList from './ConversationList'

// Ask questions about your own saved papers. Answers are grounded in stored
// metadata + your notes (never abstracts), so the assistant says plainly when a
// question needs the full text.
export default function LibraryChat({ folder, scopeLabel, paperCount, teamId }) {
  const { t, i18n } = useTranslation()
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [turns, setTurns] = useState([])
  const [busy, setBusy] = useState(false)
  const [conversations, setConversations] = useState([])
  const [conversationId, setConversationId] = useState(null)

  const loadConversations = async () => {
    try {
      setConversations(await api.listConversations('library'))
    } catch {
      /* history is non-critical */
    }
  }

  useEffect(() => {
    if (open) loadConversations()
  }, [open])

  // Reopen a saved thread: its transcript becomes the visible turns, and
  // further questions append to the same conversation.
  const openConversation = async (id) => {
    try {
      const c = await api.getConversation(id)
      const restored = []
      for (let i = 0; i < c.messages.length; i += 2) {
        restored.push({
          q: c.messages[i]?.content || '',
          a: c.messages[i + 1]?.content || '',
        })
      }
      setTurns(restored)
      setConversationId(c.id)
    } catch {
      /* ignore */
    }
  }

  const startNew = () => {
    setTurns([])
    setConversationId(null)
  }

  const ask = async (e) => {
    e.preventDefault()
    const msg = text.trim()
    if (!msg || busy) return
    setText('')
    setBusy(true)
    // Send prior turns so follow-ups keep context.
    const history = turns.flatMap((tn) => [
      { role: 'user', content: tn.q },
      { role: 'assistant', content: tn.a },
    ])
    try {
      const lang = i18n.language.startsWith('zh') ? 'zh' : 'en'
      const r = await api.libraryChat(msg, folder, lang, history, teamId, conversationId)
      if (r.conversation_id) setConversationId(r.conversation_id)
      setTurns((p) => [...p, { q: msg, a: r.answer, warning: r.warning }])
      loadConversations()
    } catch {
      setTurns((p) => [...p, { q: msg, a: '', warning: t('errorNetwork') }])
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="mb-4 w-full rounded-lg border border-dashed border-blue-300 bg-blue-50/50 px-4 py-2.5 text-sm font-medium text-blue-700 hover:bg-blue-50"
      >
        💬 {t('libraryChatOpen')}
      </button>
    )
  }

  return (
    <div className="mb-4 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-1 flex items-center justify-between">
        <h3 className="font-semibold text-slate-900">💬 {t('libraryChatTitle')}</h3>
        <button
          onClick={() => setOpen(false)}
          className="text-sm text-slate-400 hover:text-slate-700"
        >
          {t('collapse')}
        </button>
      </div>
      <p className="text-xs text-slate-400">
        {t('libraryChatScope', { scope: scopeLabel, count: paperCount })}
      </p>
      <p className="mt-1 text-xs text-slate-400">{t('libraryChatHint')}</p>

      <div className="mt-3 grid grid-cols-1 gap-4 lg:grid-cols-[1fr_15rem]">
        <div>
      {turns.length > 0 && (
        <div className="space-y-4">
          {turns.map((tn, i) => (
            <div key={i} className="space-y-2">
              <div className="flex justify-end">
                <div className="max-w-[85%] rounded-2xl rounded-tr-sm bg-blue-600 px-3 py-1.5 text-sm text-white">
                  {tn.q}
                </div>
              </div>
              {tn.warning ? (
                <div className="rounded-md border border-amber-200 bg-amber-50 p-2 text-sm text-amber-900">
                  {tn.warning}
                </div>
              ) : (
                <div className="whitespace-pre-wrap rounded-2xl rounded-tl-sm bg-slate-50 px-3 py-2 text-sm leading-6 text-slate-800">
                  {tn.a}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <form onSubmit={ask} className="mt-3 flex gap-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={t('libraryChatPlaceholder')}
          disabled={busy}
          className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:bg-slate-50"
        />
        <button
          type="submit"
          disabled={busy || !text.trim()}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {busy ? t('thinking') : t('ask')}
        </button>
      </form>
        </div>

        <ConversationList
          conversations={conversations}
          activeId={conversationId}
          onOpen={openConversation}
          onNew={startNew}
          onChanged={loadConversations}
          compact
        />
      </div>
    </div>
  )
}
