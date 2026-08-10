import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import * as api from '../lib/api'
import { copyText } from '../lib/citation'

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
        setMembers(await api.listMembers(team.id))
      } catch {
        setMembers([])
      }
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

  const kick = async (memberId) => {
    if (!team) return
    await api.removeMember(team.id, memberId)
    setMembers(await api.listMembers(team.id))
    onTeamsChanged()
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
          👤 {t('personalLibrary')}
        </button>
        {teams.map((x) => (
          <button
            key={x.id}
            onClick={() => onSwitch(String(x.id))}
            className={tabClass(String(activeTeam) === String(x.id))}
          >
            🧪 {x.name}
            <span className="ml-1 opacity-70">({x.member_count})</span>
          </button>
        ))}
        <button
          onClick={() => setPanel(panel === 'create' ? '' : 'create')}
          className="rounded-md border border-dashed border-slate-300 px-2.5 py-1.5 text-sm text-slate-500 hover:bg-slate-50"
        >
          + {t('newTeam')}
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
            ⚙ {t('manageTeam')}
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
        <div className="mt-2 rounded-lg border border-slate-200 bg-white p-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-slate-500">{t('inviteCode')}：</span>
            <code className="rounded bg-slate-100 px-2 py-1 font-mono text-sm tracking-widest text-slate-800">
              {team.invite_code}
            </code>
            <button
              onClick={copyInvite}
              className={`text-sm ${copied ? 'text-green-600' : 'text-blue-600 hover:underline'}`}
            >
              {copied ? `✓ ${t('citeCopied')}` : t('copy')}
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
                  <span className="truncate">{m.email || m.user_id.slice(0, 8)}</span>
                  {m.role === 'owner' && (
                    <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800">
                      {t('owner')}
                    </span>
                  )}
                  {team.role === 'owner' && m.role !== 'owner' && (
                    <button
                      onClick={() => kick(m.user_id)}
                      className="text-xs text-red-500 hover:text-red-700"
                    >
                      {t('removeMember')}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>

          <div className="mt-3 border-t border-slate-100 pt-3">
            {team.role === 'owner' ? (
              <button onClick={disband} className="text-sm text-red-600 hover:underline">
                {t('disbandTeam')}
              </button>
            ) : (
              <button onClick={leave} className="text-sm text-red-600 hover:underline">
                {t('leaveTeam')}
              </button>
            )}
          </div>
        </div>
      )}

      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </div>
  )
}
