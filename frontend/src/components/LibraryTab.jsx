import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import * as api from '../lib/api'

const sourceLabel = { pubmed: 'PubMed', semantic_scholar: 'Semantic Scholar' }

function LibraryCard({ paper, onChanged }) {
  const { t } = useTranslation()
  const [newTag, setNewTag] = useState('')

  const addTag = async (e) => {
    e.preventDefault()
    const tag = newTag.trim()
    if (!tag) return
    await api.addTag(paper.id, tag)
    setNewTag('')
    onChanged()
  }

  const removeTag = async (tag) => {
    await api.removeTag(paper.id, tag)
    onChanged()
  }

  const remove = async () => {
    await api.deletePaper(paper.id)
    onChanged()
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
          {sourceLabel[paper.source] || paper.source}
        </span>
        <span className="text-xs font-medium text-blue-700">[{paper.citation_key}]</span>
      </div>

      {paper.title_zh && (
        <h3 className="mb-0.5 font-semibold leading-6 text-slate-900">{paper.title_zh}</h3>
      )}
      <p className="text-sm leading-6 text-slate-600">{paper.title}</p>
      <p className="mt-2 text-xs text-slate-500">
        {paper.authors.slice(0, 4).join(', ')}
        {paper.authors.length > 4 ? ' et al.' : ''}
        {paper.year ? ` · ${paper.year}` : ''}
        {paper.venue ? ` · ${paper.venue}` : ''}
      </p>

      {/* Tags */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {paper.tags.map((tag) => (
          <span
            key={tag}
            className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2 py-0.5 text-xs text-blue-700"
          >
            {tag}
            <button
              type="button"
              onClick={() => removeTag(tag)}
              className="text-blue-400 hover:text-blue-700"
              aria-label="remove tag"
            >
              ×
            </button>
          </span>
        ))}
        <form onSubmit={addTag} className="inline-flex">
          <input
            value={newTag}
            onChange={(e) => setNewTag(e.target.value)}
            placeholder={t('addTagPlaceholder')}
            className="w-44 rounded-l-md border border-slate-300 px-2 py-0.5 text-xs focus:border-blue-500 focus:outline-none"
          />
          <button
            type="submit"
            className="rounded-r-md border border-l-0 border-slate-300 bg-slate-50 px-2 py-0.5 text-xs text-slate-600 hover:bg-slate-100"
          >
            {t('addTag')}
          </button>
        </form>
      </div>

      <div className="mt-3 flex items-center gap-4">
        <a
          href={paper.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm font-medium text-blue-600 hover:text-blue-800 hover:underline"
        >
          {t('viewSource')} →
        </a>
        <button
          type="button"
          onClick={remove}
          className="ml-auto text-sm font-medium text-red-500 hover:text-red-700"
        >
          {t('delete')}
        </button>
      </div>
    </div>
  )
}

export default function LibraryTab() {
  const { t } = useTranslation()
  const [papers, setPapers] = useState([])
  const [tags, setTags] = useState([])
  const [activeTag, setActiveTag] = useState(null)

  const load = async () => {
    const [ps, ts] = await Promise.all([api.listLibrary(activeTag), api.listTags()])
    setPapers(ps)
    setTags(ts)
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTag])

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-slate-900">{t('libraryTitle')}</h2>
        <span className="text-sm text-slate-500">
          {t('savedCount', { count: papers.length })}
        </span>
      </div>

      {/* Tag filter bar */}
      {tags.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-2">
          <button
            onClick={() => setActiveTag(null)}
            className={`rounded-full px-3 py-1 text-sm ${
              activeTag === null
                ? 'bg-blue-600 text-white'
                : 'bg-white text-slate-600 border border-slate-300 hover:bg-slate-50'
            }`}
          >
            {t('allTags')}
          </button>
          {tags.map(({ tag, count }) => (
            <button
              key={tag}
              onClick={() => setActiveTag(tag)}
              className={`rounded-full px-3 py-1 text-sm ${
                activeTag === tag
                  ? 'bg-blue-600 text-white'
                  : 'bg-white text-slate-600 border border-slate-300 hover:bg-slate-50'
              }`}
            >
              {tag} ({count})
            </button>
          ))}
        </div>
      )}

      {papers.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-300 bg-white p-10 text-center text-slate-500">
          {t('libraryEmpty')}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {papers.map((p) => (
            <LibraryCard key={p.id} paper={p} onChanged={load} />
          ))}
        </div>
      )}
    </div>
  )
}
