import React, { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import * as api from '../lib/api'
import * as local from '../lib/localFolder'
import Icon from './Icon'

// Tidying the folder of PDFs on the reader's own computer.
//
// The folder is granted once, by name, in the operating system's own dialog.
// Gaze reads the first two pages of each PDF to find its DOI, asks the server
// which of them the library already holds, and then proposes renames and moves.
// The bytes never leave the machine — only a DOI and a title are sent, and the
// server is never told where the folder is or even that it has a path.
//
// The plan is shown in full before anything happens, for the same reason as in
// the librarian, but with more at stake: a wrong row in a database is one click
// to fix, and a folder of research PDFs renamed wrongly is somebody's work.
// Nothing is ever deleted; unmatched files are only moved if asked, and only
// into a sub-folder of the one already granted; and every change is written to
// a log inside the folder so it can be reversed by hand.

const STEPS = { idle: 0, scanning: 1, reading: 2, matching: 3, ready: 4, applying: 5, done: 6 }

export default function LocalFolderPanel({ teamId, onClose, onChanged }) {
  const { t } = useTranslation()
  const [handle, setHandle] = useState(null)
  const [step, setStep] = useState(STEPS.idle)
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [files, setFiles] = useState([])
  const [matches, setMatches] = useState(new Map())
  const [missing, setMissing] = useState([])
  const [plan, setPlan] = useState([])
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')
  const [intoFolders, setIntoFolders] = useState(true)
  const [moveUnmatched, setMoveUnmatched] = useState(false)

  const supported = local.isSupported()

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  // A folder granted on a previous visit, if the browser still honours it.
  useEffect(() => {
    if (!supported) return
    local.restoreFolder().then((h) => h && setHandle(h)).catch(() => {})
  }, [supported])

  const scan = useCallback(
    async (dir) => {
      setError('')
      setResult(null)
      try {
        setStep(STEPS.scanning)
        setProgress({ done: 0, total: 0 })
        const found = await local.scanPdfs(dir, {
          onProgress: (n) => setProgress({ done: 0, total: n }),
        })
        setFiles(found)
        if (!found.length) {
          setStep(STEPS.ready)
          setPlan([])
          setMatches(new Map())
          setMissing([])
          return
        }

        // Reading is the slow part — one PDF parse per file — so it reports
        // per file rather than leaving a spinner to imply something is stuck.
        setStep(STEPS.reading)
        const identified = []
        for (let i = 0; i < found.length; i += 1) {
          const id = await local.identify(found[i].handle)
          identified.push({ key: found[i].path, doi: id.doi, title: id.title })
          setProgress({ done: i + 1, total: found.length })
        }

        setStep(STEPS.matching)
        const r = await api.matchLocal(identified, teamId)
        const byKey = new Map((r.matches || []).map((m) => [m.key, m]))
        setMatches(byKey)
        setMissing(r.missing || [])
        setPlan(local.buildPlan(found, byKey, { intoFolders, moveUnmatched }))
        setStep(STEPS.ready)
      } catch (e) {
        setError(e?.message || t('localScanFailed'))
        setStep(STEPS.idle)
      }
    },
    [teamId, intoFolders, moveUnmatched, t]
  )

  // Re-plan when the options change; no need to re-read the PDFs for that.
  useEffect(() => {
    if (step === STEPS.ready && files.length) {
      setPlan(local.buildPlan(files, matches, { intoFolders, moveUnmatched }))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intoFolders, moveUnmatched])

  const choose = async () => {
    try {
      const dir = await local.pickFolder()
      setHandle(dir)
      scan(dir)
    } catch {
      /* the picker was dismissed; not an error */
    }
  }

  const reconnect = async () => {
    try {
      const dir = await local.restoreFolder({ prompt: true })
      if (dir) {
        setHandle(dir)
        scan(dir)
      } else {
        choose()
      }
    } catch {
      choose()
    }
  }

  const apply = async () => {
    if (!handle || !plan.length) return
    setStep(STEPS.applying)
    setProgress({ done: 0, total: plan.length })
    const moved = []
    const skipped = []
    for (let i = 0; i < plan.length; i += 1) {
      const change = plan[i]
      try {
        // Between planning and applying, the folder may have changed under us.
        // Refusing to overwrite is the only safe response.
        if (await local.exists(handle, change.to)) skipped.push(change)
        else {
          await local.moveFile(handle, change.from, change.to)
          moved.push(change)
        }
      } catch {
        skipped.push(change)
      }
      setProgress({ done: i + 1, total: plan.length })
    }
    try {
      if (moved.length) await local.appendLog(handle, moved)
    } catch {
      /* the log is a courtesy, not a precondition */
    }
    setResult({ moved: moved.length, skipped: skipped.length })
    setStep(STEPS.done)
    onChanged?.()
  }

  const matchedCount = files.filter((f) => matches.get(f.path)?.paper_id).length

  if (!supported) {
    return (
      <Shell onClose={onClose} t={t}>
        <div className="px-5 py-6">
          <p className="text-sm leading-6 text-slate-700">{t('localUnsupported')}</p>
          <p className="mt-2 text-xs leading-5 text-slate-500">{t('localUnsupportedHint')}</p>
        </div>
      </Shell>
    )
  }

  return (
    <Shell onClose={onClose} t={t}>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
        {!handle && (
          <div className="rounded-xl border-2 border-dashed border-slate-200 bg-slate-50 p-6 text-center">
            <button
              onClick={choose}
              className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white transition-all hover:bg-slate-800 active:scale-[0.98]"
            >
              <Icon name="folder" />
              {t('localChoose')}
            </button>
            <p className="mt-2 text-xs leading-5 text-slate-500">{t('localChooseHint')}</p>
          </div>
        )}

        {handle && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Icon name="folder" className="text-slate-400" />
            <span className="font-medium text-slate-700">{handle.name}</span>
            <button
              onClick={reconnect}
              className="rounded-md px-2 py-1 text-xs text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800"
            >
              {t('localRescan')}
            </button>
            <button
              onClick={choose}
              className="rounded-md px-2 py-1 text-xs text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800"
            >
              {t('localChangeFolder')}
            </button>
          </div>
        )}

        {step === STEPS.scanning && <Busy label={t('localScanning', { n: progress.total })} />}
        {step === STEPS.reading && (
          <Busy label={t('localReading', { done: progress.done, total: progress.total })} />
        )}
        {step === STEPS.matching && <Busy label={t('localMatching')} />}
        {step === STEPS.applying && (
          <Busy label={t('localApplying', { done: progress.done, total: progress.total })} />
        )}

        {step === STEPS.ready && files.length > 0 && (
          <>
            <div className="grid grid-cols-3 gap-2 text-center">
              <Stat n={files.length} label={t('localFound')} />
              <Stat n={matchedCount} label={t('localMatched')} tone="text-green-700" />
              <Stat n={missing.length} label={t('localMissing')} tone="text-amber-700" />
            </div>

            <div className="space-y-1.5 rounded-lg border border-slate-200 p-3">
              <Toggle
                checked={intoFolders}
                onChange={setIntoFolders}
                label={t('localIntoFolders')}
              />
              <Toggle
                checked={moveUnmatched}
                onChange={setMoveUnmatched}
                label={t('localMoveUnmatched', { dir: `${local.GAZE_DIR}/${local.UNMATCHED_DIR}` })}
              />
            </div>

            {plan.length === 0 ? (
              <p className="text-sm text-slate-500">{t('localNothingToDo')}</p>
            ) : (
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                <p className="mb-2 text-xs font-medium text-slate-600">
                  {t('localProposes', { n: plan.length })}
                </p>
                <ul className="max-h-64 space-y-1.5 overflow-y-auto">
                  {plan.map((c) => (
                    <li key={c.from} className="text-xs leading-5">
                      <span className="block truncate text-slate-500 line-through">{c.from}</span>
                      <span className="block truncate font-medium text-slate-800">{c.to}</span>
                    </li>
                  ))}
                </ul>
                <button
                  onClick={apply}
                  className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white transition-all hover:bg-slate-800 active:scale-[0.98]"
                >
                  <Icon name="check" />
                  {t('localApply')}
                </button>
              </div>
            )}

            {missing.length > 0 && (
              <details className="rounded-lg border border-slate-200 p-3">
                <summary className="cursor-pointer text-sm text-slate-700">
                  {t('localMissingTitle', { n: missing.length })}
                </summary>
                <ul className="mt-2 space-y-1">
                  {missing.slice(0, 40).map((m) => (
                    <li key={m.paper_id} className="truncate text-xs text-slate-500">
                      {m.title}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </>
        )}

        {step === STEPS.ready && handle && files.length === 0 && (
          <p className="text-sm text-slate-500">{t('localNoPdfs')}</p>
        )}

        {step === STEPS.done && result && (
          <div className="rounded-xl border border-green-200 bg-green-50 p-3 text-sm">
            <p className="font-medium text-green-800">{t('localDone', { n: result.moved })}</p>
            {result.skipped > 0 && (
              <p className="mt-1 text-xs text-amber-700">
                {t('localSkipped', { n: result.skipped })}
              </p>
            )}
            <p className="mt-1 text-xs leading-5 text-slate-600">
              {t('localLogWritten', { path: `${local.GAZE_DIR}/${local.LOG_FILE}` })}
            </p>
          </div>
        )}

        {error && <p className="text-sm text-red-600">{error}</p>}
      </div>
      <p className="border-t border-slate-100 px-5 py-2 text-xs leading-5 text-slate-400">
        {t('localSafety')}
      </p>
    </Shell>
  )
}

function Shell({ children, onClose, t }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <div className="absolute inset-0 bg-slate-900/25" onClick={onClose} />
      <div className="animate-rise relative flex max-h-[88vh] w-full max-w-xl flex-col rounded-t-2xl border border-slate-200 bg-white shadow-xl sm:rounded-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-5 py-4">
          <div className="min-w-0">
            <h2 className="flex items-center gap-1.5 text-base font-semibold text-slate-900">
              <Icon name="folder" className="text-blue-500" />
              {t('localTitle')}
            </h2>
            <p className="mt-0.5 text-xs leading-5 text-slate-500">{t('localSubtitle')}</p>
          </div>
          <button
            onClick={onClose}
            className="shrink-0 rounded-md p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
            title={t('close')}
          >
            <Icon name="x" />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

const Busy = ({ label }) => (
  <p className="flex items-center gap-2 text-sm text-slate-500">
    <Icon name="refresh" className="animate-spin text-slate-400" />
    {label}
  </p>
)

const Stat = ({ n, label, tone = 'text-slate-800' }) => (
  <div className="rounded-lg border border-slate-200 py-2">
    <p className={`text-lg font-semibold ${tone}`}>{n}</p>
    <p className="text-xs text-slate-500">{label}</p>
  </div>
)

const Toggle = ({ checked, onChange, label }) => (
  <label className="flex cursor-pointer items-start gap-2 text-sm text-slate-700">
    <input
      type="checkbox"
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
      className="mt-0.5 h-4 w-4 shrink-0 rounded border-slate-300 accent-slate-900"
    />
    <span className="leading-5">{label}</span>
  </label>
)
