import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Icon from './Icon'

// A search takes 15-20s: translate the query, hit four sources, then synthesize.
// A single frozen label makes that feel broken, so walk through the stages the
// pipeline actually performs and show skeleton cards for the results to come.
// Timings are approximate — the last stage simply stays until the answer lands.
const STAGES = [
  { key: 'stageUnderstand', icon: 'sparkles', at: 0 },
  { key: 'stageRetrieve', icon: 'search', at: 2600 },
  { key: 'stageSynthesize', icon: 'quote', at: 7000 },
]

const DEEP_STAGES = [
  { key: 'stagePlan', icon: 'sparkles', at: 0 },
  { key: 'stageRetrieve', icon: 'search', at: 6000 },
  { key: 'stageReadFull', icon: 'bookOpen', at: 16000 },
  { key: 'stageSynthesize', icon: 'quote', at: 26000 },
]

export default function SearchProgress({ deep = false }) {
  const { t } = useTranslation()
  const [stage, setStage] = useState(0)
  const stages = deep ? DEEP_STAGES : STAGES

  useEffect(() => {
    setStage(0)
    const timers = stages.slice(1).map((s, i) =>
      setTimeout(() => setStage(i + 1), s.at)
    )
    return () => timers.forEach(clearTimeout)
  }, [deep])

  return (
    <div className="animate-rise">
      <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        {/* Indeterminate bar — we can't know real progress, so don't fake a % */}
        <div className="mb-4 h-1 overflow-hidden rounded-full bg-slate-100">
          <div className="progress-track h-full rounded-full bg-blue-500" />
        </div>

        <ul className="space-y-2">
          {stages.map((s, i) => {
            const done = i < stage
            const active = i === stage
            return (
              <li
                key={s.key}
                className={`flex items-center gap-2 text-sm transition-colors duration-300 ${
                  active
                    ? 'font-medium text-slate-800'
                    : done
                    ? 'text-slate-400'
                    : 'text-slate-300'
                }`}
              >
                <span className="flex h-5 w-5 items-center justify-center">
                  {done ? (
                    <Icon name="check" className="text-green-600" />
                  ) : active ? (
                    <Icon name={s.icon} className="animate-pulse text-blue-600" />
                  ) : (
                    <span className="h-1.5 w-1.5 rounded-full bg-current" />
                  )}
                </span>
                {t(s.key)}
              </li>
            )
          })}
        </ul>
      </div>

      {/* Placeholder cards so the layout doesn't jump when results arrive. */}
      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className="rounded-lg border border-slate-200 bg-white p-4"
            style={{ opacity: 1 - i * 0.18 }}
          >
            <div className="skeleton h-3 w-20 rounded" />
            <div className="skeleton mt-3 h-4 w-full rounded" />
            <div className="skeleton mt-2 h-4 w-4/5 rounded" />
            <div className="skeleton mt-3 h-3 w-1/2 rounded" />
          </div>
        ))}
      </div>
    </div>
  )
}
