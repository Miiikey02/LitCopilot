import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

// A force-directed map of the papers around one seed, in the spirit of
// Connected Papers. Edge weight is bibliographic coupling — how much two papers
// share a reference list — so neighbours are papers about the same thing even
// when neither cites the other.
//
// The simulation is written here rather than pulled from a graph library: it is
// ~40 lines for this size of graph and avoids a dependency.
const W = 760
const H = 460

function simulate(nodes, edges, steps = 320) {
  const n = nodes.length
  if (!n) return []
  // Deterministic ring start, so the same graph always lays out the same way.
  const pts = nodes.map((d, i) => {
    const a = (i / n) * Math.PI * 2
    return {
      ...d,
      x: W / 2 + Math.cos(a) * (d.is_seed ? 0 : 150 + (i % 3) * 40),
      y: H / 2 + Math.sin(a) * (d.is_seed ? 0 : 110 + (i % 3) * 30),
      vx: 0,
      vy: 0,
    }
  })
  const index = new Map(pts.map((p, i) => [p.id, i]))
  const links = edges
    .map((e) => ({ s: index.get(e.source), t: index.get(e.target), w: e.weight }))
    .filter((l) => l.s !== undefined && l.t !== undefined)

  for (let step = 0; step < steps; step++) {
    const cool = 1 - step / steps
    // Repulsion between every pair keeps labels from stacking.
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const dx = pts[j].x - pts[i].x
        const dy = pts[j].y - pts[i].y
        const d2 = dx * dx + dy * dy || 1
        const f = 2400 / d2
        const d = Math.sqrt(d2)
        const ux = (dx / d) * f
        const uy = (dy / d) * f
        pts[i].vx -= ux
        pts[i].vy -= uy
        pts[j].vx += ux
        pts[j].vy += uy
      }
    }
    // Similar papers pull together, in proportion to shared references.
    for (const l of links) {
      const a = pts[l.s]
      const b = pts[l.t]
      const dx = b.x - a.x
      const dy = b.y - a.y
      const d = Math.sqrt(dx * dx + dy * dy) || 1
      const target = 90 + (1 - l.w) * 160
      const f = (d - target) * 0.012 * (0.4 + l.w)
      a.vx += (dx / d) * f
      a.vy += (dy / d) * f
      b.vx -= (dx / d) * f
      b.vy -= (dy / d) * f
    }
    for (const p of pts) {
      // Gravity to centre; the seed is pinned so the map has an anchor.
      p.vx += (W / 2 - p.x) * 0.004
      p.vy += (H / 2 - p.y) * 0.004
      if (p.is_seed) {
        p.x = W / 2
        p.y = H / 2
        p.vx = p.vy = 0
        continue
      }
      p.x += Math.max(-12, Math.min(12, p.vx)) * cool
      p.y += Math.max(-12, Math.min(12, p.vy)) * cool
      p.vx *= 0.82
      p.vy *= 0.82
      p.x = Math.max(40, Math.min(W - 40, p.x))
      p.y = Math.max(30, Math.min(H - 30, p.y))
    }
  }
  return pts
}

export default function PaperGraph({ nodes, edges, onOpen }) {
  const { t } = useTranslation()
  const [hover, setHover] = useState(null)
  const [ready, setReady] = useState(false)
  const laid = useMemo(() => simulate(nodes, edges), [nodes, edges])

  useEffect(() => {
    const id = setTimeout(() => setReady(true), 40)
    return () => clearTimeout(id)
  }, [laid])

  if (!nodes.length) return null

  const years = nodes.map((n) => n.year).filter(Boolean)
  const minY = Math.min(...years, 2000)
  const maxY = Math.max(...years, 2026)
  const maxCites = Math.max(...nodes.map((n) => n.citations || 0), 1)

  // Older papers sit darker, recent ones brighter — the same cue Connected
  // Papers uses, so the eye can date a cluster at a glance.
  const colorFor = (n) => {
    if (n.is_seed) return '#1d4ed8'
    const p = years.length ? ((n.year || minY) - minY) / Math.max(maxY - minY, 1) : 0.5
    const l = 62 - p * 26
    return `hsl(199 ${40 + p * 35}% ${l}%)`
  }
  const radius = (n) =>
    n.is_seed ? 15 : 6 + Math.sqrt((n.citations || 0) / maxCites) * 13

  // Label the seed and the most-cited neighbours. Sizing the label off the node
  // radius left almost everything anonymous whenever one paper dominated the
  // citation counts — a fixed count always names the landmarks of the map, and
  // caps how many labels can collide.
  const labelled = new Set(
    [...nodes]
      .sort((a, b) => (b.citations || 0) - (a.citations || 0))
      .slice(0, 12)
      .map((n) => n.id)
  )

  const pos = new Map(laid.map((p) => [p.id, p]))

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full rounded-xl border border-slate-200 bg-gradient-to-b from-slate-50 to-white"
        style={{ maxHeight: 520 }}
      >
        <g opacity={ready ? 1 : 0} style={{ transition: 'opacity 600ms ease-out' }}>
          {edges.map((e, i) => {
            const a = pos.get(e.source)
            const b = pos.get(e.target)
            if (!a || !b) return null
            const lit =
              hover && (hover === e.source || hover === e.target)
            return (
              <line
                key={i}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke={lit ? '#3b82f6' : '#cbd5e1'}
                strokeOpacity={lit ? 0.9 : 0.35 + e.weight}
                strokeWidth={lit ? 2 : 0.6 + e.weight * 4}
                style={{ transition: 'stroke 200ms, stroke-opacity 200ms' }}
              />
            )
          })}

          {laid.map((n, i) => {
            const dim = hover && hover !== n.id &&
              !edges.some(
                (e) =>
                  (e.source === n.id && e.target === hover) ||
                  (e.target === n.id && e.source === hover)
              )
            return (
              <g
                key={n.id}
                transform={`translate(${n.x},${n.y})`}
                opacity={dim ? 0.25 : 1}
                style={{
                  transition: `opacity 200ms, transform 600ms cubic-bezier(0.22,1,0.36,1) ${i * 8}ms`,
                  cursor: 'pointer',
                }}
                onMouseEnter={() => setHover(n.id)}
                onMouseLeave={() => setHover(null)}
                onClick={() => onOpen?.(n)}
              >
                <circle
                  r={radius(n)}
                  fill={colorFor(n)}
                  stroke={n.retraction_status === 'retracted' ? '#dc2626' : '#fff'}
                  strokeWidth={n.retraction_status === 'retracted' ? 2.5 : 1.5}
                />
                {(n.is_seed || hover === n.id || labelled.has(n.id)) && (
                  <text
                    y={radius(n) + 12}
                    textAnchor="middle"
                    className="pointer-events-none"
                    style={{ fontSize: 9.5, fill: '#475569' }}
                  >
                    {(n.authors?.[0]?.split(' ').slice(-1)[0] || '?') +
                      (n.year ? ` ${n.year}` : '')}
                  </text>
                )}
              </g>
            )
          })}
        </g>
      </svg>

      {/* What the visual encoding means — a map is useless unlabelled. */}
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-400">
        <span>● {t('graphLegendSize')}</span>
        <span>● {t('graphLegendColor')}</span>
        <span>— {t('graphLegendEdge')}</span>
      </div>

      {hover && pos.get(hover) && (
        <div className="pointer-events-none absolute left-3 top-3 max-w-sm rounded-lg border border-slate-200 bg-white/95 p-3 text-xs shadow-lg backdrop-blur">
          <div className="font-medium leading-5 text-slate-900">
            {pos.get(hover).title}
          </div>
          <div className="mt-1 text-slate-500">
            {(pos.get(hover).authors || []).join(', ')}
            {pos.get(hover).year ? ` · ${pos.get(hover).year}` : ''}
            {pos.get(hover).venue ? ` · ${pos.get(hover).venue}` : ''}
          </div>
          <div className="mt-1 text-slate-400">
            {t('graphCitations', { n: pos.get(hover).citations })}
            {!pos.get(hover).is_seed &&
              ` · ${t('graphSimilarity', {
                n: Math.round(pos.get(hover).similarity * 100),
              })}`}
          </div>
        </div>
      )}
    </div>
  )
}
