import { useMemo, useState } from 'react'
import type { FaultKind, FaultRule } from '@shared/events'
import { globMembers, tagsMatching } from '@shared/events'
import { faultHelp, faultLabel } from '../lib/copy'
import { useApp } from '../store/app'
import { FaultEvidence } from './FaultEvidence'

const KINDS: FaultKind[] = [
  'blackhole',
  'refuse',
  'host_unreachable',
  'net_unreachable',
  'dns_fail',
  'tls_hang',
  'tls_garbage',
  'latency',
  'throttle',
  'reset_after',
  'quota_freeze',
  'udp_loss',
]

const HARD_DOWN: FaultKind[] = ['blackhole', 'refuse', 'host_unreachable', 'net_unreachable', 'dns_fail']

export function Faults(): React.JSX.Element {
  const { snap, applyFaults, toggleFault } = useApp()
  const [kind, setKind] = useState<FaultKind>('blackhole')
  const [tagGlob, setTagGlob] = useState('')
  const [delayMs, setDelayMs] = useState('')
  // Quota, in kilobytes, because that is the unit the behaviour is discussed in and
  // nobody wants to type 16384. Stored in bytes, which is what the engine counts.
  const [upKb, setUpKb] = useState('')
  const [downKb, setDownKb] = useState('')

  const allTags = useMemo(() => snap.outbounds.map((o) => o.tag), [snap.outbounds])
  const selected = useMemo(() => new Set(globMembers(tagGlob)), [tagGlob])
  // What the rule will ACTUALLY hit, resolved with the same matcher the sidecar uses.
  // Shown rather than assumed: a glob that silently matches nothing is the single
  // most common reason a fault "does not work".
  const willHit = useMemo(
    () => (tagGlob.trim() ? tagsMatching(tagGlob, allTags) : []),
    [tagGlob, allTags],
  )
  const groups = useMemo(() => commonPrefixes(allTags), [allTags])

  /** Clicking a tag adds or removes it from the group. */
  const toggleTag = (tag: string): void => {
    const next = new Set(selected)
    if (next.has(tag)) next.delete(tag)
    else next.add(tag)
    setTagGlob([...next].join(', '))
  }

  const add = async (): Promise<void> => {
    const rule: FaultRule = {
      id: `f${Date.now().toString(36)}`,
      enabled: true,
      kind,
      tagGlob: tagGlob.trim() || '*',
      ...(delayMs ? { delayMs: Number(delayMs) } : {}),
      ...(kind === 'quota_freeze' && upKb ? { upBytes: Number(upKb) * 1024 } : {}),
      ...(kind === 'quota_freeze' && downKb ? { downBytes: Number(downKb) * 1024 } : {}),
    }
    await applyFaults([...snap.faults, rule])
    setTagGlob('')
    setDelayMs('')
    setUpKb('')
    setDownKb('')
  }

  const remove = async (id: string): Promise<void> => {
    await applyFaults(snap.faults.filter((r) => r.id !== id))
  }

  const needsDelay = kind === 'latency' || kind === 'reset_after' || kind === 'blackhole'

  return (
    <div className="faults">
      <section className="panel">
        <h3>Inject a fault</h3>
        <div className="fault-form">
          <label className="grow">
            <span>Outbounds — click to build a group</span>
            <input
              value={tagGlob}
              onChange={(e) => setTagGlob(e.target.value)}
              placeholder="LTE-1, LTE-4, REGULAR-*   (empty = all)"
            />
          </label>

          <label>
            <span>Failure mode</span>
            <select value={kind} onChange={(e) => setKind(e.target.value as FaultKind)}>
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {faultLabel[k]}
                </option>
              ))}
            </select>
          </label>

          {needsDelay && (
            <label>
              <span>{kind === 'blackhole' ? 'Hold (ms)' : 'Delay (ms)'}</span>
              <input
                value={delayMs}
                onChange={(e) => setDelayMs(e.target.value)}
                placeholder={kind === 'blackhole' ? '16000' : '200'}
                inputMode="numeric"
              />
            </label>
          )}

          {kind === 'quota_freeze' && (
            <>
              <label>
                <span>Upload (KB)</span>
                <input
                  value={upKb}
                  onChange={(e) => setUpKb(e.target.value)}
                  placeholder="16"
                  inputMode="numeric"
                  title="Bytes this connection may send before it stops carrying traffic. Empty uses 16 KB."
                />
              </label>
              <label>
                <span>Download (KB)</span>
                <input
                  value={downKb}
                  onChange={(e) => setDownKb(e.target.value)}
                  placeholder="20"
                  inputMode="numeric"
                  title="Bytes this connection may receive before it stops carrying traffic. Empty uses 20 KB."
                />
              </label>
            </>
          )}

          <button className="primary" onClick={() => void add()}>
            Add
          </button>
        </div>

        <div className="tag-picker">
          {allTags.length === 0 ? (
            <span className="tiny dim">
              No outbounds seen yet — start an instance, or type tags by hand above.
            </span>
          ) : (
            allTags.map((tag) => (
              <button
                key={tag}
                className={`chip ${selected.has(tag) ? 'sel' : ''} ${
                  !selected.has(tag) && willHit.includes(tag) ? 'implied' : ''
                }`}
                onClick={() => toggleTag(tag)}
                title={
                  willHit.includes(tag) && !selected.has(tag)
                    ? 'covered by a pattern in the field above'
                    : undefined
                }
              >
                {tag}
              </button>
            ))
          )}
        </div>

        <div className="tag-actions">
          {groups.length > 0 && (
            <>
              <span className="tiny dim">groups:</span>
              {groups.map((g) => (
                <button key={g} className="link" onClick={() => setTagGlob(`${g}*`)}>
                  {g}*
                </button>
              ))}
              <span className="sep" />
            </>
          )}
          <button className="link" onClick={() => setTagGlob(allTags.join(', '))}>
            all
          </button>
          <button className="link" onClick={() => setTagGlob('')}>
            none
          </button>
          <button
            className="link"
            onClick={() => setTagGlob(allTags.filter((t) => !willHit.includes(t)).join(', '))}
          >
            invert
          </button>
        </div>

        {tagGlob.trim() && (
          <p className={willHit.length === 0 ? 'note bad' : 'note info'}>
            {willHit.length === 0 ? (
              <>
                This matches <strong>none</strong> of the {allTags.length} outbounds. The
                rule would be accepted and then never fire — check for a typo, or that the
                instance is running.
              </>
            ) : (
              <>
                Will hit <strong>{willHit.length}</strong> of {allTags.length} outbounds:{' '}
                <span className="mono">{willHit.join('  ')}</span>
              </>
            )}
          </p>
        )}

        <p className="note info">{faultHelp[kind]}</p>

        {kind === 'blackhole' && (
          <p className="note warn">
            A blackhole holds each dial for up to 16s, matching Xray&apos;s own dialer
            timeout. The observatory dials with a long-lived context rather than the
            per-request one, so a probe gives up at its 5s timeout while the dial keeps
            occupying a goroutine — set a shorter hold if you are probing frequently.
          </p>
        )}

        <p className="note info">
          Rules match on the <strong>outbound tag</strong>, not on an address. That is
          the point: two outbounds can share a server IP and port, and a packet filter
          cannot tell them apart. First matching rule wins, in list order.
        </p>
        <p className="note info">
          A group is <strong>one rule</strong>, so the checkbox arms and disarms the whole
          set in a single swap. That matters for correctness, not just convenience:
          toggling members one at a time would pass through half-failed states that look
          exactly like the real partial outage you are trying to observe.
        </p>
      </section>

      <FaultEvidence />

      <section className="panel">
        <h3>
          Active rules <span className="dim">{snap.faults.length}</span>
        </h3>
        {snap.faults.length === 0 ? (
          <p className="dim">No faults. Everything is behaving normally.</p>
        ) : (
          <table className="grid">
            <thead>
              <tr>
                <th />
                <th>outbounds</th>
                <th>mode</th>
                <th>params</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {snap.faults.map((r) => (
                <tr key={r.id} className={r.enabled ? '' : 'off'}>
                  <td>
                    <input
                      type="checkbox"
                      checked={r.enabled}
                      onChange={() => void toggleFault(r.id)}
                      title={r.enabled ? 'disarm this group' : 'arm this group'}
                    />
                  </td>
                  <td>
                    <RuleTargets rule={r} allTags={allTags} />
                  </td>
                  <td>
                    {faultLabel[r.kind]}
                    {HARD_DOWN.includes(r.kind) && (
                      <span className="chip tiny" title="also tears down existing connections">
                        kills live conns
                      </span>
                    )}
                  </td>
                  <td className="mono dim">
                    {[
                      r.delayMs && `delay=${r.delayMs}ms`,
                      r.rateBps && `rate=${r.rateBps}B/s`,
                      r.lossPercent && `loss=${r.lossPercent}%`,
                      r.afterBytes && `after=${r.afterBytes}B`,
                      r.kind === 'quota_freeze' &&
                        `up=${Math.round((r.upBytes ?? 16384) / 1024)}KB  down=${Math.round(
                          (r.downBytes ?? 20480) / 1024,
                        )}KB`,
                    ]
                      .filter(Boolean)
                      .join('  ') || '—'}
                  </td>
                  <td>
                    <button className="link" onClick={() => void remove(r.id)}>
                      remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel">
        <h3>What these faults cannot reproduce</h3>
        <p className="dim">
          The claim is &ldquo;as if genuinely unreachable&rdquo;, and it is only mostly
          true. Five honest gaps:
        </p>
        <ol className="gaps">
          <li>
            <code>sockopt.dialerProxy</code> hops receive a pipe from Xray&apos;s
            internal redirect and never reach the dialer, so faults do not apply to them.
          </li>
          <li>
            WireGuard&apos;s inner gVisor netstack dials bypass the dialer; only the
            outer UDP to the peer is covered.
          </li>
          <li>
            <code>burstObservatory</code>&apos;s <code>connectivity</code> check uses a
            plain HTTP client outside Xray entirely — and when it decides the network is
            down, it makes the observatory <em>discard</em> failures rather than record
            them, which can hide an injected fault. Leave it unset while testing.
          </li>
          <li>
            No TCP segment loss: userspace can stall and jitter a stream but cannot drop
            a segment beneath the kernel. No ICMP, no PMTUD blackholes.
          </li>
          <li>
            DNS failure is partial — resolution may already have happened before the
            dialer is reached, depending on <code>domainStrategy</code>.
          </li>
        </ol>
      </section>
    </div>
  )
}

/**
 * A rule's targets, resolved against the outbounds that actually exist.
 *
 * Shows what it hits, not what it says. `LTE-*` is unreadable on its own — you cannot
 * tell from it whether the group is 2 outbounds or 12, and a stale pattern that now
 * matches nothing looks identical to one that matches everything.
 */
function RuleTargets({ rule, allTags }: { rule: FaultRule; allTags: string[] }): React.JSX.Element {
  const hit = tagsMatching(rule.tagGlob, allTags)
  const members = globMembers(rule.tagGlob)
  const isPattern = members.some((m) => m.includes('*') || m.includes('?')) || rule.tagGlob === '*'

  if (allTags.length === 0) {
    // Nothing is running, so "matches nothing" would be misleading rather than useful.
    return <span className="mono">{rule.tagGlob}</span>
  }
  if (hit.length === 0) {
    return (
      <>
        <span className="mono">{rule.tagGlob}</span>{' '}
        <span className="chip tiny bad" title="this rule can never fire as written">
          matches nothing
        </span>
      </>
    )
  }
  return (
    <div className="rule-targets">
      {hit.map((t) => (
        <span key={t} className="chip tiny">
          {t}
        </span>
      ))}
      {isPattern && (
        <span className="tiny dim" title={rule.tagGlob}>
          via {rule.tagGlob}
        </span>
      )}
    </div>
  )
}

/**
 * Tag prefixes shared by two or more outbounds, offered as one-click groups.
 *
 * Derived from the config rather than configured, because the grouping is already
 * there — operators name outbounds `LTE-1..12`, `REGULAR-1..4`. Splitting on the first
 * separator recovers exactly the sets they think in.
 */
function commonPrefixes(tags: string[]): string[] {
  const counts = new Map<string, number>()
  for (const tag of tags) {
    const m = /^([^-_.]+[-_.])/.exec(tag)
    if (!m) continue
    counts.set(m[1]!, (counts.get(m[1]!) ?? 0) + 1)
  }
  return [...counts.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 6)
    .map(([p]) => p)
}
