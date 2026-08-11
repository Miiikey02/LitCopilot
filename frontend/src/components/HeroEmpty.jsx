import React from 'react'
import { useTranslation } from 'react-i18next'
import Icon from './Icon'

// The first thing a new visitor sees. A dashed empty box told them nothing —
// this states what Gaze does, and gives real questions they can run with one
// click, which is the fastest way to understand the product.
export default function HeroEmpty({ onPick, onDeepPick }) {
  const { t, i18n } = useTranslation()
  const zh = i18n.language.startsWith('zh')

  const examples = zh
    ? [
        '青光眼神经保护治疗的最新证据',
        'CRISPR 递送方法治疗囊性纤维化',
        '肠道菌群与代谢疾病的关系',
        'GLP-1 受体激动剂的心血管获益',
      ]
    : [
        'Latest evidence for neuroprotection in glaucoma',
        'CRISPR delivery methods for cystic fibrosis',
        'Gut microbiota and metabolic disease',
        'Cardiovascular benefits of GLP-1 receptor agonists',
      ]

  const features = [
    { icon: 'search', key: 'featSources' },
    { icon: 'quote', key: 'featCited' },
    { icon: 'alert', key: 'featRetraction' },
    { icon: 'sparkles', key: 'featDeep' },
  ]

  return (
    <div className="animate-rise">
      {/* Hero */}
      <div className="relative overflow-hidden rounded-2xl border border-slate-200 bg-white px-6 py-12 text-center shadow-sm sm:px-10 sm:py-16">
        {/* Soft depth behind the headline, not a decorative image. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 -top-24 h-64 bg-gradient-to-b from-blue-100/70 via-sky-50/50 to-transparent blur-2xl"
        />
        <div className="relative">
          <h2 className="mx-auto max-w-2xl text-3xl font-bold leading-tight tracking-tight text-slate-900 sm:text-4xl">
            {t('heroTitle')}{' '}
            <span className="bg-gradient-to-r from-blue-600 to-teal-500 bg-clip-text text-transparent">
              {t('heroTitleAccent')}
            </span>
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-[15px] leading-7 text-slate-500">
            {t('heroSubtitle')}
          </p>

          {/* One click to a real result — the fastest way to "get" the tool. */}
          <div className="mt-7">
            <p className="mb-2.5 text-xs font-medium uppercase tracking-wide text-slate-400">
              {t('tryOne')}
            </p>
            <div className="flex flex-wrap justify-center gap-2">
              {examples.map((ex) => (
                <button
                  key={ex}
                  onClick={() => onPick(ex)}
                  className="group rounded-full border border-slate-200 bg-white px-4 py-2 text-sm text-slate-700 shadow-sm transition-all hover:-translate-y-0.5 hover:border-blue-300 hover:text-blue-700 hover:shadow"
                >
                  {ex}
                  <Icon
                    name="send"
                    className="ml-1.5 text-slate-300 transition-colors group-hover:text-blue-500"
                  />
                </button>
              ))}
            </div>
          </div>

          <button
            onClick={() => onDeepPick(examples[0])}
            className="mt-6 inline-flex items-center gap-1.5 rounded-full bg-slate-900 px-5 py-2.5 text-sm font-medium text-white transition-all hover:-translate-y-0.5 hover:bg-slate-800 hover:shadow-lg"
          >
            <Icon name="sparkles" />
            {t('tryDeep')}
          </button>
        </div>
      </div>

      {/* What it actually does, in four claims that are all verifiable. */}
      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {features.map((f) => (
          <div
            key={f.key}
            className="rounded-xl border border-slate-200 bg-white p-4 transition-all hover:-translate-y-0.5 hover:shadow-md"
          >
            <Icon name={f.icon} className="mb-2 h-5 w-5 text-blue-600" />
            <p className="text-sm leading-6 text-slate-600">{t(f.key)}</p>
          </div>
        ))}
      </div>
    </div>
  )
}
