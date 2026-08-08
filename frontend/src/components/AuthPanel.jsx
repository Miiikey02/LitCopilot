import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { supabase } from '../lib/supabase'

// Sign-in / sign-up form. Credentials go straight to Supabase — this app never
// stores or forwards the password anywhere else.
export default function AuthPanel({ onDone }) {
  const { t } = useTranslation()
  const [mode, setMode] = useState('signin') // 'signin' | 'signup'
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const submit = async (e) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const fn = mode === 'signup' ? 'signUp' : 'signInWithPassword'
      const { data, error: err } = await supabase.auth[fn]({ email, password })
      if (err) {
        setError(err.message)
      } else if (mode === 'signup' && !data.session) {
        // Project still has email confirmation switched on.
        setNotice(t('authCheckEmail'))
      } else {
        onDone?.()
      }
    } catch (err) {
      setError(String(err.message || err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto mt-10 max-w-sm rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
      <h2 className="text-lg font-semibold text-slate-900">
        {mode === 'signup' ? t('signUp') : t('signIn')}
      </h2>
      <p className="mt-1 text-sm text-slate-500">{t('authIntro')}</p>

      <form onSubmit={submit} className="mt-4 space-y-3">
        <input
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder={t('email')}
          className="w-full rounded-md border border-slate-300 px-3 py-2 text-slate-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
        <input
          type="password"
          required
          minLength={6}
          autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={t('password')}
          className="w-full rounded-md border border-slate-300 px-3 py-2 text-slate-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />

        {error && (
          <div className="rounded-md border border-red-200 bg-red-50 p-2 text-sm text-red-700">
            {error}
          </div>
        )}
        {notice && (
          <div className="rounded-md border border-amber-200 bg-amber-50 p-2 text-sm text-amber-900">
            {notice}
          </div>
        )}

        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-md bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {busy ? '…' : mode === 'signup' ? t('signUp') : t('signIn')}
        </button>
      </form>

      <button
        onClick={() => {
          setMode(mode === 'signup' ? 'signin' : 'signup')
          setError('')
          setNotice('')
        }}
        className="mt-3 w-full text-sm text-blue-600 hover:underline"
      >
        {mode === 'signup' ? t('haveAccount') : t('needAccount')}
      </button>
    </div>
  )
}
