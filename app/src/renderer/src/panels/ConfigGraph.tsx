import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { effectiveConfigPath, useApp } from '../store/app'
import { natural, splitTag } from '../lib/tags'

import type { Selection } from './Inspector'

interface Node {
  id: string
  /** What this node maps to in the config, for the inspector. */
  sel?: Selection
  label: string
  sub: string
  col: number
  row: number
  /** Band this node belongs to within its column. Nodes sharing one are drawn together
   *  under a heading, with a gap to the next — a column of twenty identical boxes reads
   *  as one undifferentiated list otherwise. */
  group: string
  kind: 'inbound' | 'rule' | 'balancer' | 'outbound' | 'observatory' | 'dns'
  status?: 'ok' | 'bad' | 'idle' | 'fault' | undefined
  warn?: string | undefined
}

interface Edge {
  from: string
  to: string
  kind: 'route' | 'select' | 'observe' | 'fallback' | 'active'
}

/** A drawn band: one group's extent, after any manual move. */
interface Band {
  key: string
  col: number
  label: string
  count: number
  x: number
  y: number
  h: number
}

const NODE_W = 200
const NODE_H = 52
const PAD_X = 40
const PAD_Y = 34

/**
 * Row height is FIXED; only the column gap is adjustable.
 *
 * Vertical spacing has a correct value — enough for a node plus breathing room — and
 * scaling it only ever made the diagram taller without telling you anything new. What
 * actually collides is horizontal: every edge crosses the gap between two columns, so
 * that gap is the only dimension where more room buys legibility. Hence one control,
 * and it moves one thing.
 */
const ROW_H = 74
const COL_GAP_BASE = 80
/** Extra vertical space between two groups in the same column, plus room for a heading. */
const GROUP_GAP = 30

const MIN_ZOOM = 0.2
const MAX_ZOOM = 2.5

interface View {
  x: number
  y: number
  k: number
}

/**
 * Structural view of the config on a pannable, zoomable canvas.
 *
 * Laid out by semantic column rather than by a general graph algorithm — the layering
 * (inbounds → rules → balancers → outbounds) is known, and a layout engine would only
 * obscure it. Within a column, nodes are banded by group.
 *
 * The canvas is unbounded on purpose. A diagram sized to its content forces a choice
 * between scaling everything down until the labels are unreadable and scrolling a page
 * that is mostly empty, and with twenty-six outbounds both are bad. Pan and zoom instead,
 * and let a band be dragged where its reader wants it — the automatic layout is a
 * starting point, not a claim about what matters in this particular config.
 */
export function ConfigGraph({
  source,
  selection,
  onSelect,
}: {
  /** When provided, the graph renders this text instead of reading the file — used by
   *  the Build tab so the diagram reflects unsaved edits. */
  source?: string
  selection?: Selection
  onSelect?: (s: Selection) => void
} = {}): React.JSX.Element {
  const configPath = useApp(effectiveConfigPath)
  const snap = useApp((s) => s.snap)
  const [raw, setRaw] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  // View settings belong to the person reading the diagram, not to the config.
  const [spacing, setSpacing] = useState(1)
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 })
  /** Manual group moves, in world coordinates, keyed by `col:group` so they survive a
   *  re-parse of the config. */
  const [moved, setMoved] = useState<Record<string, { dx: number; dy: number }>>({})

  const svgRef = useRef<SVGSVGElement | null>(null)
  const drag = useRef<
    | { kind: 'pan'; startX: number; startY: number; view: View }
    | { kind: 'band'; key: string; startX: number; startY: number; base: { dx: number; dy: number } }
    | null
  >(null)

  useEffect(() => {
    if (source !== undefined || !configPath) return
    let alive = true
    window.xraystudio
      .readConfig(configPath)
      .then((t) => alive && setRaw(t))
      .catch((e: Error) => alive && setErr(e.message))
    return () => {
      alive = false
    }
  }, [configPath, source])

  const text = source ?? raw
  const model = useMemo(() => (text ? buildModel(text, snap) : null), [text, snap])
  const base = useMemo(() => (model ? layout(model.nodes, spacing) : null), [model, spacing])

  /** Base layout plus manual moves. */
  const placed = useMemo(() => {
    if (!base) return null
    const pos = new Map<string, { x: number; y: number }>()
    for (const [id, p] of base.pos) {
      const g = base.groupOf.get(id)
      const off = (g && moved[g]) || { dx: 0, dy: 0 }
      pos.set(id, { x: p.x + off.dx, y: p.y + off.dy })
    }
    const bands = base.bands.map((b) => {
      const off = moved[b.key] ?? { dx: 0, dy: 0 }
      return { ...b, x: b.x + off.dx, y: b.y + off.dy }
    })
    return { pos, bands }
  }, [base, moved])

  const fit = useCallback(() => {
    const svg = svgRef.current
    if (!svg || !base || !placed) return
    const r = svg.getBoundingClientRect()
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const p of placed.pos.values()) {
      minX = Math.min(minX, p.x)
      minY = Math.min(minY, p.y)
      maxX = Math.max(maxX, p.x + NODE_W)
      maxY = Math.max(maxY, p.y + NODE_H)
    }
    if (!Number.isFinite(minX)) return
    const pad = 40
    const k = Math.min(
      MAX_ZOOM,
      Math.max(MIN_ZOOM, Math.min((r.width - pad * 2) / (maxX - minX), (r.height - pad * 2) / (maxY - minY))),
    )
    setView({
      k,
      x: pad - minX * k + Math.max(0, (r.width - pad * 2 - (maxX - minX) * k) / 2),
      y: pad - minY * k,
    })
  }, [base, placed])

  /**
   * Initial framing: fit the WIDTH, anchored at the top, and never zoom past 1:1.
   *
   * Fitting everything is the wrong opening move on a real config. Twenty-six outbounds
   * make the diagram some four thousand units tall, so "show me all of it" resolves to a
   * quarter scale where no label is readable — technically complete and practically
   * useless. Start where reading starts, at the top, at a size you can read, and let
   * panning do the rest. The Fit button still frames everything for when that is what
   * you actually want.
   */
  const fitted = useRef<string | null>(null)
  useEffect(() => {
    const svg = svgRef.current
    if (!svg || !placed || !configPath) return
    if (fitted.current === configPath) return
    fitted.current = configPath

    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    for (const p of placed.pos.values()) {
      minX = Math.min(minX, p.x)
      maxX = Math.max(maxX, p.x + NODE_W)
      minY = Math.min(minY, p.y)
    }
    if (!Number.isFinite(minX)) return
    const r = svg.getBoundingClientRect()
    const pad = 30
    const k = Math.min(1, Math.max(MIN_ZOOM, (r.width - pad * 2) / (maxX - minX)))
    setView({ k, x: pad - minX * k, y: pad - minY * k })
  }, [placed, configPath])

  const onWheel = (e: React.WheelEvent<SVGSVGElement>): void => {
    const svg = svgRef.current
    if (!svg) return
    const r = svg.getBoundingClientRect()
    const px = e.clientX - r.left
    const py = e.clientY - r.top
    // Zoom toward the pointer: the point under the cursor must not move, which is what
    // makes zooming feel like moving a map rather than rescaling a picture.
    const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.k * Math.exp(-e.deltaY * 0.0015)))
    setView({ k, x: px - ((px - view.x) / view.k) * k, y: py - ((py - view.y) / view.k) * k })
  }

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>): void => {
    if (e.button !== 0) return
    drag.current = { kind: 'pan', startX: e.clientX, startY: e.clientY, view }
    ;(e.currentTarget as SVGSVGElement).setPointerCapture(e.pointerId)
  }

  const startBandDrag = (e: React.PointerEvent, key: string): void => {
    e.stopPropagation()
    drag.current = {
      kind: 'band',
      key,
      startX: e.clientX,
      startY: e.clientY,
      base: moved[key] ?? { dx: 0, dy: 0 },
    }
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e: React.PointerEvent): void => {
    const d = drag.current
    if (!d) return
    if (d.kind === 'pan') {
      setView({ ...d.view, x: d.view.x + (e.clientX - d.startX), y: d.view.y + (e.clientY - d.startY) })
      return
    }
    // Screen pixels to world units: without dividing by the zoom, a band would run away
    // from the pointer at any scale other than 1.
    const dx = d.base.dx + (e.clientX - d.startX) / view.k
    const dy = d.base.dy + (e.clientY - d.startY) / view.k
    setMoved((m) => ({ ...m, [d.key]: { dx, dy } }))
  }

  const endDrag = (): void => {
    drag.current = null
  }

  if (!configPath) return <div className="panel empty">Open a config to see its structure.</div>
  if (err) return <div className="panel empty bad">{err}</div>
  if (!model || !base || !placed) return <div className="panel empty">Parsing…</div>
  if (model.error) {
    return (
      <div className="panel empty bad">
        Could not parse the config for display: {model.error}
      </div>
    )
  }

  const { pos, bands } = placed
  const movedCount = Object.keys(moved).length

  // Grid spacing in WORLD units, chosen so the on-screen tile stays near 24px at any
  // zoom. A fixed world spacing degenerates at both ends: a dense unreadable mesh when
  // zoomed out, and four huge cells when zoomed in.
  const gridStep = 24 * Math.pow(2, Math.max(0, Math.round(Math.log2(1 / view.k))))

  // Fan every edge leaving the same node into its own departure lane. Twenty edges from
  // one balancer previously left at the same point with the same bend and overlapped
  // into a solid ribbon; you could not tell twenty apart from two.
  const fanTotal = new Map<string, number>()
  for (const e of model.edges) fanTotal.set(e.from, (fanTotal.get(e.from) ?? 0) + 1)
  const seen = new Map<string, number>()
  const fanIndex = model.edges.map((e) => {
    const k = seen.get(e.from) ?? 0
    seen.set(e.from, k + 1)
    return k
  })

  return (
    <div className="panel graph-panel">
      <div className="panel-head">
        <h3>Structure</h3>
        <span className="dim tiny graph-hint">
          {onSelect ? 'click a node to edit' : 'read-only'} · drag to pan · scroll to zoom ·
          drag a heading to move its group
        </span>
        <span className="spacer" />
        <label
          className="graph-density"
          title="Widens the gap BETWEEN COLUMNS. Every edge crosses that gap, so it is the only dimension where more room buys legibility; row height is fixed because taller rows tell you nothing new."
        >
          <span className="tiny dim">gap</span>
          <input
            type="range"
            min={0.6}
            max={3}
            step={0.1}
            value={spacing}
            onChange={(e) => setSpacing(Number(e.target.value))}
          />
          <span className="tiny mono dim">{spacing.toFixed(1)}×</span>
        </label>
        <button className="ghost tiny" onClick={fit} title="Frame everything">
          Fit
        </button>
        <button
          className="ghost tiny"
          disabled={movedCount === 0}
          onClick={() => setMoved({})}
          title="Put every group back where the layout put it"
        >
          Reset moves{movedCount > 0 ? ` (${movedCount})` : ''}
        </button>
      </div>

      <svg
        ref={svgRef}
        className="graph-canvas"
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M0,0 L10,5 L0,10 z" fill="#4a5260" />
          </marker>
          <marker id="arrowd" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M0,0 L10,5 L0,10 z" fill="#3fb950" />
          </marker>
          {/* The view transform lives on patternTransform, not on the rect that paints
              it. Scaling the rect shrank the painted area with the zoom, so at 0.6x the
              grid covered only the top-left half of the canvas; and offsetting the rect
              before its scale applied a screen-space number in world space, so the grid
              slid out of step with the nodes it is supposed to register against.

              strokeWidth is divided by the zoom so a grid line stays one screen pixel
              instead of fading out as you zoom away. */}
          <pattern
            id="grid"
            width={gridStep}
            height={gridStep}
            patternUnits="userSpaceOnUse"
            patternTransform={`translate(${view.x},${view.y}) scale(${view.k})`}
          >
            <path
              d={`M${gridStep} 0 L0 0 0 ${gridStep}`}
              fill="none"
              stroke="#1b212b"
              strokeWidth={1 / view.k}
            />
          </pattern>
        </defs>

        {/* The grid is what makes panning legible — without a fixed reference the canvas
            looks static while the content slides. This rect stays in screen space and
            simply covers the viewport; all the movement is in the pattern. */}
        <rect width="100%" height="100%" fill="url(#grid)" />

        <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
          {bands.map((b) => (
            <g
              key={b.key}
              className="graph-band"
              onPointerDown={(e) => startBandDrag(e, b.key)}
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
            >
              <rect x={b.x - 10} y={b.y - 4} width={NODE_W + 20} height={b.h} rx={10} />
              <text x={b.x - 2} y={b.y + 8} className="graph-band-label">
                {b.label} · {b.count}
                {moved[b.key] ? '  ✥' : ''}
              </text>
            </g>
          ))}

          {model.edges.map((e, i) => {
            const a = pos.get(e.from)
            const b = pos.get(e.to)
            if (!a || !b) return null
            const x1 = a.x + NODE_W
            const y1 = a.y + NODE_H / 2
            const x2 = b.x
            const y2 = b.y + NODE_H / 2
            const active = e.kind === 'active'

            const n = fanTotal.get(e.from) ?? 1
            const k = fanIndex[i] ?? 0
            const lane = n > 1 ? 0.15 + 0.55 * ((k + 1) / (n + 1)) : 0.35
            const c1 = x1 + (x2 - x1) * lane
            const c2 = x2 - (x2 - x1) * 0.28

            return (
              <path
                key={i}
                d={`M${x1},${y1} C${c1},${y1} ${c2},${y2} ${x2},${y2}`}
                fill="none"
                stroke={active ? 'var(--ok)' : e.kind === 'observe' ? '#5d6875' : '#3a4250'}
                strokeWidth={active ? 2.4 : 1.2}
                strokeDasharray={e.kind === 'observe' ? '4 3' : e.kind === 'fallback' ? '2 3' : undefined}
                markerEnd={active ? 'url(#arrowd)' : 'url(#arrow)'}
                opacity={active ? 1 : 0.55}
              />
            )
          })}

          {model.nodes.map((n) => {
            const p = pos.get(n.id)
            if (!p) return null
            const { x, y } = p
            const stroke =
              n.status === 'bad' || n.status === 'fault'
                ? 'var(--bad)'
                : n.status === 'ok'
                  ? 'var(--ok)'
                  : 'var(--border)'
            const isSel =
              !!selection &&
              !!n.sel &&
              selection.kind === n.sel.kind &&
              selection.index === n.sel.index
            return (
              <g
                key={n.id}
                transform={`translate(${x},${y})`}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => n.sel && onSelect?.(isSel ? null : n.sel)}
                style={onSelect && n.sel ? { cursor: 'pointer' } : undefined}
              >
                {isSel && (
                  <rect
                    width={NODE_W + 8}
                    height={NODE_H + 8}
                    x={-4}
                    y={-4}
                    rx={8}
                    fill="none"
                    stroke="var(--accent)"
                    strokeWidth={2}
                  />
                )}
                <rect
                  width={NODE_W}
                  height={NODE_H}
                  rx={6}
                  fill="var(--bg-raised)"
                  stroke={stroke}
                  strokeWidth={n.status === 'ok' ? 1.8 : 1}
                />
                <text x={10} y={20} className="gn-label">
                  {n.label}
                </text>
                <text x={10} y={38} className="gn-sub">
                  {n.sub}
                </text>
                {n.warn && <title>{n.warn}</title>}
                {n.warn && <circle cx={NODE_W - 12} cy={12} r={4} fill="var(--warn)" />}
              </g>
            )
          })}
        </g>
      </svg>

      {model.warnings.length > 0 && (
        <ul className="graph-warnings">
          {model.warnings.map((w, i) => (
            <li key={i} className="note warn">
              {w}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
interface Model {
  nodes: Node[]
  edges: Edge[]
  maxRow: number
  warnings: string[]
  error?: string
}

/**
 * Turns per-column ordering into base coordinates.
 *
 * Kept separate from buildModel so changing the spacing is a pure re-layout: it must not
 * re-parse the config or disturb which node is selected. Manual group moves are applied
 * on top of this, never folded into it — otherwise "reset moves" would have nothing to
 * reset to, and a config reload would silently bake someone's dragging into the layout.
 */
function layout(
  nodes: Node[],
  spacing: number,
): {
  pos: Map<string, { x: number; y: number }>
  bands: Band[]
  groupOf: Map<string, string>
} {
  const colW = NODE_W + COL_GAP_BASE * spacing
  const pos = new Map<string, { x: number; y: number }>()
  const groupOf = new Map<string, string>()
  const bands: Band[] = []

  const cols = new Map<number, Node[]>()
  for (const n of nodes) {
    const arr = cols.get(n.col)
    if (arr) arr.push(n)
    else cols.set(n.col, [n])
  }

  for (const [col, list] of cols) {
    const ordered = [...list].sort((a, b) => a.row - b.row)
    const x = PAD_X + col * colW
    let y = PAD_Y
    let i = 0
    while (i < ordered.length) {
      const group = ordered[i]!.group
      const key = `${col}:${group}`
      const members: Node[] = []
      while (i < ordered.length && ordered[i]!.group === group) members.push(ordered[i++]!)

      const top = y
      y += 16 // room for the heading, which is also the drag handle

      for (const n of members) {
        pos.set(n.id, { x, y })
        groupOf.set(n.id, key)
        y += ROW_H
      }

      bands.push({
        key,
        col,
        label: group,
        count: members.length,
        x,
        y: top,
        h: y - top - (ROW_H - NODE_H) + 6,
      })
      y += GROUP_GAP
    }
  }

  return { pos, bands, groupOf }
}

function buildModel(raw: string, snap: ReturnType<typeof useApp.getState>['snap']): Model {
  const nodes: Node[] = []
  const edges: Edge[] = []
  const warnings: string[] = []

  let cfg: Record<string, unknown>
  try {
    // Xray accepts JSONC; strip comments and trailing commas the same way it does.
    cfg = JSON.parse(stripJsonc(raw)) as Record<string, unknown>
  } catch (e) {
    return { nodes, edges, maxRow: 0, warnings, error: (e as Error).message }
  }

  const inbounds = (cfg['inbounds'] as Record<string, unknown>[]) ?? []
  const outbounds = (cfg['outbounds'] as Record<string, unknown>[]) ?? []
  const routing = (cfg['routing'] as Record<string, unknown>) ?? {}
  const rules = (routing['rules'] as Record<string, unknown>[]) ?? []
  const balancers = (routing['balancers'] as Record<string, unknown>[]) ?? []
  const obs = (cfg['observatory'] ?? cfg['burstObservatory']) as Record<string, unknown> | undefined
  const isBurst = !!cfg['burstObservatory']

  let row = 0
  inbounds.forEach((ib, i) => {
    const tag = String(ib['tag'] ?? `inbound-${i}`)
    nodes.push({
      id: `in:${tag}`,
      label: tag,
      sub: `${ib['protocol'] ?? '?'} :${ib['port'] ?? '?'}`,
      col: 0,
      row: row++,
      group: 'inbounds',
      kind: 'inbound',
    })
  })

  let rrow = 0
  rules.forEach((r, i) => {
    const id = `rule:${i}`
    const tag = String(r['ruleTag'] ?? `rule ${i}`)
    const target = r['balancerTag'] ? `→ ${r['balancerTag']}` : `→ ${r['outboundTag'] ?? '?'}`
    nodes.push({
      id,
      label: tag,
      sub: target,
      col: 1,
      row: rrow++,
      group: 'routing rules',
      kind: 'rule',
      sel: { kind: 'rule', index: i },
    })

    const inTags = (r['inboundTag'] as string[]) ?? []
    for (const it of inTags) edges.push({ from: `in:${it}`, to: id, kind: 'route' })

    if (r['balancerTag']) edges.push({ from: id, to: `bal:${r['balancerTag']}`, kind: 'route' })
    else if (r['outboundTag']) edges.push({ from: id, to: `out:${r['outboundTag']}`, kind: 'route' })

    if (r['balancerTag'] && r['outboundTag']) {
      warnings.push(
        `Rule ${i} sets both outboundTag and balancerTag. outboundTag wins and the balancer is ignored.`,
      )
    }
  })

  const outTags = outbounds.map((o) => String(o['tag'] ?? ''))
  let brow = 0
  balancers.forEach((b, i) => {
    const tag = String(b['tag'] ?? '')
    const selectors = (b['selector'] as string[]) ?? []
    const strategy = String((b['strategy'] as Record<string, unknown>)?.['type'] ?? 'random')
    const live = snap.balancers.find((x) => x.tag === tag)
    const matched = outTags.filter((t) => t && selectors.some((s) => t.startsWith(s)))

    nodes.push({
      id: `bal:${tag}`,
      sel: { kind: 'balancer', index: i },
      label: tag,
      sub: `${strategy} · ${matched.length} candidate${matched.length === 1 ? '' : 's'}`,
      col: 2,
      row: brow++,
      group: 'balancers',
      kind: 'balancer',
      status: matched.length === 0 ? 'bad' : undefined,
      ...(matched.length === 0
        ? { warn: 'This selector matches no outbound tag. Xray never checks this at load time.' }
        : {}),
    })

    if (matched.length === 0) {
      warnings.push(
        `Balancer "${tag}" selector [${selectors.join(', ')}] matches no outbound. It will return nothing for every request.`,
      )
    }
    for (const t of matched) {
      edges.push({
        from: `bal:${tag}`,
        to: `out:${t}`,
        kind: live?.selected === t ? 'active' : 'select',
      })
    }
    if (b['fallbackTag']) {
      const fb = String(b['fallbackTag'])
      edges.push({ from: `bal:${tag}`, to: `out:${fb}`, kind: 'fallback' })
      if (!outTags.includes(fb)) {
        warnings.push(
          `Balancer "${tag}" fallbackTag "${fb}" is not an existing outbound. Traffic will silently go to the FIRST outbound in the config instead.`,
        )
      }
    }
    if ((strategy === 'leastPing' || strategy === 'leastLoad') && !obs) {
      warnings.push(
        `Balancer "${tag}" uses ${strategy} but the config has no observatory or burstObservatory. The instance will fail to start with "not all dependencies are resolved."`,
      )
    }
  })

  let orow = 0
  outbounds.forEach((o, i) => {
    const tag = String(o['tag'] ?? `outbound-${i}`)
    const live = snap.outbounds.find((x) => x.tag === tag)
    nodes.push({
      id: `out:${tag}`,
      sel: { kind: 'outbound', index: i },
      label: tag || '(untagged)',
      sub: String(o['protocol'] ?? '?') + (i === 0 ? ' · default' : ''),
      col: 3,
      // Same prefix split as the rail and the RTT legend. Agreeing matters: moving your
      // eye between the diagram and the outbound list should not need a re-read.
      row: orow++,
      group: splitTag(tag).group,
      kind: 'outbound',
      status: live?.faultKind ? 'fault' : live?.alive === false ? 'bad' : live?.alive ? 'ok' : 'idle',
      ...(live?.faultKind ? { warn: `fault active: ${live.faultKind}` } : {}),
    })
    if (!o['tag']) {
      warnings.push(
        `Outbound #${i} has no tag. Untagged outbounds are invisible to balancers and observatories — they can never be selected.`,
      )
    }
  })

  if (obs) {
    const selectors = (obs['subjectSelector'] as string[]) ?? []
    const subjects = outTags.filter((t) => t && selectors.some((s) => t.startsWith(s)))
    nodes.push({
      id: 'obs',
      sel: { kind: 'observatory', index: 0 },
      label: isBurst ? 'burstObservatory' : 'observatory',
      sub: `${subjects.length} subject${subjects.length === 1 ? '' : 's'}`,
      col: 2,
      row: brow++,
      group: 'services',
      kind: 'observatory',
      status: subjects.length === 0 ? 'bad' : undefined,
    })
    for (const t of subjects) edges.push({ from: 'obs', to: `out:${t}`, kind: 'observe' })

    if (selectors.length === 0) {
      warnings.push(
        'The observatory has an empty subjectSelector, so it never starts. Balancers depending on it will return nothing.',
      )
    }

    // The high-value cross-check: candidates a balancer can pick but the observatory
    // never probes are invisible to leastPing and leastLoad.
    for (const b of balancers) {
      const bsel = (b['selector'] as string[]) ?? []
      const cands = outTags.filter((t) => t && bsel.some((s) => t.startsWith(s)))
      const uncovered = cands.filter((t) => !subjects.includes(t))
      if (uncovered.length > 0) {
        warnings.push(
          `Balancer "${b['tag']}" can select [${uncovered.join(', ')}], but the observatory does not probe them. leastPing and leastLoad iterate the observation, so those outbounds are invisible and can never be picked.`,
        )
      }
    }
  }

  // DNS sits in the services column beside the observatory: both are singletons that
  // act on the whole config rather than links in the inbound→outbound chain, and
  // drawing them in that chain would imply traffic flows through them.
  const dns = cfg['dns'] as Record<string, unknown> | undefined
  if (dns) {
    const servers = (dns['servers'] as unknown[]) ?? []
    const dnsTag = typeof dns['tag'] === 'string' ? dns['tag'] : ''
    const strategy = typeof dns['queryStrategy'] === 'string' ? dns['queryStrategy'] : 'UseIP'
    nodes.push({
      id: 'dns',
      sel: { kind: 'dns', index: 0 },
      label: 'dns',
      sub: `${servers.length} server${servers.length === 1 ? '' : 's'} · ${strategy}`,
      col: 2,
      row: brow++,
      group: 'services',
      kind: 'dns',
      status: servers.length === 0 ? 'bad' : undefined,
    })

    if (servers.length === 0) {
      warnings.push(
        'The dns block has no servers, so every lookup falls through to the system resolver — which is what configuring dns is normally meant to prevent.',
      )
    }

    // A `dns.tag` only does something once a routing rule selects it. Drawing the edge
    // when it exists, and warning when it does not, is the difference between "DNS is
    // routed" and "DNS looks routed".
    if (dnsTag) {
      const matched = rules
        .map((r, i) => ({ r, i }))
        .filter(({ r }) => ((r['inboundTag'] as string[]) ?? []).includes(dnsTag))
      for (const { i } of matched) edges.push({ from: 'dns', to: `rule:${i}`, kind: 'observe' })
      if (matched.length === 0) {
        warnings.push(
          `dns.tag is "${dnsTag}" but no routing rule matches that inboundTag, so DNS queries are routed exactly like ordinary traffic. The tag has no effect until a rule selects it.`,
        )
      }
    }

    // First match wins, and a server with no domains matches everything. Anything
    // after such a server is dead configuration that looks live.
    const catchAll = servers.findIndex(
      (s) =>
        typeof s === 'string' ||
        !Array.isArray((s as Record<string, unknown> | null)?.['domains']) ||
        ((s as Record<string, unknown>)['domains'] as unknown[]).length === 0,
    )
    if (catchAll >= 0 && catchAll < servers.length - 1) {
      warnings.push(
        `dns.servers[${catchAll}] has no domains, so it answers every query. The ${servers.length - catchAll - 1} server(s) after it are never consulted.`,
      )
    }
  }

  // Order the outbound column by group, then naturally within it.
  //
  // Config order is not grouped order: an author is free to write REGULAR-1, LTE-1,
  // REGULAR-2, and laying that out verbatim would split one group across several bands.
  // Reordering rows is safe because a node's identity for the inspector is `sel.index`,
  // which still points at the real position in the config.
  const outNodes = nodes.filter((n) => n.col === 3)
  outNodes
    .sort((a, b) => natural(a.group, b.group) || natural(a.label, b.label))
    .forEach((n, i) => {
      n.row = i
    })

  const maxRow = Math.max(row, rrow, brow, orow)
  return { nodes, edges, maxRow, warnings }
}

/** Strips // and /* *\/ comments and trailing commas, as Xray's JSON reader does. */
function stripJsonc(s: string): string {
  let out = ''
  let inStr = false
  let esc = false
  let i = 0
  while (i < s.length) {
    const c = s[i]!
    if (inStr) {
      out += c
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      i++
      continue
    }
    if (c === '"') {
      inStr = true
      out += c
      i++
      continue
    }
    if (c === '/' && s[i + 1] === '/') {
      while (i < s.length && s[i] !== '\n') i++
      continue
    }
    if (c === '/' && s[i + 1] === '*') {
      i += 2
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++
      i += 2
      continue
    }
    out += c
    i++
  }
  return out.replace(/,(\s*[}\]])/g, '$1')
}
