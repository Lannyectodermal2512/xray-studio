import type { BalancerEvalEvent, Stage } from '@shared/events'
import {
  fmtMs,
  rejectionHelp,
  rejectionLabel,
  sourceCopy,
  stageLabel,
  stageNote,
} from '../lib/copy'

/**
 * Renders one balancer decision as an ordered pipeline: what entered each stage, what
 * survived, and why every casualty died — with the numbers that justify it.
 *
 * The same component renders all four strategies, because the core emits the same
 * Stage[] shape for each. It also renders simulated decisions unchanged, which is what
 * will make the what-if diff view trivial later.
 */
export function DecisionFunnel({ evalEvent }: { evalEvent: BalancerEvalEvent | null }): React.JSX.Element {
  if (!evalEvent) {
    return (
      <div className="panel empty">
        <p>No decision recorded yet.</p>
        <p className="dim">
          A balancer evaluates once per dispatched connection. Send traffic through the
          inbound to see why it picks what it picks.
        </p>
      </div>
    )
  }

  const e = evalEvent
  const src = sourceCopy[e.source] ?? { tone: 'info' as const, text: e.source }

  return (
    <div className="funnel">
      <header className="funnel-head">
        <div>
          <span className="funnel-bal">{e.balancer_tag}</span>
          <span className="chip">{e.strategy}</span>
          {e.fallback_tag && <span className="chip dim">fallback: {e.fallback_tag}</span>}
        </div>
        <div className="funnel-result">
          <span className="dim">selected</span>
          <strong className={e.selected ? 'pick' : 'pick none'}>{e.selected || '(none)'}</strong>
          <span className="dim mono">{fmtMs(e.duration_ns)}</span>
        </div>
      </header>

      <div className={`note ${src.tone}`}>{src.text}</div>
      {e.err && <div className="note bad mono">{e.err}</div>}

      <div className="funnel-candidates">
        <span className="dim">candidates from selector {e.selectors?.join(', ') || '—'}:</span>{' '}
        {e.candidates?.length ? (
          e.candidates.map((c) => (
            <span key={c} className="chip">
              {c}
            </span>
          ))
        ) : (
          <span className="bad">
            none — this selector matches no outbound. Xray never checks this at load
            time, because balancers are built before outbounds exist.
          </span>
        )}
      </div>

      <ol className="stages">
        {e.stages?.map((st, i) => (
          <StageRow key={`${st.id}-${i}`} stage={st} />
        ))}
      </ol>
    </div>
  )
}

function StageRow({ stage }: { stage: Stage }): React.JSX.Element {
  const note = stage.note ? stageNote[stage.note] : null
  const scores = stage.scores ?? {}
  const ranked = Object.entries(scores).sort((a, b) => a[1] - b[1])

  return (
    <li className="stage">
      <div className="stage-head">
        <span className="stage-name">{stageLabel[stage.id] ?? stage.id}</span>
        <span className="stage-flow mono">
          {stage.in?.length ?? 0} → {stage.out?.length ?? 0}
        </span>
      </div>

      {note && <div className={`note ${note.tone}`}>{note.text}</div>}

      <div className="stage-body">
        <div className="survivors">
          {stage.out?.length ? (
            stage.out.map((t) => (
              <span key={t} className="chip ok">
                {t}
              </span>
            ))
          ) : (
            <span className="dim">nothing survived</span>
          )}
        </div>

        {stage.rejected && stage.rejected.length > 0 && (
          <ul className="rejects">
            {stage.rejected.map((r) => (
              <li key={`${r.tag}-${r.reason}`} title={rejectionHelp[r.reason] ?? r.reason}>
                <span className="x">✕</span>
                <span className="rtag">{r.tag}</span>
                <span className="rreason">{rejectionLabel[r.reason] ?? r.reason}</span>
                {r.values && (
                  <span className="rvals mono">
                    {Object.entries(r.values)
                      .map(([k, v]) => `${k}=${v}`)
                      .join('  ')}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}

        {ranked.length > 0 && (
          <table className="scores">
            <thead>
              <tr>
                <th>outbound</th>
                <th>deviation</th>
                <th>× √cost</th>
                <th>= score</th>
              </tr>
            </thead>
            <tbody>
              {ranked.map(([tag, score]) => {
                const dev = stage.params?.[`dev_ns:${tag}`]
                // Weight is transported in milli-units so it survives the int64 map.
                const w = (stage.params?.[`w:${tag}`] ?? 1000) / 1000
                return (
                  <tr key={tag}>
                    <td className="mono">{tag}</td>
                    <td className="mono dim">{fmtMs(dev)}</td>
                    <td className="mono dim">
                      {w === 1 ? '—' : `√${w} = ${Math.sqrt(w).toFixed(2)}`}
                    </td>
                    <td className="mono">{fmtMs(score)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}

        {stage.id === 'dice' && (stage.params?.['n'] ?? 0) > 1 && (
          <div className="note warn">
            Uniform random over {stage.params!['n']} survivors — the winner was chance,
            not ranking (p = {(100 / stage.params!['n']!).toFixed(0)}%). leastLoad and
            random are only deterministic when exactly one candidate survives.
          </div>
        )}

        {stage.params && Object.keys(stage.params).some((k) => !k.includes(':')) && (
          <div className="params mono dim">
            {Object.entries(stage.params)
              .filter(([k]) => !k.includes(':'))
              .map(([k, v]) => `${k}=${v}`)
              .join('   ')}
          </div>
        )}
      </div>
    </li>
  )
}
