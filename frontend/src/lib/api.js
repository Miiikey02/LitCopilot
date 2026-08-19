// Thin API client for the Gaze backend.
import { getAccessToken, refreshSession } from './supabase'

async function send(path, options, token) {
  const headers = { ...(options.headers || {}) }
  if (token) headers.Authorization = `Bearer ${token}`
  return fetch(path, { ...options, headers })
}

async function req(path, options = {}) {
  // Attach the Supabase access token so the backend can identify the user and
  // scope library/folder/history rows to them.
  let token = await getAccessToken()
  let res = await send(path, options, token)

  // A 401 right after sign-in usually means the session wasn't persisted yet,
  // or the access token just expired. Refresh once and retry before failing —
  // otherwise a transient blip leaves the library looking empty.
  if (res.status === 401) {
    const fresh = await refreshSession()
    if (fresh && fresh !== token) {
      token = fresh
      res = await send(path, options, token)
    }
  }

  if (!res.ok) {
    const err = new Error(`${options?.method || 'GET'} ${path} failed: ${res.status}`)
    err.status = res.status
    throw err
  }
  // DELETE endpoints may return an empty-ish body; guard the parse.
  const text = await res.text()
  return text ? JSON.parse(text) : null
}

const jsonPost = (path, body) =>
  req(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

// --- Search ---
export const search = (
  query,
  lang,
  limit,
  includePreprints = true,
  sort = 'relevance',
  sources = null,
  conversationId = null
) =>
  jsonPost('/api/search', {
    query,
    lang: lang || null,
    limit: limit ?? null,
    include_preprints: includePreprints,
    sort,
    sources,
    conversation_id: conversationId,
  })

// --- Deep research (planned multi-step review) ---
export const deepResearch = (
  query,
  lang,
  includePreprints = true,
  sources = null,
  conversationId = null,
  limit = null,
  perQuestion = null
) =>
  jsonPost('/api/deep-research', {
    query,
    lang: lang || null,
    include_preprints: includePreprints,
    sources,
    conversation_id: conversationId,
    limit,
    per_question: perQuestion ?? 8,
  })

// --- Single paper: deep read, graph, entities, evidence ---
export const paperRead = (identifier, lang) =>
  jsonPost('/api/paper/read', { identifier, lang: lang || null })
export const paperConnected = (identifier) =>
  jsonPost('/api/paper/connected', { identifier })
export const paperEvidence = (identifier, lang, focus) =>
  jsonPost('/api/paper/evidence', { identifier, lang: lang || null, focus: focus || null })
export const paperResolve = (identifier, lang) =>
  jsonPost('/api/paper/resolve', { identifier, lang: lang || null })
export const paperArticle = (identifier, lang) =>
  jsonPost('/api/paper/article', { identifier, lang: lang || null })
export const paperUpload = async (file) => {
  // Sent as the raw body, not multipart: the server parses multipart in pure
  // Python, which costs seconds per megabyte on a small instance, and there is
  // only ever one field.
  //
  // The token matters here: an upload sent without it is recorded with no
  // owner, and an ownerless upload is readable by anyone holding its id.
  const token = await getAccessToken()
  const headers = { 'Content-Type': 'application/pdf' }
  if (token) headers.Authorization = `Bearer ${token}`
  const r = await fetch('/api/paper/upload', { method: 'POST', headers, body: file })
  if (!r.ok) {
    const detail = await r.json().catch(() => ({}))
    throw new Error(detail.detail || 'upload failed')
  }
  return r.json()
}
// --- Importing someone else's reference library ---
//
// Raw body again, for the same reason as the PDF upload. The file may be a
// RIS/BibTeX/EndNote/PubMed export or a pasted list of DOIs; the server works
// out which from the content, so the name is a hint rather than a decision.
export const libraryImport = async (content, filename, folderId, teamId) => {
  const token = await getAccessToken()
  const headers = { 'Content-Type': 'text/plain; charset=utf-8' }
  if (token) headers.Authorization = `Bearer ${token}`
  const params = new URLSearchParams({ filename: filename || '' })
  if (folderId) params.set('folder_id', String(folderId))
  if (teamId) params.set('team_id', String(teamId))
  const r = await fetch(`/api/library/import?${params}`, {
    method: 'POST',
    headers,
    body: content,
  })
  if (!r.ok) {
    const detail = await r.json().catch(() => ({}))
    const err = new Error(detail.detail || 'import failed')
    err.status = r.status
    throw err
  }
  return r.json()
}
// Which of these local PDFs the library already holds. Only a DOI and a title
// are sent — never the file, never a path on the reader's machine.
export const matchLocal = (files, teamId) =>
  jsonPost('/api/library/match-local', { files, team_id: teamId ?? null })

// --- Assistants: a toolset plus instructions, built-in or your own ---
export const listAssistants = (teamId, lang) =>
  req(`/api/assistants${ws({ lang }, teamId)}`)
export const createAssistant = (a) => jsonPost('/api/assistants', a)
export const updateAssistant = (id, fields) =>
  req(`/api/assistants/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  })
export const deleteAssistant = (id) => req(`/api/assistants/${id}`, { method: 'DELETE' })

// --- Experiment records: the lab notebook ---
export const listRecords = (teamId, q) => req(`/api/records${ws({ q }, teamId)}`)
export const createRecord = (r) => jsonPost('/api/records', r)
// Write the minimum; get a structured record back. It completes what you wrote
// and says what is still missing — it never fills a gap with an invention.
export const draftRecord = (text, teamId, lang) =>
  jsonPost('/api/records/draft', { text, team_id: teamId ?? null, lang: lang || null })
export const updateRecord = (id, fields) =>
  req(`/api/records/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  })
export const deleteRecord = (id) => req(`/api/records/${id}`, { method: 'DELETE' })

// --- Skills: the user's own conventions, written down once ---
export const listSkills = (teamId) => req(`/api/skills${ws({}, teamId)}`)
export const createSkill = (skill) => jsonPost('/api/skills', skill)
export const updateSkill = (id, fields) =>
  req(`/api/skills/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  })
export const deleteSkill = (id) => req(`/api/skills/${id}`, { method: 'DELETE' })
// Describe what you want — or paste what just worked — and get a skill back.
export const draftSkill = (description, lang) =>
  jsonPost('/api/skills/draft', { description, lang: lang || null })

// --- The librarian agent ---
// It answers with proposals, never edits. Applying them is the second call,
// made only after the reader has seen what it wants to do.
export const libraryAgent = (
  message, teamId, lang, history = [], skillId = null, assistant = null
) =>
  jsonPost('/api/library/agent', {
    message,
    team_id: teamId ?? null,
    lang: lang || null,
    history,
    skill_id: skillId,
    assistant,
  })
export const libraryAgentApply = (actions, teamId) =>
  jsonPost('/api/library/agent/apply', { actions, team_id: teamId ?? null })

export const importStatus = (jobId) => req(`/api/library/import/${jobId}`)
export const recentImports = () => req('/api/library/imports')

export const paperAsk = (identifier, selection, question, intent, lang, conversationId) =>
  jsonPost('/api/paper/ask', {
    identifier,
    selection,
    question: question || '',
    intent: intent || 'free',
    lang: lang || null,
    conversation_id: conversationId ?? null,
  })

// --- Research agent (multi-turn follow-ups) ---
export const chat = (sessionId, message, lang, conversationId, forceSearch = false) =>
  jsonPost('/api/chat', {
    session_id: sessionId,
    message,
    lang: lang || null,
    conversation_id: conversationId ?? null,
    force_search: forceSearch,
  })

// --- Saved conversations ---
// `teamId === undefined` lists across workspaces; pass it (null for personal)
// to get only the threads belonging to the workspace being looked at.
// `q` searches within the threads — the question, every message, and the
// papers cited — not just the titles the rail shows.
export const listConversations = (kind, teamId, q) => {
  const qs = new URLSearchParams()
  if (kind) qs.set('kind', kind)
  if (q) qs.set('q', q)
  if (teamId !== undefined) {
    qs.set('scope', 'workspace')
    if (teamId) qs.set('team', teamId)
  }
  const s = qs.toString()
  return req(`/api/conversations${s ? `?${s}` : ''}`)
}
export const getConversation = (id) => req(`/api/conversations/${id}`)
export const resumeConversation = (id) =>
  jsonPost(`/api/conversations/${id}/resume`, {})
export const deleteConversation = (id) =>
  req(`/api/conversations/${id}`, { method: 'DELETE' })
export const renameConversation = (id, title) =>
  req(`/api/conversations/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  })

// --- Library ---
export const saveLibrary = (paper, teamId, folderId = null) =>
  jsonPost('/api/library/save', {
    ...paper,
    team_id: teamId ?? null,
    folder_id: folderId,
  })
// `team` selects the workspace: undefined/null = personal library.
const ws = (params = {}, teamId) => {
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v !== null && v !== undefined && v !== '') qs.set(k, v)
  }
  if (teamId) qs.set('team', teamId)
  const s = qs.toString()
  return s ? `?${s}` : ''
}

export const listLibrary = (tag, folder, q, teamId, state) =>
  req(`/api/library${ws({ tag, folder, q, state }, teamId)}`)

// Where a paper is in the reading of it: '' | toread | reading | read | cited.
export const setReadState = (id, state, teamId) =>
  req(`/api/library/${id}/state${ws({}, teamId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state }),
  })
export const readStateCounts = (teamId) => req(`/api/library/states${ws({}, teamId)}`)

// Put the library back as it was before a batch of agent changes.
export const undoLibrary = (undoId) => jsonPost(`/api/library/undo/${undoId}`, {})

export const setNotes = (id, notes, teamId) =>
  req(`/api/library/${id}/notes${ws({}, teamId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ notes }),
  })

// Ask questions grounded in your own saved papers.
export const libraryChat = (message, folder, lang, history, teamId, conversationId) =>
  jsonPost('/api/library/chat', {
    message,
    folder: folder ?? null,
    team_id: teamId ?? null,
    lang: lang || null,
    history: history || [],
    conversation_id: conversationId ?? null,
  })
export const deletePaper = (id, teamId) =>
  req(`/api/library/${id}${ws({}, teamId)}`, { method: 'DELETE' })
export const addTag = (id, tag, teamId) =>
  jsonPost(`/api/library/${id}/tags${ws({}, teamId)}`, { tag })
export const removeTag = (id, tag, teamId) =>
  req(`/api/library/${id}/tags/${encodeURIComponent(tag)}${ws({}, teamId)}`, {
    method: 'DELETE',
  })
export const listTags = (teamId) => req(`/api/library/tags${ws({}, teamId)}`)

// --- Folders ---
export const listFolders = (teamId) => req(`/api/folders${ws({}, teamId)}`)
export const createFolder = (name, teamId, parentId = null) =>
  jsonPost(`/api/folders${ws({}, teamId)}`, { name, parent_id: parentId })
export const moveFolder = (folderId, parentId, teamId) =>
  req(`/api/folders/${folderId}/parent${ws({}, teamId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parent_id: parentId }),
  })
export const renameFolder = (id, name, teamId) =>
  req(`/api/folders/${id}${ws({}, teamId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
export const deleteFolder = (id, teamId) =>
  req(`/api/folders/${id}${ws({}, teamId)}`, { method: 'DELETE' })
export const movePaper = (paperId, folderId, teamId) =>
  req(`/api/library/${paperId}/folder${ws({}, teamId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folder_id: folderId }),
  })

// --- Teams (shared lab workspaces) ---
export const listTeams = () => req('/api/teams')
export const createTeam = (name) => jsonPost('/api/teams', { name })
export const joinTeam = (inviteCode) =>
  jsonPost('/api/teams/join', { invite_code: inviteCode })
export const listMembers = (teamId) => req(`/api/teams/${teamId}/members`)
export const renameTeam = (teamId, name) =>
  req(`/api/teams/${teamId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
export const deleteTeam = (teamId) => req(`/api/teams/${teamId}`, { method: 'DELETE' })
export const setMemberRole = (teamId, memberId, role) =>
  req(`/api/teams/${teamId}/members/${memberId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role }),
  })
export const removeMember = (teamId, memberId) =>
  req(`/api/teams/${teamId}/members/${memberId}`, { method: 'DELETE' })

// --- History ---
export const listHistory = () => req('/api/history')
export const clearHistory = () => req('/api/history', { method: 'DELETE' })

// --- Feedback (works signed out) ---
export const sendFeedback = (message, email, context) =>
  jsonPost('/api/feedback', { message, email: email || '', context: context || '' })

// --- Clinical trials ---
export const findTrials = (query) => jsonPost('/api/trials', { query })
