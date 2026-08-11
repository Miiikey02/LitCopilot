import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Icon from './Icon'

// A search takes 15-20s and a deep run 40-60s: translate the query, hit four
// sources, then synthesize. A single frozen label makes that feel broken, so
// walk through the stages the pipeline actually performs.
//
// Honest by construction: the stages are the real steps, and the source chips
// light up during the retrieval stage because all four ARE being queried. No
// fake percentages and no invented counts — real numbers only appear once the
// run returns them.
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

const SOURCES = ['PubMed', 'Semantic Scholar', 'OpenAlex', 'bioRxiv']

export default function SearchProgress({ deep = false }) {
  const { t } = useTranslation()
  const [stage, setStage] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const stages = deep ? DEEP_STAGES : STAGES
  const retrieveIndex = stages.findIndex((s) => s.key === 'stageRetrieve')

  useEffect(() => {
    setStage(0)
    const timers = stages.slice(1).map((s, i) =>
      setTimeout(() => setStage(i + 1), s.at)
    )
    const tick = setInterval(() => setElapsed((e) => e + 1), 1000)
    return () => {
      timers.forEach(clearTimeout)
      clearInterval(tick)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deep])

  return (
    <div className="animate-rise">
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="h-1 bg-slate-100">
          <div className="progress-track h-full rounded-full bg-gradient-to-r from-blue-500 to-teal-400" />
        </div>

        <div className="p-5">
          <ul className="space-y-2.5">
            {stages.map((s, i) => {
              const done = i < stage
              const active = i === stage
              return (
                <li key={s.key}>
                  <div
                    className={`flex items-center gap-2.5 text-sm transition-all duration-500 ${
                      active
                        ? 'font-medium text-slate-800'
                        : done
                        ? 'text-slate-400'
                        : 'text-slate-300'
                    }`}
                  >
                    <span className="relative flex h-5 w-5 items-center justify-center">
                      {done ? (
                        <Icon name="check" className="animate-rise text-green-600" />
                      ) : active ? (
                        <>
                          <span className="absolute inline-flex h-5 w-5 animate-ping rounded-full bg-blue-400 opacity-30" />
                          <Icon name={s.icon} className="relative text-blue-600" />
                        </>
                      ) : (
                        <span className="h-1.5 w-1.5 rounded-full bg-current" />
                      )}
                    </span>
                    {t(s.key)}
                  </div>

                  {/* During retrieval, show the four databases being queried. */}
                  {i === retrieveIndex && (done || active) && (
                    <div className="ml-7 mt-1.5 flex flex-wrap gap-1.5">
                      {SOURCES.map((src, k) => (
                        <span
                          key={src}
                          style={{ animationDelay: `${k * 120}ms` }}
                          className={`animate-rise rounded-full px-2 py-0.5 text-xs transition-colors duration-500 ${
                            done
                              ? 'bg-green-50 text-green-700'
                              : 'bg-blue-50 text-blue-700'
                          }`}
                        >
                          {!done && (
                            <span className="mr-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-blue-500 align-middle" />
                          )}
                          {src}
                        </span>
                      ))}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>

          <p className="mt-4 border-t border-slate-100 pt-3 text-xs text-slate-400">
            {t('elapsed', { n: elapsed })}
            {deep && ` · ${t('deepTakesLonger')}`}
          </p>
        </div>
      </div>

      {/* Placeholder cards so the layout doesn't jump when results arrive. */}
      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className="rounded-xl border border-slate-200 bg-white p-4"
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
