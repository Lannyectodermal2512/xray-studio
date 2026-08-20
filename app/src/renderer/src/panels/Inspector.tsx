import { useMemo } from 'react'
import { DocHint } from '../components/DocHint'
import { JsonSlice } from '../components/JsonSlice'
import * as E from '../graph/edit'
import type { ParsedConfig } from '../graph/edit'
import { useT } from '../lib/i18n'

/**
 * Property editor for whatever is selected in the graph.
 *
 * Every change is a minimal text patch (see graph/edit.ts) applied to a working copy.
 * Nothing touches the user's file until they press Save — this edits a real config they
 * also maintain by hand, so silently rewriting it on every keystroke would be wrong.
 */

export type Selection =
  | { kind: 'observatory'; index: number }
  | { kind: 'outbound'; index: number }
  | { kind: 'balancer'; index: number }
  | { kind: 'rule'; index: number }
  | { kind: 'dns'; index: number }
  | null

/** Accepted spellings are far looser than this (`use_ip4`, `use-ipv4`, …) and anything
 *  unrecognised silently becomes UseIP — offer the canonical four rather than a free
 *  text field that fails open. */
const QUERY_STRATEGIES = ['UseIP', 'UseIPv4', 'UseIPv6', 'UseSystem']

interface Props {
  src: string
  cfg: ParsedConfig
  selection: Selection
  onChange: (text: string, warnings?: string[]) => void
  onSelect: (s: Selection) => void
}

const B = 'routing.balancers[].'
const S = 'routing.balancers[].strategy.settings.'

export function Inspector({ src, cfg, selection, onChange, onSelect }: Props): React.JSX.Element {
  const { t } = useT()
  const outboundTags = useMemo(
    () => cfg.outbounds.map((o) => o.tag).filter((t): t is string => !!t),
    [cfg.outbounds],
  )

  if (!selection) {
    return (
      <div className="inspector empty">
        <p className="dim">{t('graph.selectNode')}</p>
        <div className="insp-actions">
          <button onClick={() => onChange(E.addOutbound(src, nextTag(outboundTags, 'proxy'), 'freedom'))}>
            + outbound
          </button>
          <button
            onClick={() =>
              onChange(E.addBalancer(src, nextTag(cfg.balancers.map((b) => b.tag), 'bal'), ['proxy-']))
            }
          >
            + balancer
          </button>
          <button onClick={() => onChange(E.addRule(src, cfg.inbounds[0]?.tag ?? '', {}))}>
            {t('insp.plusRoutingRule')}
          </button>
          {!cfg.hasObservatory && !cfg.hasBurst && (
            <button onClick={() => onChange(E.addObservatory(src, ['proxy-'], true))}>
              + burstObservatory
            </button>
          )}
          {!cfg.dns && <button onClick={() => onChange(E.addDns(src))}>+ dns</button>}
        </div>
      </div>
    )
  }


  if (selection.kind === 'dns') {
    const d = cfg.dns
    if (!d) return <div className="inspector empty dim">{t('insp.noDns')}</div>
    const inboundTags = cfg.inbounds.map((i) => i.tag).filter((t): t is string => !!t)
    const routedByTag =
      !!d.tag && cfg.rules.some((r) => (r.inboundTag ?? []).includes(d.tag as string))

    return (
      <div className="inspector">
        <header>
          <h3>dns</h3>
          <button
            className="danger"
            onClick={() => {
              onChange(E.removeDns(src))
              onSelect(null)
            }}
          >
            remove
          </button>
        </header>

        <Field label="queryStrategy" path="dns.queryStrategy">
          <select
            value={d.queryStrategy ?? 'UseIP'}
            onChange={(e) => onChange(E.setDnsField(src, 'queryStrategy', e.target.value))}
          >
            {QUERY_STRATEGIES.map((q) => (
              <option key={q} value={q}>
                {q}
              </option>
            ))}
          </select>
        </Field>
        <p className="tiny dim">
          {t('insp.queryStrategyNote')}
        </p>

        <Field label="tag" path="dns.tag">
          <input
            value={d.tag ?? ''}
            placeholder="(none)"
            onChange={(e) => onChange(E.setDnsField(src, 'tag', e.target.value))}
          />
        </Field>
        {d.tag && !routedByTag && (
          <p className="tiny warn">
            {t('insp.noRuleForDnsTag')} <code className="inline-code">{d.tag}</code>{t('insp.dnsTagNote')}
          </p>
        )}
        {!d.tag && inboundTags.length > 0 && (
          <p className="tiny dim">
            {t('insp.dnsNoTag')}
          </p>
        )}

        <Field label="clientIp" path="dns.clientIp">
          <input
            value={d.clientIp ?? ''}
            placeholder="(none)"
            onChange={(e) => onChange(E.setDnsField(src, 'clientIp', e.target.value))}
          />
        </Field>

        <div className="insp-checks">
          {(
            [
              ['disableCache', d.disableCache],
              ['disableFallback', d.disableFallback],
              ['disableFallbackIfMatch', d.disableFallbackIfMatch],
              ['enableParallelQuery', d.enableParallelQuery],
              ['useSystemHosts', d.useSystemHosts],
              ['serveStale', d.serveStale],
            ] as const
          ).map(([key, val]) => (
            <label key={key} className="toggle">
              <input
                type="checkbox"
                checked={!!val}
                onChange={(e) =>
                  onChange(E.setDnsField(src, key, e.target.checked ? true : undefined))
                }
              />
              {key} <DocHint path={`dns.${key}`} />
            </label>
          ))}
        </div>

        <h4 className="insp-sub">
          servers <span className="dim">{d.servers.length}</span>
        </h4>
        {d.servers.length === 0 && (
          <p className="tiny bad">
            {t('insp.noServers')}
          </p>
        )}

        {d.servers.map((s, i) => (
          <div key={i} className="dns-server">
            <div className="dns-server-head">
              <input
                className="mono"
                value={s.address}
                placeholder="1.1.1.1 / https://dns.google/dns-query / localhost"
                onChange={(e) => onChange(E.setDnsServerField(src, i, 'address', e.target.value))}
              />
              <button
                className="tiny"
                title={t('insp.removeServer')}
                onClick={() => onChange(E.removeDnsServer(src, i))}
              >
                ✕
              </button>
            </div>

            {s.simple ? (
              <button
                className="tiny"
                onClick={() => onChange(E.setDnsServerField(src, i, 'domains', []))}
              >
                {t('insp.perServerOptions')}
              </button>
            ) : (
              <>
                <Field label="domains" path="dns.servers.domains">
                  <input
                    value={(s.domains ?? []).join(', ')}
                    placeholder="geosite:cn, domain:example.com"
                    onChange={(e) =>
                      onChange(
                        E.setDnsServerField(
                          src,
                          i,
                          'domains',
                          e.target.value.split(',').map((x) => x.trim()).filter(Boolean),
                        ),
                      )
                    }
                  />
                </Field>
                <Field label="expectedIPs" path="dns.servers.expectedIPs">
                  <input
                    value={(s.expectedIPs ?? []).join(', ')}
                    placeholder="geoip:cn"
                    onChange={(e) =>
                      onChange(
                        E.setDnsServerField(
                          src,
                          i,
                          'expectedIPs',
                          e.target.value.split(',').map((x) => x.trim()).filter(Boolean),
                        ),
                      )
                    }
                  />
                </Field>
                <div className="insp-checks">
                  <label className="toggle">
                    <input
                      type="checkbox"
                      checked={!!s.skipFallback}
                      onChange={(e) =>
                        onChange(
                          E.setDnsServerField(
                            src,
                            i,
                            'skipFallback',
                            e.target.checked ? true : undefined,
                          ),
                        )
                      }
                    />
                    skipFallback
                  </label>
                  <button className="tiny" onClick={() => onChange(E.simplifyDnsServer(src, i))}>
                    {t('insp.collapseToAddress')}
                  </button>
                </div>
              </>
            )}
          </div>
        ))}

        <button onClick={() => onChange(E.addDnsServer(src, '1.1.1.1'))}>{t('insp.addServer')}</button>

        <p className="tiny dim">
          {t('insp.dnsOrder')} <code className="inline-code">domains</code>{' '}
          {t('insp.dnsOrderTail')}
        </p>
        {d.hostsCount > 0 && (
          <p className="tiny dim">
            {d.hostsCount} static <code className="inline-code">hosts</code> entr
            {d.hostsCount === 1 ? 'y' : 'ies'} — edit them in the JSON below.
          </p>
        )}

        <JsonSlice src={src} path={['dns']} label="dns" onChange={onChange} />
      </div>
    )
  }

  if (selection.kind === 'observatory') {
    const o = cfg.observatory
    if (!o) return <div className="inspector empty dim">{t('insp.noObservatory')}</div>
    const covered = outboundTags.filter((t) => o.subjectSelector.some((sel) => t.startsWith(sel)))
    const O = o.burst ? 'burstObservatory' : 'observatory'
    const P = o.burst ? 'burstObservatory.pingConfig.' : 'observatory.'

    return (
      <div className="inspector">
        <header>
          <h3>{O}</h3>
          <button
            className="danger"
            onClick={() => {
              onChange(E.removeObservatory(src, o.burst))
              onSelect(null)
            }}
          >
            remove
          </button>
        </header>

        <Field label="kind" path={o.burst ? 'burstObservatory' : 'observatory'}>
          <select
            value={o.burst ? 'burst' : 'plain'}
            onChange={(e) => onChange(E.convertObservatory(src, e.target.value === 'burst', o.subjectSelector))}
          >
            <option value="plain">observatory</option>
            <option value="burst">burstObservatory</option>
          </select>
        </Field>
        <p className="tiny warn">
          {o.burst
            ? t('insp.burstHealthPing')
            : t('insp.plainNoHealthPing')}
        </p>

        <Field label="subjectSelector" path={`${O}.subjectSelector`}>
          <input
            value={o.subjectSelector.join(', ')}
            placeholder="proxy-"
            onChange={(e) =>
              onChange(
                E.setObservatoryField(
                  src,
                  o.burst,
                  'subjectSelector',
                  e.target.value.split(',').map((x) => x.trim()).filter(Boolean),
                ),
              )
            }
          />
        </Field>
        <p className={covered.length === 0 ? 'tiny bad' : 'tiny dim'}>
          {covered.length === 0
            ? t('insp.coversNothing')
            : t('insp.prefixMatches', { n: covered.length, tags: covered.join(', ') })}
        </p>

        {!o.burst && (
          <>
            <Field label="probeUrl" path="observatory.probeUrl">
              <input
                value={o.probeUrl ?? ''}
                placeholder="https://www.google.com/generate_204"
                onChange={(e) => onChange(E.setObservatoryField(src, false, 'probeUrl', e.target.value))}
              />
            </Field>
            <Field label="probeInterval" path="observatory.probeInterval">
              <input
                value={o.probeInterval ?? ''}
                placeholder="10s"
                onChange={(e) => onChange(E.setObservatoryField(src, false, 'probeInterval', e.target.value))}
              />
            </Field>
            <Field label="enableConcurrency" path="observatory.enableConcurrency">
              <select
                value={o.enableConcurrency ? 'true' : 'false'}
                onChange={(e) => onChange(E.setObservatoryField(src, false, 'enableConcurrency', e.target.value === 'true'))}
              >
                <option value="false">{t('insp.concurrencyOff')}</option>
                <option value="true">{t('insp.concurrencyOn')}</option>
              </select>
            </Field>
            <p className="tiny warn">
              {o.enableConcurrency
                ? t('insp.concurrentPass', {
                    n: covered.length || 'n',
                    interval: o.probeInterval ?? '10s',
                  })
                : t('insp.serialPass', {
                    n: covered.length || 'n',
                    interval: o.probeInterval ?? '10s',
                  })}
            </p>
          </>
        )}

        {o.burst && (
          <>
            <Field label="destination" path="burstObservatory.pingConfig.destination">
              <input
                value={o.destination ?? ''}
                placeholder="https://connectivitycheck.gstatic.com/generate_204"
                onChange={(e) => onChange(E.setObservatoryField(src, true, 'destination', e.target.value))}
              />
            </Field>
            <Field label="interval" path="burstObservatory.pingConfig.interval">
              <input
                value={o.interval ?? ''}
                placeholder="1m"
                onChange={(e) => onChange(E.setObservatoryField(src, true, 'interval', e.target.value))}
              />
            </Field>
            <Field label="sampling" path="burstObservatory.pingConfig.sampling">
              <input
                type="number"
                min={1}
                value={o.sampling ?? 10}
                onChange={(e) => onChange(E.setObservatoryField(src, true, 'sampling', Number(e.target.value)))}
              />
            </Field>
            <Field label="timeout" path="burstObservatory.pingConfig.timeout">
              <input
                value={o.timeout ?? ''}
                placeholder="5s"
                onChange={(e) => onChange(E.setObservatoryField(src, true, 'timeout', e.target.value))}
              />
            </Field>
            <Field label="connectivity" path="burstObservatory.pingConfig.connectivity">
              <input
                value={o.connectivity ?? ''}
                placeholder={t('insp.connectivityEmpty')}
                onChange={(e) => onChange(E.setObservatoryField(src, true, 'connectivity', e.target.value))}
              />
            </Field>
            <p className="tiny warn">
              {t('insp.roundTakes')}{' '}
              <strong>{roundLabel(o.interval ?? '1m', o.sampling ?? 10)}</strong>{t('insp.windowNote')}
            </p>
            {o.connectivity && (
              <p className="tiny warn">
                {t('insp.connectivityNote')}
              </p>
            )}
          </>
        )}

        <JsonSlice
          src={src}
          path={[o.burst ? 'burstObservatory' : 'observatory']}
          label={o.burst ? 'burstObservatory' : 'observatory'}
          onChange={onChange}
        />
      </div>
    )
  }

  if (selection.kind === 'outbound') {
    const ob = cfg.outbounds[selection.index]
    if (!ob) return <div className="inspector empty dim">{t('insp.gone.outbound')}</div>
    return (
      <div className="inspector">
        <header>
          <h3>{t('evidence.colOutbound')}</h3>
          <button
            className="danger"
            onClick={() => {
              onChange(E.removeOutbound(src, selection.index))
              onSelect(null)
            }}
          >
            remove
          </button>
        </header>

        <Field label="tag" path="outbounds[].tag">
          <input
            value={ob.tag ?? ''}
            onChange={(e) => {
              const { text, warnings } = E.renameOutbound(src, selection.index, e.target.value)
              onChange(text, warnings)
            }}
          />
        </Field>
        <p className="tiny dim">
          {t('insp.untaggedOutbounds')}
        </p>

        <Field label="protocol" path="outbounds[].protocol">
          <input
            value={ob.protocol ?? ''}
            readOnly
            title={t('insp.protocolShapeNote')}
          />
        </Field>
        <p className="tiny dim">
          <code className="inline-code">settings</code>,{' '}
          <code className="inline-code">streamSettings</code>, TLS and Reality keys,{' '}
          <code className="inline-code">mux</code> and <code className="inline-code">sockopt</code>{' '}
          {t('insp.protocolSpecific', { tab: t('tab.protocols') })}
        </p>

        <JsonSlice
          src={src}
          path={['outbounds', selection.index]}
          label="outbound"
          onChange={onChange}
        />
      </div>
    )
  }

  if (selection.kind === 'balancer') {
    const b = cfg.balancers[selection.index]
    if (!b) return <div className="inspector empty dim">{t('insp.gone.balancer')}</div>
    const strategy = b.strategy?.type ?? 'random'
    const settings = b.strategy?.settings ?? {}
    const matched = outboundTags.filter((t) => (b.selector ?? []).some((s) => t.startsWith(s)))
    const needsObs = strategy === 'leastPing' || strategy === 'leastLoad'

    return (
      <div className="inspector">
        <header>
          <h3>balancer</h3>
          <button
            className="danger"
            onClick={() => {
              onChange(E.removeBalancer(src, selection.index))
              onSelect(null)
            }}
          >
            remove
          </button>
        </header>

        <Field label="tag" path={B + 'tag'}>
          <input
            value={b.tag ?? ''}
            onChange={(e) => onChange(E.setBalancerTag(src, selection.index, e.target.value))}
          />
        </Field>

        <Field label="selector" path={B + 'selector'}>
          <input
            value={(b.selector ?? []).join(', ')}
            placeholder="proxy-"
            onChange={(e) =>
              onChange(
                E.setBalancerSelector(
                  src,
                  selection.index,
                  e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
                ),
              )
            }
          />
        </Field>
        <p className={matched.length === 0 ? 'tiny bad' : 'tiny dim'}>
          {matched.length === 0
            ? t('insp.matchesNothing')
            : t('insp.prefixMatches', { n: matched.length, tags: matched.join(', ') })}
        </p>

        <Field label="strategy" path={B + 'strategy'}>
          <select
            value={strategy}
            onChange={(e) => onChange(E.setBalancerStrategy(src, selection.index, e.target.value))}
          >
            {['random', 'roundRobin', 'leastPing', 'leastLoad'].map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </Field>

        {needsObs && !cfg.hasObservatory && !cfg.hasBurst && (
          <div className="note bad">
            <p>
              {t('insp.needsObservatory', { strategy })}
            </p>
            <div className="insp-actions">
              <button onClick={() => onChange(E.addObservatory(src, b.selector ?? [], false))}>
                {t('insp.addObservatory')}
              </button>
              <button onClick={() => onChange(E.addObservatory(src, b.selector ?? [], true))}>
                {t('insp.addBurstObservatory')}
              </button>
            </div>
          </div>
        )}

        <Field label="fallbackTag" path={B + 'fallbackTag'}>
          <select
            value={b.fallbackTag ?? ''}
            onChange={(e) => onChange(E.setBalancerFallback(src, selection.index, e.target.value))}
          >
            <option value="">(none)</option>
            {outboundTags.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </Field>
        {(strategy === 'random' || strategy === 'roundRobin') && (
          <p className="tiny warn">
            {b.fallbackTag
              ? t('insp.fallbackConsults')
              : t('insp.noFallbackIgnores')}
          </p>
        )}

        {strategy === 'leastLoad' && (
          <>
            <Field label="expected" path={S + 'expected'}>
              <input
                type="number"
                min={0}
                value={num(settings['expected'], 1)}
                onChange={(e) =>
                  onChange(E.setStrategySetting(src, selection.index, 'expected', Number(e.target.value)))
                }
              />
            </Field>
            <Field label="maxRTT" path={S + 'maxRTT'}>
              <input
                placeholder={t('insp.timeoutPlaceholder')}
                value={str(settings['maxRTT'])}
                onChange={(e) =>
                  onChange(
                    E.setStrategySetting(
                      src,
                      selection.index,
                      'maxRTT',
                      e.target.value === '' ? undefined : e.target.value,
                    ),
                  )
                }
              />
            </Field>
            <Field label="tolerance" path={S + 'tolerance'}>
              <input
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={num(settings['tolerance'], 0)}
                onChange={(e) =>
                  onChange(
                    E.setStrategySetting(src, selection.index, 'tolerance', Number(e.target.value)),
                  )
                }
              />
            </Field>
            {!cfg.hasBurst && Number(settings['tolerance'] ?? 0) > 0 && (
              <p className="tiny warn">
                {t('insp.toleranceNeedsBurst')}
              </p>
            )}
            {Number(settings['expected'] ?? 0) > 1 && (
              <p className="tiny dim">
                {t('insp.uniformDraw')}
              </p>
            )}
          </>
        )}

        <JsonSlice
          src={src}
          path={['routing', 'balancers', selection.index]}
          label="balancer"
          onChange={onChange}
        />
      </div>
    )
  }

  const r = cfg.rules[selection.index]
  if (!r) return <div className="inspector empty dim">{t('insp.gone.rule')}</div>
  const balancerTags = cfg.balancers.map((b) => b.tag).filter((t): t is string => !!t)

  return (
    <div className="inspector">
      <header>
        <h3>routing rule #{selection.index}</h3>
        <button
          className="danger"
          onClick={() => {
            onChange(E.removeRule(src, selection.index))
            onSelect(null)
          }}
        >
          remove
        </button>
      </header>

      <Field label="inboundTag" path="routing.rules[].inboundTag">
        <input value={(r.inboundTag ?? []).join(', ')} readOnly />
      </Field>

      <Field label="balancerTag" path="routing.rules[].balancerTag">
        <select
          value={r.balancerTag ?? ''}
          onChange={(e) => onChange(E.setRuleTarget(src, selection.index, 'balancerTag', e.target.value))}
        >
          <option value="">(none)</option>
          {balancerTags.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </Field>

      <Field label="outboundTag" path="routing.rules[].outboundTag">
        <select
          value={r.outboundTag ?? ''}
          onChange={(e) => onChange(E.setRuleTarget(src, selection.index, 'outboundTag', e.target.value))}
        >
          <option value="">(none)</option>
          {outboundTags.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </Field>

      <p className="tiny dim">
        {t('insp.exclusiveNote')}
      </p>
      <p className="tiny dim">
        {t('insp.rulesOrder')}
      </p>
      <p className="tiny dim">
        {t('insp.ruleMatchesMore')} <code className="inline-code">domain</code>,{' '}
        <code className="inline-code">ip</code>, <code className="inline-code">port</code>,{' '}
        <code className="inline-code">network</code>, <code className="inline-code">source</code>,{' '}
        <code className="inline-code">user</code>, <code className="inline-code">protocol</code>,{' '}
        <code className="inline-code">attrs</code>{t('insp.editThoseHere')}
      </p>

      <JsonSlice
        src={src}
        path={['routing', 'rules', selection.index]}
        label="rule"
        onChange={onChange}
      />
    </div>
  )
}

function Field({
  label,
  path,
  children,
}: {
  label: string
  path: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <label className="insp-field">
      <span className="lbl">
        {label} <DocHint path={path} />
      </span>
      {children}
    </label>
  )
}

function num(v: unknown, dflt: number): number {
  return typeof v === 'number' ? v : dflt
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** Renders interval x sampling as a human duration. */
function roundLabel(interval: string, sampling: number): string {
  let secs = 0
  for (const [, n, u] of interval.matchAll(/(\d+(?:\.\d+)?)(ns|us|ms|s|m|h)/g)) {
    const v = Number(n)
    secs += u === 'h' ? v * 3600 : u === 'm' ? v * 60 : u === 's' ? v : 0
  }
  const total = Math.max(10, secs) * Math.max(1, sampling)
  return total < 60 ? `${total}s` : `${(total / 60).toFixed(1)} min`
}

/** Picks the next free `<base>-N` tag. */
function nextTag(existing: Array<string | undefined>, base: string): string {
  const taken = new Set(existing.filter(Boolean))
  for (let i = 1; ; i++) {
    const t = `${base}-${i}`
    if (!taken.has(t)) return t
  }
}
