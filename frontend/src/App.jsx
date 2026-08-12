import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import * as api from './lib/api'
import AnswerText from './components/AnswerText'
import SourceCard from './components/SourceCard'
import LibraryTab from './components/LibraryTab'
import TrialsList from './components/TrialsList'
import ResearchChat from './components/ResearchChat'
import BulkExport from './components/BulkExport'
import AuthPanel from './components/AuthPanel'
import Icon from './components/Icon'
import SearchProgress from './components/SearchProgress'
import HeroEmpty from './components/HeroEmpty'
import Sidebar from './components/Sidebar'
import Updates from './components/Updates'
import FeedbackPanel from './components/FeedbackPanel'
import SegmentedControl from './components/SegmentedControl'
import SourcePicker, { ALL_SOURCES } from './components/SourcePicker'
import DeepResearchView from './components/DeepResearchView'
import LookupResult from './components/LookupResult'
import { supabase, authEnabled } from './lib/supabase'
import { exportMarkdown, exportPdf } from './lib/exportResult'

// Layout choice is a workspace preference, so it outlives a single search.
const VIEW_KEY = 'gaze.sourcesView'
const DBS_KEY = 'gaze.databases'
const RAIL_KEY = 'gaze.sidebarCollapsed'

export default function App() {
  const { t, i18n } = useTranslation()
  const [tab, setTab] = useState('search') // 'search' | 'library' | 'updates'
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const [railCollapsed, setRailCollapsed] = useState(
    () => localStorage.getItem(RAIL_KEY) === '1'
  )
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState(15) // how many papers to retrieve per search
  // Deep research reads far more than a quick search, so it gets its own
  // ceiling and its own breadth-per-sub-question.
  const [deepLimit, setDeepLimit] = useState(25)
  const [perQuestion, setPerQuestion] = useState(8)
  const [databases, setDatabases] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(DBS_KEY) || 'null')
      const kept = Array.isArray(saved) ? saved.filter((k) => ALL_SOURCES.includes(k)) : []
      return kept.length ? kept : ALL_SOURCES
    } catch {
      return ALL_SOURCES
    }
  })
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
  // The question the open thread belongs to. Re-running that same question —
  // in another mode, against other databases, however it is triggered —
  // updates the thread instead of filing a second entry for one piece of work.
  const [threadQuery, setThreadQuery] = useState('')
  // 'quick' answers from abstracts, 'deep' plans sub-questions and reads full
  // text, 'lookup' finds one specific paper and opens it for close reading.
  const [mode, setMode] = useState('quick')
  const deepMode = mode === 'deep'
  const lookupMode = mode === 'lookup'
  const [lookup, setLookup] = useState(null)
  const [lookupSaved, setLookupSaved] = useState(false)
  const [deep, setDeep] = useState(null) // the deep-research brief, when run
  // null while we're still restoring a persisted session on first paint.
  const [session, setSession] = useState(authEnabled ? null : 'disabled')
  const [teams, setTeams] = useState([])
  // Saving asks where to put the paper, so the destinations have to be known
  // before the button is pressed.
  const [saveFolders, setSaveFolders] = useState([])
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

  useEffect(() => {
    if (!signedIn) return setSaveFolders([])
    api
      .listFolders(saveTeam ? Number(saveTeam) : null)
      .then((fs) => setSaveFolders(fs.filter((f) => f.id != null)))
      .catch(() => setSaveFolders([]))
  }, [signedIn, saveTeam])

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
    // The rail lists saved threads rather than bare queries: a thread can be
    // reopened with the answer it produced, a query can only be run again.
    if (!signedIn) {
      setHistory([])
      return
    }
    try {
      setHistory(await api.listConversations('search'))
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
      // Passed explicitly rather than read from state: changing the databases
      // re-runs immediately, before React has committed the new value.
      const dbs = overrides.sources || databases
      // A re-run of the question already on screen reuses its thread; a new
      // question files its own, or the rail would overwrite earlier work with
      // an unrelated search. This is decided by the text, not by which control
      // was pressed, so switching mode and pressing search behaves the same as
      // switching mode alone used to.
      const keepThread =
        conversationId && text === threadQuery ? conversationId : null
      const includePreprints = dbs.includes('biorxiv')
      setLoading(true)
      setError('')
      setLookup(null)
      setLookupSaved(false)
      setTrials(null) // clear trials from any previous search
      setChatTurns([]) // start a fresh research thread for the new search
      setConversationId(null)
      setDeep(null)
      try {
        if (overrides.lookup ?? lookupMode) {
          // One specific paper: confirm it is the right one, then the reader
          // opens on it. Resolving here also warms the cache the reader uses.
          setResult(null)
          setLookup({ ...(await api.paperResolve(text, lang)), identifier: text })
          return
        }
        if (overrides.deep ?? deepMode) {
          // Deep research returns a brief plus its notebook; reuse the same
          // sources panel and follow-up session as a quick search.
          const d = await api.deepResearch(text, lang, includePreprints, dbs, keepThread, deepLimit, perQuestion)
          setDeep(d)
          if (d.conversation_id) setConversationId(d.conversation_id)
          setThreadQuery(text)
          setThreadQuery(text)
          // The brief is long and the source list is the reference shelf beside
          // it; a narrow column would make both worse.
          setWideSources(true)
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
        const data = await api.search(text, lang, limit, includePreprints, sort, dbs, keepThread)
        setResult(data)
        if (data.conversation_id) setConversationId(data.conversation_id)
        setThreadQuery(text)
        setThreadQuery(text)
        loadHistory()
      } catch (err) {
        // "Not found" is an answer, not an outage. Reporting it as a dead
        // backend sends the reader off to check a service that is running fine.
        setError(err?.status === 404 ? t('lookupNotFound') : t('errorNetwork'))
        setResult(null)
      } finally {
        setLoading(false)
      }
    },
    [loading, loadHistory, limit, deepLimit, perQuestion, databases, sortBy, deepMode, lookupMode, conversationId, threadQuery, t, i18n]
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
    async (message, forceSearch = false) => {
      if (!result?.session_id || chatLoading) return
      const lang = i18n.language.startsWith('zh') ? 'zh' : 'en'
      setChatLoading(true)
      try {
        const resp = await api.chat(result.session_id, message, lang, conversationId, forceSearch)
        if (resp.conversation_id) setConversationId(resp.conversation_id)
        setChatTurns((prev) => [
          ...prev,
          {
            question: message,
            answer: resp.answer,
            searched: resp.searched,
            searchQuery: resp.search_query,
            suggestSearch: resp.suggest_search || '',
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
    // Detach from the thread too, so the next search files its own rather than
    // overwriting the one just left behind.
    setThreadQuery('')
  }, [])

  // Saving needs an account. Send signed-out users to the sign-in screen rather
  // than letting the click fail silently with a 401.
  const onSavePaper = useCallback(
    async (paper, folderId = null) => {
      if (authEnabled && session === false) {
        setTab('library')
        throw new Error('sign in required')
      }
      return api.saveLibrary(paper, saveTeam ? Number(saveTeam) : null, folderId)
    },
    [session, saveTeam]
  )

  const onSubmit = (e) => {
    e.preventDefault()
    runSearch(query)
  }

  // Reopening is not re-running: the stored answer, papers and thread come
  // back, and no second history entry is filed for the same piece of work.
  const onOpenThread = async (conv) => {
    if (loading) return
    setLoading(true)
    setError('')
    setDeep(null)
    setLookup(null)
    setTrials(null)
    try {
      const r = await api.resumeConversation(conv.id)
      const st = r.state || {}
      setQuery(r.seed_query || r.title || '')
      setConversationId(r.id)
      setThreadQuery(r.seed_query || '')
      // Put the controls back the way they were, so what is on screen matches
      // what the toolbar claims produced it.
      setMode(st.mode === 'deep' ? 'deep' : 'quick')
      if (st.limit) setLimit(st.limit)
      if (st.sort) setSortBy(st.sort)
      if (Array.isArray(st.databases) && st.databases.length) setDatabases(st.databases)
      setResult({
        original_query: r.seed_query,
        detected_lang: st.lang || (i18n.language.startsWith('zh') ? 'zh' : 'en'),
        english_query: st.english_query || '',
        answer: r.answer,
        sources: r.sources,
        session_id: r.session_id,
        warning: st.warning || null,
      })
      // A deep brief is its notebook as much as its prose; restoring only the
      // answer would quietly downgrade it to a quick search.
      if (st.mode === 'deep') {
        setDeep({
          original_query: r.seed_query,
          detected_lang: st.lang || 'zh',
          answer: r.answer,
          contradictions: st.contradictions || [],
          gaps: st.gaps || [],
          sources: r.sources,
          sub_questions: st.sub_questions || [],
          full_text_read: st.full_text_read || 0,
          session_id: r.session_id,
          warning: st.warning || null,
        })
      }
      // Everything after the opening exchange is the follow-up thread.
      const rest = (r.messages || []).slice(2)
      const turns = []
      for (const m of rest) {
        if (m.role === 'user') turns.push({ question: m.content, answer: '' })
        else if (turns.length) turns[turns.length - 1].answer = m.content
      }
      setChatTurns(turns)
      setTab('search')
    } catch {
      setError(t('errorNetwork'))
    } finally {
      setLoading(false)
    }
  }

  // Removing one thread, rather than the whole rail.
  const onDeleteThread = async (conv) => {
    try {
      await api.deleteConversation(conv.id)
    } catch {
      /* it may already be gone; the reload below settles it either way */
    }
    // Deleting the thread you are reading should clear the screen with it,
    // otherwise the results stay up with nothing behind them.
    if (conv.id === conversationId) onNewSearch()
    loadHistory()
  }

  const onClearHistory = async () => {
    // The rail lists threads now, so clearing has to remove those.
    try {
      await Promise.all((history || []).map((c) => api.deleteConversation(c.id)))
    } catch {
      /* fall through to the history clear below */
    }
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

  // "New search" clears the whole working state, so the next question is not
  // read against the last one's answer, sources or thread.
  const onNewSearch = () => {
    setTab('search')
    setQuery('')
    setResult(null)
    setDeep(null)
    setLookup(null)
    setLookupSaved(false)
    setTrials(null)
    setChatTurns([])
    setConversationId(null)
    setThreadQuery('')
    setError('')
  }

  return (
    <div className="flex h-screen overflow-hidden bg-slate-50">
      {feedbackOpen && (
        <FeedbackPanel
          // Where they were when something bothered them, so a report can be
          // reproduced instead of guessed at.
          context={`${tab}/${mode}/${i18n.language}`}
          onClose={() => setFeedbackOpen(false)}
        />
      )}
      <Sidebar
        collapsed={railCollapsed}
        onToggle={() => {
          const next = !railCollapsed
          setRailCollapsed(next)
          localStorage.setItem(RAIL_KEY, next ? '1' : '0')
        }}
        tab={tab}
        onTab={setTab}
        history={history}
        onOpenThread={onOpenThread}
        onDeleteThread={onDeleteThread}
        onClearHistory={onClearHistory}
        onNewSearch={onNewSearch}
        session={session}
        authEnabled={authEnabled}
        onSignIn={() => setTab('library')}
        onSignOut={() => supabase.auth.signOut()}
        onToggleLang={toggleLang}
        onFeedback={() => setFeedbackOpen(true)}
      />

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
      <main className="w-full flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto max-w-5xl">
        {/* The library is per-account, so it needs a signed-in user. Search
            itself stays open so people can try Gaze before registering. */}
        {tab === 'updates' && <Updates />}

        {tab === 'library' &&
          (signedIn ? <LibraryTab /> : <AuthPanel onDone={() => setTab('library')} />)}

        {tab === 'search' && (
        <>
        <form onSubmit={onSubmit} className="no-print mb-6">
          <div className="flex gap-2">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={lookupMode ? t('lookupPlaceholder') : t('searchPlaceholder')}
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
              value={mode}
              // Changing mode sets up the next search rather than running one:
              // deep research is slow and has its own settings, and firing it
              // the instant the toggle moves takes that choice away.
              onChange={setMode}
              options={[
                { value: 'quick', label: t('quickMode'), icon: 'search' },
                { value: 'deep', label: t('deepMode'), icon: 'sparkles' },
                { value: 'lookup', label: t('lookupMode'), icon: 'bookOpen' },
              ]}
            />
            {lookupMode && (
              <span className="text-xs text-slate-400">{t('lookupHint')}</span>
            )}
            {deepMode && (
              <>
                <label htmlFor="deep-limit">{t('resultsCount')}</label>
                <select
                  id="deep-limit"
                  value={deepLimit}
                  onChange={(e) => setDeepLimit(Number(e.target.value))}
                  className="rounded-md border border-slate-300 bg-white px-2 py-1 text-slate-700 focus:border-blue-500 focus:outline-none"
                >
                  {[15, 25, 35, 50].map((n) => (
                    <option key={n} value={n}>
                      {t('resultsCountOption', { count: n })}
                    </option>
                  ))}
                </select>
                <label className="ml-2" htmlFor="per-question">
                  {t('perQuestion')}
                </label>
                <select
                  id="per-question"
                  value={perQuestion}
                  onChange={(e) => setPerQuestion(Number(e.target.value))}
                  title={t('perQuestionHint')}
                  className="rounded-md border border-slate-300 bg-white px-2 py-1 text-slate-700 focus:border-blue-500 focus:outline-none"
                >
                  {[5, 8, 12, 15].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </>
            )}
            {!lookupMode && !deepMode && (
              <>
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
            <SourcePicker
              value={databases}
              onChange={(next) => {
                setDatabases(next)
                localStorage.setItem(DBS_KEY, JSON.stringify(next))
                // Same reasoning as the mode toggle: pick your databases, then
                // search.
              }}
            />
          
              </>
            )}
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
          </div>
        </form>

        {lookup && !loading && (
          <div className="mb-6">
            <LookupResult
              result={lookup}
              identifier={lookup.identifier}
              saving={false}
              saved={lookupSaved}
              onSave={
                signedIn
                  ? async () => {
                      try {
                        await api.saveLibrary(lookup.paper, saveTeam || null)
                        setLookupSaved(true)
                      } catch {
                        setError(t('errorNetwork'))
                      }
                    }
                  : null
              }
            />
          </div>
        )}

        {deepMode && !result && !loading && (
          <p className="animate-expand mb-4 flex items-start gap-1.5 rounded-lg bg-blue-50/70 px-3 py-2 text-xs leading-5 text-blue-800">
            <Icon name="sparkles" className="mt-0.5 shrink-0" />
            {t('deepModeHint')}
          </p>
        )}

        {loading && <SearchProgress deep={deepMode} sources={databases} />}

        {error && (
          <div className="mb-6 rounded-lg border border-red-200 bg-red-50 p-4 text-red-800">
            {error}
          </div>
        )}

        {!result && !lookup && !loading && !error && (
          <div className="space-y-4">
            <HeroEmpty
              onPick={(q) => {
                setQuery(q)
                setMode('quick')
                runSearch(q, { deep: false, lookup: false })
              }}
              onDeepPick={(q) => {
                setQuery(q)
                setMode('deep')
                runSearch(q, { deep: true, lookup: false })
              }}
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
              {/* Deep research has already said everything this panel used to
                  say, in 研究简报 above. What is left worth keeping is the
                  actions, so they appear as a plain bar rather than a card
                  wrapped around nothing. */}
              {deep && result.answer && (
                <div className="no-print mb-4 flex flex-wrap gap-2">
                  <button
                    onClick={onFindTrials}
                    disabled={trialsLoading}
                    className="rounded-md bg-teal-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-700 disabled:opacity-50"
                  >
                    {trialsLoading ? t('findingTrials') : t('findTrials')}
                  </button>
                  <button
                    onClick={() => exportMarkdown(result)}
                    className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
                  >
                    <Icon name="download" className="mr-1" />
                    {t('exportMd')}
                  </button>
                  <button
                    onClick={exportPdf}
                    className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
                  >
                    <Icon name="printer" className="mr-1" />
                    {t('exportPdf')}
                  </button>
                </div>
              )}

              {!deep && (
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
                  <div
                    className={`no-print flex flex-wrap gap-2 ${
                      deep ? '' : 'mt-5 border-t border-slate-100 pt-4'
                    }`}
                  >
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
              )}

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
                      folders={saveFolders}
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
        </div>
      </main>
      </div>
    </div>
  )
}
