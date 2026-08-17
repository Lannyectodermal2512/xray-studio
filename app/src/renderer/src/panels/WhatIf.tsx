import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ObsRow, SimOverride, SimRequest, SimResponse } from '@shared/events'
import { useApp } from '../store/app'
import { DecisionFunnel } from './DecisionFunnel'
import { fmtMs, fmtMsFromMs, isDeadSentinel } from '../lib/copy'
import { DocHint } from '../components/DocHint'

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
  const { snap, selectedBalancer } = useApp()

  const balancer = useMemo(
    () => snap.balancers.find((b) => b.tag === selectedBalancer) ?? snap.balancers[0],
    [snap.balancers, selectedBalancer],
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
          No balancer yet. Start a config with a <code>routing.balancers</code> entry and send
          some traffic through it.
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
          <h3>What if…</h3>
          <div className="row gap">
            {busy && <span className="dim tiny">simulating…</span>}
            <button className="ghost" onClick={() => setFrozen(live)}>
              Re-capture observation
            </button>
          </div>
        </div>

        <p className="note info">
          Answers come from the sidecar running the <strong>real</strong> strategy code against
          the observation below — not from a model of it. Balancer <code>{balancer.tag}</code>,
          strategy <code>{balancer.strategy}</code>.
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
              <em className="tiny warn">speed priority: may select nothing</em>
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
              <em className="tiny warn">inert: needs burstObservatory</em>
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
            <span className="tiny dim">ms, walked in the order given</span>
          </label>

          <label>
            <span className="lbl">costs <DocHint path="routing.balancers[].strategy.settings.costs" /></span>
            <input
              type="text"
              placeholder="e.g. proxy-a=4"
              value={costs}
              onChange={(e) => setCosts(e.target.value)}
            />
            <span className="tiny dim">substring=weight; score × √weight</span>
          </label>
        </div>
      </section>

      <section className="card">
        <h3>Observation</h3>
        <p className="tiny dim">
          Frozen so the sliders act on a stable baseline. Adjust individual outbounds to ask
          "what if this one were slower, or dead?".
        </p>
        <table className="grid">
          <thead>
            <tr>
              <th>outbound</th>
              <th>delay</th>
              <th>deviation</th>
              <th>override</th>
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
                      kill
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
                More than one candidate survives, so the final step is a uniform draw. There is
                no single answer — only a distribution.
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
            <h3>Simulated decision</h3>
            <DecisionFunnel evalEvent={res.trace} />
          </section>
        </>
      )}
    </div>
  )
}
