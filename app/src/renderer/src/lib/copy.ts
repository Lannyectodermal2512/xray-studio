import type { RejectionReason, StageId, StageNote, FaultKind } from '@shared/events'

/**
 * Human wording for the stable machine codes the core emits.
 *
 * The codes never change and are never localised; all phrasing lives here. Several of
 * these exist to explain Xray behaviour that is genuinely surprising, so the text is
 * doing real work — it is not decoration.
 */

export const rejectionLabel: Record<RejectionReason, string> = {
  not_in_observation: 'never probed',
  not_alive: 'reported dead',
  maxrtt_exceeded: 'slower than maxRTT',
  tolerance_exceeded: 'failure rate above tolerance',
  not_in_candidates: 'outside this balancer',
  outranked: 'outranked',
  above_baseline: 'above every baseline',
  beyond_expected: 'beyond the expected count',
  not_chosen_by_dice: 'lost the random draw',
  not_current_index: 'not this rotation slot',
}

export const rejectionHelp: Record<RejectionReason, string> = {
  not_in_observation:
    'The observatory has no record of this outbound. leastPing and leastLoad iterate the observation, not the candidate list, so an outbound that has never been probed is invisible to them — it is not rejected, it simply never appears. Usually means the observatory subjectSelector does not cover it.',
  not_alive:
    'The observatory reports this outbound as down. Under burstObservatory "alive" means at least one success in the current sampling window (all != fail), not "the last probe succeeded".',
  maxrtt_exceeded:
    'Delay is at or above maxRTT. Note the comparison uses Delay — an integer number of milliseconds — not HealthPing.Average, so sub-millisecond differences are invisible here.',
  tolerance_exceeded:
    'fail/all exceeds tolerance. Only active with burstObservatory (it needs HealthPing), with all > 0 and tolerance > 0 — under the plain observatory the setting parses but does nothing.',
  not_in_candidates: 'Present in the observation, but not selected by this balancer.',
  outranked: 'Viable, but another candidate ranked strictly better.',
  above_baseline: 'Score did not fall below any configured baseline.',
  beyond_expected: 'Ranked below the truncation point set by expected.',
  not_chosen_by_dice:
    'Survived to the final step and lost a uniform random draw. This is not a defect: the last step of random and leastLoad is chance, not ranking.',
  not_current_index: 'Round-robin selected a different slot on this pass.',
}

export const stageLabel: Record<StageId, string> = {
  select: 'selector',
  observation: 'observatory',
  alive_filter: 'liveness',
  node_filter: 'filters',
  score: 'score',
  sort: 'rank',
  baseline: 'baseline / expected',
  expected: 'expected',
  min_scan: 'lowest delay',
  rr_index: 'rotation',
  dice: 'random draw',
}

export interface NoteCopy {
  text: string
  tone: 'info' | 'warn' | 'bad'
}

export const stageNote: Record<StageNote, NoteCopy> = {
  observatory_ignored_no_fallback: {
    tone: 'warn',
    text:
      'Observatory ignored — random and roundRobin only consult it when fallbackTag is set. Without one, dead outbounds are picked just as readily as live ones.',
  },
  observatory_nil: {
    tone: 'bad',
    text:
      'No observatory is available, so this strategy returns nothing for every request. leastPing and leastLoad require an observatory or burstObservatory block.',
  },
  observation_error: {
    tone: 'bad',
    text: 'Reading the observatory failed; the liveness filter was skipped entirely.',
  },
  no_health_ping: {
    tone: 'warn',
    text:
      'No HealthPing data — this is the plain observatory, not burstObservatory. leastLoad therefore uses raw delay as the deviation and degenerates into leastPing with a cost multiplier.',
  },
  unfound_assumed_alive: {
    tone: 'warn',
    text:
      'A candidate missing from the observation was kept: random and roundRobin treat "not found" as ALIVE, not dead.',
  },
  baseline_applied: { tone: 'info', text: 'A baseline produced enough survivors and stopped the walk.' },
  baseline_none_qualified: {
    tone: 'warn',
    text:
      'Speed-priority mode (baselines with expected <= 0): nothing qualified, so the balancer legitimately selects nothing and defers to fallbackTag.',
  },
  baselines_unsorted: {
    tone: 'warn',
    text: 'Baselines are walked in config order, not sorted. A non-ascending list wastes iterations.',
  },
  expected_floor_applied: {
    tone: 'info',
    text: 'The expected floor widened the selection past what the baselines qualified.',
  },
  tie: {
    tone: 'warn',
    text:
      'Two or more candidates tied on the deciding key. Under burstObservatory the tie order comes from Go map iteration, so the winner among equals is re-randomised on every call.',
  },
  rr_index_jumped: {
    tone: 'warn',
    text:
      'The candidate list changed length, so the modulo rotation jumped rather than advancing by one. Round-robin is not a stable cursor over a stable set.',
  },
  empty: { tone: 'bad', text: 'Nothing survived this stage.' },
  override_pinned: {
    tone: 'bad',
    text:
      'A manual override is pinned, bypassing the strategy entirely. It has no expiry, and it is not validated — pinning a tag that does not exist kills the connection rather than falling back.',
  },
  no_baselines: { tone: 'info', text: 'No baselines configured; expected alone decides the cut.' },
  expected_exceeds_available: {
    tone: 'info',
    text: 'expected is larger than the number of qualified outbounds, so all of them are kept.',
  },
}

export const sourceCopy: Record<string, NoteCopy> = {
  strategy: { tone: 'info', text: 'Chosen by the strategy.' },
  override: {
    tone: 'bad',
    text: 'Pinned by a manual override — the strategy did not run.',
  },
  fallback_empty: {
    tone: 'warn',
    text: 'The strategy returned nothing, so fallbackTag was used.',
  },
  fallback_select_error: {
    tone: 'warn',
    text: 'Selecting candidates failed, so fallbackTag was used.',
  },
  error: {
    tone: 'bad',
    text:
      'No tag and no fallbackTag. The dispatcher silently falls through to the DEFAULT outbound — the first one in the config.',
  },
}

export const faultLabel: Record<FaultKind, string> = {
  blackhole: 'Blackhole (drop)',
  refuse: 'Connection refused',
  host_unreachable: 'Host unreachable',
  net_unreachable: 'Network unreachable',
  dns_fail: 'DNS failure',
  tls_hang: 'TLS handshake hangs',
  tls_garbage: 'TLS garbage response',
  latency: 'Added latency',
  throttle: 'Bandwidth throttle',
  reset_after: 'Reset mid-connection',
  udp_loss: 'UDP packet loss',
}

export const faultHelp: Record<FaultKind, string> = {
  blackhole:
    'Packets vanish. The dial blocks until it times out, exactly like an iptables DROP or a whitelist that ignores you. Probes and real traffic both see it.',
  refuse: 'Immediate ECONNREFUSED, like a closed port or REJECT --reject-with tcp-reset.',
  host_unreachable: 'ICMP host unreachable — the route exists but the host does not answer.',
  net_unreachable: 'ICMP network unreachable — no route to the network at all.',
  dns_fail:
    'Resolution fails. Partial fidelity: depending on domainStrategy, resolution may already have happened before the dialer is reached.',
  tls_hang:
    'TCP connects, then nothing answers, so the TLS handshake times out. The classic "port open, service dead" shape — and the one most easily mistaken for a working server.',
  tls_garbage:
    'TCP connects and the server replies with noise, producing "first record does not look like a TLS handshake".',
  latency: 'Adds delay to the connect and to every read. Use it to make a balancer re-rank.',
  throttle: 'Token-bucket rate limit in both directions.',
  reset_after: 'Passes traffic, then tears the connection down with ECONNRESET.',
  udp_loss: 'Drops a percentage of datagrams. Meaningful for QUIC, KCP and hysteria.',
}

export function fmtMs(ns: number | undefined): string {
  if (!ns) return '—'
  const ms = ns / 1e6
  if (ms < 1) return `${(ns / 1000).toFixed(0)}µs`
  if (ms < 1000) return `${ms.toFixed(1)}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

/**
 * The plain observatory writes delay = 99999999 for a dead outbound rather than
 * leaving it unset, and the burst observatory uses rttFailed = MaxInt64. Neither is a
 * measurement, and rendering them as durations produces nonsense like "100000.00s".
 */
export const DEAD_DELAY_MS = 99_999_999

export function isDeadSentinel(ms: number | undefined): boolean {
  return ms !== undefined && ms >= DEAD_DELAY_MS
}

export function fmtMsFromMs(ms: number | undefined): string {
  if (ms === undefined || ms === null) return '—'
  if (isDeadSentinel(ms)) return 'dead'
  if (ms === 0) return '<1ms'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(2)}s`
}
