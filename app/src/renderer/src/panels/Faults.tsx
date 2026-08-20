import { useMemo, useState } from 'react'
import type { FaultKind, FaultRule } from '@shared/events'
import { globMembers, tagsMatching } from '@shared/events'
import { useCopy } from '../lib/copy'
import { useT } from '../lib/i18n'
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
  'udp_loss',
]

const HARD_DOWN: FaultKind[] = ['blackhole', 'refuse', 'host_unreachable', 'net_unreachable', 'dns_fail']

export function Faults(): React.JSX.Element {
  const { faultLabel, faultHelp } = useCopy()
  const { t } = useT()
  const { snap, applyFaults, toggleFault } = useApp()
  const [kind, setKind] = useState<FaultKind>('blackhole')
  const [tagGlob, setTagGlob] = useState('')
  const [delayMs, setDelayMs] = useState('')

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
    }
    await applyFaults([...snap.faults, rule])
    setTagGlob('')
    setDelayMs('')
  }

  const remove = async (id: string): Promise<void> => {
    await applyFaults(snap.faults.filter((r) => r.id !== id))
  }

  const needsDelay = kind === 'latency' || kind === 'reset_after' || kind === 'blackhole'

  return (
    <div className="faults">
      <section className="panel">
        <h3>{t('faults.inject')}</h3>
        <div className="fault-form">
          <label className="grow">
            <span>{t('faults.pickOutbounds')}</span>
            <input
              value={tagGlob}
              onChange={(e) => setTagGlob(e.target.value)}
              placeholder={t('faults.tagsPlaceholder')}
            />
          </label>

          <label>
            <span>{t('faults.failureMode')}</span>
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
              <span>{kind === 'blackhole' ? t('faults.holdMs') : t('faults.delayMs')}</span>
              <input
                value={delayMs}
                onChange={(e) => setDelayMs(e.target.value)}
                placeholder={kind === 'blackhole' ? '16000' : '200'}
                inputMode="numeric"
              />
            </label>
          )}

          <button className="primary" onClick={() => void add()}>
            {t('faults.add')}
          </button>
        </div>

        <div className="tag-picker">
          {allTags.length === 0 ? (
            <span className="tiny dim">
              {t('faults.noOutboundsSeen')}
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
                    ? t('faults.coveredByPattern')
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
              <span className="tiny dim">{t('faults.groups')}</span>
              {groups.map((g) => (
                <button key={g} className="link" onClick={() => setTagGlob(`${g}*`)}>
                  {g}*
                </button>
              ))}
              <span className="sep" />
            </>
          )}
          <button className="link" onClick={() => setTagGlob(allTags.join(', '))}>
            {t('faults.selectAll')}
          </button>
          <button className="link" onClick={() => setTagGlob('')}>
            {t('faults.selectNone')}
          </button>
          <button
            className="link"
            onClick={() => setTagGlob(allTags.filter((t) => !willHit.includes(t)).join(', '))}
          >
            {t('faults.selectInvert')}
          </button>
        </div>

        {tagGlob.trim() && (
          <p className={willHit.length === 0 ? 'note bad' : 'note info'}>
            {willHit.length === 0 ? (
              <>
                {t('faults.thisMatches')} <strong>{t('faults.matchNone')}</strong>{' '}
                {t('faults.matchesNoneOf', { n: allTags.length })}
              </>
            ) : (
              <>
                {t('faults.willHitLabel')} <strong>{willHit.length}</strong> of {allTags.length} outbounds:{' '}
                <span className="mono">{willHit.join('  ')}</span>
              </>
            )}
          </p>
        )}

        <p className="note info">{faultHelp[kind]}</p>

        {kind === 'blackhole' && (
          <p className="note warn">
            {t('faults.blackholeNote')}
          </p>
        )}

        <p className="note info">
          {t('faults.rulesMatchOn')} <strong>{t('faults.outboundTag')}</strong>{t('faults.tagNotAddress')}
        </p>
        <p className="note info">
          {t('faults.groupIs')} <strong>{t('faults.oneRule')}</strong>{t('faults.oneRuleNote')}
        </p>
      </section>

      <FaultEvidence />

      <section className="panel">
        <h3>
          {t('faults.activeRules')} <span className="dim">{snap.faults.length}</span>
        </h3>
        {snap.faults.length === 0 ? (
          <p className="dim">{t('faults.none')}</p>
        ) : (
          <table className="grid">
            <thead>
              <tr>
                <th />
                <th>{t('faults.colOutbounds')}</th>
                <th>{t('faults.colMode')}</th>
                <th>{t('faults.colParams')}</th>
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
                      title={r.enabled ? t('faults.disarmGroup') : t('faults.armGroup')}
                    />
                  </td>
                  <td>
                    <RuleTargets rule={r} allTags={allTags} />
                  </td>
                  <td>
                    {faultLabel[r.kind]}
                    {HARD_DOWN.includes(r.kind) && (
                      <span className="chip tiny" title={t('faults.hardDown')}>
                        {t('faults.killsLiveConns')}
                      </span>
                    )}
                  </td>
                  <td className="mono dim">
                    {[
                      r.delayMs && `delay=${r.delayMs}ms`,
                      r.rateBps && `rate=${r.rateBps}B/s`,
                      r.lossPercent && `loss=${r.lossPercent}%`,
                      r.afterBytes && `after=${r.afterBytes}B`,
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
        <h3>{t('faults.cannotReproduce')}</h3>
        <p className="dim">
          {t('faults.gapsLead')}
        </p>
        <ol className="gaps">
          <li>
            <code>sockopt.dialerProxy</code> {t('faults.gapDialerProxy')}
          </li>
          <li>
            {t('faults.gapWireguard')}
          </li>
          <li>
            <code>burstObservatory</code>&apos;s <code>connectivity</code> {t('faults.gapConnectivity1')} <em>{t('faults.discard')}</em> {t('faults.gapConnectivity2')}
          </li>
          <li>
            {t('faults.gapTcp')}
          </li>
          <li>
            {t('faults.gapDns')} <code>domainStrategy</code>.
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
  const { t } = useT()
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
        <span className="chip tiny bad" title={t('faults.neverFires')}>
          {t('faults.matchesNothing')}
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
