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
  sort = 'relevance'
) =>
  jsonPost('/api/search', {
    query,
    lang: lang || null,
    limit: limit ?? null,
    include_preprints: includePreprints,
    sort,
  })

// --- Research agent (multi-turn follow-ups) ---
export const chat = (sessionId, message, lang) =>
  jsonPost('/api/chat', { session_id: sessionId, message, lang: lang || null })

// --- Library ---
export const saveLibrary = (paper) => jsonPost('/api/library/save', paper)
export const listLibrary = (tag, folder, q) => {
  const qs = new URLSearchParams()
  if (tag) qs.set('tag', tag)
  if (folder !== null && folder !== undefined) qs.set('folder', folder)
  if (q) qs.set('q', q)
  const s = qs.toString()
  return req(`/api/library${s ? `?${s}` : ''}`)
}

export const setNotes = (id, notes) =>
  req(`/api/library/${id}/notes`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ notes }),
  })

// Ask questions grounded in your own saved papers.
export const libraryChat = (message, folder, lang, history) =>
  jsonPost('/api/library/chat', {
    message,
    folder: folder ?? null,
    lang: lang || null,
    history: history || [],
  })
export const deletePaper = (id) => req(`/api/library/${id}`, { method: 'DELETE' })
export const addTag = (id, tag) => jsonPost(`/api/library/${id}/tags`, { tag })
export const removeTag = (id, tag) =>
  req(`/api/library/${id}/tags/${encodeURIComponent(tag)}`, { method: 'DELETE' })
export const listTags = () => req('/api/library/tags')

// --- Folders ---
export const listFolders = () => req('/api/folders')
export const createFolder = (name) => jsonPost('/api/folders', { name })
export const renameFolder = (id, name) =>
  req(`/api/folders/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
export const deleteFolder = (id) => req(`/api/folders/${id}`, { method: 'DELETE' })
export const movePaper = (paperId, folderId) =>
  req(`/api/library/${paperId}/folder`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folder_id: folderId }),
  })

// --- History ---
export const listHistory = () => req('/api/history')
export const clearHistory = () => req('/api/history', { method: 'DELETE' })

// --- Clinical trials ---
export const findTrials = (query) => jsonPost('/api/trials', { query })
