import { useCallback, useEffect, useMemo, useState } from 'react'
import type { BalancerView, ObsRow, SimOverride, SimRequest, SimResponse } from '@shared/events'
import { effectiveConfigPath, useApp } from '../store/app'
import { parseConfig } from '../graph/edit'
import { DecisionFunnel } from './DecisionFunnel'
import { fmtMs, fmtMsFromMs, isDeadSentinel } from '../lib/copy'
import { DocHint } from '../components/DocHint'
import { useT } from '../lib/i18n'

/**
 * What-if analysis.
 *
 * Every answer here comes from the sidecar running the REAL strategy code against a
 * frozen observation. The renderer deliberately does not reimplement the algorithms:
 * leastLoad's settings interact (costs, baselines, expected, maxRTT, tolerance) in
 * ways a second implementation gets subtly wrong, and a simulator that disagreed with
 * the engine would be worse than none at all.
 */
export function WhatIf(): React.JSX.Element {
  const { t } = useT()
  const { snap, selectedBalancer } = useApp()
  const configPath = useApp(effectiveConfigPath)

  /* Balancers from the CONFIG, not only from telemetry.
   *
   * snap.balancers is built from decision events, and those only fire once traffic has
   * been routed through a balancer. That made this panel unusable in exactly the case it
   * exists for: you have just opened a config and want to know what its balancer would
   * do, before sending anything through it. The strategy is still run for real by the
   * sidecar against a supplied observation — nothing here is simulated locally — so a
   * prior decision was never actually needed, only assumed.
   *
   * Live views win when they exist, since they carry candidates the core itself
   * resolved. */
  const [configBalancers, setConfigBalancers] = useState<BalancerView[]>([])
  useEffect(() => {
    if (!configPath) return
    let alive = true
    void window.xraystudio
      .readConfig(configPath)
      .then((text) => {
        if (!alive) return
        const cfg = parseConfig(text)
        if (!cfg) return
        const outTags = cfg.outbounds.map((o) => o.tag ?? '').filter(Boolean)
        setConfigBalancers(
          cfg.balancers
            .filter((b) => b.tag)
            .map((b) => ({
              tag: b.tag!,
              strategy: b.strategy?.type ?? 'random',
              selectors: b.selector ?? [],
              // Same prefix match the core uses, so the candidate set is the real one
              // rather than every outbound in the file.
              candidates: outTags.filter((t) => (b.selector ?? []).some((sel) => t.startsWith(sel))),
              selected: '',
              source: '',
              fallbackTag: b.fallbackTag ?? '',
              err: '',
              lastEvalMonoNs: 0,
              pickShare: {},
              evalCount: 0,
            })),
        )
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [configPath])

  const balancers = useMemo(() => {
    const merged = [...configBalancers]
    for (const live of snap.balancers) {
      const i = merged.findIndex((b) => b.tag === live.tag)
      if (i >= 0) merged[i] = live
      else merged.push(live)
    }
    return merged
  }, [configBalancers, snap.balancers])

  const balancer = useMemo(
    () => balancers.find((b) => b.tag === selectedBalancer) ?? balancers[0],
    [balancers, selectedBalancer],
  )

  // Freeze the observation on first load so sliders act on a stable baseline rather
  // than a target that moves under the user as probes land.
  const [frozen, setFrozen] = useState<ObsRow[] | null>(null)
  // The observation travels with each decision, so the most recent eval for this
  // balancer carries exactly what the strategy saw. Falling back to the outbound view
  // keeps the panel usable before any traffic has been dispatched.
  const live: ObsRow[] = useMemo(() => {
    const fromEval = balancer ? snap.lastEvals[balancer.tag]?.observation : undefined
    if (fromEval && fromEval.length > 0) return fromEval
    // ObsRow mirrors the Go wire format (snake_case); OutboundView is the UI's own
    // aggregate. Convert rather than widen either one.
    return snap.outbounds.map(
      (o): ObsRow => ({
        tag: o.tag,
        alive: o.alive ?? true,
        delay_ms: o.delayMs,
        has_hp: o.hasHealthPing,
        all: o.all,
        fail: o.fail,
        avg_ns: o.avgNs,
        dev_ns: o.devNs,
        max_ns: o.maxNs,
        min_ns: o.minNs,
        last_err: o.lastErr,
      }),
    )
  }, [balancer, snap.lastEvals, snap.outbounds])

  useEffect(() => {
    if (!frozen && live.length > 0) setFrozen(live)
  }, [frozen, live])

  const [expected, setExpected] = useState(1)
  const [maxRttMs, setMaxRttMs] = useState(0)
  const [tolerance, setTolerance] = useState(0)
  const [baselines, setBaselines] = useState('')
  const [costs, setCosts] = useState('')
  const [overrides, setOverrides] = useState<Record<string, SimOverride>>({})

  const [res, setRes] = useState<SimResponse | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const observation = frozen ?? live
  const candidates = balancer?.candidates ?? observation.map((r: ObsRow) => r.tag)

  const run = useCallback(async () => {
    if (!balancer || observation.length === 0) return
    setBusy(true)
    setErr(null)
    const req: SimRequest = {
      balancerTag: balancer.tag,
      strategy: balancer.strategy,
      candidates,
      observation,
      overrides: Object.values(overrides),
      expected,
      maxRttMs,
      tolerance,
      baselineMs: baselines
        .split(',')
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n) && n > 0),
      costs: costs
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((pair) => {
          const [match, value] = pair.split('=')
          return { match: match ?? '', value: Number(value ?? 1) }
        }),
      trials: 1000,
    }
    if (balancer.fallbackTag) req.fallbackTag = balancer.fallbackTag
    try {
      setRes(await window.xraystudio.simulate(req))
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [balancer, candidates, observation, overrides, expected, maxRttMs, tolerance, baselines, costs])

  // Debounced: a localhost round-trip is sub-millisecond, so there is no need for a
  // separate local preview — one source of truth is worth more than 60fps sliders.
  useEffect(() => {
    const id = setTimeout(() => void run(), 150)
    return () => clearTimeout(id)
  }, [run])

  if (!balancer) {
    return (
      <div className="pad">
        <p className="dim">
          {t('whatif.noBalancer')} <code>routing.balancers</code> {t('whatif.noBalancerTail')}
        </p>
      </div>
    )
  }

  const setOverride = (tag: string, patch: Partial<SimOverride> | null): void =>
    setOverrides((prev) => {
      const next = { ...prev }
      if (patch === null) delete next[tag]
      else next[tag] = { ...(next[tag] ?? { tag }), ...patch, tag }
      return next
    })

  return (
    <div className="whatif">
      <section className="card">
        <div className="card-head">
          <h3>{t('whatif.title')}</h3>
          <div className="row gap">
            {busy && <span className="dim tiny">simulating…</span>}
            <button className="ghost" onClick={() => setFrozen(live)}>
              {t('whatif.recapture')}
            </button>
          </div>
        </div>

        <p className="note info">
          {t('whatif.sourceLead')} <strong>{t('whatif.real')}</strong> {t('whatif.sourceTail')}{' '}
          <code>{balancer.tag}</code>, {t('whatif.strategyIs')} <code>{balancer.strategy}</code>.
        </p>

        <div className="sim-grid">
          <label>
            <span className="lbl">expected <DocHint path="routing.balancers[].strategy.settings.expected" /></span>
            <input
              type="range"
              min={0}
              max={Math.max(4, candidates.length)}
              value={expected}
              onChange={(e) => setExpected(Number(e.target.value))}
            />
            <span className="mono">{expected}</span>
            {expected === 0 && baselines.trim() !== '' && (
              <em className="tiny warn">{t('whatif.speedPriority')}</em>
            )}
          </label>

          <label>
            <span className="lbl">maxRTT <DocHint path="routing.balancers[].strategy.settings.maxRTT" /></span>
            <input
              type="range"
              min={0}
              max={1000}
              step={10}
              value={maxRttMs}
              onChange={(e) => setMaxRttMs(Number(e.target.value))}
            />
            <span className="mono">{maxRttMs === 0 ? 'off' : `${maxRttMs}ms`}</span>
          </label>

          <label>
            <span className="lbl">tolerance <DocHint path="routing.balancers[].strategy.settings.tolerance" /></span>
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round(tolerance * 100)}
              onChange={(e) => setTolerance(Number(e.target.value) / 100)}
            />
            <span className="mono">{tolerance === 0 ? 'off' : `${Math.round(tolerance * 100)}%`}</span>
            {tolerance > 0 && !observation.some((r: ObsRow) => r.has_hp) && (
              <em className="tiny warn">{t('whatif.inertNeedsBurst')}</em>
            )}
          </label>

          <label>
            <span className="lbl">baselines <DocHint path="routing.balancers[].strategy.settings.baselines" /></span>
            <input
              type="text"
              placeholder="e.g. 200, 400"
              value={baselines}
              onChange={(e) => setBaselines(e.target.value)}
            />
            <span className="tiny dim">{t('whatif.walkedInOrder')}</span>
          </label>

          <label>
            <span className="lbl">costs <DocHint path="routing.balancers[].strategy.settings.costs" /></span>
            <input
              type="text"
              placeholder={t('whatif.costsPlaceholder')}
              value={costs}
              onChange={(e) => setCosts(e.target.value)}
            />
            <span className="tiny dim">{t('whatif.costsHint')}</span>
          </label>
        </div>
      </section>

      <section className="card">
        <h3>{t('whatif.observation')}</h3>
        <p className="tiny dim">
          {t('whatif.observationNote')}
        </p>
        <table className="grid">
          <thead>
            <tr>
              <th>{t('evidence.colOutbound')}</th>
              <th>{t('whatif.colDelay')}</th>
              <th>{t('whatif.colDeviation')}</th>
              <th>{t('whatif.colOverride')}</th>
            </tr>
          </thead>
          <tbody>
            {observation.map((r: ObsRow) => {
              const o = overrides[r.tag]
              return (
                <tr key={r.tag}>
                  <td className="mono">{r.tag}</td>
                  <td className={isDeadSentinel(r.delay_ms) ? 'mono bad' : 'mono'}>
                    {fmtMsFromMs(r.delay_ms)}
                  </td>
                  <td className="mono dim">{r.has_hp ? fmtMs(r.dev_ns ?? 0) : '—'}</td>
                  <td className="row gap">
                    <button
                      className={o?.dead ? 'ghost on' : 'ghost'}
                      onClick={() => setOverride(r.tag, o?.dead ? null : { dead: true })}
                    >
                      {t('whatif.kill')}
                    </button>
                    <input
                      className="tiny-num"
                      type="number"
                      placeholder="ms"
                      value={o?.delayMs ?? ''}
                      onChange={(e) => {
                        if (e.target.value === '') {
                          const { delayMs: _drop, ...rest } = overrides[r.tag] ?? { tag: r.tag }
                          setOverride(r.tag, null)
                          if (Object.keys(rest).length > 1) setOverride(r.tag, rest)
                        } else {
                          setOverride(r.tag, { delayMs: Number(e.target.value) })
                        }
                      }}
                    />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </section>

      {err && <p className="note bad">{err}</p>}

      {res && (
        <>
          <section className="card">
            <div className="card-head">
              <h3>Outcome over {res.trials.toLocaleString()} trials</h3>
              <span className={res.deterministic ? 'chip ok' : 'chip warn'}>
                {res.deterministic ? 'deterministic' : 'random'}
              </span>
            </div>
            {!res.deterministic && (
              <p className="note warn">
                {t('whatif.uniformDraw')}
              </p>
            )}
            <div className="dist">
              {res.distribution.map((o) => (
                <div key={o.tag} className="dist-row">
                  <span className="mono dist-tag">{o.tag}</span>
                  <div className="dist-bar">
                    <div style={{ width: `${o.share * 100}%` }} />
                  </div>
                  <span className="mono dim">{(o.share * 100).toFixed(1)}%</span>
                </div>
              ))}
            </div>
          </section>

          <section className="panel">
            <h3>{t('whatif.simulated')}</h3>
            <DecisionFunnel evalEvent={res.trace} />
          </section>
        </>
      )}
    </div>
  )
}
