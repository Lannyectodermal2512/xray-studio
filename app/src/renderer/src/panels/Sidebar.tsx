import { useMemo, useState } from 'react'
import type { BalancerView, OutboundView } from '@shared/events'
import { useApp } from '../store/app'
import { fmtMsFromMs, isDeadSentinel } from '../lib/copy'
import { groupBy, natural } from '../lib/tags'
import { useT, type T } from '../lib/i18n'

const SPARK_W = 72
const SPARK_H = 16

/**
 * 60-sample sparkline, drawn against a scale SHARED across every outbound.
 *
 * Per-sparkline auto-scaling was the flaw in the previous version: each line was
 * normalised to its own maximum, so a 200 ms outbound and an 800 ms one produced
 * identical shapes. Twenty-five of those side by side carry no information at all —
 * they only look like data. One common scale, stated in the section header, makes the
 * heights mean something and makes an outlier visible at a glance.
 *
 * A failed probe has no RTT, so it is never plotted as a value; it is a full-height red
 * band, which reads as "gap in service" rather than the easily-missed 5px tick it was.
 */
function Spark({
  data,
  max,
  tone,
}: {
  data: number[]
  max: number
  tone: string
}): React.JSX.Element {
  const step = SPARK_W / Math.max(1, data.length - 1)
  const y = (v: number): number => SPARK_H - 1 - (Math.min(v, max) / max) * (SPARK_H - 3)

  // One area per unbroken run of successes. Separate runs rather than one spanning
  // path: bridging a gap would draw a line through an outage that never happened.
  const runs: { d: string; from: number; to: number }[] = []
  let cur: string | null = null
  let start = 0
  data.forEach((v, i) => {
    if (v < 0) {
      if (cur) runs.push({ d: cur, from: start, to: (i - 1) * step })
      cur = null
      return
    }
    const x = i * step
    if (!cur) {
      cur = `M${x.toFixed(1)},${y(v).toFixed(1)}`
      start = x
    } else {
      cur += `L${x.toFixed(1)},${y(v).toFixed(1)}`
    }
  })
  if (cur) runs.push({ d: cur, from: start, to: (data.length - 1) * step })

  const hasData = data.some((v) => v >= 0)

  return (
    <svg className="spark" width={SPARK_W} height={SPARK_H} viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}>
      {!hasData && (
        <line
          x1={0}
          x2={SPARK_W}
          y1={SPARK_H - 1}
          y2={SPARK_H - 1}
          stroke="var(--fg-faint)"
          strokeWidth="1"
          strokeDasharray="2 3"
        />
      )}
      {data.map((v, i) =>
        v < 0 ? (
          <rect key={i} x={i * step - 1} y={0} width={2} height={SPARK_H} fill="var(--bad)" opacity={0.55} />
        ) : null,
      )}
      {runs.map((r, i) => (
        <path
          key={`a${i}`}
          d={`${r.d}L${r.to.toFixed(1)},${SPARK_H}L${r.from.toFixed(1)},${SPARK_H}Z`}
          fill={tone}
          opacity={0.16}
        />
      ))}
      {runs.map((r, i) => (
        <path key={`l${i}`} d={r.d} fill="none" stroke={tone} strokeWidth="1.5" />
      ))}
    </svg>
  )
}

function statusColor(ob: OutboundView): string {
  if (ob.faultKind) return 'var(--bad)'
  if (ob.alive === null) return 'var(--idle)'
  return ob.alive ? 'var(--ok)' : 'var(--bad)'
}

/**
 * The number beside the sparkline.
 *
 * `delayMs` is 0 both for "sub-millisecond" and for "never measured", and rendering the
 * second as `<1ms` claimed a measurement that does not exist — with sixteen unprobed
 * LTE outbounds that was most of the column. `alive === null` is the observatory saying
 * it has no record, so say that instead.
 */
function valueText(ob: OutboundView, t: T): string {
  if (isDeadSentinel(ob.delayMs)) return t('common.dead')
  // 0 means "no measurement". Which of the two it is depends on whether the observatory
  // has an opinion: no record at all, or a probed outbound whose window is all failures.
  if (ob.delayMs === 0) return ob.alive === false ? t('common.dead') : '—'
  return fmtMsFromMs(ob.delayMs)
}

function valueTone(ob: OutboundView): string {
  if (isDeadSentinel(ob.delayMs) || ob.alive === false) return 'bad'
  if (ob.alive === null) return 'faint'
  return 'dim'
}

function statusTitle(ob: OutboundView, t: T): string {
  if (ob.faultKind) return t('rail.faultActive', { kind: ob.faultKind })
  if (ob.alive === null) return t('rail.statusNeverProbed')
  return ob.alive ? t('rail.statusAlive') : t('rail.statusDead')
}

export function Sidebar(): React.JSX.Element {
  const {
    snap,
    selectedBalancer,
    selectBalancer,
    selectedOutbound,
    selectOutbound,
    requestEdit,
  } = useApp()
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const { t } = useT()

  // Grouped and naturally ordered, matching the RTT legend. A flat lexicographic list
  // puts LTE-10 between LTE-1 and LTE-2, which at twenty outbounds is unreadable.
  const groups = useMemo(() => groupBy(snap.outbounds, (o) => o.tag), [snap.outbounds])

  // The shared sparkline ceiling. Rounded up to something a person can hold in their
  // head, and printed in the header — a chart whose scale is invisible invites reading
  // two equal-looking lines as equal measurements.
  const sparkMax = useMemo(() => {
    const vals = snap.outbounds.flatMap((o) => o.spark.filter((v) => v >= 0))
    const peak = Math.max(1, ...vals)
    const step = peak <= 100 ? 25 : peak <= 500 ? 50 : peak <= 2000 ? 250 : 1000
    return Math.ceil(peak / step) * step
  }, [snap.outbounds])
  const balancers = useMemo(
    () => [...snap.balancers].sort((a, b) => natural(a.tag, b.tag)),
    [snap.balancers],
  )

  const toggle = (name: string): void =>
    setCollapsed((c) => {
      const next = new Set(c)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })

  return (
    <aside className="rail">
      <section>
        <h2>
          {t('rail.outbounds')} <span className="dim">{snap.outbounds.length}</span>
          {snap.outbounds.length > 0 && (
            <span
              className="dim scale-note"
              title={t('rail.scaleTitle')}
            >
              {t('rail.scale', { n: sparkMax })}
            </span>
          )}
        </h2>
        {snap.outbounds.length === 0 && <p className="dim pad">{t('rail.noOutbounds')}</p>}

        {groups.map((g) => {
          const dead = g.items.filter((o) => o.alive === false).length
          const faulted = g.items.filter((o) => o.faultKind).length
          const shut = collapsed.has(g.name)
          return (
            <div key={g.name} className="ob-group">
              <button className="ob-group-head" onClick={() => toggle(g.name)}>
                <span className="caret">{shut ? '▸' : '▾'}</span>
                <span className="ob-group-name">{g.name}</span>
                <span className="dim tiny">{g.items.length}</span>
                <span className="spacer" />
                {faulted > 0 && (
                  <span className="chip tiny bad" title={t('rail.faultTitle')}>
                    {t('rail.fault', { n: faulted })}
                  </span>
                )}
                {dead > 0 && (
                  <span
                    className="chip tiny bad"
                    title={t('rail.deadTitle')}
                  >
                    {/* Out of how many: "12 dead" reads very differently in a group of
                        twelve than in a group of sixteen, and the count alone gave no
                        way to tell those apart. */}
                    {t('rail.dead', { n: dead, total: g.items.length })}
                  </span>
                )}
              </button>

              {!shut && (
                <ul className="ob-list">
                  {g.items.map((ob) => {
                    return (
                      <li
                        key={ob.tag}
                        className={ob.tag === selectedOutbound ? 'sel' : ''}
                        onClick={() => selectOutbound(ob.tag === selectedOutbound ? null : ob.tag)}
                      >
                        {/* One line per outbound. The sparkline used to sit on a second
                            row, which at twenty-five outbounds turned the rail into a
                            column of near-identical squiggles with no obvious owner. */}
                        <div className="ob-row">
                          <span
                            className="dot"
                            style={{ background: statusColor(ob) }}
                            title={statusTitle(ob, t)}
                          />
                          <span
                            className="ob-tag"
                            title={
                              ob.tag ||
                              t('rail.untagged')
                            }
                          >
                            {/* The full tag, not just the part after the group prefix.
                                A row is read on its own — in a screenshot, when scrolled
                                past its heading, when compared against a fault rule or a
                                log line — and "3" is not something you can match against
                                any of those. */}
                            {ob.tag === '' ? '—' : ob.tag}
                          </span>
                          {ob.inFlight > 0 && (
                            <span className="chip tiny" title={t('rail.probesInFlight')}>
                              {ob.inFlight}
                            </span>
                          )}
                          {ob.faultKind && (
                            <span className="fault-dot" title={t('rail.faultActive', { kind: ob.faultKind })} />
                          )}
                          <Spark data={ob.spark} max={sparkMax} tone={statusColor(ob)} />
                          <span className={`ob-val mono ${valueTone(ob)}`}>{valueText(ob, t)}</span>
                          {/* Revealed on hover: the rail is a status list first, and a
                              permanent button on every row would compete with the
                              health dot for attention. Omitted entirely for untagged
                              dials — there is no config entry to open. */}
                          {ob.tag !== '' && (
                            <button
                              className="ob-edit"
                              title={t('rail.editTitle', { tag: ob.tag })}
                              onClick={(e) => {
                                e.stopPropagation()
                                requestEdit(ob.tag)
                              }}
                            >
                              {t('rail.edit')}
                            </button>
                          )}
                        </div>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          )
        })}
      </section>

      <section>
        <h2>
          {t('rail.balancers')} <span className="dim">{snap.balancers.length}</span>
        </h2>
        {snap.balancers.length === 0 && <p className="dim pad">{t('rail.noBalancerDecisions')}</p>}
        <ul className="bal-list">
          {balancers.map((b: BalancerView) => (
            <li
              key={b.tag}
              className={b.tag === selectedBalancer ? 'sel' : ''}
              onClick={() => selectBalancer(b.tag)}
            >
              <div className="ob-row">
                <span className="ob-tag">{b.tag}</span>
                <span className="chip tiny">{b.strategy}</span>
                <span className="spacer" />
                <button
                  className="ob-edit"
                  title={t('rail.editTitle', { tag: b.tag })}
                  onClick={(e) => {
                    e.stopPropagation()
                    requestEdit(b.tag, 'balancer')
                  }}
                >
                  {t('rail.edit')}
                </button>
              </div>
              <div className="ob-meta">
                <span className="dim">→</span>
                <span className="mono">{b.selected || '(none)'}</span>
                {b.source === 'override' && (
                  <span className="chip tiny bad" title={t('rail.pinnedBypass')}>
                    pinned
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>
      </section>
    </aside>
  )
}
