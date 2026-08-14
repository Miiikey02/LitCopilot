import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import * as api from '../lib/api'
import Icon from './Icon'

// Where a paper is in the reading of it.
//
// A library that only records whether something was saved cannot answer the
// question a researcher actually has most mornings — what should I read next.
// Four states are enough: one for the pile, one for the thing open on the desk,
// one for the thing finished with, and one for the thing already in a draft.
// More would be a taxonomy nobody maintains.
//
// Unset is a real state rather than a missing value: papers arrive in bulk from
// an import, and "not yet triaged" is exactly what you want to filter to.

export const STATES = ['toread', 'reading', 'read', 'cited']

const TONE = {
  toread: 'bg-amber-50 text-amber-700 border-amber-200',
  reading: 'bg-blue-50 text-blue-700 border-blue-200',
  read: 'bg-green-50 text-green-700 border-green-200',
  cited: 'bg-purple-50 text-purple-700 border-purple-200',
  '': 'bg-white text-slate-500 border-slate-200',
}

const ICON = { toread: 'bookOpen', reading: 'clock', read: 'check', cited: 'quote', '': 'plus' }

export function stateLabel(t, state) {
  return state ? t(`state_${state}`) : t('stateUnset')
}

/** The control on a paper card: current state, and a menu to change it. */
export default function ReadState({ paper, teamId, onChanged }) {
  const { t } = useTranslation()
  const [state, setState] = useState(paper.read_state || '')
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  const set = async (next) => {
    setOpen(false)
    if (next === state || busy) return
    const previous = state
    setState(next) // optimistic: the click should feel instant
    setBusy(true)
    try {
      await api.setReadState(paper.id, next, teamId)
      onChanged?.()
    } catch {
      setState(previous)
    } finally {
      setBusy(false)
    }
  }

  return (
    <span className="relative inline-block">
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
        title={t('readStateTitle')}
        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors ${TONE[state]} disabled:opacity-60`}
      >
        <Icon name={ICON[state]} />
        {stateLabel(t, state)}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute left-0 z-20 mt-1 w-32 rounded-md border border-slate-200 bg-white py-1 shadow-lg">
            {[...STATES, ''].map((option) => (
              <button
                key={option || 'unset'}
                onClick={() => set(option)}
                className={`flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-xs transition-colors hover:bg-slate-50 ${
                  option === state ? 'font-medium text-blue-700' : 'text-slate-700'
                }`}
              >
                <Icon name={ICON[option]} className="text-slate-400" />
                {stateLabel(t, option)}
              </button>
            ))}
          </div>
        </>
      )}
    </span>
  )
}

/** The filter row above the library. */
export function ReadStateFilter({ active, counts = {}, onPick }) {
  const { t } = useTranslation()
  const options = [null, ...STATES, 'unset']
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {options.map((option) => {
        const key = option === null ? 'all' : option
        const n = option === null ? null : counts[option === 'unset' ? 'unset' : option] || 0
        const isActive = (active || null) === option
        return (
          <button
            key={key}
            onClick={() => onPick(option)}
            className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
              isActive
                ? 'border-slate-900 bg-slate-900 text-white'
                : 'border-slate-200 text-slate-600 hover:border-slate-300 hover:bg-slate-50'
            }`}
          >
            {option === null
              ? t('allPapers')
              : option === 'unset'
              ? t('stateUnset')
              : t(`state_${option}`)}
            {n !== null && n > 0 && <span className="ml-1 opacity-70">{n}</span>}
          </button>
        )
      })}
    </div>
  )
}
