import { useEffect, useState } from 'react'
import { effectiveConfigPath, useApp } from '../store/app'
import { useT } from '../lib/i18n'

/**
 * Immediate evidence that injected faults are firing.
 *
 * Without this the engine looks broken. A fault takes effect on the very next dial, but
 * the only thing the dashboard used to show was the alive/dead dot — and that comes
 * from the observatory, which can lag by minutes:
 *
 *   - burstObservatory's DEFAULTS (interval 1m, sampling 10) give a 10-minute round,
 *     and `alive` is `All != Fail`, so it stays true until the entire window has failed.
 *   - the plain observatory probes SEQUENTIALLY unless enableConcurrency is set, so a
 *     full cycle is probeInterval x the number of outbounds.
 *
 * Someone injects a fault, watches for thirty seconds, sees nothing change, and
 * concludes nothing works. So: count the dials the fault engine actually intercepted,
 * and state plainly when the health status will catch up.
 */
export function FaultEvidence(): React.JSX.Element | null {
  const { t } = useT()
  const snap = useApp((s) => s.snap)
  const configPath = useApp(effectiveConfigPath)
  const [lag, setLag] = useState<ObservatoryLag | null>(null)

  useEffect(() => {
    if (!configPath) return
    let alive = true
    void window.xraystudio
      .readConfig(configPath)
      .then((t) => alive && setLag(estimateLag(t, snap.outbounds.length)))
      .catch(() => undefined)
    return () => {
      alive = false
    }
    // Re-estimate when the outbound count changes: the plain observatory's cycle is
    // proportional to it.
  }, [configPath, snap.outbounds.length])

  // The snapshot carries no clock of its own, so use the newest event's timestamp as
  // "now" on the sidecar's monotonic scale. Mixing in Date.now() would be wrong: the
  // two clocks have different origins.
  const nowNs = Math.max(
    0,
    ...snap.recentDials.map((d) => d.mono_ns),
    ...snap.outbounds.map((o) => o.lastFaultMonoNs),
  )
  const hit = snap.outbounds.filter((o) => o.faultHits > 0)
  const active = snap.faults.filter((f) => f.enabled)
  if (active.length === 0) return null

  return (
    <section className="panel">
      <h3>{t('evidence.title')}</h3>

      {hit.length === 0 ? (
        <p className="note warn">
          {t('evidence.noDial')}
        </p>
      ) : (
        <>
          <p className="note ok">
            {t('evidence.working')}
          </p>
          <table className="tbl">
            <thead>
              <tr>
                <th>{t('evidence.colOutbound')}</th>
                <th>{t('evidence.colBlocked')}</th>
                <th>{t('evidence.colLast')}</th>
                <th>{t('evidence.colHealth')}</th>
              </tr>
            </thead>
            <tbody>
              {hit.map((o) => (
                <tr key={o.tag}>
                  <td className="mono">{o.tag}</td>
                  <td className="mono bad">{o.faultHits}</td>
                  <td className="mono dim">{ago(nowNs, o.lastFaultMonoNs)}</td>
                  <td className={o.alive === false ? 'bad' : 'warn'}>
                    {o.alive === false ? t('common.dead') : t('evidence.stillShownAlive')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {lag && (
        <p className={lag.seconds > 60 ? 'note warn' : 'note info'}>
          {lag.kind === 'burst' ? (
            <>
              {t('evidence.burstLead', { interval: lag.interval, sampling: lag.sampling })}{' '}
              <strong>{fmtDuration(lag.seconds)}</strong>. {t('evidence.burstTail')}
            </>
          ) : lag.kind === 'plain' ? (
            <>
              {lag.concurrent
                ? t('evidence.plainLeadConcurrent', { interval: lag.interval })
                : t('evidence.plainLeadSequential', {
                    interval: lag.interval,
                    n: lag.outbounds,
                  })}{' '}
              <strong>{fmtDuration(lag.seconds)}</strong> {t('evidence.plainTail')}
            </>
          ) : (
            <>
              {t('evidence.noObservatory')}
            </>
          )}
        </p>
      )}
    </section>
  )
}

interface ObservatoryLag {
  kind: 'burst' | 'plain' | 'none'
  interval: string
  sampling: number
  seconds: number
  concurrent: boolean
  outbounds: number
}

/** Parses just enough of the config to explain the delay honestly. */
function estimateLag(raw: string, outbounds: number): ObservatoryLag {
  let doc: Record<string, unknown> = {}
  try {
    doc = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, '')) as Record<string, unknown>
  } catch {
    return { kind: 'none', interval: '', sampling: 0, seconds: 0, concurrent: false, outbounds }
  }

  const burst = doc['burstObservatory'] as Record<string, unknown> | undefined
  if (burst) {
    const ping = (burst['pingConfig'] ?? {}) as Record<string, unknown>
    const interval = String(ping['interval'] ?? '1m')
    const sampling = Number(ping['sampling'] ?? 10)
    // v26.7.28 clamps the interval to a 10s minimum; earlier versions had a bug that
    // compared a Duration against the integer 10, so anything above 10ns passed.
    const secs = Math.max(10, parseDuration(interval)) * sampling
    return { kind: 'burst', interval, sampling, seconds: secs, concurrent: true, outbounds }
  }

  const plain = doc['observatory'] as Record<string, unknown> | undefined
  if (plain) {
    const interval = String(plain['probeInterval'] ?? '10s')
    const concurrent = Boolean(plain['enableConcurrency'])
    const one = parseDuration(interval)
    return {
      kind: 'plain',
      interval,
      sampling: 0,
      seconds: concurrent ? one : one * Math.max(1, outbounds),
      concurrent,
      outbounds,
    }
  }
  return { kind: 'none', interval: '', sampling: 0, seconds: 0, concurrent: false, outbounds }
}

/** Xray durations: number + unit, e.g. "10s", "2h45m". */
function parseDuration(s: string): number {
  let total = 0
  for (const [, n, unit] of s.matchAll(/(\d+(?:\.\d+)?)(ns|us|ms|s|m|h)/g)) {
    const v = Number(n)
    total +=
      unit === 'h' ? v * 3600 : unit === 'm' ? v * 60 : unit === 's' ? v : unit === 'ms' ? v / 1000 : 0
  }
  return total || 10
}

function fmtDuration(s: number): string {
  if (s < 60) return `${Math.round(s)}s`
  const m = s / 60
  return m < 60 ? `${m.toFixed(m < 10 ? 1 : 0)} min` : `${(m / 60).toFixed(1)} h`
}

function ago(nowNs: number, thenNs: number): string {
  if (!thenNs) return '—'
  const s = (nowNs - thenNs) / 1e9
  return s < 1 ? 'just now' : s < 60 ? `${Math.round(s)}s ago` : `${Math.round(s / 60)}m ago`
}
