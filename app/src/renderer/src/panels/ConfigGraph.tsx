import { useEffect, useMemo, useState } from 'react'
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

/** A drawn band: one group's extent within a column. */
interface Band {
  col: number
  label: string
  count: number
  y: number
  h: number
}

interface Edge {
  from: string
  to: string
  kind: 'route' | 'select' | 'observe' | 'fallback' | 'active'
}

const NODE_W = 200
const NODE_H = 52
const PAD_X = 40
const PAD_Y = 34

/**
 * Vertical room per node and horizontal room per column, at density 1.
 *
 * Both are scaled by the density control rather than fixed. With sixteen outbounds fed
 * by one balancer, sixteen edges converge on the same 200px-wide box: at the old fixed
 * spacing their curves overlapped into a solid band, and no amount of styling fixes
 * that — only distance does.
 */
const ROW_H_BASE = 74
const COL_GAP_BASE = 80
/** Extra vertical space between two groups in the same column, plus room for a heading. */
const GROUP_GAP = 30

/**
 * Read-only structural view of the config, laid out by semantic column rather than by
 * a general graph algorithm — we already know the layering
 * (inbounds → rules → balancers → outbounds), so a layout engine would only obscure it.
 *
 * The live overlay is the point: the current pick is highlighted, faulted outbounds are
 * marked, and a selector that matches nothing is called out — a condition Xray never
 * checks, because balancers are built before outbounds exist.
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
  // Density is a view setting, not config state: it belongs to the person reading the
  // diagram, and what "readable" means depends entirely on how many outbounds they have.
  const [density, setDensity] = useState(1)

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

  if (!configPath) return <div className="panel empty">Open a config to see its structure.</div>
  if (err) return <div className="panel empty bad">{err}</div>
  if (!model) return <div className="panel empty">Parsing…</div>
  if (model.error) {
    return (
      <div className="panel empty bad">
        Could not parse the config for display: {model.error}
      </div>
    )
  }

  const { pos, bands, width, height } = layout(model.nodes, density)

  // Give every edge leaving the same node its own departure lane.
  //
  // Twenty edges from one balancer all started at the same point with the same bend, so
  // they overlapped into a single opaque ribbon and you could not tell twenty apart from
  // two. Spreading the first control point across the horizontal gap makes each curve
  // leave at a different angle, which is what actually separates them — there is nothing
  // to route around here, the columns are already disjoint.
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
        <span className="dim">
          {onSelect ? 'click a node to edit it' : 'read-only — use the Build tab to edit'}
        </span>
        <span className="spacer" />
        <label className="graph-density" title="Spreads the diagram out. With many outbounds feeding one balancer the edges overlap; distance is the only thing that separates them.">
          <span className="tiny dim">spacing</span>
          <input
            type="range"
            min={0.6}
            max={2.4}
            step={0.1}
            value={density}
            onChange={(e) => setDensity(Number(e.target.value))}
          />
          <span className="tiny mono dim">{density.toFixed(1)}×</span>
        </label>
      </div>
      {/* Scales to fit rather than scrolling. The diagram is only four columns wide and
          its value is seeing the whole path at once; a min-width made it overflow the
          card in the Build layout and silently clip the outbounds column instead. */}
      <svg
        className="graph"
        width="100%"
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="xMinYMin meet"
      >
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M0,0 L10,5 L0,10 z" fill="#4a5260" />
          </marker>
          <marker id="arrowd" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M0,0 L10,5 L0,10 z" fill="#3fb950" />
          </marker>
        </defs>

        {/* Group bands first, so every edge and node draws over them. */}
        {bands.map((b, i) => (
          <g key={`band-${i}`} className="graph-band">
            <rect
              x={PAD_X + b.col * (NODE_W + COL_GAP_BASE * density) - 10}
              y={b.y - 4}
              width={NODE_W + 20}
              height={b.h}
              rx={10}
            />
            <text
              x={PAD_X + b.col * (NODE_W + COL_GAP_BASE * density) - 2}
              y={b.y + 8}
              className="graph-band-label"
            >
              {b.label} · {b.count}
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
          // Lane within the gap: 0.15..0.7 of the way across, so curves stay inside the
          // corridor between the two columns and never cross a node.
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
              {n.warn && (
                <title>{n.warn}</title>
              )}
              {n.warn && (
                <circle cx={NODE_W - 12} cy={12} r={4} fill="var(--warn)" />
              )}
            </g>
          )
        })}
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
 * Turns per-column ordering into coordinates.
 *
 * Kept separate from buildModel so density is a pure re-layout: changing the slider must
 * not re-parse the config or disturb which node is selected. Groups are laid out in the
 * order buildModel emitted them, so a column's reading order still follows the config.
 */
function layout(
  nodes: Node[],
  density: number,
): { pos: Map<string, { x: number; y: number }>; bands: Band[]; width: number; height: number } {
  const rowH = ROW_H_BASE * density
  const colW = NODE_W + COL_GAP_BASE * density
  const pos = new Map<string, { x: number; y: number }>()
  const bands: Band[] = []

  const cols = new Map<number, Node[]>()
  for (const n of nodes) {
    const arr = cols.get(n.col)
    if (arr) arr.push(n)
    else cols.set(n.col, [n])
  }

  let maxY = 0
  let maxCol = 0
  for (const [col, list] of cols) {
    maxCol = Math.max(maxCol, col)
    const ordered = [...list].sort((a, b) => a.row - b.row)
    let y = PAD_Y
    let i = 0
    while (i < ordered.length) {
      const group = ordered[i]!.group
      const members: Node[] = []
      while (i < ordered.length && ordered[i]!.group === group) members.push(ordered[i++]!)

      // A band is only worth drawing when it names something. A single-member group in a
      // column of one is just a node, and a heading over it is noise.
      const banded = members.length > 1 || cols.get(col)!.length > members.length
      const top = y
      if (banded) y += 16

      for (const n of members) {
        pos.set(n.id, { x: PAD_X + col * colW, y })
        y += rowH
      }

      if (banded) {
        bands.push({ col, label: group, count: members.length, y: top, h: y - top - (rowH - NODE_H) + 6 })
      }
      y += GROUP_GAP * density
      maxY = Math.max(maxY, y)
    }
  }

  return {
    pos,
    bands,
    width: PAD_X * 2 + maxCol * colW + NODE_W,
    height: Math.max(320, maxY + 10),
  }
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
