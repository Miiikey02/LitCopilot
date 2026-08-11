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
import AuthPanel from './components/AuthPanel'
import Icon from './components/Icon'
import SearchProgress from './components/SearchProgress'
import HeroEmpty from './components/HeroEmpty'
import SegmentedControl from './components/SegmentedControl'
import PaperView from './components/PaperView'
import DeepResearchView from './components/DeepResearchView'
import { supabase, authEnabled } from './lib/supabase'
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
  const [conversationId, setConversationId] = useState(null)
  const [deepMode, setDeepMode] = useState(false)
  const [deep, setDeep] = useState(null) // the deep-research brief, when run
  const [readingPaper, setReadingPaper] = useState(null) // identifier under 精读
  // null while we're still restoring a persisted session on first paint.
  const [session, setSession] = useState(authEnabled ? null : 'disabled')
  const [teams, setTeams] = useState([])
  // Which workspace a "Save" on a search result goes to: '' = personal.
  const [saveTeam, setSaveTeam] = useState('')

  useEffect(() => {
    if (!authEnabled) return
    supabase.auth.getSession().then(({ data }) => setSession(data.session ?? false))
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) =>
      setSession(s ?? false)
    )
    return () => sub.subscription.unsubscribe()
  }, [])

  const signedIn = session === 'disabled' || Boolean(session)

  useEffect(() => {
    if (!signedIn) {
      setTeams([])
      return
    }
    api.listTeams().then(setTeams).catch(() => setTeams([]))
  }, [signedIn])

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
    // History is per-account; signed-out visitors simply have none.
    if (!signedIn) {
      setHistory([])
      return
    }
    try {
      setHistory(await api.listHistory())
    } catch {
      /* history is non-critical */
    }
  }, [signedIn])

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
      setConversationId(null)
      setDeep(null)
      try {
        if (overrides.deep ?? deepMode) {
          // Deep research returns a brief plus its notebook; reuse the same
          // sources panel and follow-up session as a quick search.
          const d = await api.deepResearch(text, lang, includePreprints)
          setDeep(d)
          setResult({
            original_query: d.original_query,
            detected_lang: d.detected_lang,
            english_query: d.sub_questions.map((x) => x.search).join(' ; '),
            answer: d.answer,
            sources: d.sources,
            session_id: d.session_id,
            warning: d.warning,
          })
          loadHistory()
          return
        }
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
    [loading, loadHistory, limit, includePreprints, sortBy, deepMode, t, i18n]
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
        const resp = await api.chat(result.session_id, message, lang, conversationId)
        if (resp.conversation_id) setConversationId(resp.conversation_id)
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
    [result, chatLoading, conversationId, i18n, t]
  )

  // Reopening a saved deep-dive: the paper corpus is never persisted (it holds
  // abstracts), so re-run the conversation's seed query to rebuild it, then
  // restore the transcript and keep talking in the same thread.
  const onOpenConversation = useCallback(
    async (id) => {
      if (chatLoading || loading) return
      try {
        const c = await api.getConversation(id)
        const restored = []
        for (let i = 0; i < c.messages.length; i += 2) {
          restored.push({
            question: c.messages[i]?.content || '',
            answer: c.messages[i + 1]?.content || '',
          })
        }
        if (c.seed_query) {
          setQuery(c.seed_query)
          await runSearch(c.seed_query)
        }
        setChatTurns(restored)
        setConversationId(c.id)
      } catch {
        /* ignore */
      }
    },
    [chatLoading, loading, runSearch]
  )

  const onNewConversation = useCallback(() => {
    setChatTurns([])
    setConversationId(null)
  }, [])

  // Saving needs an account. Send signed-out users to the sign-in screen rather
  // than letting the click fail silently with a 401.
  const onSavePaper = useCallback(
    async (paper) => {
      if (authEnabled && session === false) {
        setTab('library')
        throw new Error('sign in required')
      }
      return api.saveLibrary(paper, saveTeam ? Number(saveTeam) : null)
    },
    [session, saveTeam]
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
            <SegmentedControl
              value={tab}
              onChange={setTab}
              options={[
                { value: 'search', label: t('tabSearch'), icon: 'search' },
                { value: 'library', label: t('tabLibrary'), icon: 'library' },
              ]}
            />
          </div>
          <div className="flex items-center gap-3">
            {authEnabled && session && (
              <>
                <span
                  className="hidden max-w-[12rem] truncate text-sm text-slate-500 sm:inline"
                  title={session.user?.email}
                >
                  {session.user?.email}
                </span>
                <button
                  onClick={() => supabase.auth.signOut()}
                  className="text-sm text-slate-500 hover:text-slate-800"
                >
                  {t('signOut')}
                </button>
              </>
            )}
            {/* Signed out, accounts exist: make signing in visible from any tab,
                otherwise the only way in is discovering the library tab. */}
            {authEnabled && session === false && (
              <button
                onClick={() => setTab('library')}
                className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
              >
                {t('signIn')} / {t('signUp')}
              </button>
            )}
            <button
              onClick={toggleLang}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              {i18n.language.startsWith('zh') ? t('toggleToEn') : t('toggleToZh')}
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-6">
        {/* The library is per-account, so it needs a signed-in user. Search
            itself stays open so people can try Gaze before registering. */}
        {tab === 'library' &&
          (signedIn ? <LibraryTab /> : <AuthPanel onDone={() => setTab('library')} />)}

        {tab === 'search' && (
        <>
        <form onSubmit={onSubmit} className="no-print mb-6">
          <div className="flex gap-2">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('searchPlaceholder')}
              className="flex-1 rounded-xl border border-slate-300 px-5 py-3.5 text-[15px] text-slate-900 shadow-sm transition-shadow focus:border-blue-500 focus:shadow-md focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <button
              type="submit"
              disabled={loading}
              className={`rounded-xl bg-blue-600 px-7 py-3.5 font-medium text-white transition-all hover:bg-blue-700 hover:shadow-md active:scale-[0.98] disabled:opacity-80 ${
                loading ? 'btn-busy' : ''
              }`}
            >
              {loading ? t('searching') : t('searchButton')}
            </button>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-slate-500">
            {/* Quick search answers from abstracts; deep research plans
                sub-questions and reads open-access full text. */}
            <SegmentedControl
              value={deepMode}
              onChange={setDeepMode}
              options={[
                { value: false, label: t('quickMode'), icon: 'search' },
                { value: true, label: t('deepMode'), icon: 'sparkles' },
              ]}
            />
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
            {teams.length > 0 && (
              <label className="ml-2 inline-flex items-center gap-1.5">
                {t('saveTo')}
                <select
                  value={saveTeam}
                  onChange={(e) => setSaveTeam(e.target.value)}
                  className="rounded-md border border-slate-300 bg-white px-2 py-1 text-slate-700 focus:border-blue-500 focus:outline-none"
                >
                  <option value=""><Icon name="user" className="mr-1" />{t('personalLibrary')}</option>
                  {teams.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
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

        {deepMode && !result && !loading && (
          <p className="animate-expand mb-4 flex items-start gap-1.5 rounded-lg bg-blue-50/70 px-3 py-2 text-xs leading-5 text-blue-800">
            <Icon name="sparkles" className="mt-0.5 shrink-0" />
            {t('deepModeHint')}
          </p>
        )}

        {loading && <SearchProgress deep={deepMode} />}

        {error && (
          <div className="mb-6 rounded-lg border border-red-200 bg-red-50 p-4 text-red-800">
            {error}
          </div>
        )}

        {!result && !loading && !error && (
          <div className="space-y-4">
            <HeroEmpty
              onPick={(q) => {
                setQuery(q)
                setDeepMode(false)
                runSearch(q, { deep: false })
              }}
              onDeepPick={(q) => {
                setQuery(q)
                setDeepMode(true)
                runSearch(q, { deep: true })
              }}
            />
            <div className="rounded-lg border border-slate-200 bg-white p-5">
              <HistoryList
                history={history}
                onPick={onPickHistory}
                onClear={onClearHistory}
              />
            </div>
          </div>
        )}

        {/* Deep research: the brief, disagreements, gaps and the notebook —
            shown above the usual sources panel. */}
        {readingPaper && (
          <div className="mb-6">
            <PaperView
              identifier={readingPaper}
              onClose={() => setReadingPaper(null)}
            />
          </div>
        )}

        {deep && !loading && (
          <div className="mb-6">
            <DeepResearchView
              result={deep}
              citationKeys={citationKeys}
              onCite={onCite}
            />
          </div>
        )}

        {result && !loading && (
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
                      {trialsLoading ? t('findingTrials') : `${t('findTrials')}`}
                    </button>
                    <button
                      onClick={() => exportMarkdown(result)}
                      className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
                    >
                      <Icon name="download" className="mr-1" />{t('exportMd')}
                    </button>
                    <button
                      onClick={exportPdf}
                      className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
                    >
                      <Icon name="printer" className="mr-1" />{t('exportPdf')}
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
                      <>{wideSources ? <Icon name="columns" className="mr-1" /> : <Icon name="grid" className="mr-1" />}{wideSources ? t('viewSplit') : t('viewWide')}</>
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
                      onSave={onSavePaper}
                      onRead={setReadingPaper}
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

        {/* Deep-dive sits full width below the two panels: a chat squeezed into
            the narrow answer column left no room for the thread or composer. */}
        {result && !loading && result.answer && result.session_id && (
          <ResearchChat
            turns={chatTurns}
            onAsk={onAsk}
            loading={chatLoading}
            citationKeys={citationKeys}
            onCite={onCite}
            conversationId={conversationId}
            onOpenConversation={onOpenConversation}
            onNewConversation={onNewConversation}
          />
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
