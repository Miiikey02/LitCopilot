// Thin API client for the Gaze backend.

async function req(path, options) {
  const res = await fetch(path, options)
  if (!res.ok) {
    throw new Error(`${options?.method || 'GET'} ${path} failed: ${res.status}`)
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
export const search = (query, lang, limit, includePreprints = true) =>
  jsonPost('/api/search', {
    query,
    lang: lang || null,
    limit: limit ?? null,
    include_preprints: includePreprints,
  })

// --- Research agent (multi-turn follow-ups) ---
export const chat = (sessionId, message, lang) =>
  jsonPost('/api/chat', { session_id: sessionId, message, lang: lang || null })

// --- Library ---
export const saveLibrary = (paper) => jsonPost('/api/library/save', paper)
export const listLibrary = (tag) =>
  req(`/api/library${tag ? `?tag=${encodeURIComponent(tag)}` : ''}`)
export const deletePaper = (id) => req(`/api/library/${id}`, { method: 'DELETE' })
export const addTag = (id, tag) => jsonPost(`/api/library/${id}/tags`, { tag })
export const removeTag = (id, tag) =>
  req(`/api/library/${id}/tags/${encodeURIComponent(tag)}`, { method: 'DELETE' })
export const listTags = () => req('/api/library/tags')

// --- History ---
export const listHistory = () => req('/api/history')
export const clearHistory = () => req('/api/history', { method: 'DELETE' })

// --- Clinical trials ---
export const findTrials = (query) => jsonPost('/api/trials', { query })
