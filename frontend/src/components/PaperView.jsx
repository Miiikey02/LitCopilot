import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import * as api from '../lib/api'
import AnswerText from './AnswerText'
import ChatComposer from './ChatComposer'
import Icon from './Icon'
import PaperGraph from './PaperGraph'
import SegmentedControl from './SegmentedControl'
import TypingDots from './TypingDots'

// Everything about one paper: a close reading, the map of papers around it,
// the entities it names, and an agent scoped to that neighbourhood.
export default function PaperView({ identifier, onClose }) {
  const { t, i18n } = useTranslation()
  const lang = i18n.language.startsWith('zh') ? 'zh' : 'en'
  const [tab, setTab] = useState('read')
  const [read, setRead] = useState(null)
  const [graph, setGraph] = useState(null)
  const [evidence, setEvidence] = useState(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [turns, setTurns] = useState([])
  const [chatting, setChatting] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError('')
    api
      .paperRead(identifier, lang)
      .then((d) => alive && setRead(d))
      .catch(() => alive && setError(t('paperNotFound')))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [identifier, lang])

  const loadGraph = async () => {
    if (graph || busy) return
    setBusy(true)
    try {
      setGraph(await api.paperConnected(identifier))
    } catch {
      setGraph({ nodes: [], edges: [] })
    } finally {
      setBusy(false)
    }
  }

  const loadEvidence = async () => {
    if (evidence || busy) return
    setBusy(true)
    try {
      setEvidence(await api.paperEvidence(identifier, lang))
    } catch {
      setEvidence({ answer: '', sources: [], warning: t('errorNetwork') })
    } finally {
      setBusy(false)
    }
  }

  const onTab = (next) => {
    setTab(next)
    if (next === 'graph') loadGraph()
    if (next === 'evidence') loadEvidence()
  }

  const ask = async (msg) => {
    if (!evidence?.session_id || chatting) return
    setChatting(true)
    try {
      const r = await api.chat(evidence.session_id, msg, lang)
      setTurns((p) => [...p, { q: msg, a: r.answer, warning: r.warning }])
    } catch {
      setTurns((p) => [...p, { q: msg, a: '', warning: t('errorNetwork') }])
    } finally {
      setChatting(false)
    }
  }

  const paper = read?.paper
  const r = read?.read

  const Section = ({ icon, title, children }) => (
    <div className="animate-rise">
      <h4 className="mb-1.5 flex items-center gap-1.5 text-sm font-semibold text-slate-800">
        <Icon name={icon} className="text-slate-400" />
        {title}
      </h4>
      {children}
    </div>
  )

  return (
    <div className="animate-rise overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <header className="flex items-start gap-3 border-b border-slate-100 px-5 py-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Icon name="bookOpen" className="text-blue-600" />
            <h2 className="text-base font-semibold text-slate-900">
              {t('paperRead')}
            </h2>
            {read?.has_full_text && (
              <span className="rounded-full bg-green-50 px-2 py-0.5 text-xs text-green-700">
                {t('fullTextBadge')}
              </span>
            )}
          </div>
          {paper && (
            <p className="mt-1 truncate text-sm text-slate-500">{paper.title}</p>
          )}
        </div>
        <button
          onClick={onClose}
          className="rounded-md p-1 text-slate-400 transition-colors hover:bg-slate-50 hover:text-slate-700"
          title={t('close')}
        >
          <Icon name="x" />
        </button>
      </header>

      <div className="border-b border-slate-100 px-5 py-2.5">
        <SegmentedControl
          value={tab}
          onChange={onTab}
          size="sm"
          options={[
            { value: 'read', label: t('tabRead'), icon: 'note' },
            { value: 'graph', label: t('tabGraph'), icon: 'grid' },
            { value: 'entities', label: t('tabEntities'), icon: 'flask' },
            { value: 'evidence', label: t('tabEvidence'), icon: 'quote' },
          ]}
        />
      </div>

      <div className="p-5">
        {loading && (
          <div className="space-y-3">
            <div className="skeleton h-4 w-1/3 rounded" />
            <div className="skeleton h-4 w-full rounded" />
            <div className="skeleton h-4 w-5/6 rounded" />
          </div>
        )}
        {error && <p className="text-sm text-red-600">{error}</p>}

        {!loading && tab === 'read' && (
          <div className="space-y-5">
            {read?.warning && (
              <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                {read.warning}
              </div>
            )}
            {paper?.retraction_status === 'retracted' && (
              <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
                <Icon name="alert" className="mr-1" />
                {t('retracted')} · {t('retractedHint')}
              </div>
            )}
            {r && (
              <>
                {r.takeaway && (
                  <div className="rounded-lg bg-blue-50/70 p-4 text-[15px] leading-7 text-slate-800">
                    <span className="font-semibold">{t('takeaway')}：</span>
                    {r.takeaway}
                  </div>
                )}
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                  {[
                    ['question', t('readQuestion'), 'search'],
                    ['design', t('readDesign'), 'grid'],
                    ['sample', t('readSample'), 'users'],
                  ].map(([k, label, icon]) => (
                    <Section key={k} icon={icon} title={label}>
                      <p className="text-sm leading-6 text-slate-600">
                        {r[k] || '—'}
                      </p>
                    </Section>
                  ))}
                </div>
                {[
                  ['findings', t('readFindings'), 'check'],
                  ['limitations', t('readLimitations'), 'alert'],
                  ['not_established', t('readNotEstablished'), 'x'],
                ].map(([k, label, icon]) =>
                  r[k]?.length ? (
                    <Section key={k} icon={icon} title={label}>
                      <ul className="space-y-1.5">
                        {r[k].map((x, i) => (
                          <li key={i} className="text-sm leading-6 text-slate-700">
                            • {x}
                          </li>
                        ))}
                      </ul>
                    </Section>
                  ) : null
                )}
              </>
            )}
          </div>
        )}

        {tab === 'graph' && (
          <div>
            {busy && !graph && <p className="text-sm text-slate-400">{t('buildingGraph')}</p>}
            {graph && graph.nodes.length > 0 && (
              <>
                <p className="mb-3 text-xs text-slate-400">{t('graphExplain')}</p>
                <PaperGraph
                  nodes={graph.nodes}
                  edges={graph.edges}
                  onOpen={(n) => n.url && window.open(n.url, '_blank', 'noopener')}
                />
              </>
            )}
            {graph && graph.nodes.length === 0 && (
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
                <Section key={k} icon="flask" title={t(`ent_${k}`, k)}>
                  <div className="flex flex-wrap gap-1.5">
                    {v.map((x) => (
                      <a
                        key={x}
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
                        className="rounded-full border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-700 transition-all hover:-translate-y-0.5 hover:border-blue-300 hover:text-blue-700"
                      >
                        {x}
                        <Icon name="externalLink" className="ml-1 text-slate-300" />
                      </a>
                    ))}
                  </div>
                </Section>
              ))}
            {!Object.values(read?.entities || {}).some((v) => v?.length) && (
              <p className="text-sm text-slate-400">{t('entitiesEmpty')}</p>
            )}
          </div>
        )}

        {tab === 'evidence' && (
          <div className="space-y-4">
            {busy && !evidence && (
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

            {evidence?.session_id && (
              <div className="border-t border-slate-100 pt-4">
                {turns.map((tn, i) => (
                  <div key={i} className="mb-4 space-y-2">
                    <div className="flex justify-end">
                      <div className="animate-from-right max-w-[80%] rounded-2xl rounded-tr-md bg-blue-600 px-4 py-2 text-sm text-white">
                        {tn.q}
                      </div>
                    </div>
                    <div className="animate-from-left rounded-2xl rounded-tl-md bg-slate-50 px-4 py-3 text-sm leading-6 text-slate-800">
                      {tn.warning || (
                        <AnswerText
                          text={tn.a}
                          citationKeys={(evidence.sources || []).map(
                            (s) => s.citation_key
                          )}
                          inline
                        />
                      )}
                    </div>
                  </div>
                ))}
                {chatting && (
                  <div className="mb-4 flex">
                    <div className="rounded-2xl bg-slate-50 px-4 py-3 text-slate-400">
                      <TypingDots />
                    </div>
                  </div>
                )}
                <ChatComposer
                  onSend={ask}
                  busy={chatting}
                  placeholder={t('paperAskPlaceholder')}
                />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
