import { useEffect, useMemo, useState } from 'react'
import { effectiveConfigPath, useApp } from '../store/app'

import type { Selection } from './Inspector'

interface Node {
  id: string
  /** What this node maps to in the config, for the inspector. */
  sel?: Selection
  label: string
  sub: string
  col: number
  row: number
  kind: 'inbound' | 'rule' | 'balancer' | 'outbound' | 'observatory' | 'dns'
  status?: 'ok' | 'bad' | 'idle' | 'fault' | undefined
  warn?: string | undefined
}

interface Edge {
  from: string
  to: string
  kind: 'route' | 'select' | 'observe' | 'fallback' | 'active'
}

const COL_X = [40, 300, 580, 860]
const ROW_H = 74
const NODE_W = 200
const NODE_H = 52

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

  const height = Math.max(320, (model.maxRow + 1) * ROW_H + 40)

  return (
    <div className="panel graph-panel">
      <div className="panel-head">
        <h3>Structure</h3>
        <span className="dim">
          {onSelect ? 'click a node to edit it' : 'read-only — use the Build tab to edit'}
        </span>
      </div>
      {/* Scales to fit rather than scrolling. The diagram is only four columns wide and
          its value is seeing the whole path at once; a min-width made it overflow the
          card in the Build layout and silently clip the outbounds column instead. */}
      <svg
        className="graph"
        width="100%"
        height={height}
        viewBox={`0 0 1100 ${height}`}
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

        {model.edges.map((e, i) => {
          const a = model.nodes.find((n) => n.id === e.from)
          const b = model.nodes.find((n) => n.id === e.to)
          if (!a || !b) return null
          const x1 = COL_X[a.col]! + NODE_W
          const y1 = 20 + a.row * ROW_H + NODE_H / 2
          const x2 = COL_X[b.col]!
          const y2 = 20 + b.row * ROW_H + NODE_H / 2
          const mid = (x1 + x2) / 2
          const active = e.kind === 'active'
          return (
            <path
              key={i}
              d={`M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`}
              fill="none"
              stroke={active ? 'var(--ok)' : e.kind === 'observe' ? '#5d6875' : '#3a4250'}
              strokeWidth={active ? 2.4 : 1.2}
              strokeDasharray={e.kind === 'observe' ? '4 3' : e.kind === 'fallback' ? '2 3' : undefined}
              markerEnd={active ? 'url(#arrowd)' : 'url(#arrow)'}
              opacity={active ? 1 : 0.65}
            />
          )
        })}

        {model.nodes.map((n) => {
          const x = COL_X[n.col]!
          const y = 20 + n.row * ROW_H
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
      kind: 'inbound',
    })
  })

  let rrow = 0
  rules.forEach((r, i) => {
    const id = `rule:${i}`
    const tag = String(r['ruleTag'] ?? `rule ${i}`)
    const target = r['balancerTag'] ? `→ ${r['balancerTag']}` : `→ ${r['outboundTag'] ?? '?'}`
    nodes.push({ id, label: tag, sub: target, col: 1, row: rrow++, kind: 'rule', sel: { kind: 'rule', index: i } })

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
      row: orow++,
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
