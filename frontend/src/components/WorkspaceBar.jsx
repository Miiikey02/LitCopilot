import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import * as api from '../lib/api'
import { copyText } from '../lib/citation'
import Icon from './Icon'

// Switch between the personal library and each lab (team) the user belongs to,
// and manage the active lab: invite code, members, rename, leave/disband.
export default function WorkspaceBar({ teams, activeTeam, onSwitch, onTeamsChanged }) {
  const { t } = useTranslation()
  const [panel, setPanel] = useState('') // '' | 'create' | 'join' | 'manage'
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [members, setMembers] = useState([])
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  // Recent agent changes in this lab. A 负责人 sees everyone's, so a shelf
  // re-filed by one member's assistant can be put back without finding them.
  const [batches, setBatches] = useState([])
  const [undoing, setUndoing] = useState(null)

  const team = teams.find((x) => String(x.id) === String(activeTeam))

  const create = async (e) => {
    e.preventDefault()
    if (!name.trim()) return
    try {
      const created = await api.createTeam(name.trim())
      setName('')
      setPanel('')
      setError('')
      await onTeamsChanged()
      onSwitch(String(created.id))
    } catch {
      setError(t('teamError'))
    }
  }

  const join = async (e) => {
    e.preventDefault()
    if (!code.trim()) return
    try {
      const joined = await api.joinTeam(code.trim())
      setCode('')
      setPanel('')
      setError('')
      await onTeamsChanged()
      onSwitch(String(joined.id))
    } catch {
      setError(t('teamBadCode'))
    }
  }

  const openManage = async () => {
    setPanel(panel === 'manage' ? '' : 'manage')
    setError('')
    if (team) {
      try {
        // Refresh the workspace list too, not just the members. Someone made
        // 负责人 after this page loaded had the badge — it comes from the fresh
        // member list — but none of the controls, which read the role cached
        // from when they had joined as an ordinary member.
        const [fresh] = await Promise.all([api.listMembers(team.id), onTeamsChanged()])
        setMembers(fresh)
      } catch {
        setMembers([])
      }
      api.listUndo(team.id).then(setBatches).catch(() => setBatches([]))
    }
  }

  const undoBatch = async (b) => {
    if (!window.confirm(t('undoBatchConfirm', { who: b.by || t('noteHistorySomeone') }))) return
    setUndoing(b.id)
    try {
      const r = await api.undoLibrary(b.id)
      if (r?.failed) window.alert(t('undoBatchPartial', { n: r.failed }))
      setBatches(await api.listUndo(team.id))
      onTeamsChanged()
    } catch {
      window.alert(t('agentUndoFailed'))
    } finally {
      setUndoing(null)
    }
  }

  const copyInvite = async () => {
    if (!team) return
    await copyText(team.invite_code)
    setCopied(true)
    setTimeout(() => setCopied(false), 1600)
  }

  const leave = async () => {
    if (!team || !window.confirm(t('leaveTeamConfirm', { name: team.name }))) return
    await api.removeMember(team.id, 'me')
    setPanel('')
    onSwitch(null)
    onTeamsChanged()
  }

  const disband = async () => {
    if (!team || !window.confirm(t('deleteTeamConfirm', { name: team.name }))) return
    await api.deleteTeam(team.id)
    setPanel('')
    onSwitch(null)
    onTeamsChanged()
  }

  const setRole = async (memberId, role) => {
    try {
      await api.setMemberRole(team.id, memberId, role)
      // A 负责人 who steps down should lose the controls at once, and one who
      // hands the lab over should see it happen — both mean re-reading our
      // own role, not only the list.
      const [fresh] = await Promise.all([api.listMembers(team.id), onTeamsChanged()])
      setMembers(fresh)
    } catch (err) {
      window.alert(err?.status === 403 ? t('ownerOnlyRole') : t('errorNetwork'))
    }
  }

  const kick = async (memberId) => {
    if (!team) return
    try {
      await api.removeMember(team.id, memberId)
      setMembers(await api.listMembers(team.id))
      onTeamsChanged()
    } catch (err) {
      window.alert(err?.status === 403 ? t('ownerOnlyRemove') : t('errorNetwork'))
    }
  }

  const tabClass = (active) =>
    `rounded-md px-3 py-1.5 text-sm font-medium ${
      active ? 'bg-blue-600 text-white' : 'bg-white text-slate-600 border border-slate-300 hover:bg-slate-50'
    }`

  return (
    <div className="mb-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">
          {t('workspace')}
        </span>
        <button onClick={() => onSwitch(null)} className={tabClass(!activeTeam)}>
          <Icon name="user" className="mr-1" />{t('personalLibrary')}
        </button>
        {teams.map((x) => (
          <button
            key={x.id}
            onClick={() => onSwitch(String(x.id))}
            className={tabClass(String(activeTeam) === String(x.id))}
          >
            <Icon name="flask" className="mr-1" />{x.name}
            <span className="ml-1 opacity-70">({x.member_count})</span>
          </button>
        ))}
        <button
          onClick={() => setPanel(panel === 'create' ? '' : 'create')}
          className="rounded-md border border-dashed border-slate-300 px-2.5 py-1.5 text-sm text-slate-500 hover:bg-slate-50"
        >
          <Icon name="plus" className="mr-0.5" />{t('newTeam')}
        </button>
        <button
          onClick={() => setPanel(panel === 'join' ? '' : 'join')}
          className="rounded-md border border-dashed border-slate-300 px-2.5 py-1.5 text-sm text-slate-500 hover:bg-slate-50"
        >
          {t('joinTeam')}
        </button>
        {team && (
          <button
            onClick={openManage}
            className="ml-auto text-sm text-slate-500 hover:text-slate-800"
          >
            <Icon name="settings" className="mr-1" />{t('manageTeam')}
          </button>
        )}
      </div>

      {panel === 'create' && (
        <form onSubmit={create} className="mt-2 flex gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('teamNamePlaceholder')}
            className="w-64 rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
          />
          <button className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700">
            {t('create')}
          </button>
        </form>
      )}

      {panel === 'join' && (
        <form onSubmit={join} className="mt-2 flex gap-2">
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder={t('inviteCodePlaceholder')}
            className="w-48 rounded-md border border-slate-300 px-3 py-1.5 font-mono text-sm uppercase focus:border-blue-500 focus:outline-none"
          />
          <button className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700">
            {t('join')}
          </button>
        </form>
      )}

      {panel === 'manage' && team && (
        <div className="animate-expand mt-2 rounded-lg border border-slate-200 bg-white p-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-slate-500">{t('inviteCode')}：</span>
            <code className="rounded bg-slate-100 px-2 py-1 font-mono text-sm tracking-widest text-slate-800">
              {team.invite_code}
            </code>
            <button
              onClick={copyInvite}
              className={`text-sm ${copied ? 'text-green-600' : 'text-blue-600 hover:underline'}`}
            >
              {copied ? <><Icon name="check" className="mr-1" />{t('citeCopied')}</> : <><Icon name="copy" className="mr-1" />{t('copy')}</>}
            </button>
            <span className="text-xs text-slate-400">{t('inviteHint')}</span>
          </div>

          <div className="mt-3">
            <div className="text-sm font-medium text-slate-700">
              {t('members')} ({members.length})
            </div>
            <ul className="mt-1 space-y-1">
              {members.map((m) => (
                <li key={m.user_id} className="flex items-center gap-2 text-sm text-slate-600">
                  <span className="min-w-0 flex-1 truncate">
                    {m.email || m.user_id.slice(0, 8)}
                    {/* What each person has put on the shelf: the question a
                        PI actually asks of a shared library. */}
                    <span className="ml-1.5 text-xs text-slate-400">
                      {t('papersAdded', { n: m.papers_added ?? 0 })}
                    </span>
                  </span>
                  {m.role === 'owner' && (
                    <span className="shrink-0 rounded-full bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800">
                      {t('owner')}
                    </span>
                  )}
                  {/* Admin is shareable and handed over, so a lab outlives the
                      account that created it. */}
                  {team.role === 'owner' && (
                    <button
                      onClick={() => setRole(m.user_id, m.role === 'owner' ? 'member' : 'owner')}
                      className="shrink-0 text-xs text-slate-500 hover:text-blue-700"
                    >
                      {m.role === 'owner' ? t('makeMember') : t('makeOwner')}
                    </button>
                  )}
                  {team.role === 'owner' && m.role !== 'owner' && (
                    <button
                      onClick={() => kick(m.user_id)}
                      className="shrink-0 text-xs text-red-500 hover:text-red-700"
                    >
                      {t('removeMember')}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>

          {batches.length > 0 && (
            <div className="mt-3 border-t border-slate-100 pt-3">
              <p className="text-sm font-medium text-slate-700">
                {t(team.role === 'owner' ? 'undoBatchesAll' : 'undoBatchesMine')}
              </p>
              <ul className="mt-1 space-y-1">
                {batches.slice(0, 10).map((b) => (
                  <li key={b.id} className="flex items-center gap-2 text-xs text-slate-600">
                    <span className="min-w-0 flex-1 truncate">
                      <span className="font-medium text-slate-700">
                        {b.by || t('noteHistorySomeone')}
                      </span>
                      {' · '}
                      {new Date(b.at).toLocaleString()}
                      {' · '}
                      {t('undoBatchChanges', { n: b.changes })}
                      {b.label ? ` — ${b.label}` : ''}
                    </span>
                    {b.undone ? (
                      <span className="shrink-0 text-slate-400">{t('undoBatchDone')}</span>
                    ) : (
                      <button
                        onClick={() => undoBatch(b)}
                        disabled={undoing === b.id}
                        className="shrink-0 text-blue-700 hover:underline disabled:opacity-50"
                      >
                        {undoing === b.id ? t('agentUndoing') : t('undoBatchAction')}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="mt-3 border-t border-slate-100 pt-3">
            <div className="flex flex-wrap items-center gap-4">
              {(team.role !== 'owner' ||
                members.filter((m) => m.role === 'owner').length > 1) && (
                <button onClick={leave} className="text-sm text-red-600 hover:underline">
                  {t('leaveTeam')}
                </button>
              )}
              {team.role === 'owner' && (
                <button onClick={disband} className="text-sm text-red-600 hover:underline">
                  {t('disbandTeam')}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </div>
  )
}
