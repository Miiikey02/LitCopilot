import React from 'react'
import { useTranslation } from 'react-i18next'
import Icon from './Icon'
import { UPDATES } from '../lib/updates'

// What changed, by date.
//
// Grouped by release rather than listed as a flat feed: a reader who was away
// for a week wants to know what is different now, not to reconstruct it from
// twenty individual changes. Fixes are kept alongside features rather than
// hidden, because "the thing that was broken for you is fixed" is often the
// entry someone came here to find.

const KIND = {
  feature: { label: 'updateFeature', icon: 'sparkles', tone: 'bg-blue-50 text-blue-700' },
  change: { label: 'updateChange', icon: 'refresh', tone: 'bg-slate-100 text-slate-600' },
  fix: { label: 'updateFix', icon: 'check', tone: 'bg-green-50 text-green-700' },
}

export default function Updates() {
  const { t, i18n } = useTranslation()
  const zh = i18n.language.startsWith('zh')
  const pick = (v) => (typeof v === 'string' ? v : zh ? v.zh : v.en)

  return (
    <div className="animate-rise">
      <header className="mb-6">
        <h2 className="text-2xl font-bold tracking-tight text-slate-900">
          {t('updatesTitle')}
        </h2>
        <p className="mt-1 text-sm leading-6 text-slate-500">{t('updatesIntro')}</p>
      </header>

      <ol className="relative border-l border-slate-200 pl-6">
        {UPDATES.map((release, i) => (
          <li key={release.date} className="mb-8 last:mb-0">
            <span
              className={`absolute -left-[7px] mt-1.5 h-3 w-3 rounded-full border-2 border-white ${
                i === 0 ? 'bg-blue-500' : 'bg-slate-300'
              }`}
              aria-hidden="true"
            />
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h3 className="text-base font-semibold text-slate-900">
                {pick(release.title)}
              </h3>
              <time className="text-xs text-slate-400">{release.date}</time>
              {i === 0 && (
                <span className="rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700">
                  {t('updateLatest')}
                </span>
              )}
            </div>

            <ul className="mt-3 space-y-2.5">
              {release.items.map((item, k) => {
                const kind = KIND[item.kind] || KIND.change
                return (
                  <li key={k} className="flex gap-2.5">
                    <span
                      className={`mt-0.5 inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${kind.tone}`}
                    >
                      <Icon name={kind.icon} />
                      {t(kind.label)}
                    </span>
                    <p className="min-w-0 flex-1 text-sm leading-7 text-slate-700">
                      {pick(item)}
                    </p>
                  </li>
                )
              })}
            </ul>
          </li>
        ))}
      </ol>

      <p className="mt-8 border-t border-slate-100 pt-4 text-xs leading-6 text-slate-400">
        {t('updatesFooter')}
      </p>
    </div>
  )
}
