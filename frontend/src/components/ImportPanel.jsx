import React, { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import * as api from '../lib/api'
import Icon from './Icon'

// Bringing an existing reference library in.
//
// Two ways in, because there are two kinds of user: one has a file exported
// from EndNote or Zotero, the other has a list of DOIs in an email. Both end
// up at the same endpoint — the server identifies the format from the content,
// so nobody is asked to name it.
//
// Importing is slow by necessity: every reference is looked up against PubMed
// or OpenAlex, one at a time, so a few hundred references take minutes. That
// makes progress the main thing this panel shows. It is a real count from the
// server, not an animation — a lab importing a decade of papers should be able
// to close the tab and come back.

const ACCEPT = '.ris,.bib,.bibtex,.enw,.nbib,.medline,.xml,.json,.txt'
const POLL_MS = 1500

function Bar({ job }) {
  const { t } = useTranslation()
  const pct = job.total ? Math.round((job.done / job.total) * 100) : 0
  const running = job.status === 'running'
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
      <div className="mb-2 flex items-center justify-between text-sm">
        <span className="truncate font-medium text-slate-700">
          {job.filename || t('importPasted')}
        </span>
        <span className="shrink-0 pl-2 text-xs text-slate-500">
          {job.done} / {job.total}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
        <div
          className={`h-full rounded-full transition-[width] duration-500 ${
            running ? 'bg-blue-500' : job.status === 'done' ? 'bg-green-500' : 'bg-amber-500'
          }`}
          style={{ width: `${Math.max(pct, running ? 4 : 100)}%` }}
        />
      </div>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs">
        <span className="text-green-700">{t('importAdded', { n: job.added })}</span>
        {job.duplicates > 0 && (
          <span className="text-slate-500">{t('importDuplicates', { n: job.duplicates })}</span>
        )}
        {job.failed > 0 && (
          <span className="text-amber-700">{t('importFailed', { n: job.failed })}</span>
        )}
        {running && <span className="text-blue-600">{t('importRunning')}</span>}
      </div>
      {/* A stopped job is not a mystery: it says what happened, and what it
          managed to file before it stopped is already in the library. */}
      {job.note && <p className="mt-1 text-xs text-amber-700">{job.note}</p>}
    </div>
  )
}

export default function ImportPanel({ folders = [], folderId, teamId, onClose, onChanged }) {
  const { t } = useTranslation()
  const [pasted, setPasted] = useState('')
  const [target, setTarget] = useState(folderId ? String(folderId) : '')
  const [jobs, setJobs] = useState([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [dragging, setDragging] = useState(false)
  const input = useRef(null)
  const live = useRef(true)

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    return () => {
      live.current = false
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  // Poll while anything is still running. The library refreshes as rows land,
  // so papers appear behind the panel rather than all at once at the end.
  useEffect(() => {
    if (!jobs.some((j) => j.status === 'running')) return undefined
    const timer = setInterval(async () => {
      const running = jobs.filter((j) => j.status === 'running')
      const updated = await Promise.all(
        running.map((j) => api.importStatus(j.id).catch(() => null))
      )
      if (!live.current) return
      const byId = new Map(updated.filter(Boolean).map((j) => [j.id, j]))
      if (byId.size) {
        setJobs((prev) => prev.map((j) => byId.get(j.id) || j))
        onChanged?.()
      }
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [jobs, onChanged])

  const start = async (content, filename) => {
    setBusy(true)
    setError('')
    try {
      const job = await api.libraryImport(
        content,
        filename,
        target ? Number(target) : null,
        teamId ? Number(teamId) : null
      )
      setJobs((prev) => [job, ...prev])
    } catch (e) {
      setError(e.message || t('importFailedToStart'))
    } finally {
      setBusy(false)
    }
  }

  const takeFiles = async (files) => {
    for (const file of Array.from(files || [])) {
      // Read as text: every supported format is text, and a PDF dropped here
      // belongs in the PDF upload above, which says so.
      const text = await file.text().catch(() => '')
      if (text.trim()) await start(text, file.name)
    }
  }

  const anyRunning = jobs.some((j) => j.status === 'running')

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <div className="absolute inset-0 bg-slate-900/25" onClick={onClose} />
      <div className="animate-rise relative flex max-h-[88vh] w-full max-w-xl flex-col rounded-t-2xl border border-slate-200 bg-white shadow-xl sm:rounded-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-5 py-4">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-slate-900">{t('importTitle')}</h2>
            <p className="mt-0.5 text-xs leading-5 text-slate-500">{t('importSubtitle')}</p>
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
          <div
            onDragOver={(e) => {
              e.preventDefault()
              setDragging(true)
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault()
              setDragging(false)
              takeFiles(e.dataTransfer.files)
            }}
            className={`rounded-xl border-2 border-dashed p-5 text-center transition-colors ${
              dragging ? 'border-blue-400 bg-blue-50' : 'border-slate-200 bg-slate-50'
            }`}
          >
            <input
              ref={input}
              type="file"
              accept={ACCEPT}
              multiple
              className="hidden"
              onChange={(e) => {
                const files = e.target.files
                e.target.value = ''
                takeFiles(files)
              }}
            />
            <button
              onClick={() => input.current?.click()}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white transition-all hover:bg-slate-800 active:scale-[0.98] disabled:opacity-60"
            >
              <Icon name="filePlus" />
              {t('importChooseFile')}
            </button>
            <p className="mt-2 text-xs leading-5 text-slate-500">{t('importFormats')}</p>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">
              {t('importPasteLabel')}
            </label>
            <textarea
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
              rows={3}
              placeholder={"10.1038/s41586-020-2649-2\n33268894"}
              className="w-full resize-y rounded-lg border border-slate-200 p-2 text-sm text-slate-800 outline-none transition-colors focus:border-blue-400"
            />
            <button
              onClick={() => {
                const text = pasted.trim()
                if (!text) return
                setPasted('')
                start(text, '')
              }}
              disabled={busy || !pasted.trim()}
              className="mt-1 inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-700 transition-colors hover:border-blue-300 hover:text-blue-700 disabled:opacity-50"
            >
              <Icon name="plus" />
              {t('importPasteAction')}
            </button>
          </div>

          {folders.length > 0 && (
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">
                {t('importFolderLabel')}
              </label>
              <select
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                className="w-full rounded-lg border border-slate-200 bg-white p-2 text-sm text-slate-800 outline-none focus:border-blue-400"
              >
                <option value="">{t('importNoFolder')}</option>
                {folders
                  .filter((f) => f.id !== null && f.id !== undefined)
                  .map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
              </select>
            </div>
          )}

          {error && <p className="text-xs leading-5 text-red-600">{error}</p>}

          {jobs.length > 0 && (
            <div className="space-y-2">
              {jobs.map((job) => (
                <Bar key={job.id} job={job} />
              ))}
              {anyRunning && (
                <p className="text-xs leading-5 text-slate-500">{t('importKeepOpenHint')}</p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
