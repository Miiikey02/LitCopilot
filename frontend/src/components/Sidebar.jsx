import React from 'react'
import { useTranslation } from 'react-i18next'
import Icon from './Icon'

// The persistent left rail: start something new, move between search and the
// library, and pick up an earlier question.
//
// History belongs here rather than under the results, where it sat before: it
// is how you get back to previous work, so it should be reachable while you are
// looking at something else — not only from an empty page.

// The matched term, picked out of its snippet. Plain string splitting rather
// than a regex: a search term is arbitrary text, and "10.1038/s41586" would be
// a broken pattern rather than a search.
function Mark({ text, term }) {
  const needle = (term || '').trim()
  if (!needle) return text
  const at = text.toLowerCase().indexOf(needle.toLowerCase())
  if (at < 0) return text
  return (
    <>
      {text.slice(0, at)}
      <mark className="rounded bg-amber-100 px-0.5 text-slate-700">
        {text.slice(at, at + needle.length)}
      </mark>
      {text.slice(at + needle.length)}
    </>
  )
}

function NavItem({ icon, label, active, onClick, collapsed }) {
  return (
    <button
      onClick={onClick}
      title={collapsed ? label : ''}
      className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${
        active
          ? 'bg-blue-50 font-medium text-blue-700'
          : 'text-slate-600 hover:bg-slate-100'
      } ${collapsed ? 'justify-center px-0' : ''}`}
    >
      <Icon name={icon} className="shrink-0" />
      {!collapsed && <span className="truncate">{label}</span>}
    </button>
  )
}

export default function Sidebar({
  collapsed,
  onToggle,
  tab,
  onTab,
  history,
  historyQuery,
  onHistoryQuery,
  onOpenThread,
  onDeleteThread,
  onClearHistory,
  onNewSearch,
  session,
  authEnabled,
  onSignIn,
  onSignOut,
  onToggleLang,
  onFeedback,
}) {
  const { t, i18n } = useTranslation()

  return (
    <aside
      className={`no-print flex h-full shrink-0 flex-col border-r border-slate-200 bg-white transition-[width] duration-200 ${
        collapsed ? 'w-[60px]' : 'w-64'
      }`}
    >
      <div
        className={`flex items-center gap-2 px-3 py-3 ${
          collapsed ? 'justify-center' : 'justify-between'
        }`}
      >
        {!collapsed && (
          <span className="truncate text-lg font-bold text-slate-900">
            {t('appName')}
          </span>
        )}
        <button
          onClick={onToggle}
          title={t(collapsed ? 'expandSidebar' : 'collapseSidebar')}
          className="rounded-md p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
        >
          <Icon name="columns" />
        </button>
      </div>

      <div className="px-3 pb-2">
        <button
          onClick={onNewSearch}
          title={collapsed ? t('newSearch') : ''}
          className={`flex w-full items-center gap-2 rounded-full border border-slate-200 bg-slate-50 py-2 text-sm font-medium text-slate-700 transition-all hover:border-blue-300 hover:bg-white hover:text-blue-700 hover:shadow-sm ${
            collapsed ? 'justify-center px-0' : 'px-4'
          }`}
        >
          <Icon name="plus" className="shrink-0" />
          {!collapsed && t('newSearch')}
        </button>
      </div>

      <nav className="space-y-1 px-3 pb-2">
        <NavItem
          icon="search"
          label={t('tabSearch')}
          active={tab === 'search'}
          onClick={() => onTab('search')}
          collapsed={collapsed}
        />
        <NavItem
          icon="library"
          label={t('tabLibrary')}
          active={tab === 'library'}
          onClick={() => onTab('library')}
          collapsed={collapsed}
        />
        <NavItem
          icon="clock"
          label={t('tabUpdates')}
          active={tab === 'updates'}
          onClick={() => onTab('updates')}
          collapsed={collapsed}
        />
      </nav>

      {!collapsed && (
        <div className="flex min-h-0 flex-1 flex-col border-t border-slate-100 pt-3">
          <div className="flex items-center justify-between px-4 pb-1">
            <span className="text-xs font-medium uppercase tracking-wide text-slate-400">
              {t('recentSearches')}
            </span>
            {history?.length > 0 && (
              <button
                onClick={onClearHistory}
                className="text-xs text-slate-400 transition-colors hover:text-slate-700"
              >
                {t('clearHistory')}
              </button>
            )}
          </div>
          {/* Searching the rail searches inside the threads, not just their
              titles — what you remember about an old search is usually a paper
              you saw or a phrase in the answer, not the words you typed. */}
          {/* text-xs on the wrapper, not just the input: the icons size
              themselves in em, and inside a plain div they inherit the rail's
              16px — a 17px magnifier beside 12px text, which is what made this
              look like a form field dropped into a sidebar. Inset matches the
              section heading above it. */}
          <div className="relative px-4 pb-2 text-xs">
            <Icon
              name="search"
              className="pointer-events-none absolute left-6 top-1/2 -translate-y-1/2 text-slate-400"
            />
            <input
              value={historyQuery || ''}
              onChange={(e) => onHistoryQuery?.(e.target.value)}
              placeholder={t('historySearchPlaceholder')}
              className="w-full rounded-md border border-slate-200 bg-slate-50 py-1 pl-6 pr-6 text-xs text-slate-700 outline-none transition-colors placeholder:text-slate-400 focus:border-blue-300 focus:bg-white"
            />
            {historyQuery && (
              <button
                onClick={() => onHistoryQuery?.('')}
                title={t('clear')}
                className="absolute right-5 top-1/2 -translate-y-1/2 rounded text-slate-400 transition-colors hover:text-slate-700"
              >
                <Icon name="x" />
              </button>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            {!history?.length && (
              <p className="px-2 py-2 text-xs leading-5 text-slate-400">
                {t(historyQuery ? 'historyNoMatch' : 'historyEmpty')}
              </p>
            )}
            <ul>
              {(history || []).map((h) => (
                <li key={h.id} className="group relative">
                  <button
                    onClick={() => onOpenThread(h)}
                    title={h.seed_query || h.title}
                    className="block w-full rounded-lg py-1.5 pl-2 pr-7 text-left text-sm text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900"
                  >
                    <span className="block truncate">{h.title || h.seed_query}</span>
                    {/* The line that matched, when the match was not the title.
                        Without it a result list of titles gives no reason for
                        any of them being there. */}
                    {h.snippet && (
                      <span className="mt-0.5 block truncate text-xs leading-5 text-slate-400">
                        <Mark text={h.snippet} term={historyQuery} />
                      </span>
                    )}
                  </button>
                  {/* Per-thread delete: clearing everything is a blunt tool
                      when one stray search is what you want gone. */}
                  <button
                    onClick={() => onDeleteThread(h)}
                    title={t('deleteThread')}
                    className="absolute right-1 top-1/2 hidden -translate-y-1/2 rounded p-1 text-slate-400 transition-colors hover:bg-slate-200 hover:text-red-600 group-hover:block"
                  >
                    <Icon name="trash" />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      <div className="mt-auto space-y-1 border-t border-slate-100 p-3">
        {authEnabled && session && (
          <>
            {!collapsed && (
              <p
                className="truncate px-3 pb-1 text-xs text-slate-400"
                title={session.user?.email}
              >
                {session.user?.email}
              </p>
            )}
            <NavItem
              icon="logOut"
              label={t('signOut')}
              onClick={onSignOut}
              collapsed={collapsed}
            />
          </>
        )}
        {authEnabled && session === false && (
          <NavItem
            icon="logIn"
            label={`${t('signIn')} / ${t('signUp')}`}
            onClick={onSignIn}
            collapsed={collapsed}
          />
        )}
        <NavItem
          icon="messageSquare"
          label={t('feedbackNav')}
          onClick={onFeedback}
          collapsed={collapsed}
        />
        <NavItem
          icon="globe"
          label={i18n.language.startsWith('zh') ? t('toggleToEn') : t('toggleToZh')}
          onClick={onToggleLang}
          collapsed={collapsed}
        />
      </div>
    </aside>
  )
}
