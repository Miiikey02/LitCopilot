import React, { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import * as api from '../lib/api'
import ChatComposer from './ChatComposer'
import ConversationList from './ConversationList'
import Icon from './Icon'
import TypingDots from './TypingDots'

// Ask questions about your own saved papers. Answers are grounded in stored
// metadata + your notes (never abstracts), so the assistant says plainly when a
// question needs the full text.
export default function LibraryChat({ folder, scopeLabel, paperCount, teamId }) {
  const { t, i18n } = useTranslation()
  const [open, setOpen] = useState(false)
  const [turns, setTurns] = useState([])
  const [busy, setBusy] = useState(false)
  const [conversations, setConversations] = useState([])
  const [conversationId, setConversationId] = useState(null)
  const endRef = useRef(null)

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

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [turns.length, busy])

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

  const ask = async (msg) => {
    if (busy) return
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
        className="mb-4 flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-blue-300 bg-blue-50/50 px-4 py-3 text-sm font-medium text-blue-700 transition-colors hover:bg-blue-100/70"
      >
        <Icon name="chat" />
        {t('libraryChatOpen')}
      </button>
    )
  }

  return (
    <section className="animate-expand mb-4 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <header className="flex flex-wrap items-center gap-x-2 border-b border-slate-100 px-5 py-3.5">
        <Icon name="chat" className="text-blue-600" />
        <h3 className="text-base font-semibold text-slate-900">
          {t('libraryChatTitle')}
        </h3>
        <span className="text-xs text-slate-400">
          · {t('libraryChatScope', { scope: scopeLabel, count: paperCount })}
        </span>
        <button
          onClick={() => setOpen(false)}
          className="ml-auto text-sm text-slate-400 transition-colors hover:text-slate-700"
        >
          {t('collapse')}
        </button>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-[17rem_1fr]">
        <div className="order-2 border-t border-slate-100 p-3 lg:order-1 lg:border-r lg:border-t-0">
          <ConversationList
            conversations={conversations}
            activeId={conversationId}
            onOpen={openConversation}
            onNew={startNew}
            onChanged={loadConversations}
          />
        </div>

        <div className="order-1 flex min-h-[20rem] flex-col lg:order-2">
          <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4 lg:max-h-[30rem]">
            {turns.length === 0 && !busy && (
              <div className="flex h-full flex-col items-center justify-center py-10 text-center">
                <Icon name="library" className="h-7 w-7 text-slate-300" />
                <p className="mt-2 max-w-md text-sm leading-6 text-slate-400">
                  {t('libraryChatHint')}
                </p>
              </div>
            )}

            {turns.map((tn, i) => (
              <div key={i} className="space-y-2.5">
                <div className="flex justify-end">
                  <div className="animate-from-right max-w-[80%] rounded-2xl rounded-tr-md bg-blue-600 px-4 py-2.5 text-[15px] leading-6 text-white">
                    {tn.q}
                  </div>
                </div>
                {tn.warning ? (
                  <div className="rounded-md border border-amber-200 bg-amber-50 p-2.5 text-sm text-amber-900">
                    {tn.warning}
                  </div>
                ) : (
                  <div className="animate-from-left whitespace-pre-wrap rounded-2xl rounded-tl-md bg-slate-50 px-4 py-3.5 text-[15px] leading-7 text-slate-800">
                    {tn.a}
                  </div>
                )}
              </div>
            ))}

            {busy && (
              <div className="flex">
                <div className="animate-from-left rounded-2xl rounded-tl-md bg-slate-50 px-5 py-4 text-slate-400">
                  <TypingDots />
                </div>
              </div>
            )}
            <div ref={endRef} />
          </div>

          <div className="border-t border-slate-100 p-4">
            <ChatComposer
              onSend={ask}
              busy={busy}
              placeholder={t('libraryChatPlaceholder')}
            />
          </div>
        </div>
      </div>
    </section>
  )
}
