import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import * as api from '../lib/api'
import Icon from './Icon'

// The lab's own conventions, written down once.
//
// No tool can guess that a group names folders by grant number, or that every
// note has to record species and sample size. Those are instructions, not
// features — so rather than guess, let people write them down and have the
// agent follow them.
//
// A skill composes the tools the agent already has. It cannot grant new
// abilities, and it cannot switch off the rules it sits under: changes are
// still proposals, ids are still never invented, a retracted paper is still
// not evidence. That is enforced server-side, not by asking nicely.
//
// Writing a good instruction from a blank form is prompt engineering, which is
// not a thing to ask a biologist to do. So the panel takes a description in
// plain language and drafts the skill; the user edits what comes back.

function Editor({ initial, wish: seededWish, teamId, onSaved, onCancel }) {
  const { t, i18n } = useTranslation()
  // Seeded from a run that went well: the description box arrives filled in,
  // so the user presses one button instead of facing a blank page.
  const [wish, setWish] = useState(seededWish || '')
  const [draft, setDraft] = useState(initial?.id ? initial : null)
  const [drafting, setDrafting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const generate = async () => {
    if (!wish.trim() || drafting) return
    setDrafting(true)
    setError('')
    try {
      setDraft(await api.draftSkill(wish.trim(), i18n.language))
    } catch {
      setError(t('skillDraftFailed'))
    } finally {
      setDrafting(false)
    }
  }

  const save = async () => {
    if (!draft?.name?.trim() || !draft?.instructions?.trim() || saving) return
    setSaving(true)
    setError('')
    try {
      if (initial?.id) {
        await api.updateSkill(initial.id, {
          name: draft.name,
          description: draft.description,
          instructions: draft.instructions,
        })
      } else {
        await api.createSkill({ ...draft, team_id: teamId ? Number(teamId) : null })
      }
      onSaved()
    } catch (e) {
      setError(e?.message || t('skillSaveFailed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="rounded-xl border border-slate-200 p-3">
      {!draft && (
        <>
          <label className="mb-1 block text-xs font-medium text-slate-600">
            {t('skillWishLabel')}
          </label>
          <textarea
            value={wish}
            onChange={(e) => setWish(e.target.value)}
            rows={3}
            placeholder={t('skillWishPlaceholder')}
            className="w-full resize-y rounded-lg border border-slate-200 p-2 text-sm text-slate-800 outline-none transition-colors focus:border-blue-400"
          />
          <div className="mt-2 flex items-center gap-2">
            <button
              onClick={generate}
              disabled={drafting || !wish.trim()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white transition-all hover:bg-slate-800 disabled:opacity-50"
            >
              <Icon name="sparkles" />
              {drafting ? t('skillDrafting') : t('skillDraftAction')}
            </button>
            <button
              onClick={onCancel}
              className="rounded-lg px-2 py-1.5 text-sm text-slate-500 hover:text-slate-800"
            >
              {t('cancel')}
            </button>
          </div>
        </>
      )}

      {draft && (
        <div className="space-y-2">
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">
              {t('skillName')}
            </label>
            <input
              value={draft.name || ''}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              className="w-full rounded-lg border border-slate-200 p-2 text-sm outline-none focus:border-blue-400"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">
              {t('skillWhen')}
            </label>
            <input
              value={draft.description || ''}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              className="w-full rounded-lg border border-slate-200 p-2 text-sm outline-none focus:border-blue-400"
            />
            <p className="mt-0.5 text-xs text-slate-400">{t('skillWhenHint')}</p>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">
              {t('skillInstructions')}
            </label>
            <textarea
              value={draft.instructions || ''}
              onChange={(e) => setDraft({ ...draft, instructions: e.target.value })}
              rows={6}
              className="w-full resize-y rounded-lg border border-slate-200 p-2 text-sm leading-6 outline-none focus:border-blue-400"
            />
          </div>
          {error && <p className="text-xs text-red-600">{error}</p>}
          <div className="flex items-center gap-2">
            <button
              onClick={save}
              disabled={saving}
              className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white transition-all hover:bg-slate-800 disabled:opacity-50"
            >
              <Icon name="check" />
              {saving ? t('saving') : t('save')}
            </button>
            <button
              onClick={onCancel}
              className="rounded-lg px-2 py-1.5 text-sm text-slate-500 hover:text-slate-800"
            >
              {t('cancel')}
            </button>
          </div>
        </div>
      )}
      {!draft && error && <p className="mt-2 text-xs text-red-600">{error}</p>}
    </div>
  )
}

export default function SkillsPanel({ teamId, seed, onClose, onChanged }) {
  const { t } = useTranslation()
  const [skills, setSkills] = useState([])
  // `seed` is a draft handed in from elsewhere — "save what just worked".
  const [editing, setEditing] = useState(seed ? {} : null)
  const [expanded, setExpanded] = useState(null)
  const [error, setError] = useState('')

  const load = async () => {
    try {
      setSkills(await api.listSkills(teamId))
    } catch {
      setError(t('skillLoadFailed'))
    }
  }

  useEffect(() => {
    load()
    const onKey = (e) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamId])

  const remove = async (skill) => {
    if (!window.confirm(t('skillDeleteConfirm', { name: skill.name }))) return
    await api.deleteSkill(skill.id)
    load()
    onChanged?.()
  }

  const toggleShare = async (skill) => {
    await api.updateSkill(skill.id, { shared: !skill.shared })
    load()
    onChanged?.()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <div className="absolute inset-0 bg-slate-900/25" onClick={onClose} />
      <div className="animate-rise relative flex max-h-[88vh] w-full max-w-xl flex-col rounded-t-2xl border border-slate-200 bg-white shadow-xl sm:rounded-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-5 py-4">
          <div className="min-w-0">
            <h2 className="flex items-center gap-1.5 text-base font-semibold text-slate-900">
              <Icon name="flask" className="text-blue-500" />
              {t('skillsTitle')}
            </h2>
            <p className="mt-0.5 text-xs leading-5 text-slate-500">{t('skillsSubtitle')}</p>
          </div>
          <button
            onClick={onClose}
            className="shrink-0 rounded-md p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
            title={t('close')}
          >
            <Icon name="x" />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
          {editing !== null ? (
            <Editor
              initial={editing.id ? editing : null}
              wish={editing.id ? '' : seed?.wish || ''}
              teamId={teamId}
              onSaved={() => {
                setEditing(null)
                load()
                onChanged?.()
              }}
              onCancel={() => setEditing(null)}
            />
          ) : (
            <button
              onClick={() => setEditing({})}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-700 transition-colors hover:border-blue-300 hover:text-blue-700"
            >
              <Icon name="plus" />
              {t('skillNew')}
            </button>
          )}

          {skills.length === 0 && editing === null && (
            <p className="text-sm leading-6 text-slate-500">{t('skillsEmpty')}</p>
          )}

          {skills.map((skill) => (
            <div key={skill.id} className="rounded-lg border border-slate-200 p-3">
              <div className="flex items-start justify-between gap-2">
                <button
                  onClick={() => setExpanded(expanded === skill.id ? null : skill.id)}
                  className="min-w-0 flex-1 text-left"
                >
                  <p className="truncate text-sm font-medium text-slate-800">
                    {skill.name}
                    {skill.shared && (
                      <span className="ml-1.5 rounded-full bg-blue-50 px-1.5 py-0.5 text-xs font-normal text-blue-700">
                        {t('skillShared')}
                      </span>
                    )}
                  </p>
                  {skill.description && (
                    <p className="mt-0.5 line-clamp-2 text-xs leading-5 text-slate-500">
                      {skill.description}
                    </p>
                  )}
                </button>
                <div className="flex shrink-0 items-center gap-0.5">
                  {teamId && (
                    <button
                      onClick={() => toggleShare(skill)}
                      title={t(skill.shared ? 'skillUnshare' : 'skillShare')}
                      className="rounded p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-blue-700"
                    >
                      <Icon name="users" />
                    </button>
                  )}
                  <button
                    onClick={() => setEditing(skill)}
                    title={t('rename')}
                    className="rounded p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
                  >
                    <Icon name="pencil" />
                  </button>
                  <button
                    onClick={() => remove(skill)}
                    title={t('delete')}
                    className="rounded p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-red-600"
                  >
                    <Icon name="trash" />
                  </button>
                </div>
              </div>
              {expanded === skill.id && (
                <p className="mt-2 whitespace-pre-wrap rounded-md bg-slate-50 p-2 text-xs leading-6 text-slate-600">
                  {skill.instructions}
                </p>
              )}
            </div>
          ))}

          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>
        <p className="border-t border-slate-100 px-5 py-2 text-xs leading-5 text-slate-400">
          {t('skillsSafety')}
        </p>
      </div>
    </div>
  )
}
