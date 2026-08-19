import React from 'react'
import { useTranslation } from 'react-i18next'
import AnswerText from './AnswerText'
import Icon from './Icon'
import CountUp from './CountUp'

// The deep-research brief: a cited answer, the disagreements and gaps the
// agent found, and an auditable notebook of what it searched and read.
export default function DeepResearchView({ result, citationKeys, onCite }) {
  const { t } = useTranslation()
  if (!result) return null

  return (
    <div className="animate-rise space-y-4">
      <section className="animate-glow rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Icon name="sparkles" className="text-blue-600" />
          <h2 className="text-lg font-semibold text-slate-900">{t('deepBrief')}</h2>
          {/* Real values returned by the run, counted up on arrival. */}
          <span className="flex flex-wrap items-center gap-x-3 text-xs text-slate-500">
            <span>
              <CountUp
                value={result.sub_questions.length}
                className="font-semibold text-slate-800"
              />{' '}
              {t('metaSubs')}
            </span>
            <span>
              <CountUp
                value={result.sources.length}
                className="font-semibold text-slate-800"
              />{' '}
              {t('metaPapers')}
            </span>
            <span>
              <CountUp
                value={result.full_text_read}
                className="font-semibold text-green-700"
              />{' '}
              {t('metaFull')}
            </span>
          </span>
        </div>

        {result.warning && (
          <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            {result.warning}
          </div>
        )}

        {result.answer ? (
          <AnswerText
            text={result.answer}
            citationKeys={citationKeys}
            onCite={onCite}
          />
        ) : (
          <p className="text-slate-500">{t('noAnswer')}</p>
        )}
      </section>

      {/* Disagreement is signal, not noise — show it rather than smoothing it. */}
      {result.contradictions?.length > 0 && (
        <section className="rounded-xl border border-amber-200 bg-amber-50/60 p-5">
          <h3 className="mb-2 flex items-center gap-2 font-semibold text-amber-900">
            <Icon name="alert" />
            {t('contradictions')}
          </h3>
          <ul className="space-y-1.5">
            {result.contradictions.map((c, i) => (
              <li key={i} className="text-sm leading-6 text-amber-900">
                • <AnswerText text={c} citationKeys={citationKeys} onCite={onCite} inline />
              </li>
            ))}
          </ul>
        </section>
      )}

      {result.gaps?.length > 0 && (
        <section className="rounded-xl border border-slate-200 bg-white p-5">
          <h3 className="mb-2 flex items-center gap-2 font-semibold text-slate-800">
            <Icon name="search" className="text-slate-400" />
            {t('gaps')}
          </h3>
          <ul className="space-y-1.5">
            {result.gaps.map((g, i) => (
              <li key={i} className="text-sm leading-6 text-slate-700">
                • <AnswerText text={g} citationKeys={citationKeys} onCite={onCite} inline />
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* The notebook: what was asked, searched and read, so a run is auditable. */}
      <details className="rounded-xl border border-slate-200 bg-white p-5" open>
        <summary className="cursor-pointer font-semibold text-slate-800">
          <Icon name="bookOpen" className="mr-2 text-slate-400" />
          {t('notebook')}
        </summary>
        <ol className="stagger mt-3 space-y-3">
          {result.sub_questions.map((s, i) => {
            // `sources` was added after some threads were saved. Absent means
            // "this record does not say", which is not the same as "none" —
            // claiming none for an old thread told the reader something false
            // about every step of it.
            const recorded = Array.isArray(s.sources)
            const used = recorded
              ? s.sources.map((n) => result.sources[n]).filter(Boolean)
              : []
            return (
              <li key={i} className="border-l-2 border-slate-200 pl-3">
                <div className="text-sm font-medium text-slate-800">{s.question}</div>
                <div className="mt-0.5 text-xs text-slate-400">
                  <code className="rounded bg-slate-50 px-1 py-0.5">{s.search}</code>
                  {' · '}
                  {t('foundPapers', { n: s.found })}
                  {recorded && s.found > 0 && (
                    <>
                      {' · '}
                      <span className={used.length ? '' : 'text-amber-600'}>
                        {used.length
                          ? t('stepKept', { n: used.length })
                          : t('stepKeptNone')}
                      </span>
                    </>
                  )}
                  {!recorded && s.found > 0 && (
                    <>{' · '}<span className="text-slate-400">{t('stepUnrecorded')}</span></>
                  )}
                </div>

                {/* Listed, not hidden behind a disclosure. Checking the
                    evidence is the reason to open a research record at all,
                    and a step whose papers take a click to see is a step most
                    readers never verify. */}
                {used.length > 0 && (
                  <ul className="mt-1.5 space-y-1">
                    {used.map((paper) => (
                      <li
                        key={paper.citation_key + paper.source_id}
                        className="flex items-baseline gap-1.5 text-xs leading-5"
                      >
                        <span className="shrink-0 text-slate-300">·</span>
                        <span className="min-w-0">
                          <button
                            onClick={() => onCite?.(paper.citation_key)}
                            className="text-left text-slate-600 hover:text-blue-700 hover:underline"
                          >
                            <span className="font-medium text-slate-700">
                              {paper.citation_key}
                            </span>
                            {' — '}
                            {paper.title}
                          </button>
                          {paper.url && (
                            <a
                              href={paper.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              title={t('viewSource')}
                              className="ml-1 inline-block text-slate-400 hover:text-blue-700"
                            >
                              <Icon name="externalLink" />
                            </a>
                          )}
                          {paper.retraction_status === 'retracted' && (
                            <span className="ml-1 rounded bg-red-50 px-1 text-[10px] text-red-700">
                              {t('retracted')}
                            </span>
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            )
          })}
        </ol>
      </details>
    </div>
  )
}
