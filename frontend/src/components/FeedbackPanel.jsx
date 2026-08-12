import React, { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import * as api from '../lib/api'
import Icon from './Icon'

// Somewhere to say what is wrong, or missing, or good.
//
// Open to people who are not signed in, because search is: the reader most
// likely to hit something confusing is the one who has not committed to an
// account yet, and asking them to register first loses exactly that report.
// Nothing is required except the message — an email only if they want a reply.
export default function FeedbackPanel({ context, onClose }) {
  const { t } = useTranslation()
  const [message, setMessage] = useState('')
  const [email, setEmail] = useState('')
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState('')
  const area = useRef(null)

  useEffect(() => {
    area.current?.focus()
    const onKey = (e) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const send = async () => {
    if (!message.trim() || sending) return
    setSending(true)
    setError('')
    try {
      await api.sendFeedback(message, email, context)
      setSent(true)
      setTimeout(onClose, 1600)
    } catch {
      setError(t('feedbackFailed'))
      setSending(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <div className="absolute inset-0 bg-slate-900/25" onClick={onClose} />
      <div className="animate-rise relative w-full max-w-lg rounded-t-2xl border border-slate-200 bg-white shadow-xl sm:rounded-2xl">
        <header className="flex items-start gap-3 border-b border-slate-100 px-5 py-4">
          <div className="min-w-0 flex-1">
            <h3 className="flex items-center gap-1.5 text-sm font-semibold text-slate-900">
              <Icon name="messageSquare" className="text-blue-600" />
              {t('feedbackTitle')}
            </h3>
            <p className="mt-1 text-xs leading-5 text-slate-500">{t('feedbackIntro')}</p>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-slate-400 transition-colors hover:bg-slate-50 hover:text-slate-700"
          >
            <Icon name="x" />
          </button>
        </header>

        {sent ? (
          <div className="px-5 py-10 text-center">
            <Icon name="check" className="mx-auto h-7 w-7 text-green-600" />
            <p className="mt-2 text-sm text-slate-700">{t('feedbackThanks')}</p>
          </div>
        ) : (
          <>
            <div className="px-5 py-4">
              <textarea
                ref={area}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={6}
                placeholder={t('feedbackPlaceholder')}
                className="w-full resize-none rounded-lg border border-slate-300 p-3 text-sm leading-6 text-slate-800 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
              <input
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={t('feedbackEmail')}
                className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-800 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
              {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
            </div>
            <footer className="flex items-center gap-2 border-t border-slate-100 px-5 py-3">
              <button
                onClick={send}
                disabled={!message.trim() || sending}
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
              >
                {sending ? t('feedbackSending') : t('feedbackSend')}
              </button>
              {/* Say what is attached, rather than attaching it quietly. */}
              <span className="ml-auto text-xs text-slate-400">
                {t('feedbackContext', { context })}
              </span>
            </footer>
          </>
        )}
      </div>
    </div>
  )
}
