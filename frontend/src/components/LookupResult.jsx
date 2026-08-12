import React from 'react'
import { useTranslation } from 'react-i18next'
import Icon from './Icon'

// The answer to "is this the paper?" — shown before opening 精读模式, so a
// mistyped DOI or the wrong edition is caught here rather than after a window
// opens on the wrong article.
export default function LookupResult({ result, identifier, onSave, saving, saved }) {
  const { t } = useTranslation()
  const p = result.paper

  const openReader = () =>
    window.open(`/read?id=${encodeURIComponent(identifier)}`, '_blank', 'noopener')

  return (
    <div className="animate-rise overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="p-5">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-semibold leading-6 text-slate-900">
              {p.title}
            </h3>
            {p.title_zh && (
              <p className="mt-1 text-sm text-slate-500">{p.title_zh}</p>
            )}
            <p className="mt-1.5 text-sm text-slate-500">
              {(p.authors || []).slice(0, 6).join(', ')}
              {(p.authors || []).length > 6 && ' et al.'}
              {p.venue && ` · ${p.venue}`}
              {p.year && ` · ${p.year}`}
            </p>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1.5">
            {result.has_full_text ? (
              <span className="rounded-full bg-green-50 px-2 py-0.5 text-xs text-green-700">
                {t('fullTextBadge')}
              </span>
            ) : (
              <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-700">
                {t('abstractOnlyBadge')}
              </span>
            )}
          </div>
        </div>

        {/* Integrity first: nobody should open a retracted paper unwarned. */}
        {p.retraction_status === 'retracted' && (
          <div className="mt-3 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
            <Icon name="alert" className="mr-1" />
            {t('retracted')} · {t('retractedHint')}
          </div>
        )}
        {p.retraction_status === 'concern' && (
          <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            <Icon name="alert" className="mr-1" />
            {t('concern')}
          </div>
        )}
        {result.exact === false && (
          <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            <Icon name="alert" className="mr-1" />
            {t('lookupInexact')}
          </div>
        )}
        {result.warning && (
          <p className="mt-3 rounded-md bg-slate-50 p-2.5 text-xs leading-5 text-slate-500">
            {result.warning}
          </p>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            onClick={openReader}
            className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition-all hover:-translate-y-0.5 hover:bg-slate-800 hover:shadow active:translate-y-0 active:scale-[0.98]"
          >
            <Icon name="bookOpen" />
            {t('openReader')}
          </button>
          {onSave && (
            <button
              onClick={onSave}
              disabled={saving || saved}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3.5 py-2 text-sm text-slate-700 transition-colors hover:border-blue-300 hover:text-blue-700 disabled:opacity-60"
            >
              <Icon name={saved ? 'check' : 'star'} />
              {saved ? t('saved') : t('save')}
            </button>
          )}
          {p.url && (
            <a
              href={p.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 px-2 py-2 text-sm text-slate-500 transition-colors hover:text-blue-700"
            >
              {t('viewSource')} <Icon name="externalLink" />
            </a>
          )}
        </div>
      </div>
    </div>
  )
}
