// Thin API client for the Gaze backend.
import { getAccessToken } from './supabase'

async function req(path, options = {}) {
  // Attach the Supabase access token so the backend can identify the user and
  // scope library/folder/history rows to them.
  const token = await getAccessToken()
  const headers = { ...(options.headers || {}) }
  if (token) headers.Authorization = `Bearer ${token}`

  const res = await fetch(path, { ...options, headers })
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
export const listLibrary = (tag, folder) => {
  const qs = new URLSearchParams()
  if (tag) qs.set('tag', tag)
  if (folder !== null && folder !== undefined) qs.set('folder', folder)
  const s = qs.toString()
  return req(`/api/library${s ? `?${s}` : ''}`)
}
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
