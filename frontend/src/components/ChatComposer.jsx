import React, { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Icon from './Icon'

// The message box for both chats. A research follow-up is often a couple of
// sentences, so this is a textarea that grows with the text rather than a
// single-line input: Enter sends, Shift+Enter breaks the line.
export default function ChatComposer({ onSend, busy, placeholder }) {
  const { t } = useTranslation()
  const [text, setText] = useState('')
  const ref = useRef(null)

  // Grow to fit the content, up to a ceiling. While empty we leave the height
  // to CSS (rows=2) rather than measuring: a measurement taken before layout
  // settles reports the full available height and pins the box open.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    if (text) el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }, [text])

  const send = () => {
    const msg = text.trim()
    if (!msg || busy) return
    setText('')
    onSend(msg)
  }

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      send()
    }
  }

  return (
    <div className="rounded-xl border border-slate-300 bg-white shadow-sm transition-colors focus-within:border-blue-500 focus-within:ring-1 focus-within:ring-blue-500">
      <textarea
        ref={ref}
        rows={2}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        disabled={busy}
        placeholder={placeholder}
        className="block w-full resize-none rounded-t-xl border-0 bg-transparent px-4 py-3 text-[15px] leading-6 text-slate-900 placeholder:text-slate-400 focus:outline-none disabled:opacity-60"
      />
      <div className="flex items-center justify-between gap-3 border-t border-slate-100 px-3 py-2">
        <span className="text-xs text-slate-400">{t('composerHint')}</span>
        <button
          type="button"
          onClick={send}
          disabled={busy || !text.trim()}
          className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-40"
        >
          {busy ? (
            <>
              <Icon name="refresh" className="animate-spin-slow" />
              {t('thinking')}
            </>
          ) : (
            <>
              {t('ask')}
              <Icon name="send" />
            </>
          )}
        </button>
      </div>
    </div>
  )
}
