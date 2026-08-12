import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import CiteButton from './CiteButton'
import Icon from './Icon'

const sourceLabel = {
  pubmed: 'PubMed',
  semantic_scholar: 'Semantic Scholar',
  openalex: 'OpenAlex',
  biorxiv: 'bioRxiv',
}

const SourceCard = React.forwardRef(function SourceCard(
  { paper, index, onSave },
  ref
) {
  const { t } = useTranslation()
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)

  const handleSave = async () => {
    if (saved || saving) return
    setSaving(true)
    try {
      await onSave(paper)
      setSaved(true)
    } catch {
      // Surface nothing intrusive; leave the button retryable.
    } finally {
      setSaving(false)
    }
  }
  return (
    <div
      ref={ref}
      data-cite={paper.citation_key}
      className="card-hover rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
          {index + 1} · {sourceLabel[paper.source] || paper.source}
        </span>
        <span className="flex items-center gap-1.5">
          {paper.evidence_type && (
            <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-xs text-indigo-700">
              {t(`ev_${paper.evidence_type}`, paper.evidence_type)}
            </span>
          )}
          {paper.has_full_text && (
            <span
              className="rounded-full bg-green-50 px-2 py-0.5 text-xs text-green-700"
              title={t('fullTextRead')}
            >
              <Icon name="bookOpen" />
            </span>
          )}
          <span className="text-xs font-medium text-blue-700">
            [{paper.citation_key}]
          </span>
        </span>
      </div>

      {paper.retraction_status && (
        <div
          className={`mb-2 flex items-start gap-1.5 rounded-md border px-2 py-1.5 text-xs ${
            paper.retraction_status === 'retracted'
              ? 'border-red-200 bg-red-50 text-red-800'
              : 'border-amber-200 bg-amber-50 text-amber-900'
          }`}
        >
          <Icon name="alert" className="mt-0.5 shrink-0" />
          <span>
            <span className="font-semibold">
              {paper.retraction_status === 'retracted'
                ? t('retracted')
                : t('concernRaised')}
            </span>
            {' · '}
            {t('retractedHint')}
          </span>
        </div>
      )}
      {/* Title: Chinese translation first (Chinese-first), English below. */}
      {paper.title_zh && (
        <h3 className="mb-0.5 font-semibold leading-6 text-slate-900">
          {paper.title_zh}
        </h3>
      )}
      <p className="text-sm leading-6 text-slate-600">{paper.title}</p>

      <p className="mt-2 text-xs text-slate-500">
        {paper.authors.slice(0, 4).join(', ')}
        {paper.authors.length > 4 ? ' et al.' : ''}
        {paper.year ? ` · ${paper.year}` : ''}
        {paper.venue ? ` · ${paper.venue}` : ''}
      </p>

      {paper.relevance_zh && (
        <div className="mt-3 rounded-md bg-amber-50 p-2 text-sm text-amber-900">
          <span className="font-medium">{t('whyRelevant')}：</span>
          {paper.relevance_zh}
        </div>
      )}

      {/* Same grouping as the library card: what you do with the paper on the
          left, saving pinned right, wrapping as groups rather than dropping
          one button onto a second line. */}
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <a
          href={paper.url}
          target="_blank"
          rel="noopener noreferrer"
          className="whitespace-nowrap text-sm font-medium text-blue-600 hover:text-blue-800 hover:underline"
        >
          {t('viewSource')} <Icon name="externalLink" className="ml-0.5" />
        </a>
        {paper.oa_url && (
          <a
            href={paper.oa_url}
            target="_blank"
            rel="noopener noreferrer"
            className="whitespace-nowrap text-sm font-medium text-green-700 hover:text-green-800 hover:underline"
          >
            <Icon name="download" className="mr-1" />{t('freeFullText')}
          </a>
        )}
        <CiteButton paper={paper} />
        {onSave && (
          <button
            type="button"
            onClick={handleSave}
            disabled={saved || saving}
            className={
              saved
                ? 'ml-auto whitespace-nowrap text-sm font-medium text-green-600'
                : 'ml-auto whitespace-nowrap text-sm font-medium text-slate-600 hover:text-slate-900 disabled:opacity-50'
            }
          >
            {saved ? <><Icon name="check" className="mr-1" />{t('saved')}</> : <><Icon name="star" className="mr-1" />{t('save')}</>}
          </button>
        )}
      </div>
    </div>
  )
})

export default SourceCard
