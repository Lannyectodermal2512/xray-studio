import { useCallback, useEffect, useState } from 'react'
import type { Diagnostic } from '@shared/events'
import { effectiveConfigPath, useApp } from '../store/app'
import { useT, type Key } from '../lib/i18n'
import { diagDetail, diagMessage } from '../lib/diag'

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

/** Severity presentation. The label and blurb are keys; only `cls` is not language. */
const severityCopy: Record<Diagnostic['severity'], { label: Key; cls: string; blurb: Key | null }> =
  {
    error: { label: 'sev.error', cls: 'bad', blurb: 'sev.errorBlurb' },
    dysfunction: { label: 'sev.dysfunction', cls: 'warn', blurb: 'sev.dysfunctionBlurb' },
    warning: { label: 'sev.warning', cls: 'warn', blurb: 'sev.warningBlurb' },
    info: { label: 'sev.info', cls: '', blurb: null },
  }

export function Validate(): React.JSX.Element {
  const { t } = useT()
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
        <p className="dim">{t('validate.openToValidate')}</p>
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
          <h3>{t('validate.title')}</h3>
          <div className="row gap">
            {busy && <span className="dim tiny">{t('validate.checking')}</span>}
            {diags !== null && sorted.length === 0 && <span className="chip ok">{t('validate.clean')}</span>}
            {(['error', 'dysfunction', 'warning'] as const).map((s) =>
              counts[s] ? (
                <span key={s} className={`chip ${severityCopy[s].cls}`}>
                  {counts[s]} {t(severityCopy[s].label)}
                </span>
              ) : null,
            )}
            <button className="ghost" onClick={() => void run()}>
              {t('validate.recheck')}
            </button>
          </div>
        </div>

        <p className="note info">
          {t('validate.lead')} <em>{t('validate.accepts')}</em> {t('validate.leadMid')}{' '}
          <strong>{t('validate.silentlyBroken')}</strong>.
        </p>
      </section>

      {err && <p className="note bad">{err}</p>}

      {diags !== null && sorted.length === 0 && (
        <section className="card">
          <p className="dim">
            {t('validate.clean2')}
          </p>
        </section>
      )}

      {sorted.map((d, i) => (
        <section key={`${d.code}-${d.path}-${i}`} className="card diag">
          <div className="card-head">
            <div className="row gap">
              <span className={`chip ${severityCopy[d.severity].cls}`}>
                {t(severityCopy[d.severity].label)}
              </span>
              {d.path && <code className="mono dim">{d.path}</code>}
            </div>
            <code className="tiny dim">{d.code}</code>
          </div>
          <p className="diag-msg">{diagMessage(d, t)}</p>
          {diagDetail(d, t) && <p className="tiny dim">{diagDetail(d, t)}</p>}
          {severityCopy[d.severity].blurb && (
            <p className="tiny faint">{t(severityCopy[d.severity].blurb!)}</p>
          )}
        </section>
      ))}
    </div>
  )
}
