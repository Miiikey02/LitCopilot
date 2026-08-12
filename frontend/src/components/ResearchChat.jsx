import React, { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import * as api from '../lib/api'
import AnswerText from './AnswerText'
import ChatComposer from './ChatComposer'
import Icon from './Icon'
import TypingDots from './TypingDots'

// Conversational "deep-dive" on the current search. Laid out as a real chat
// surface — saved threads on the left, the conversation and composer on the
// right — because follow-up questions are a main way people use the agent, not
// an afterthought squeezed under the answer.
export default function ResearchChat({
  turns,
  onAsk,
  loading,
  citationKeys,
  onCite,
  conversationId,
  onOpenConversation,
  onNewConversation,
}) {
  const { t } = useTranslation()
  const endRef = useRef(null)


  useEffect(() => {
  }, [turns.length])

  // Keep the newest exchange in view as the thread grows.
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [turns.length, loading])

  return (
    <section className="no-print mt-6 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <header className="flex flex-wrap items-center gap-x-2 border-b border-slate-100 px-5 py-3.5">
        <Icon name="chat" className="text-blue-600" />
        <h2 className="text-base font-semibold text-slate-900">{t('deepDiveTitle')}</h2>
        <span className="hidden text-xs text-slate-400 sm:inline">
          · {t('followupHint')}
        </span>
      </header>

      <div>
        <div className="flex min-h-[22rem] flex-col">
          <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4 lg:max-h-[32rem]">
            {turns.length === 0 && !loading && (
              <div className="flex h-full flex-col items-center justify-center py-12 text-center">
                <Icon name="sparkles" className="h-7 w-7 text-slate-300" />
                <p className="mt-2 max-w-sm text-sm leading-6 text-slate-400">
                  {t('deepDiveEmpty')}
                </p>
              </div>
            )}

            {turns.map((turn, i) => (
              <div key={i} className="space-y-2.5">
                <div className="flex justify-end">
                  <div className="animate-from-right max-w-[80%] rounded-2xl rounded-tr-md bg-blue-600 px-4 py-2.5 text-[15px] leading-6 text-white">
                    {turn.question}
                  </div>
                </div>
                <div className="animate-from-left rounded-2xl rounded-tl-md bg-slate-50 px-4 py-3.5">
                  {turn.searched && (
                    <div className="mb-2 inline-flex items-center gap-1.5 rounded-full bg-teal-50 px-2.5 py-1 text-xs text-teal-700">
                      <Icon name="search" />
                      {t('agentSearched', { query: turn.searchQuery })}
                    </div>
                  )}
                  {turn.warning ? (
                    <div className="rounded-md border border-amber-200 bg-amber-50 p-2.5 text-sm text-amber-900">
                      {turn.warning}
                    </div>
                  ) : (
                    <AnswerText
                      text={turn.answer}
                      citationKeys={citationKeys}
                      onCite={onCite}
                    />
                  )}
                </div>
              </div>
            ))}

            {loading && (
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
              onSend={onAsk}
              busy={loading}
              placeholder={t('followupPlaceholder')}
            />
          </div>
        </div>
      </div>
    </section>
  )
}
