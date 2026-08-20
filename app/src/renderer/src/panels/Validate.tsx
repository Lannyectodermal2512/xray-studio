import { useCallback, useEffect, useState } from 'react'
import type { Diagnostic } from '@shared/events'
import { effectiveConfigPath, useApp } from '../store/app'

/**
 * Config validation.
 *
 * The point of this panel is the `dysfunction` severity. Xray already rejects
 * malformed configs; what it does not tell you about are the configs it accepts and
 * then does not act on — a selector matching no outbound, a fallbackTag pointing
 * nowhere, a key nobody reads. Those start cleanly, log nothing, and silently route
 * traffic somewhere other than where you intended.
 */

const severityRank: Record<Diagnostic['severity'], number> = {
  error: 0,
  dysfunction: 1,
  warning: 2,
  info: 3,
}

const severityCopy: Record<Diagnostic['severity'], { label: string; cls: string; blurb: string }> = {
  error: {
    label: 'error',
    cls: 'bad',
    blurb: 'Xray will refuse to start.',
  },
  dysfunction: {
    label: 'silently broken',
    cls: 'warn',
    blurb:
      'The config loads and starts. This part of it simply never does anything, with no error and nothing in the logs.',
  },
  warning: {
    label: 'warning',
    cls: 'warn',
    blurb: 'Works, but probably not the way you expect.',
  },
  info: { label: 'note', cls: '', blurb: '' },
}

export function Validate(): React.JSX.Element {
  const state = useApp()
  const path = effectiveConfigPath(state)

  const [diags, setDiags] = useState<Diagnostic[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const run = useCallback(async () => {
    if (!path) return
    setBusy(true)
    try {
      const res = await window.xraystudio.validate(path)
      setDiags(res.diagnostics ?? [])
      setErr(null)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [path])

  useEffect(() => {
    void run()
  }, [run])

  // Re-validate whenever the file changes on disk, since the user edits externally.
  useEffect(() => {
    const off = window.xraystudio.onConfigChanged(() => void run())
    return off
  }, [run])

  if (!path) {
    return (
      <div className="pad">
        <p className="dim">Open a config to validate it.</p>
      </div>
    )
  }

  const sorted = [...(diags ?? [])].sort(
    (a, b) => severityRank[a.severity] - severityRank[b.severity],
  )
  const counts = sorted.reduce<Record<string, number>>((acc, d) => {
    acc[d.severity] = (acc[d.severity] ?? 0) + 1
    return acc
  }, {})

  return (
    <div className="whatif">
      <section className="card">
        <div className="card-head">
          <h3>Validation</h3>
          <div className="row gap">
            {busy && <span className="dim tiny">checking…</span>}
            {diags !== null && sorted.length === 0 && <span className="chip ok">clean</span>}
            {(['error', 'dysfunction', 'warning'] as const).map((s) =>
              counts[s] ? (
                <span key={s} className={`chip ${severityCopy[s].cls}`}>
                  {counts[s]} {severityCopy[s].label}
                </span>
              ) : null,
            )}
            <button className="ghost" onClick={() => void run()}>
              Re-check
            </button>
          </div>
        </div>

        <p className="note info">
          Xray already rejects malformed configs. What it will not tell you about is the
          config it <em>accepts</em> and then does not act on — those appear here as{' '}
          <strong>silently broken</strong>.
        </p>
      </section>

      {err && <p className="note bad">{err}</p>}

      {diags !== null && sorted.length === 0 && (
        <section className="card">
          <p className="dim">
            Nothing to report. Every balancer has candidates, every referenced tag exists, and
            every key is read by something.
          </p>
        </section>
      )}

      {sorted.map((d, i) => (
        <section key={`${d.code}-${d.path}-${i}`} className="card diag">
          <div className="card-head">
            <div className="row gap">
              <span className={`chip ${severityCopy[d.severity].cls}`}>
                {severityCopy[d.severity].label}
              </span>
              {d.path && <code className="mono dim">{d.path}</code>}
            </div>
            <code className="tiny dim">{d.code}</code>
          </div>
          <p className="diag-msg">{d.message}</p>
          {d.detail && <p className="tiny dim">{d.detail}</p>}
          {severityCopy[d.severity].blurb && (
            <p className="tiny faint">{severityCopy[d.severity].blurb}</p>
          )}
        </section>
      ))}
    </div>
  )
}
