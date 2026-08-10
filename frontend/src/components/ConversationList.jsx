import React from 'react'
import { useTranslation } from 'react-i18next'
import * as api from '../lib/api'

// Past conversations with the agent: click one to reopen it and keep talking.
export default function ConversationList({
  conversations,
  activeId,
  onOpen,
  onNew,
  onChanged,
  compact = false,
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
    <div className={compact ? '' : 'rounded-lg border border-slate-200 bg-white p-3'}>
      <div className="mb-2 flex items-center justify-between">
        <h4 className="px-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
          {t('conversationHistory')}
        </h4>
        <button
          onClick={onNew}
          className="text-xs font-medium text-blue-600 hover:underline"
        >
          + {t('newConversation')}
        </button>
      </div>

      {conversations.length === 0 ? (
        <p className="px-1 py-2 text-xs text-slate-400">{t('noConversations')}</p>
      ) : (
        <ul className="max-h-64 space-y-0.5 overflow-y-auto">
          {conversations.map((c) => (
            <li key={c.id}>
              <div
                role="button"
                tabIndex={0}
                onClick={() => onOpen(c.id)}
                onKeyDown={(e) => e.key === 'Enter' && onOpen(c.id)}
                className={`group flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-sm ${
                  String(activeId) === String(c.id)
                    ? 'bg-blue-50 text-blue-800'
                    : 'text-slate-600 hover:bg-slate-50'
                }`}
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate">{c.title}</div>
                  <div className="text-xs text-slate-400">
                    {when(c.updated_at)} · {t('turnCount', { n: Math.ceil(c.message_count / 2) })}
                  </div>
                </div>
                <button
                  onClick={(e) => remove(e, c.id)}
                  title={t('delete')}
                  className="shrink-0 text-xs text-slate-300 opacity-0 transition-opacity hover:text-red-600 group-hover:opacity-100"
                >
                  ×
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
