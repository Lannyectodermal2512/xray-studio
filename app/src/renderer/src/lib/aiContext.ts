import type { Diagnostic, Snapshot } from '@shared/events'
import { isDeadSentinel } from './copy'

/**
 * What the assistant is told about the running instance.
 *
 * The point of wiring a model into this app rather than pasting a config into a chat
 * window elsewhere is that the app holds evidence the model otherwise cannot have: which
 * outbounds the observatory believes are alive, what their deviation actually is, which
 * candidate the balancer rejected and for what stated reason, which faults are armed.
 * "Why is LTE-3 never selected?" has a real answer here and only a guess anywhere else.
 *
 * Everything is summarised rather than dumped. A raw event stream would be mostly
 * repetition, and the budget is better spent on the config itself.
 */

export interface ContextOptions {
  includeConfig: boolean
  includeTelemetry: boolean
  redactSecrets: boolean
}

/** Keys whose values are credentials. Matched case-insensitively, by whole key. */
const SECRET_KEYS =
  /^(id|password|auth|token|secret|seed|privatekey|publickey|shortid|apikey|api_key)$/i

/**
 * Masks credential values while preserving shape.
 *
 * The config is the substance of every question worth asking here, and it is also where
 * the UUIDs and Reality keys live. Sending it to a third party is a real disclosure, so
 * the values that are actually secret are replaced with a marker of the same length
 * class — the model still sees that a field is present and well-formed, which is all it
 * needs to reason about structure.
 */
export function redact(raw: string): string {
  return raw.replace(
    /("(?:[A-Za-z_][\w-]*)")(\s*:\s*)"([^"]*)"/g,
    (whole, keyQuoted: string, sep: string, value: string) => {
      const key = keyQuoted.slice(1, -1)
      if (!SECRET_KEYS.test(key) || value === '') return whole
      return `${keyQuoted}${sep}"<redacted:${value.length}>"`
    },
  )
}

export function buildContext(
  snap: Snapshot,
  config: { path: string | null; text: string | null },
  diags: Diagnostic[] | null,
  opts: ContextOptions,
): string {
  const parts: string[] = []

  parts.push(
    [
      '# Environment',
      `Xray-core: ${snap.xrayVersion ?? 'not started'}`,
      `Instance state: ${snap.state?.state ?? 'stopped'}`,
      `Config path: ${config.path ?? '(none)'}`,
    ].join('\n'),
  )

  if (opts.includeTelemetry && snap.outbounds.length > 0) {
    parts.push(outboundTable(snap))
    if (snap.balancers.length > 0) parts.push(balancerSection(snap))
    const active = snap.faults.filter((f) => f.enabled)
    if (active.length > 0) parts.push(faultSection(snap, active))
    if (snap.recentLogs.length > 0) parts.push(logSection(snap))
  }

  if (diags && diags.length > 0) parts.push(diagSection(diags))

  if (opts.includeConfig && config.text) {
    const body = opts.redactSecrets ? redact(config.text) : config.text
    parts.push(
      `# Config${opts.redactSecrets ? ' (credentials masked)' : ''}\n\`\`\`json\n${body}\n\`\`\``,
    )
  }

  return parts.join('\n\n')
}

function outboundTable(snap: Snapshot): string {
  const rows = (snap.outbounds ?? [])
    .filter((o) => o.tag)
    .map((o) => {
      const delay = isDeadSentinel(o.delayMs) ? 'dead' : o.delayMs === 0 ? '-' : `${o.delayMs}ms`
      const health = o.hasHealthPing
        ? `avg=${fmtNs(o.avgNs)} dev=${fmtNs(o.devNs)} fail=${o.fail}/${o.all}`
        : 'no HealthPing'
      return [
        o.tag,
        o.alive === null ? 'never probed' : o.alive ? 'alive' : 'dead',
        delay,
        health,
        o.faultKind ? `FAULT ${o.faultKind} (${o.faultHits} dials hit)` : '',
        o.lastErr ? `last error: ${o.lastErr.slice(0, 120)}` : '',
      ]
        .filter(Boolean)
        .join(' | ')
    })
  return `# Outbounds (${rows.length}), as the observatory currently reports them\n${rows.join('\n')}`
}

function balancerSection(snap: Snapshot): string {
  const out = snap.balancers.map((b) => {
    const head =
      `## ${b.tag} — ${b.strategy}\n` +
      // ?? [] throughout: the sidecar is Go, and Go marshals a nil slice as null rather
      // than [], so any of these can arrive null even though the type says string[].
      `selectors: ${(b.selectors ?? []).join(', ') || '(none)'}\n` +
      `candidates: ${(b.candidates ?? []).join(', ') || '(none)'}\n` +
      `currently selected: ${b.selected || '(none)'} (source: ${b.source || '-'})\n` +
      `evaluations: ${b.evalCount}${b.fallbackTag ? `, fallbackTag: ${b.fallbackTag}` : ''}` +
      (b.err ? `\nerror: ${b.err}` : '')

    // The funnel is the one thing no other tool can tell them, so it is worth the
    // tokens: every candidate that dropped out, and the core's own stated reason.
    const ev = snap.lastEvals[b.tag]
    if (!ev?.stages?.length) return head
    const stages = ev.stages
      .map((s) => {
        const kept = (s.out ?? []).join(', ') || '(none)'
        const dropped = (s.rejected ?? []).map((r) => `${r.tag} (${r.reason})`).join(', ')
        // Scores are the substance of the leastLoad ranking stage: without them "outranked"
        // is a verdict with no arithmetic behind it.
        const scores = s.scores
          ? ' | scores ' +
            Object.entries(s.scores)
              .map(([tag, ns]) => `${tag}=${(ns / 1e6).toFixed(1)}ms`)
              .join(', ')
          : ''
        return `  ${s.id}: kept ${kept}${dropped ? ` | dropped ${dropped}` : ''}${scores}${
          s.note ? ` | note ${s.note}` : ''
        }`
      })
      .join('\n')
    return `${head}\nlast decision:\n${stages}`
  })
  return `# Balancers\n${out.join('\n\n')}`
}

function faultSection(snap: Snapshot, active: Snapshot['faults']): string {
  const rules = active.map(
    (f) =>
      `${f.id}: ${f.kind} on tags matching "${f.tagGlob}"` +
      (f.delayMs ? `, delay ${f.delayMs}ms` : '') +
      (f.lossPercent ? `, loss ${f.lossPercent}%` : ''),
  )
  const hits = snap.outbounds
    .filter((o) => o.faultHits > 0)
    .map((o) => `${o.tag}: ${o.faultHits} intercepted dials`)
  return [
    '# Injected faults (these are deliberate, applied by the user through this app)',
    ...rules,
    hits.length ? `evidence:\n${hits.join('\n')}` : 'No dial has been intercepted yet.',
  ].join('\n')
}

function logSection(snap: Snapshot): string {
  const lines = (snap.recentLogs ?? [])
    .slice(-25)
    .map((l) => `[${l.severity}] ${l.message.slice(0, 200)}`)
  return `# Recent core log (last ${lines.length} lines)\n${lines.join('\n')}`
}

function diagSection(diags: Diagnostic[]): string {
  const lines = diags
    .slice(0, 40)
    .map((d) => `[${d.severity}] ${d.code}${d.path ? ` at ${d.path}` : ''}: ${d.message}`)
  return `# Validator findings\n${lines.join('\n')}`
}

function fmtNs(ns: number): string {
  if (!ns) return '-'
  return ns >= 1e6 ? `${(ns / 1e6).toFixed(1)}ms` : `${(ns / 1000).toFixed(0)}µs`
}

/**
 * The assistant's brief.
 *
 * Written to make it useful about THIS core rather than about Xray in general: the
 * version is pinned, several keys were removed in 26.x, and the balancer behaviours that
 * confuse people are specific and checkable. It is also told to say when the telemetry
 * does not support an answer — a confident guess about why an outbound is dead is worse
 * than none, because the app exists precisely to stop people guessing.
 */
export const SYSTEM_PROMPT = `You are an assistant inside Xray Studio, a desktop tool for testing Xray-core configurations. You are helping the user understand and edit a specific Xray config, and you are given live telemetry from a running instance of Xray-core v26.7.28.

Ground rules:
- Answer from the telemetry and config you are given. When they do not settle a question, say so and name what would settle it — a probe, a fault, a config change. Do not guess about liveness, latency or selection.
- The core is v26.7.28. Several keys were removed in the 26.x line and are silently ignored by Go's JSON decoder rather than rejected: routing.domainMatcher, a rule's "type": "field", allowInsecure, the h2 and quic transports, the global "transport" block, legacy reverse, and Trojan's flow. Point these out when you see them.
- Balancer behaviour worth remembering: leastPing and leastLoad iterate the OBSERVATION, not the candidate list, so an outbound the observatory never probed is invisible rather than rejected. random and roundRobin only consult the observatory when fallbackTag is set. leastLoad ends in a uniform random draw over the survivors, so it is only deterministic with expected=1 and no baselines. Its score is RTTDeviation × √costWeight, and without burstObservatory there is no HealthPing, so deviation degrades to raw delay.
- Fault injection in this app happens at the dialer. It cannot reach a dialerProxy hop, WireGuard's internal stack, or burst.checkConnectivity, and mux reuses one physical connection so a fault only bites on a NEW dial.
- When proposing a config change, give the smallest edit that achieves it and say what it changes at runtime. Show JSON fragments, not whole rewritten files, unless asked.
- Be concise. The user is an engineer looking at the same data you are.`
