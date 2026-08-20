import { useCallback, useEffect, useState } from 'react'
import type { CheckStatus, SelfCheckReport } from '@shared/events'
import { useT } from '../lib/i18n'

/**
 * Continuous verification of the dashboard's own claims.
 *
 * Everything this app says about Xray — why an outbound was rejected, what
 * principle_target means for each strategy, which candidate leastPing should favour —
 * is an assertion about someone else's code. These checks re-derive those assertions
 * from the core's own answers so that a wrong one becomes visible rather than quietly
 * misleading.
 */

const statusOrder: Record<CheckStatus, number> = { fail: 0, warn: 1, ok: 2, skipped: 3 }

function Pill({ report }: { report: SelfCheckReport | null }): React.JSX.Element {
  const { t } = useT()
  if (!report) return <span className="chip">{t('selfcheck.noData')}</span>
  if (report.fail > 0) return <span className="chip bad">{report.fail} failing</span>
  if (report.warn > 0) return <span className="chip warn">{report.warn} to review</span>
  if (report.ok > 0) return <span className="chip ok">all {report.ok} verified</span>
  return <span className="chip">{t('selfcheck.nothingToCheck')}</span>
}

export function SelfCheck(): React.JSX.Element {
  const { t } = useT()
  const [report, setReport] = useState<SelfCheckReport | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [auto, setAuto] = useState(true)
  const [ranAt, setRanAt] = useState<number | null>(null)

  const run = useCallback(async () => {
    try {
      setReport(await window.xraystudio.selfCheck())
      setErr(null)
      setRanAt(Date.now())
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    void run()
    if (!auto) return
    const id = setInterval(() => void run(), 5000)
    return () => clearInterval(id)
  }, [run, auto])

  const checks = [...(report?.checks ?? [])].sort(
    (a, b) => statusOrder[a.status] - statusOrder[b.status],
  )

  return (
    <div className="whatif">
      <section className="card">
        <div className="card-head">
          <h3>{t('selfcheck.title')}</h3>
          <div className="row gap">
            <Pill report={report} />
            <label className="row gap tiny dim">
              <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
              {t('selfcheck.every5s')}
            </label>
            <button className="ghost" onClick={() => void run()}>
              {t('selfcheck.run')}
            </button>
          </div>
        </div>

        <p className="note info">
          {t('selfcheck.rederive')}{' '}
          <code>Router.GetPrincipleTarget</code>{t('selfcheck.oracleNote')} <code>TestRoute</code> {t('selfcheck.oracleNoteTail')}
        </p>

        {ranAt && (
          <p className="tiny dim">{t('selfcheck.lastRun', { time: new Date(ranAt).toLocaleTimeString() })}</p>
        )}
      </section>

      {err && <p className="note bad">{err}</p>}

      {checks.length > 0 && (
        <section className="card">
          <table className="grid checks">
            <thead>
              <tr>
                <th>status</th>
                <th>subject</th>
                <th>claim</th>
              </tr>
            </thead>
            <tbody>
              {checks.map((c) => (
                <tr key={c.id}>
                  <td>
                    <span className={`chip ${c.status === 'ok' ? 'ok' : c.status === 'warn' ? 'warn' : c.status === 'fail' ? 'bad' : ''}`}>
                      {c.status}
                    </span>
                  </td>
                  <td className="mono">{c.subject}</td>
                  <td>
                    <div>{c.summary}</div>
                    {c.detail && <div className="tiny dim">{c.detail}</div>}
                    {(c.expected || c.actual) && (
                      <div className="tiny mono dim">
                        {c.expected && <>expected: {c.expected} </>}
                        {c.actual && <>· actual: {c.actual}</>}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  )
}
