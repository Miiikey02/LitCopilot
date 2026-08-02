import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import * as api from './lib/api'
import AnswerText from './components/AnswerText'
import SourceCard from './components/SourceCard'
import LibraryTab from './components/LibraryTab'
import HistoryList from './components/HistoryList'
import TrialsList from './components/TrialsList'
import { exportMarkdown, exportPdf } from './lib/exportResult'

export default function App() {
  const { t, i18n } = useTranslation()
  const [tab, setTab] = useState('search') // 'search' | 'library'
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState(15) // how many papers to retrieve per search
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState(null)
  const [history, setHistory] = useState([])
  const [trials, setTrials] = useState(null)
  const [trialsLoading, setTrialsLoading] = useState(false)

  // Refs to each source card so citation clicks can scroll + flash them.
  const cardRefs = useRef({})

  const citationKeys = useMemo(
    () => (result?.sources || []).map((s) => s.citation_key),
    [result]
  )

  const loadHistory = useCallback(async () => {
    try {
      setHistory(await api.listHistory())
    } catch {
      /* history is non-critical */
    }
  }, [])

  useEffect(() => {
    loadHistory()
  }, [loadHistory])

  const runSearch = useCallback(
    async (q) => {
      const text = (q ?? '').trim()
      if (!text || loading) return
      setLoading(true)
      setError('')
      setTrials(null) // clear trials from any previous search
      try {
        const data = await api.search(text, null, limit)
        setResult(data)
        loadHistory()
      } catch (err) {
        setError(t('errorNetwork'))
        setResult(null)
      } finally {
        setLoading(false)
      }
    },
    [loading, loadHistory, limit, t]
  )

  const onFindTrials = async () => {
    if (!result || trialsLoading) return
    setTrialsLoading(true)
    try {
      const data = await api.findTrials(result.original_query)
      setTrials(data.trials)
    } catch {
      setTrials([])
    } finally {
      setTrialsLoading(false)
    }
  }

  const onSubmit = (e) => {
    e.preventDefault()
    runSearch(query)
  }

  const onPickHistory = (q) => {
    setQuery(q)
    runSearch(q)
  }

  const onClearHistory = async () => {
    await api.clearHistory()
    loadHistory()
  }

  const onCite = (key) => {
    const el = cardRefs.current[key]
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    el.classList.remove('card-flash')
    // Reflow so the animation can retrigger.
    void el.offsetWidth
    el.classList.add('card-flash')
  }

  const toggleLang = () => {
    i18n.changeLanguage(i18n.language.startsWith('zh') ? 'en' : 'zh')
  }

  return (
    <div className="min-h-screen">
      <header className="no-print border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-6">
            <h1 className="text-xl font-bold text-slate-900">
              {t('appName')}
              <span className="ml-2 hidden text-sm font-normal text-slate-500 sm:inline">
                {t('tagline')}
              </span>
            </h1>
            <nav className="flex gap-1">
              {[
                ['search', t('tabSearch')],
                ['library', t('tabLibrary')],
              ].map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setTab(key)}
                  className={`rounded-md px-3 py-1.5 text-sm font-medium ${
                    tab === key
                      ? 'bg-blue-50 text-blue-700'
                      : 'text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  {label}
                </button>
              ))}
            </nav>
          </div>
          <button
            onClick={toggleLang}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            {i18n.language.startsWith('zh') ? t('toggleToEn') : t('toggleToZh')}
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-6">
        {tab === 'library' && <LibraryTab />}

        {tab === 'search' && (
        <>
        <form onSubmit={onSubmit} className="no-print mb-6">
          <div className="flex gap-2">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('searchPlaceholder')}
              className="flex-1 rounded-lg border border-slate-300 px-4 py-3 text-slate-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <button
              type="submit"
              disabled={loading}
              className="rounded-lg bg-blue-600 px-6 py-3 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {loading ? t('searching') : t('searchButton')}
            </button>
          </div>
          <div className="mt-2 flex items-center gap-2 text-sm text-slate-500">
            <label htmlFor="result-limit">{t('resultsCount')}</label>
            <select
              id="result-limit"
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
              className="rounded-md border border-slate-300 bg-white px-2 py-1 text-slate-700 focus:border-blue-500 focus:outline-none"
            >
              {[5, 10, 15, 20, 25].map((n) => (
                <option key={n} value={n}>
                  {t('resultsCountOption', { count: n })}
                </option>
              ))}
            </select>
          </div>
        </form>

        {error && (
          <div className="mb-6 rounded-lg border border-red-200 bg-red-50 p-4 text-red-800">
            {error}
          </div>
        )}

        {!result && !loading && !error && (
          <div className="space-y-4">
            <div className="rounded-lg border border-dashed border-slate-300 bg-white p-10 text-center">
              <h2 className="mb-2 text-lg font-semibold text-slate-800">
                {t('emptyStateTitle')}
              </h2>
              <p className="mx-auto max-w-xl text-slate-500">{t('emptyStateBody')}</p>
            </div>
            <div className="rounded-lg border border-slate-200 bg-white p-5">
              <HistoryList
                history={history}
                onPick={onPickHistory}
                onClear={onClearHistory}
              />
            </div>
          </div>
        )}

        {result && (
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
            {/* Left: synthesized answer */}
            <section className="lg:col-span-3">
              <div className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
                <div className="mb-4 flex items-center justify-between">
                  <h2 className="text-lg font-semibold text-slate-900">
                    {t('answerTitle')}
                  </h2>
                  <span className="text-xs text-slate-400">
                    {t('detectedLang')}:{' '}
                    {result.detected_lang === 'zh' ? t('langZh') : t('langEn')}
                  </span>
                </div>

                {result.warning && (
                  <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                    {result.warning}
                  </div>
                )}

                {result.answer ? (
                  <>
                    <p className="mb-3 text-xs text-slate-400">
                      {t('citationHint')}
                    </p>
                    <AnswerText
                      text={result.answer}
                      citationKeys={citationKeys}
                      onCite={onCite}
                    />
                  </>
                ) : (
                  <p className="text-slate-500">{t('noAnswer')}</p>
                )}

                {result.answer && (
                  <div className="no-print mt-5 flex flex-wrap gap-2 border-t border-slate-100 pt-4">
                    <button
                      onClick={onFindTrials}
                      disabled={trialsLoading}
                      className="rounded-md bg-teal-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-700 disabled:opacity-50"
                    >
                      {trialsLoading ? t('findingTrials') : `🧪 ${t('findTrials')}`}
                    </button>
                    <button
                      onClick={() => exportMarkdown(result)}
                      className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
                    >
                      ⬇ {t('exportMd')}
                    </button>
                    <button
                      onClick={exportPdf}
                      className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
                    >
                      🖨 {t('exportPdf')}
                    </button>
                  </div>
                )}

                <div className="mt-6 border-t border-slate-100 pt-4 text-xs text-slate-400">
                  <div>
                    {t('searchedWith')}:{' '}
                    <code className="text-slate-500">{result.english_query}</code>
                  </div>
                  <div className="mt-2">{t('disclaimer')}</div>
                </div>
              </div>

              {/* Related clinical trials (ClinicalTrials.gov) */}
              {trials !== null && (
                <div className="mt-6 rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
                  <div className="mb-3 flex items-center justify-between">
                    <h2 className="text-lg font-semibold text-slate-900">
                      {t('trialsTitle')}
                    </h2>
                    <span className="text-xs text-slate-400">{t('trialsSource')}</span>
                  </div>
                  <TrialsList trials={trials} />
                </div>
              )}
            </section>

            {/* Right: source list */}
            <aside className="lg:col-span-2">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-lg font-semibold text-slate-900">
                  {t('sourcesTitle')}
                </h2>
                <span className="text-sm text-slate-500">
                  {t('sourceCount', { count: result.sources.length })}
                </span>
              </div>
              {result.sources.length === 0 ? (
                <p className="text-slate-500">{t('noSources')}</p>
              ) : (
                <div className="space-y-3">
                  {result.sources.map((p, i) => (
                    <SourceCard
                      key={`${p.source}-${p.source_id}`}
                      paper={p}
                      index={i}
                      onSave={api.saveLibrary}
                      ref={(el) => {
                        if (el) cardRefs.current[p.citation_key] = el
                      }}
                    />
                  ))}
                </div>
              )}
            </aside>
          </div>
        )}
        </>
        )}

        <footer className="mt-10 border-t border-slate-200 pt-4 text-center text-xs text-slate-400">
          {t('poweredBy')}
        </footer>
      </main>
    </div>
  )
}
