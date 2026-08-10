import React from 'react'
import { useTranslation } from 'react-i18next'
import * as api from '../lib/api'
import Icon from './Icon'

// Past conversations with the agent: click one to reopen it and keep talking.
export default function ConversationList({
  conversations,
  activeId,
  onOpen,
  onNew,
  onChanged,
}) {
  const { t, i18n } = useTranslation()

  const when = (iso) => {
    const d = new Date(iso)
    const mins = Math.round((Date.now() - d.getTime()) / 60000)
    if (mins < 1) return t('justNow')
    if (mins < 60) return t('minutesAgo', { n: mins })
    if (mins < 60 * 24) return t('hoursAgo', { n: Math.round(mins / 60) })
    return d.toLocaleDateString(i18n.language.startsWith('zh') ? 'zh-CN' : 'en-US')
  }

  const remove = async (e, id) => {
    e.stopPropagation()
    if (!window.confirm(t('deleteConversationConfirm'))) return
    await api.deleteConversation(id)
    if (String(activeId) === String(id)) onNew()
    onChanged()
  }

  return (
    <aside className="flex h-full flex-col rounded-xl border border-slate-200 bg-slate-50/70">
      <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2.5">
        <h4 className="text-sm font-semibold text-slate-700">
          {t('conversationHistory')}
        </h4>
        <button
          onClick={onNew}
          title={t('newConversation')}
          className="inline-flex items-center gap-1 rounded-md bg-white px-2 py-1 text-xs font-medium text-blue-700 shadow-sm ring-1 ring-slate-200 transition-colors hover:bg-blue-50"
        >
          <Icon name="plus" />
          {t('newConversation')}
        </button>
      </div>

      {conversations.length === 0 ? (
        <p className="px-3 py-6 text-center text-xs leading-5 text-slate-400">
          {t('noConversations')}
        </p>
      ) : (
        <ul className="flex-1 space-y-1 overflow-y-auto p-2">
          {conversations.map((c) => {
            const active = String(activeId) === String(c.id)
            return (
              <li key={c.id}>
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => onOpen(c.id)}
                  onKeyDown={(e) => e.key === 'Enter' && onOpen(c.id)}
                  className={`group flex cursor-pointer items-start gap-2 rounded-lg px-2.5 py-2 transition-colors ${
                    active
                      ? 'bg-white shadow-sm ring-1 ring-blue-200'
                      : 'hover:bg-white/80'
                  }`}
                >
                  <Icon
                    name="messageSquare"
                    className={`mt-0.5 ${active ? 'text-blue-600' : 'text-slate-300'}`}
                  />
                  <div className="min-w-0 flex-1">
                    <div
                      className={`line-clamp-2 text-[13px] leading-5 ${
                        active ? 'font-medium text-slate-900' : 'text-slate-700'
                      }`}
                    >
                      {c.title}
                    </div>
                    <div className="mt-0.5 text-[11px] text-slate-400">
                      {when(c.updated_at)} ·{' '}
                      {t('turnCount', { n: Math.ceil(c.message_count / 2) })}
                    </div>
                  </div>
                  <button
                    onClick={(e) => remove(e, c.id)}
                    title={t('delete')}
                    className="shrink-0 text-slate-300 opacity-0 transition hover:text-red-600 focus:opacity-100 group-hover:opacity-100"
                  >
                    <Icon name="trash" />
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </aside>
  )
}
