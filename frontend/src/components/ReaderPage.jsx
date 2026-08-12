import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import * as api from '../lib/api'
import AnswerText from './AnswerText'
import ArticlePane from './ArticlePane'
import ChatComposer from './ChatComposer'
import Icon from './Icon'
import PaperGraph from './PaperGraph'
import SegmentedControl from './SegmentedControl'
import TypingDots from './TypingDots'

// 精读模式 — one paper, in its own window.
//
// Left: the article as published. Right: the close reading, the map of related
// work, the entities, and an agent that answers about this paper. The two
// panes are wired together: every claim on the right points at the sentence on
// the left it came from, and any passage on the left can be sent to the agent.

const KIND_DOT = {
  finding: 'bg-blue-400',
  limitation: 'bg-amber-400',
  not_established: 'bg-rose-400',
}

export default function ReaderPage() {
  const { t, i18n } = useTranslation()
  const lang = i18n.language.startsWith('zh') ? 'zh' : 'en'
  const identifier = new URLSearchParams(window.location.search).get('id') || ''
  // An uploaded PDF exists in no citation index, so the map of related work and
  // the evidence across it have nothing to draw on.
  const isUpload = identifier.startsWith('upload:')
  const fileInput = useRef(null)
  const [uploading, setUploading] = useState(false)

  const [article, setArticle] = useState(null)
  const [read, setRead] = useState(null)
  const [graph, setGraph] = useState(null)
  const [evidence, setEvidence] = useState(null)
  const [tab, setTab] = useState('read')
  const [turns, setTurns] = useState([])
  const [chatting, setChatting] = useState(false)
  const [activeId, setActiveId] = useState(null)
  const [error, setError] = useState('')
  const [split, setSplit] = useState(58) // % width of the article pane
  // 'pdf' shows the paper exactly as published; 'text' is the parsed reading
  // view, which is the only one that can carry highlights and select-to-ask.
  const [leftView, setLeftView] = useState('pdf')
  const dragging = useRef(false)
  const chatEnd = useRef(null)

  // The article resolves in seconds and the close reading takes far longer, so
  // they are fetched independently — you can start reading immediately.
  useEffect(() => {
    if (!identifier) return setError(t('readerNoId'))
    let alive = true
    api
      .paperArticle(identifier, lang)
      .then((d) => {
        if (!alive) return
        setArticle(d)
        if (!d.has_pdf) setLeftView('text')
      })
      .catch(() => alive && setError(t('paperNotFound')))
    api
      .paperRead(identifier, lang)
      .then((d) => alive && setRead(d))
      .catch(() => alive && setRead({ warning: t('errorNetwork') }))
    return () => {
      alive = false
    }
  }, [identifier, lang])

  useEffect(() => {
    document.title = article?.paper?.title
      ? `${article.paper.title} · ${t('readerMode')}`
      : t('readerMode')
  }, [article, t])

  // Same reason as the article pane: scrollIntoView is unreliable inside these
  // nested scrollers, so pin the conversation to the bottom directly.
  useEffect(() => {
    const box = chatEnd.current?.parentElement?.parentElement
    if (box) box.scrollTop = box.scrollHeight
  }, [turns, chatting])

  // Every appraisal point that carries a source sentence becomes a highlight.
  const r = read?.read
  const highlights = []
  for (const kind of ['finding', 'limitation', 'not_established']) {
    const key =
      kind === 'finding'
        ? 'findings'
        : kind === 'limitation'
        ? 'limitations'
        : 'not_established'
    ;(r?.[key] || []).forEach((it, i) => {
      if (it.quote) highlights.push({ id: `${kind}-${i}`, kind, ...it })
    })
  }

  const onDrag = useCallback((e) => {
    if (!dragging.current) return
    const pct = (e.clientX / window.innerWidth) * 100
    setSplit(Math.min(75, Math.max(30, pct)))
  }, [])

  useEffect(() => {
    const stop = () => {
      dragging.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    window.addEventListener('mousemove', onDrag)
    window.addEventListener('mouseup', stop)
    return () => {
      window.removeEventListener('mousemove', onDrag)
      window.removeEventListener('mouseup', stop)
    }
  }, [onDrag])

  const loadGraph = async () => {
    if (graph) return
    setGraph({ nodes: [], edges: [], loading: true })
    try {
      setGraph(await api.paperConnected(identifier))
    } catch {
      setGraph({ nodes: [], edges: [] })
    }
  }

  const loadEvidence = async () => {
    if (evidence) return
    setEvidence({ loading: true })
    try {
      setEvidence(await api.paperEvidence(identifier, lang))
    } catch {
      setEvidence({ answer: '', sources: [], warning: t('errorNetwork') })
    }
  }

  const onTab = (next) => {
    setTab(next)
    if (next === 'graph') loadGraph()
    if (next === 'evidence') loadEvidence()
  }

  // A selection sent from the article, or a free question typed in the bar.
  const send = async ({ selection = '', question = '', intent = 'free' }) => {
    if (chatting) return
    setTab('chat')
    setChatting(true)
    setTurns((p) => [...p, { q: question || t(`intent_${intent}`), selection, a: '' }])
    try {
      const res = selection
        ? await api.paperAsk(identifier, selection, question, intent, lang)
        : await api.chat(read?.session_id, question, lang)
      setTurns((p) =>
        p.map((x, i) =>
          i === p.length - 1 ? { ...x, a: res.answer, warning: res.warning } : x
        )
      )
    } catch {
      setTurns((p) =>
        p.map((x, i) => (i === p.length - 1 ? { ...x, warning: t('errorNetwork') } : x))
      )
    } finally {
      setChatting(false)
    }
  }

  const paper = article?.paper || read?.paper

  if (error) {
    return (
      <div className="flex h-screen items-center justify-center text-slate-500">
        {error}
      </div>
    )
  }

  // Locating a claim only works in the parsed view, so asking to locate one
  // switches to it rather than doing nothing while the PDF is showing.
  const locate = (id) => {
    setLeftView('text')
    setActiveId(id)
  }

  const Item = ({ it, id, kind }) => (
    <li>
      <button
        onClick={() => it.quote && locate(id)}
        className={`group flex w-full gap-2 rounded-md px-2 py-1.5 text-left text-sm leading-6 transition-colors ${
          it.quote ? 'hover:bg-slate-50' : 'cursor-default'
        } ${activeId === id ? 'bg-blue-50' : ''}`}
      >
        <span className={`mt-2 h-1.5 w-1.5 shrink-0 rounded-full ${KIND_DOT[kind]}`} />
        <span className="flex-1 text-slate-700">{it.text}</span>
        {it.quote && (
          <span className="mt-0.5 shrink-0 text-slate-300 transition-colors group-hover:text-blue-500">
            <Icon name="quote" />
          </span>
        )}
      </button>
    </li>
  )

  const Group = ({ label, items, kind }) =>
    items?.length ? (
      <div className="animate-rise">
        <h4 className="mb-1 px-2 text-sm font-semibold text-slate-800">{label}</h4>
        <ul>
          {items.map((it, i) => (
            <Item key={i} it={it} id={`${kind}-${i}`} kind={kind} />
          ))}
        </ul>
      </div>
    ) : null

  return (
    <div className="flex h-screen flex-col bg-slate-50">
      <header className="flex shrink-0 items-center gap-3 border-b border-slate-200 bg-white px-4 py-2.5">
        <Icon name="bookOpen" className="shrink-0 text-blue-600" />
        <span className="shrink-0 text-sm font-semibold text-slate-900">
          {t('readerMode')}
        </span>
        {article && !article.has_full_text && (
          <span className="shrink-0 rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-700">
            {t('abstractOnlyBadge')}
          </span>
        )}
        {article?.has_full_text && (
          <span className="shrink-0 rounded-full bg-green-50 px-2 py-0.5 text-xs text-green-700">
            {t('fullTextBadge')}
          </span>
        )}
        <p className="min-w-0 flex-1 truncate text-sm text-slate-500">
          {paper?.title}
        </p>
        {/* A publisher that blocks our fetch will still serve the reader's own
            browser, so offer the file even when it cannot be framed here. */}
        <input
          ref={fileInput}
          type="file"
          accept="application/pdf,.pdf"
          className="hidden"
          onChange={async (e) => {
            const file = e.target.files?.[0]
            e.target.value = ''
            if (!file) return
            setUploading(true)
            try {
              const up = await api.paperUpload(file)
              // Reload against the upload identifier so every panel — reading,
              // entities, the agent — re-resolves from the same one place.
              window.location.search = `?id=${encodeURIComponent(up.identifier)}`
            } catch (err) {
              setUploading(false)
              window.alert(`${t('uploadFailed')}${err.message ? `: ${err.message}` : ''}`)
            }
          }}
        />
        <button
          onClick={() => fileInput.current?.click()}
          disabled={uploading}
          title={t('uploadPdfHint')}
          className="shrink-0 rounded-md border border-slate-200 px-2 py-1 text-xs text-slate-600 transition-colors hover:border-blue-300 hover:text-blue-700 disabled:opacity-50"
        >
          <Icon name="filePlus" className="mr-1" />
          {uploading ? t('uploadingPdf') : t('uploadPdf')}
        </button>

        {/* The best PDF an index knows of is sometimes an unfamiliar mirror
            rather than the publisher, so name the host before you go there. */}
        {article?.pdf_link && !article?.has_pdf && (
          <a
            href={article.pdf_link}
            target="_blank"
            rel="noopener noreferrer"
            title={(() => {
              try {
                return new URL(article.pdf_link).host
              } catch {
                return article.pdf_link
              }
            })()}
            className="shrink-0 text-xs text-slate-500 transition-colors hover:text-blue-700"
          >
            {t('openPdfExternally')} <Icon name="externalLink" />
          </a>
        )}
        {paper?.url && (
          <a
            href={paper.url}
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0 text-xs text-slate-500 transition-colors hover:text-blue-700"
          >
            {t('openOriginal')} <Icon name="externalLink" />
          </a>
        )}
      </header>

      <div className="flex min-h-0 flex-1">
        <div style={{ width: `${split}%` }} className="flex min-w-0 flex-col">
          {article?.has_pdf && (
            <div className="flex shrink-0 items-center gap-3 border-b border-slate-100 bg-white px-4 py-2">
              <SegmentedControl
                value={leftView}
                onChange={setLeftView}
                size="sm"
                options={[
                  { value: 'pdf', label: t('viewPdf'), icon: 'filePlus' },
                  { value: 'text', label: t('viewText'), icon: 'note' },
                ]}
              />
              <p className="truncate text-xs text-slate-400">
                {leftView === 'pdf' ? t('pdfHint') : t('textHint')}
              </p>
            </div>
          )}
          <div className="min-h-0 flex-1">
            {leftView === 'pdf' && article?.has_pdf ? (
              <iframe
                title={t('viewPdf')}
                // A frame cannot send the auth header, so it uses the signed,
                // short-lived link the article response issued for this file.
                src={
                  article.pdf_embed ||
                  `/api/paper/pdf?id=${encodeURIComponent(identifier)}`
                }
                className="h-full w-full border-0 bg-slate-100"
              />
            ) : (
              <ArticlePane
                blocks={article?.blocks || []}
                highlights={highlights}
                activeId={activeId}
                license={article?.license}
                warning={article?.warning}
                loading={!article}
                onMarkClick={(hl) => setActiveId(hl.id)}
                onAsk={(selection, intent) => send({ selection, intent })}
              />
            )}
          </div>
        </div>

        {/* Draggable divider — reading widths are personal, and a Chinese
            reader of an English paper usually wants the panes near even. */}
        <div
          onMouseDown={() => {
            dragging.current = true
            document.body.style.cursor = 'col-resize'
            document.body.style.userSelect = 'none'
          }}
          className="group w-1 shrink-0 cursor-col-resize bg-slate-200 transition-colors hover:bg-blue-400"
        >
          <div className="mx-auto h-full w-px bg-transparent group-hover:bg-blue-400" />
        </div>

        <div className="flex min-w-0 flex-1 flex-col bg-white">
          <div className="shrink-0 border-b border-slate-100 px-4 py-2.5">
            <SegmentedControl
              value={tab}
              onChange={onTab}
              size="sm"
              options={[
                { value: 'read', label: t('tabRead'), icon: 'note' },
                { value: 'chat', label: t('tabChat'), icon: 'sparkles' },
                ...(isUpload
                  ? []
                  : [
                      { value: 'graph', label: t('tabGraph'), icon: 'grid' },
                      { value: 'evidence', label: t('tabEvidence'), icon: 'quote' },
                    ]),
                { value: 'entities', label: t('tabEntities'), icon: 'flask' },
              ]}
            />
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
            {tab === 'read' && (
              <div className="space-y-4">
                {!read && (
                  <div className="space-y-2.5">
                    <div className="skeleton h-4 w-2/3 rounded" />
                    <div className="skeleton h-4 w-full rounded" />
                    <div className="skeleton h-4 w-5/6 rounded" />
                  </div>
                )}
                {read?.warning && (
                  <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                    {read.warning}
                  </div>
                )}
                {read?.paper?.retraction_status === 'retracted' && (
                  <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
                    <Icon name="alert" className="mr-1" />
                    {t('retracted')} · {t('retractedHint')}
                  </div>
                )}
                {r && (
                  <>
                    {r.takeaway && (
                      <div className="rounded-lg bg-blue-50/70 p-3.5 text-sm leading-7 text-slate-800">
                        <span className="font-semibold">{t('takeaway')}：</span>
                        {r.takeaway}
                      </div>
                    )}
                    {highlights.length > 0 && (
                      <p className="px-2 text-xs text-slate-400">{t('clickToLocate')}</p>
                    )}
                    {[
                      ['question', t('readQuestion')],
                      ['design', t('readDesign')],
                      ['sample', t('readSample')],
                    ].map(([k, label]) => (
                      <div key={k} className="px-2">
                        <h4 className="text-sm font-semibold text-slate-800">{label}</h4>
                        <p className="mt-0.5 text-sm leading-6 text-slate-600">
                          {r[k] || '—'}
                        </p>
                      </div>
                    ))}
                    <Group label={t('readFindings')} items={r.findings} kind="finding" />
                    <Group
                      label={t('readLimitations')}
                      items={r.limitations}
                      kind="limitation"
                    />
                    <Group
                      label={t('readNotEstablished')}
                      items={r.not_established}
                      kind="not_established"
                    />
                  </>
                )}
              </div>
            )}

            {tab === 'chat' && (
              <div>
                {!turns.length && !chatting && (
                  <div className="mt-6 text-center">
                    <Icon name="sparkles" className="mx-auto h-6 w-6 text-slate-300" />
                    <p className="mt-2 text-sm text-slate-400">{t('readerChatEmpty')}</p>
                  </div>
                )}
                {turns.map((tn, i) => (
                  <div key={i} className="mb-4">
                    {tn.selection && (
                      <blockquote className="mb-1.5 border-l-2 border-blue-300 bg-slate-50 py-1 pl-2.5 text-xs leading-5 text-slate-500">
                        {tn.selection.length > 220
                          ? `${tn.selection.slice(0, 220)}…`
                          : tn.selection}
                      </blockquote>
                    )}
                    <div className="flex justify-end">
                      <div className="animate-from-right max-w-[85%] rounded-2xl rounded-tr-md bg-blue-600 px-3.5 py-2 text-sm text-white">
                        {tn.q}
                      </div>
                    </div>
                    {(tn.a || tn.warning) && (
                      <div className="animate-from-left mt-2 rounded-2xl rounded-tl-md bg-slate-50 px-3.5 py-3 text-sm leading-7 text-slate-800">
                        {tn.warning || <AnswerText text={tn.a} citationKeys={[]} inline />}
                      </div>
                    )}
                  </div>
                ))}
                {chatting && (
                  <div className="flex">
                    <div className="rounded-2xl bg-slate-50 px-4 py-3 text-slate-400">
                      <TypingDots />
                    </div>
                  </div>
                )}
                <div ref={chatEnd} />
              </div>
            )}

            {tab === 'graph' && (
              <div>
                {graph?.loading && (
                  <p className="text-sm text-slate-400">{t('buildingGraph')}</p>
                )}
                {graph?.nodes?.length > 0 && (
                  <>
                    <p className="mb-3 text-xs text-slate-400">{t('graphExplain')}</p>
                    <PaperGraph
                      nodes={graph.nodes}
                      edges={graph.edges}
                      onOpen={(n) => n.url && window.open(n.url, '_blank', 'noopener')}
                    />
                  </>
                )}
                {graph && !graph.loading && !graph.nodes?.length && (
                  <p className="text-sm text-slate-400">{t('graphEmpty')}</p>
                )}
              </div>
            )}

            {tab === 'entities' && (
              <div className="space-y-4">
                <p className="rounded-md bg-slate-50 p-2.5 text-xs leading-5 text-slate-500">
                  {t('entitiesDisclaimer')}
                </p>
                {Object.entries(read?.entities || {})
                  .filter(([, v]) => v?.length)
                  .map(([k, v]) => (
                    <div key={k}>
                      <h4 className="mb-1.5 text-sm font-semibold text-slate-800">
                        {t(`ent_${k}`, k)}
                      </h4>
                      <div className="flex flex-wrap gap-1.5">
                        {v.map((x) => (
                          <span key={x} className="inline-flex overflow-hidden rounded-full border border-slate-200">
                            {/* Two affordances per entity: ask about it here,
                                or check it in the authoritative database. */}
                            <button
                              onClick={() =>
                                send({
                                  selection: x,
                                  question: t('entityAsk', { x }),
                                })
                              }
                              className="bg-white px-2.5 py-1 text-xs text-slate-700 transition-colors hover:bg-blue-50 hover:text-blue-700"
                            >
                              {x}
                            </button>
                            <a
                              href={
                                k === 'pathways'
                                  ? `https://reactome.org/content/query?q=${encodeURIComponent(x)}`
                                  : k === 'drugs'
                                  ? `https://pubchem.ncbi.nlm.nih.gov/#query=${encodeURIComponent(x)}`
                                  : k === 'genes' || k === 'proteins'
                                  ? `https://www.uniprot.org/uniprotkb?query=${encodeURIComponent(x)}`
                                  : `https://pubmed.ncbi.nlm.nih.gov/?term=${encodeURIComponent(x)}`
                              }
                              target="_blank"
                              rel="noopener noreferrer"
                              title={t('openInDatabase')}
                              className="border-l border-slate-200 bg-slate-50 px-1.5 py-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-blue-700"
                            >
                              <Icon name="externalLink" />
                            </a>
                          </span>
                        ))}
                      </div>
                    </div>
                  ))}
                {read && !Object.values(read.entities || {}).some((v) => v?.length) && (
                  <p className="text-sm text-slate-400">{t('entitiesEmpty')}</p>
                )}
              </div>
            )}

            {tab === 'evidence' && (
              <div className="space-y-3">
                {evidence?.loading && (
                  <p className="text-sm text-slate-400">{t('buildingEvidence')}</p>
                )}
                {evidence?.warning && (
                  <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                    {evidence.warning}
                  </div>
                )}
                {evidence?.answer && (
                  <AnswerText
                    text={evidence.answer}
                    citationKeys={(evidence.sources || []).map((s) => s.citation_key)}
                  />
                )}
              </div>
            )}
          </div>

          {/* The conversation bar stays put whichever tab you are on, so a
              question never costs you your place. */}
          <div className="shrink-0 border-t border-slate-100 px-4 py-3">
            <ChatComposer
              onSend={(m) => send({ question: m })}
              busy={chatting}
              placeholder={t('readerAskPlaceholder')}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
