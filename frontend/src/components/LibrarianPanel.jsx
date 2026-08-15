import React, { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import * as api from '../lib/api'
import AnswerText from './AnswerText'
import Icon from './Icon'
import SkillsPanel from './SkillsPanel'
import AssistantDesigner from './AssistantDesigner'

// An agent that can tidy the library, rather than only describe it.
//
// The whole design rests on one rule: it proposes, you apply. Every change it
// wants to make arrives as a listed action with an explicit button, and until
// that button is pressed the library is untouched. An agent that re-filed three
// hundred papers on its own would be unusable even when it was right — the one
// time it was wrong there would be no way to see what it had done.
//
// Showing the plan is also the honest form of explanation. "Create 青光眼, file
// 3 papers into it" is checkable in a way that a paragraph describing the same
// intention is not.

const ICONS = {
  create_folder: 'folder',
  move_papers: 'library',
  add_tags: 'star',
  write_note: 'note',
  set_reading_state: 'bookOpen',
  write_record: 'flask',
  amend_record: 'pencil',
}

function ActionList({ actions, applied, busy, onApply, onDismiss }) {
  const { t } = useTranslation()
  const label = (a) => {
    if (a.kind === 'create_folder') {
      return a.parent
        ? t('actCreateFolderIn', { name: a.name, parent: a.parent })
        : t('actCreateFolder', { name: a.name })
    }
    if (a.kind === 'move_papers') {
      return a.folder?.toLowerCase() === 'unfiled'
        ? t('actUnfile', { n: a.paper_ids.length })
        : t('actMovePapers', { n: a.paper_ids.length, folder: a.folder })
    }
    if (a.kind === 'add_tags') {
      return t('actAddTags', { n: a.paper_ids.length, tags: (a.tags || []).join('、') })
    }
    if (a.kind === 'set_reading_state') {
      return t('actSetState', {
        n: a.paper_ids.length,
        state: a.state ? t(`state_${a.state}`) : t('stateUnset'),
      })
    }
    if (a.kind === 'write_record') return t('actWriteRecord', { title: a.title })
    if (a.kind === 'amend_record') return t('actAmendRecord')
    if (a.kind === 'write_note') return t('actWriteNote')
    return a.kind
  }

  return (
    <div className="mt-2 rounded-xl border border-slate-200 bg-slate-50 p-3">
      <p className="mb-2 text-xs font-medium text-slate-600">
        {applied ? t('agentApplied', { n: actions.length }) : t('agentProposes')}
      </p>
      <ul className="space-y-1.5">
        {actions.map((a, i) => (
          <li key={i} className="flex items-start gap-2 text-sm text-slate-700">
            <Icon name={ICONS[a.kind] || 'check'} className="mt-0.5 shrink-0 text-slate-400" />
            <div className="min-w-0">
              <span>{label(a)}</span>
              {/* A note is the one action whose content matters more than its
                  label — show the text that would be saved. */}
              {a.kind === 'write_note' && (
                <p className="mt-0.5 whitespace-pre-wrap text-xs leading-5 text-slate-500">
                  {a.note}
                </p>
              )}
              {/* A record is mostly its contents; the label alone says almost
                  nothing about whether it is right. */}
              {(a.kind === 'write_record' || a.kind === 'amend_record') && (
                <div className="mt-0.5 space-y-0.5 text-xs leading-5 text-slate-500">
                  {a.happened_on && <p>{a.happened_on}</p>}
                  {a.aim && <p>{t('recordAim')}：{a.aim}</p>}
                  {a.method && <p className="whitespace-pre-wrap">{t('recordMethod')}：{a.method}</p>}
                  <p>
                    {t('recordResult')}：
                    {a.result || <span className="text-slate-400">{t('recordNoResult')}</span>}
                  </p>
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>
      {!applied && (
        <div className="mt-3 flex items-center gap-2">
          <button
            onClick={onApply}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white transition-all hover:bg-slate-800 active:scale-[0.98] disabled:opacity-60"
          >
            <Icon name="check" />
            {busy ? t('agentApplying') : t('agentApply')}
          </button>
          <button
            onClick={onDismiss}
            className="rounded-lg px-2 py-1.5 text-sm text-slate-500 transition-colors hover:text-slate-800"
          >
            {t('agentDiscard')}
          </button>
        </div>
      )}
    </div>
  )
}

const SUGGESTIONS = ['agentEg1', 'agentEg2', 'agentEg3']

export default function LibrarianPanel({ teamId, initialAssistant, onClose, onChanged }) {
  const { t, i18n } = useTranslation()
  const [turns, setTurns] = useState([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [applying, setApplying] = useState(-1)
  const [error, setError] = useState('')
  // The convention to work by this turn. Null is the base behaviour.
  const [skills, setSkills] = useState([])
  const [skillId, setSkillId] = useState(null)
  const [managing, setManaging] = useState(false)
  // Which assistant is working. They share one runtime and one safety model;
  // what differs is which tools they may reach for and how they are told to
  // work — so switching is a picker, not a different screen.
  const [assistants, setAssistants] = useState([])
  const [assistant, setAssistant] = useState(initialAssistant || 'library')
  const [designing, setDesigning] = useState(false)
  const [seedSkill, setSeedSkill] = useState(null)
  const box = useRef(null)
  const area = useRef(null)

  useEffect(() => {
    area.current?.focus()
    const onKey = (e) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    box.current?.scrollTo({ top: box.current.scrollHeight })
  }, [turns, busy])

  const loadSkills = async () => {
    try {
      setSkills(await api.listSkills(teamId))
    } catch {
      /* skills are optional; the agent works without them */
    }
  }

  const loadAssistants = async () => {
    try {
      setAssistants(await api.listAssistants(teamId, i18n.language))
    } catch {
      /* the library assistant is the default and needs no list */
    }
  }

  useEffect(() => {
    loadSkills()
    loadAssistants()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamId])

  const ask = async (text) => {
    const message = (text ?? input).trim()
    if (!message || busy) return
    setInput('')
    setError('')
    setBusy(true)
    const history = turns
      .filter((x) => x.content)
      .map((x) => ({ role: x.role, content: x.content }))
    setTurns((prev) => [...prev, { role: 'user', content: message }])
    try {
      const r = await api.libraryAgent(message, teamId, i18n.language, history, skillId, assistant)
      setTurns((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: r.answer || '',
          actions: r.actions || [],
          applied: false,
          warning: r.warning,
        },
      ])
    } catch {
      setError(t('agentFailed'))
    } finally {
      setBusy(false)
    }
  }

  const pickAssistant = (id) => {
    if (id === assistant) return
    setAssistant(id)
    // A new assistant starts a new thread. Carrying over a plan made under
    // different tools would have it answering for work it could not have done.
    setTurns([])
    setError('')
  }

  const apply = async (index) => {
    const turn = turns[index]
    if (!turn?.actions?.length) return
    setApplying(index)
    setError('')
    try {
      const r = await api.libraryAgentApply(turn.actions, teamId)
      setTurns((prev) =>
        prev.map((x, i) => (i === index ? { ...x, applied: true, result: r } : x))
      )
      onChanged?.()
    } catch {
      setError(t('agentApplyFailed'))
    } finally {
      setApplying(-1)
    }
  }

  const revert = async (index) => {
    const undoId = turns[index]?.result?.undo_id
    if (!undoId) return
    setApplying(index)
    setError('')
    try {
      await api.undoLibrary(undoId)
      setTurns((prev) =>
        prev.map((x, i) => (i === index ? { ...x, reverted: true } : x))
      )
      onChanged?.()
    } catch {
      setError(t('agentUndoFailed'))
    } finally {
      setApplying(-1)
    }
  }

  // The lowest-friction way to write a skill is not to write one: point at a
  // run that went well and let it be described from that.
  const saveAsSkill = (index) => {
    const turn = turns[index]
    const asked = turns[index - 1]?.content || ''
    const did = (turn.actions || []).map((a) => JSON.stringify(a)).join('\n')
    setSeedSkill({
      name: '',
      description: '',
      instructions: '',
      _from: `${t('skillFromRunPrefix')}\n\n${asked}\n\n${turn.content || ''}\n\n${did}`,
    })
    setManaging(true)
  }

  const discard = (index) =>
    setTurns((prev) => prev.map((x, i) => (i === index ? { ...x, actions: [] } : x)))

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <div className="absolute inset-0 bg-slate-900/25" onClick={onClose} />
      <div className="animate-rise relative flex h-[88vh] w-full max-w-2xl flex-col rounded-t-2xl border border-slate-200 bg-white shadow-xl sm:h-[80vh] sm:rounded-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-5 py-4">
          <div className="min-w-0">
            <h2 className="flex items-center gap-1.5 text-base font-semibold text-slate-900">
              <Icon name="sparkles" className="text-blue-500" />
              {t('agentTitle')}
            </h2>
            <p className="mt-0.5 text-xs leading-5 text-slate-500">
              {assistants.find((a) => a.id === assistant)?.description || t('agentSubtitle')}
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

        {/* Which assistant. The three built in cover literature, the notebook
            and proposal writing; anything after them someone made. */}
        <div className="flex flex-wrap items-center gap-1.5 border-b border-slate-100 px-5 py-2">
          {assistants.map((a) => (
            <button
              key={a.id}
              onClick={() => pickAssistant(a.id)}
              title={a.description}
              className={`max-w-[13rem] truncate rounded-full border px-2.5 py-1 text-xs transition-colors ${
                assistant === a.id
                  ? 'border-blue-600 bg-blue-50 font-medium text-blue-700'
                  : 'border-slate-200 text-slate-600 hover:border-blue-300'
              }`}
            >
              {a.name}
            </button>
          ))}
          <button
            onClick={() => setDesigning(true)}
            className="rounded-full border border-dashed border-slate-300 px-2.5 py-1 text-xs text-slate-500 transition-colors hover:border-blue-300 hover:text-blue-700"
          >
            <Icon name="plus" className="mr-0.5" />
            {t('assistantNew')}
          </button>
        </div>

        <div ref={box} className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {turns.length === 0 && (
            <div>
              <p className="text-sm leading-6 text-slate-500">
                {assistants.find((a) => a.id === assistant)?.description || t('agentEmpty')}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {(assistants.find((a) => a.id === assistant)?.examples || []).map((ex) => (
                  <button
                    key={ex}
                    onClick={() => ask(ex)}
                    className="rounded-full border border-slate-200 px-3 py-1.5 text-xs text-slate-600 transition-colors hover:border-blue-300 hover:text-blue-700"
                  >
                    {ex}
                  </button>
                ))}
              </div>
            </div>
          )}

          {turns.map((turn, i) =>
            turn.role === 'user' ? (
              <div key={i} className="flex justify-end">
                <p className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-blue-50 px-3 py-2 text-sm text-slate-800">
                  {turn.content}
                </p>
              </div>
            ) : (
              <div key={i} className="max-w-[95%]">
                {turn.content && (
                  <div className="text-sm leading-6 text-slate-700">
                    <AnswerText text={turn.content} />
                  </div>
                )}
                {turn.warning && (
                  <p className="text-sm leading-6 text-amber-700">{turn.warning}</p>
                )}
                {turn.actions?.length > 0 && (
                  <ActionList
                    actions={turn.actions}
                    applied={turn.applied}
                    busy={applying === i}
                    onApply={() => apply(i)}
                    onDismiss={() => discard(i)}
                  />
                )}
                {turn.applied && turn.result?.failed > 0 && (
                  <p className="mt-1 text-xs text-amber-700">
                    {t('agentSomeFailed', { n: turn.result.failed })}
                  </p>
                )}
                {/* Undo is offered right where the change was made, while the
                    reader is still looking at what it did. Buried in a settings
                    page it would be found only by someone already alarmed. */}
                {turn.applied && turn.result?.undo_id && !turn.reverted && (
                  <button
                    onClick={() => revert(i)}
                    disabled={applying === i}
                    className="mt-1 inline-flex items-center gap-1 text-xs text-slate-500 underline-offset-2 transition-colors hover:text-slate-800 hover:underline disabled:opacity-50"
                  >
                    <Icon name="refresh" />
                    {applying === i ? t('agentUndoing') : t('agentUndo')}
                  </button>
                )}
                {turn.reverted && (
                  <p className="mt-1 text-xs text-slate-500">{t('agentUndone')}</p>
                )}
                {turn.applied && !turn.reverted && (
                  <button
                    onClick={() => saveAsSkill(i)}
                    className="mt-1 ml-3 inline-flex items-center gap-1 text-xs text-slate-500 underline-offset-2 transition-colors hover:text-blue-700 hover:underline"
                  >
                    <Icon name="flask" />
                    {t('skillSaveThis')}
                  </button>
                )}
              </div>
            )
          )}

          {busy && (
            <p className="text-sm text-slate-400">{t('agentThinking')}</p>
          )}
          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>

        <div className="border-t border-slate-100 p-3">
          {/* Which convention to work by. Off by default: the base behaviour is
              what most requests want, and a skill silently in force would be a
              surprise the next time the agent did something unexpected. */}
          <div className="mb-2 flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-slate-400">{t('skillUsing')}</span>
            <button
              onClick={() => setSkillId(null)}
              className={`rounded-full border px-2 py-0.5 text-xs transition-colors ${
                skillId === null
                  ? 'border-slate-900 bg-slate-900 text-white'
                  : 'border-slate-200 text-slate-600 hover:border-slate-300'
              }`}
            >
              {t('skillNone')}
            </button>
            {skills.map((s2) => (
              <button
                key={s2.id}
                onClick={() => setSkillId(s2.id)}
                title={s2.description}
                className={`max-w-[12rem] truncate rounded-full border px-2 py-0.5 text-xs transition-colors ${
                  skillId === s2.id
                    ? 'border-blue-600 bg-blue-50 text-blue-700'
                    : 'border-slate-200 text-slate-600 hover:border-blue-300'
                }`}
              >
                {s2.name}
              </button>
            ))}
            <button
              onClick={() => {
                setSeedSkill(null)
                setManaging(true)
              }}
              className="rounded-full border border-dashed border-slate-300 px-2 py-0.5 text-xs text-slate-500 transition-colors hover:border-blue-300 hover:text-blue-700"
            >
              <Icon name="plus" className="mr-0.5" />
              {t('skillManage')}
            </button>
          </div>
          <div className="flex items-end gap-2">
            <textarea
              ref={area}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  ask()
                }
              }}
              rows={2}
              placeholder={t('agentPlaceholder')}
              className="min-w-0 flex-1 resize-none rounded-xl border border-slate-200 p-2.5 text-sm text-slate-800 outline-none transition-colors focus:border-blue-400"
            />
            <button
              onClick={() => ask()}
              disabled={busy || !input.trim()}
              className="shrink-0 rounded-xl bg-slate-900 p-2.5 text-white transition-all hover:bg-slate-800 active:scale-[0.98] disabled:opacity-40"
              title={t('ask')}
            >
              <Icon name="send" />
            </button>
          </div>
          <p className="mt-1 px-1 text-xs text-slate-400">{t('agentSafety')}</p>
        </div>
      </div>
      {designing && (
        <AssistantDesigner
          teamId={teamId}
          onClose={() => setDesigning(false)}
          onSaved={(made) => {
            setDesigning(false)
            loadAssistants().then(() => made && pickAssistant(made.id))
          }}
        />
      )}
      {managing && (
        <SkillsPanel
          teamId={teamId}
          seed={seedSkill?._from ? { ...seedSkill, wish: seedSkill._from } : null}
          onClose={() => {
            setManaging(false)
            setSeedSkill(null)
          }}
          onChanged={loadSkills}
        />
      )}
    </div>
  )
}
