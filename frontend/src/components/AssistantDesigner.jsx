import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import * as api from '../lib/api'
import Icon from './Icon'

// Building an assistant, for someone who has never built one.
//
// An assistant is two decisions: what it may touch, and how it should work.
// That is deliberately all — no canvas, no nodes, no graph of steps. People who
// cannot write a flowchart can still say "只看最近三年的文献，每篇写一句汇报要点",
// and that sentence is the whole program.
//
// The capabilities are checkboxes rather than free text because they are the
// one part that must not be guessed: a writing assistant that could quietly
// rewrite the library would be a different and much more dangerous thing than
// the person thought they were making. What they can grant is bounded by what
// the runtime already enforces, and everything still arrives as a proposal.

const CAPABILITIES = ['library', 'records', 'writing']

const CAP_ICON = { library: 'library', records: 'flask', writing: 'note' }

export default function AssistantDesigner({ teamId, onClose, onSaved }) {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [instructions, setInstructions] = useState('')
  const [toolsets, setToolsets] = useState(['library'])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const toggle = (cap) =>
    setToolsets((prev) =>
      prev.includes(cap) ? prev.filter((x) => x !== cap) : [...prev, cap]
    )

  const save = async () => {
    if (!name.trim() || !instructions.trim() || saving) return
    setSaving(true)
    setError('')
    try {
      const made = await api.createAssistant({
        name: name.trim(),
        description: description.trim(),
        instructions: instructions.trim(),
        toolsets: toolsets.length ? toolsets : ['library'],
        team_id: teamId ? Number(teamId) : null,
      })
      onSaved?.(made)
    } catch (e) {
      setError(e?.message || t('assistantSaveFailed'))
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center sm:items-center">
      <div className="absolute inset-0 bg-slate-900/25" onClick={onClose} />
      <div className="animate-rise relative flex max-h-[88vh] w-full max-w-lg flex-col rounded-t-2xl border border-slate-200 bg-white shadow-xl sm:rounded-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-5 py-4">
          <div className="min-w-0">
            <h2 className="flex items-center gap-1.5 text-base font-semibold text-slate-900">
              <Icon name="sparkles" className="text-blue-500" />
              {t('assistantDesignTitle')}
            </h2>
            <p className="mt-0.5 text-xs leading-5 text-slate-500">
              {t('assistantDesignSubtitle')}
            </p>
          </div>
          <button
            onClick={onClose}
            className="shrink-0 rounded-md p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
            title={t('close')}
          >
            <Icon name="x" />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">
              {t('assistantName')}
            </label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('assistantNamePlaceholder')}
              className="w-full rounded-lg border border-slate-200 p-2 text-sm outline-none focus:border-blue-400"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">
              {t('assistantWhen')}
            </label>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('assistantWhenPlaceholder')}
              className="w-full rounded-lg border border-slate-200 p-2 text-sm outline-none focus:border-blue-400"
            />
          </div>

          <div>
            <p className="mb-1.5 text-xs font-medium text-slate-600">
              {t('assistantCapabilities')}
            </p>
            <div className="space-y-1.5">
              {CAPABILITIES.map((cap) => (
                <label
                  key={cap}
                  className="flex cursor-pointer items-start gap-2 rounded-lg border border-slate-200 p-2 text-sm transition-colors hover:border-blue-300"
                >
                  <input
                    type="checkbox"
                    checked={toolsets.includes(cap)}
                    onChange={() => toggle(cap)}
                    className="mt-0.5 h-4 w-4 shrink-0 rounded border-slate-300 accent-slate-900"
                  />
                  <span className="min-w-0">
                    <span className="flex items-center gap-1.5 font-medium text-slate-800">
                      <Icon name={CAP_ICON[cap]} className="text-slate-400" />
                      {t(`cap_${cap}`)}
                    </span>
                    <span className="mt-0.5 block text-xs leading-5 text-slate-500">
                      {t(`cap_${cap}_hint`)}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">
              {t('assistantHow')}
            </label>
            <textarea
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              rows={5}
              placeholder={t('assistantHowPlaceholder')}
              className="w-full resize-y rounded-lg border border-slate-200 p-2 text-sm leading-6 outline-none focus:border-blue-400"
            />
            <p className="mt-0.5 text-xs leading-5 text-slate-400">{t('assistantHowHint')}</p>
          </div>

          {error && <p className="text-xs text-red-600">{error}</p>}
        </div>

        <div className="flex items-center gap-2 border-t border-slate-100 px-5 py-3">
          <button
            onClick={save}
            disabled={saving || !name.trim() || !instructions.trim()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white transition-all hover:bg-slate-800 disabled:opacity-50"
          >
            <Icon name="check" />
            {saving ? t('saving') : t('assistantCreate')}
          </button>
          <button
            onClick={onClose}
            className="rounded-lg px-2 py-1.5 text-sm text-slate-500 hover:text-slate-800"
          >
            {t('cancel')}
          </button>
          <span className="ml-auto text-xs text-slate-400">{t('assistantSafety')}</span>
        </div>
      </div>
    </div>
  )
}
