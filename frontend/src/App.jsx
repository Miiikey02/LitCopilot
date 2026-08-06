import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import * as api from './lib/api'
import AnswerText from './components/AnswerText'
import SourceCard from './components/SourceCard'
import LibraryTab from './components/LibraryTab'
import HistoryList from './components/HistoryList'
import TrialsList from './components/TrialsList'
import ResearchChat from './components/ResearchChat'
import BulkExport from './components/BulkExport'
import { exportMarkdown, exportPdf } from './lib/exportResult'

// Layout choice is a workspace preference, so it outlives a single search.
const VIEW_KEY = 'gaze.sourcesView'

export default function App() {
  const { t, i18n } = useTranslation()
  const [tab, setTab] = useState('search') // 'search' | 'library'
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState(15) // how many papers to retrieve per search
  const [includePreprints, setIncludePreprints] = useState(true) // bioRxiv preprints
  const [sortBy, setSortBy] = useState('relevance') // 'relevance' | 'date'
  const [wideSources, setWideSources] = useState(
    () => localStorage.getItem(VIEW_KEY) === 'wide'
  )
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState(null)
  const [history, setHistory] = useState([])
  const [trials, setTrials] = useState(null)
  const [trialsLoading, setTrialsLoading] = useState(false)
  const [chatTurns, setChatTurns] = useState([]) // follow-up research thread
  const [chatLoading, setChatLoading] = useState(false)

  // Refs to each source card so citation clicks can scroll + flash them.
  const cardRefs = useRef({})

  const citationKeys = useMemo(
    () => (result?.sources || []).map((s) => s.citation_key),
    [result]
  )

  // Sort key: "YYYY-MM-DD" padded from whatever precision the source gave us
  // (falling back to the year), so partial dates still order sensibly.
  const dateKey = (s) => {
    if (s.pub_date) {
      const [y = '', m = '', d = ''] = s.pub_date.split('-')
      return `${y.padStart(4, '0')}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`
    }
    return s.year ? `${String(s.year).padStart(4, '0')}-00-00` : ''
  }

  // The backend already applies the sort at the source query; re-sorting here
  // keeps the displayed list consistent after the research agent appends new
  // papers mid-session. Papers without any date sink to the bottom.
  const sortedSources = useMemo(() => {
    const sources = result?.sources || []
    if (sortBy !== 'date') return sources
    return [...sources].sort((a, b) => {
      const ka = dateKey(a)
      const kb = dateKey(b)
      if (!ka || !kb) return ka ? -1 : kb ? 1 : 0
      return kb.localeCompare(ka)
    })
  }, [result, sortBy])

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
    async (q, overrides = {}) => {
      const text = (q ?? '').trim()
      if (!text || loading) return
      // Response language follows the UI language (toggle drives content too).
      const lang =
        overrides.lang || (i18n.language.startsWith('zh') ? 'zh' : 'en')
      // Sort is applied at the source query, so a change means a new search;
      // the caller passes it explicitly to avoid racing the state update.
      const sort = overrides.sort || sortBy
      setLoading(true)
      setError('')
      setTrials(null) // clear trials from any previous search
      setChatTurns([]) // start a fresh research thread for the new search
      try {
        const data = await api.search(text, lang, limit, includePreprints, sort)
        setResult(data)
        loadHistory()
      } catch (err) {
        setError(t('errorNetwork'))
        setResult(null)
      } finally {
        setLoading(false)
      }
    },
    [loading, loadHistory, limit, includePreprints, sortBy, t, i18n]
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

  const onAsk = useCallback(
    async (message) => {
      if (!result?.session_id || chatLoading) return
      const lang = i18n.language.startsWith('zh') ? 'zh' : 'en'
      setChatLoading(true)
      try {
        const resp = await api.chat(result.session_id, message, lang)
        setChatTurns((prev) => [
          ...prev,
          {
            question: message,
            answer: resp.answer,
            searched: resp.searched,
            searchQuery: resp.search_query,
            warning: resp.warning,
          },
        ])
        // The agent may have grown the corpus — refresh the sources panel.
        setResult((prev) => (prev ? { ...prev, sources: resp.sources } : prev))
      } catch {
        setChatTurns((prev) => [
          ...prev,
          { question: message, answer: '', warning: t('errorNetwork') },
        ])
      } finally {
        setChatLoading(false)
      }
    },
    [result, chatLoading, i18n, t]
  )

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
    const next = i18n.language.startsWith('zh') ? 'en' : 'zh'
    i18n.changeLanguage(next)
    // The answer and per-source localized fields are generated server-side, so
    // switching language re-runs the current search to regenerate them.
    if (result?.original_query)
      runSearch(result.original_query, { lang: next })
  }

  const onSortChange = (next) => {
    setSortBy(next)
    // "By date" means *retrieve* the newest matching papers, not just reorder
    // the top relevance hits — so re-run the search whenever one is showing.
    if (result?.original_query) runSearch(result.original_query, { sort: next })
  }

  const toggleView = () => {
    setWideSources((prev) => {
      localStorage.setItem(VIEW_KEY, prev ? 'split' : 'wide')
      return !prev
    })
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
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-slate-500">
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
            <label className="ml-2" htmlFor="result-sort">
              {t('sortBy')}
            </label>
            <select
              id="result-sort"
              value={sortBy}
              onChange={(e) => onSortChange(e.target.value)}
              title={t('sortHint')}
              className="rounded-md border border-slate-300 bg-white px-2 py-1 text-slate-700 focus:border-blue-500 focus:outline-none"
            >
              <option value="relevance">{t('sortRelevance')}</option>
              <option value="date">{t('sortDate')}</option>
            </select>
            <label className="ml-2 inline-flex cursor-pointer items-center gap-1.5">
              <input
                type="checkbox"
                checked={includePreprints}
                onChange={(e) => setIncludePreprints(e.target.checked)}
                className="h-3.5 w-3.5 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
              />
              {t('includePreprints')}
            </label>
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
          <div
            className={
              wideSources
                ? 'space-y-6'
                : 'grid grid-cols-1 gap-6 lg:grid-cols-5'
            }
          >
            {/* Answer. In split view it is sticky on large screens, so it stays
                in view while a long source list scrolls past instead of leaving
                a column of blank space (and scrolls internally if the answer
                itself is taller than the viewport). */}
            <section
              className={
                wideSources
                  ? ''
                  : 'lg:col-span-3 lg:sticky lg:top-6 lg:self-start lg:max-h-[calc(100vh-5rem)] lg:overflow-y-auto print:static print:max-h-none print:overflow-visible'
              }
            >
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

              {/* Conversational deep-dive: follow-up research agent */}
              {result.answer && result.session_id && (
                <ResearchChat
                  turns={chatTurns}
                  onAsk={onAsk}
                  loading={chatLoading}
                  citationKeys={citationKeys}
                  onCite={onCite}
                />
              )}
            </section>

            {/* Sources: a narrow column beside the answer (split view), or a
                full-width multi-column wall (wide view) so a 25-paper list
                fits in a few screens instead of one very long one. */}
            <aside className={wideSources ? '' : 'lg:col-span-2'}>
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-baseline gap-2">
                  <h2 className="text-lg font-semibold text-slate-900">
                    {t('sourcesTitle')}
                  </h2>
                  <span className="text-sm text-slate-500">
                    {t('sourceCount', { count: result.sources.length })}
                  </span>
                </div>
                {result.sources.length > 0 && (
                  <div className="no-print flex items-center gap-2">
                    <button
                      type="button"
                      onClick={toggleView}
                      title={wideSources ? t('viewSplitHint') : t('viewWideHint')}
                      className="hidden rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 lg:inline-flex"
                    >
                      {wideSources ? `▥ ${t('viewSplit')}` : `▦ ${t('viewWide')}`}
                    </button>
                    <BulkExport
                      papers={sortedSources}
                      queryLabel={result.original_query}
                    />
                  </div>
                )}
              </div>
              {result.sources.length === 0 ? (
                <p className="text-slate-500">{t('noSources')}</p>
              ) : (
                <div
                  className={
                    wideSources
                      ? 'grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3 print:grid-cols-1'
                      : 'space-y-3'
                  }
                >
                  {sortedSources.map((p, i) => (
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
