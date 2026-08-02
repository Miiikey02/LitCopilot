import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import AnswerText from './AnswerText'

// Conversational "deep-dive" thread shown under the main answer. Each turn shows
// the researcher's follow-up and the agent's citation-strict reply; when the
// agent pulled in new literature, a chip shows the query it ran.
export default function ResearchChat({
  turns,
  onAsk,
  loading,
  citationKeys,
  onCite,
}) {
  const { t } = useTranslation()
  const [text, setText] = useState('')

  const submit = (e) => {
    e.preventDefault()
    const msg = text.trim()
    if (!msg || loading) return
    setText('')
    onAsk(msg)
  }

  return (
    <div className="mt-6 rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
      <h2 className="text-lg font-semibold text-slate-900">{t('deepDiveTitle')}</h2>
      <p className="mt-1 text-xs text-slate-400">{t('followupHint')}</p>

      {turns.length > 0 && (
        <div className="mt-4 space-y-5">
          {turns.map((turn, i) => (
            <div key={i} className="space-y-2">
              {/* Researcher's follow-up */}
              <div className="flex justify-end">
                <div className="max-w-[85%] rounded-2xl rounded-tr-sm bg-blue-600 px-4 py-2 text-sm text-white">
                  {turn.question}
                </div>
              </div>
              {/* Agent reply */}
              <div className="rounded-2xl rounded-tl-sm bg-slate-50 px-4 py-3">
                {turn.searched && (
                  <div className="mb-2 inline-flex items-center gap-1 rounded-full bg-teal-50 px-2 py-0.5 text-xs text-teal-700">
                    🔍 {t('agentSearched', { query: turn.searchQuery })}
                  </div>
                )}
                {turn.warning ? (
                  <div className="rounded-md border border-amber-200 bg-amber-50 p-2 text-sm text-amber-900">
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
        </div>
      )}

      <form onSubmit={submit} className="mt-4 flex gap-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={t('followupPlaceholder')}
          disabled={loading}
          className="flex-1 rounded-lg border border-slate-300 px-4 py-2.5 text-slate-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:bg-slate-50"
        />
        <button
          type="submit"
          disabled={loading || !text.trim()}
          className="rounded-lg bg-blue-600 px-5 py-2.5 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {loading ? t('thinking') : t('ask')}
        </button>
      </form>
    </div>
  )
}
