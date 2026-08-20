import { useMemo, useState } from 'react'
import { useApp } from '../store/app'
import { useT } from '../lib/i18n'

const SEVERITIES = ['error', 'warning', 'info', 'debug', 'unknown']

export function LogPanel(): React.JSX.Element {
  const { snap, coreLog } = useApp()
  const { t } = useT()
  const [minSeverity, setMinSeverity] = useState('info')
  const [connFilter, setConnFilter] = useState('')

  const rank = (s: string): number => {
    const i = SEVERITIES.indexOf(s)
    return i < 0 ? SEVERITIES.length : i
  }

  const rows = useMemo(() => {
    const limit = rank(minSeverity)
    return snap.recentLogs.filter((l) => {
      if (rank(l.severity) > limit) return false
      if (connFilter && String(l.conn_id ?? '') !== connFilter) return false
      return true
    })
  }, [snap.recentLogs, minSeverity, connFilter])

  return (
    <div className="logs">
      {/* Where the files are.
          The app assigns these rather than taking them from the config, because a log
          path is a property of the machine and these configs travel between machines.
          This is the one place that says so — it is where someone looks when they want
          the file itself. */}
      {snap.logPaths && (
        <section className="panel log-paths">
          <div className="panel-head">
            <h3>{t('log.files')}</h3>
            <span className="tiny dim">{t('log.filesSub')}</span>
          </div>
          <div className="log-path-row">
            <span className="tiny dim">{t('log.access')}</span>
            <code className="mono">{snap.logPaths.access}</code>
            <button
              className="ghost tiny"
              onClick={() => void navigator.clipboard.writeText(snap.logPaths!.access)}
            >
              {t('log.copy')}
            </button>
          </div>
          <div className="log-path-row">
            <span className="tiny dim">{t('log.error')}</span>
            <code className="mono">{snap.logPaths.error}</code>
            <button
              className="ghost tiny"
              onClick={() => void navigator.clipboard.writeText(snap.logPaths!.error)}
            >
              {t('log.copy')}
            </button>
          </div>
          <p className="tiny faint">
            {t('log.filesNote')}
          </p>
        </section>
      )}

      <section className="panel">
        <div className="panel-head">
          <h3>{t('log.coreLog')}</h3>
          <div className="log-filters">
            <select value={minSeverity} onChange={(e) => setMinSeverity(e.target.value)}>
              {SEVERITIES.map((s) => (
                <option key={s} value={s}>
                  {t('log.andAbove', { severity: s })}
                </option>
              ))}
            </select>
            <input
              value={connFilter}
              onChange={(e) => setConnFilter(e.target.value)}
              placeholder="conn id"
              className="mono"
              size={10}
            />
          </div>
        </div>

        <p className="dim">
          Structured records from the core&apos;s own logger, teed rather than replaced —
          whatever <code>log.access</code> / <code>log.error</code> your config sets up
          still works.
        </p>

        <div className="log-stream mono">
          {rows.length === 0 && <div className="dim">{t('log.nothingAtLevel')}</div>}
          {rows.map((l) => (
            <div key={l.seq} className={`log-line sev-${l.severity}`}>
              <span className="dim">{(l.mono_ns / 1e9).toFixed(2)}s</span>
              <span className={`sev ${l.severity}`}>{l.severity}</span>
              {l.conn_id ? (
                <button className="link mono" onClick={() => setConnFilter(String(l.conn_id))}>
                  #{l.conn_id}
                </button>
              ) : (
                <span className="dim">—</span>
              )}
              <span className="dim caller">{l.caller ?? ''}</span>
              <span className="msg">{l.message}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="panel">
        <h3>Routing decisions</h3>
        {snap.recentRules.length === 0 ? (
          <p className="dim">No routing decisions yet.</p>
        ) : (
          <div className="log-stream mono">
            {snap.recentRules
              .slice()
              .reverse()
              .map((r) => (
                <div key={r.seq} className="log-line">
                  <span className="dim">{(r.mono_ns / 1e9).toFixed(2)}s</span>
                  {r.rule_idx < 0 ? (
                    <span className="bad" title="Nothing matched, so traffic silently took the default outbound — the first one in the config.">
                      no rule matched → default outbound
                    </span>
                  ) : (
                    <>
                      <span className="chip tiny">#{r.rule_idx}</span>
                      {r.pass === 2 && (
                        <span className="chip tiny" title="second pass, after IPIfNonMatch resolved IPs">
                          pass 2
                        </span>
                      )}
                      <span>{r.rule_tag || '(untagged rule)'}</span>
                      <span className="dim">→</span>
                      <span>{r.balancer ? `balancer ${r.balancer}` : r.out_tag}</span>
                    </>
                  )}
                </div>
              ))}
          </div>
        )}
      </section>

      <section className="panel">
        <h3>Sidecar stdout</h3>
        <div className="log-stream mono dim">
          {coreLog.length === 0 && <div>Nothing yet.</div>}
          {coreLog.slice(-100).map((l, i) => (
            <div key={i} className="log-line">
              {l}
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
