import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/shallow'
import { useApp } from '../store/app'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import type { RttSeries } from '@shared/events'
import { groupBy, natural } from '../lib/tags'

const PALETTE = ['#4c9aff', '#3fb950', '#d29922', '#f778ba', '#a371f7', '#39c5cf', '#ff7b72']
const CHART_H = 220
const MIN_SPAN = 15

interface Group {
  name: string
  tags: string[]
}

function groupTags(tags: string[]): Group[] {
  return groupBy(tags, (t) => t).map((g) => ({ name: g.name, tags: g.items }))
}

/**
 * Live RTT chart.
 *
 * Failures are deliberately NOT plotted as values. The observatory represents a dead
 * probe as delay = 99999999 (plain) or rttFailed = MaxInt64 (burst); charting those
 * would compress every real measurement into a flat line at the bottom. They are drawn
 * as red marks in a time-aligned lane beneath the chart instead.
 *
 * uPlot's own legend is switched off. It lays series out in a single wrapping row, so
 * at twenty-odd outbounds — an ordinary count for a balanced config — the labels
 * collide into an unreadable block. The replacement groups by tag prefix and lets a
 * whole group be shown or hidden at once, which is how these configs are reasoned
 * about anyway.
 *
 * The series is pulled on a slow timer rather than pushed with the 30Hz snapshot: it
 * is large, and it changes at probe cadence (seconds), not at frame cadence.
 */
export function RttTimeline(): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const plotRef = useRef<uPlot | null>(null)
  const [series, setSeries] = useState<RttSeries | null>(null)
  const [logScale, setLogScale] = useState(false)
  // Once the user picks a scale we stop second-guessing them.
  const userChoseScale = useRef(false)
  const [autoLog, setAutoLog] = useState(false)
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  // Bumped whenever the plot geometry changes, so the failure lane recomputes its
  // pixel positions against the same axis the chart just drew.
  const [geom, setGeom] = useState(0)

  useEffect(() => {
    let alive = true
    const tick = async (): Promise<void> => {
      const s = await window.xraystudio.rttSeries()
      if (alive) setSeries(s)
    }
    void tick()
    const id = setInterval(tick, 1000)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [])

  // A single slow probe — very common on the first round, while TLS sessions and DNS
  // are cold — is enough to compress every subsequent measurement into a flat line at
  // the bottom of a linear axis. Rather than hide the outlier (it is real data), switch
  // to a log axis and say why.
  useEffect(() => {
    if (!series || userChoseScale.current) return
    const vals = series.values.flat().filter((v): v is number => v !== null && v > 0)
    if (vals.length < 4) return
    const sorted = [...vals].sort((a, b) => a - b)
    const median = sorted[Math.floor(sorted.length / 2)]!
    const max = sorted[sorted.length - 1]!
    const wide = max / Math.max(1, median) > 8
    setAutoLog(wide)
    setLogScale(wide)
  }, [series])

  const groups = useMemo(() => groupTags(series?.tags ?? []), [series?.tags])

  // Liveness comes from the snapshot, not from the series: the chart carries samples,
  // and "alive" is the observatory's own verdict over its sampling window, which is not
  // the same as "the last probe succeeded".
  // useShallow, because the selector builds a fresh object on every snapshot: without
  // it zustand would see a new reference 30 times a second and re-render the chart
  // continuously. Shallow comparison over a record of primitives is exactly right here.
  const aliveByTag = useApp(
    useShallow((st) => {
      const m: Record<string, boolean | null> = {}
      for (const o of st.snap.outbounds) m[o.tag] = o.alive
      return m
    }),
  )

  useEffect(() => {
    const host = hostRef.current
    if (!host || !series) return

    const data: uPlot.AlignedData = [
      series.t,
      ...series.values.map((v) => v.map((x) => (x === null ? null : x))),
    ] as uPlot.AlignedData

    // Rebuild when the set of series changes; otherwise just feed new data, which is
    // what keeps this cheap at high sample counts.
    if (!plotRef.current || plotRef.current.series.length - 1 !== series.tags.length) {
      plotRef.current?.destroy()
      plotRef.current = new uPlot(
        {
          width: host.clientWidth || 800,
          height: CHART_H,
          padding: [10, 10, 0, 6],
          legend: { show: false },
          cursor: { drag: { x: true, y: false } },
          hooks: {
            // setSize covers resize; setScale covers a zoom-drag. Both move the x
            // mapping the failure lane depends on.
            setSize: [() => setGeom((g) => g + 1)],
            setScale: [() => setGeom((g) => g + 1)],
          },
          // x carries seconds since sidecar start, not a unix timestamp. Without
          // time:false uPlot renders it as 1970 dates, which is both wrong and useless
          // — elapsed time is what matters when correlating a fault with a failover.
          scales: {
            x: {
              time: false,
              // With only a handful of samples uPlot would auto-fit the axis to the
              // span between them, producing a window a few milliseconds wide labelled
              // "0.187s … 0.1892s". Enforce a floor so the early view reads as a
              // timeline rather than a rendering fault.
              range: (_u, min, max) => {
                if (max - min >= MIN_SPAN) return [min, max]
                return [min, min + MIN_SPAN]
              },
            },
            y: {
              distr: logScale ? 3 : 1,
              // Keep a range even with no samples at all.
              //
              // When every outbound is dead there are no values, uPlot draws no y ticks,
              // and the axis collapses to zero width — taking the gutter the probe lane
              // below borrows for its labels with it, so the names vanished exactly when
              // the config was most broken. An empty chart with a labelled axis is also
              // simply more honest than one with no axis at all.
              range: (_u, min, max) =>
                min == null || max == null || !Number.isFinite(min) || !Number.isFinite(max)
                  ? [logScale ? 1 : 0, 100]
                  : [logScale ? Math.max(1, min) : Math.min(0, min), max],
            },
          },
          axes: [
            {
              stroke: '#8b96a5',
              grid: { stroke: '#262d38', width: 1 },
              values: (_u, vals) => vals.map((v) => `${v}s`),
            },
            {
              stroke: '#8b96a5',
              grid: { stroke: '#262d38', width: 1 },
              // Wider than the labels need, because the probe lane below borrows this
              // gutter for its tag and counters and must stay aligned with the plot
              // area to the pixel. Buying that alignment with ~35px of chart width is
              // the right trade: a lane whose marks do not line up with the samples
              // above them is worse than a slightly narrower chart.
              size: 96,
              values: (_u, vals) => vals.map((v) => `${v}ms`),
            },
          ],
          series: [
            { label: 't' },
            ...series.tags.map((tag, i) => ({
              label: tag,
              stroke: PALETTE[i % PALETTE.length]!,
              width: 1.5,
              show: !hidden.has(tag),
              // Each probe result adds one row to the shared x axis, so every OTHER
              // series is null at that instant. Without spanGaps the chart would only
              // connect two points that happen to be adjacent, which for interleaved
              // probes is almost never — the result is a scatter of disconnected
              // diagonals rather than a line per outbound.
              spanGaps: true,
              points: { show: true, size: 4 },
            })),
          ],
        },
        data,
        host,
      )
      setGeom((g) => g + 1)
    } else {
      plotRef.current.setData(data)
      setGeom((g) => g + 1)
    }
    // `hidden` is applied through the effect below, not here: rebuilding the plot on
    // every legend click would throw away the zoom and flash the canvas.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series, logScale])

  // Visibility is pushed into the existing plot instance.
  useEffect(() => {
    const u = plotRef.current
    if (!u || !series) return
    series.tags.forEach((tag, i) => {
      const want = !hidden.has(tag)
      if (u.series[i + 1]?.show !== want) u.setSeries(i + 1, { show: want })
    })
  }, [hidden, series])

  useEffect(() => {
    const onResize = (): void => {
      const host = hostRef.current
      if (host && plotRef.current) plotRef.current.setSize({ width: host.clientWidth, height: CHART_H })
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => () => plotRef.current?.destroy(), [])

  const toggleTag = useCallback((tag: string) => {
    setHidden((h) => {
      const next = new Set(h)
      if (next.has(tag)) next.delete(tag)
      else next.add(tag)
      return next
    })
  }, [])

  const toggleGroup = useCallback((g: Group) => {
    setHidden((h) => {
      const next = new Set(h)
      const anyVisible = g.tags.some((t) => !next.has(t))
      // Mixed state collapses to hidden, so one click always reaches a clean state.
      for (const t of g.tags) {
        if (anyVisible) next.add(t)
        else next.delete(t)
      }
      return next
    })
  }, [])

  /** Show only this group. The fastest way to read one role out of twenty series. */
  const soloGroup = useCallback(
    (g: Group) => {
      const keep = new Set(g.tags)
      setHidden(new Set((series?.tags ?? []).filter((t) => !keep.has(t))))
    },
    [series?.tags],
  )

  const lastValue = useCallback(
    (i: number): number | null => {
      const col = series?.values[i]
      if (!col) return null
      for (let k = col.length - 1; k >= 0; k--) {
        const v = col[k]
        if (v !== null && v !== undefined) return v
      }
      return null
    },
    [series],
  )

  return (
    <section className="panel">
      <div className="panel-head">
        <h3>RTT</h3>
        <div className="rtt-actions">
          {hidden.size > 0 && (
            <button className="tiny" onClick={() => setHidden(new Set())}>
              show all ({hidden.size} hidden)
            </button>
          )}
          <label className="toggle">
            <input
              type="checkbox"
              checked={logScale}
              onChange={(e) => {
                userChoseScale.current = true
                setAutoLog(false)
                setLogScale(e.target.checked)
              }}
            />
            log scale
          </label>
        </div>
      </div>

      <div ref={hostRef} className="chart" />

      {series && (
        <ProbeLane
          aliveByTag={aliveByTag}
          series={series}
          plot={plotRef.current}
          geom={geom}
          hidden={hidden}
          groups={groups}
        />
      )}

      {autoLog && (
        <p className="note info">
          Log scale applied automatically: one probe is far slower than the rest, and on a
          linear axis it would flatten everything else. Uncheck to compare.
        </p>
      )}

      {series && series.tags.length > 0 && (
        <div className="rtt-legend">
          {groups.map((g) => {
            const allHidden = g.tags.every((t) => hidden.has(t))
            return (
              <div key={g.name} className={`lg-group${allHidden ? ' off' : ''}`}>
                <div className="lg-head">
                  <button
                    className="lg-title"
                    onClick={() => toggleGroup(g)}
                    title={allHidden ? 'show this group' : 'hide this group'}
                  >
                    <span className="lg-box">{allHidden ? '' : '✓'}</span>
                    {g.name}
                    <span className="dim">{g.tags.length}</span>
                  </button>
                  {groups.length > 1 && (
                    <button className="lg-solo" onClick={() => soloGroup(g)} title="show only this group">
                      solo
                    </button>
                  )}
                </div>
                <div className="lg-items">
                  {g.tags.map((tag) => {
                    const i = series.tags.indexOf(tag)
                    const off = hidden.has(tag)
                    const v = lastValue(i)
                    return (
                      <button
                        key={tag}
                        className={`lg-item${off ? ' off' : ''}`}
                        onClick={() => toggleTag(tag)}
                        title={`${tag} — click to ${off ? 'show' : 'hide'}`}
                      >
                        <span
                          className="lg-swatch"
                          style={{ background: off ? 'transparent' : PALETTE[i % PALETTE.length] }}
                        />
                        {/* Full tag, matching the rail and the failure lane below.
                            The group heading is context, not a substitute for the name:
                            "7" cannot be matched against a fault rule or a log line. */}
                        <span className="lg-name">{tag}</span>
                        <span className="lg-val mono">{v === null ? '—' : `${Math.round(v)}`}</span>
                      </button>
                    )
                  })}
                </div>
              </div>
            )
          })}
          <p className="tiny faint lg-foot">
            Values are the most recent sample in milliseconds. Click a name to hide its
            line, a group heading to hide all of it.
          </p>
        </div>
      )}

      {series && series.t.length === 0 && (
        <p className="dim">
          No samples yet. The chart fills as the observatory probes; every probe, failed
          or not, also appears in the lane beneath it.
        </p>
      )}
    </section>
  )
}

/**
 * Every probe, on the chart's own time axis: one row per outbound, green for a success
 * and red for a failure.
 *
 * Showing only failures answered half the question. A row of red marks tells you an
 * outbound is failing but not whether it is failing on EVERY attempt or one in five,
 * and an outbound with no row at all is ambiguous between "healthy" and "never probed".
 * With both classes plotted, the probe cadence itself becomes visible — which is the
 * thing that explains why an injected fault takes a minute to show up in the health
 * status.
 *
 * Successes are derived from the chart series rather than sent separately: a non-null
 * sample IS a successful probe, since the store writes null for a failure and records
 * it in `failures` instead.
 *
 * Positions come from uPlot's own valToPos against the live x scale, so the lane stays
 * aligned through resizes and zoom-drags instead of approximating the axis geometry.
 */
function ProbeLane({
  series,
  plot,
  geom,
  hidden,
  groups,
  aliveByTag,
}: {
  series: RttSeries
  plot: uPlot | null
  geom: number
  hidden: Set<string>
  groups: Group[]
  aliveByTag: Record<string, boolean | null>
}): React.JSX.Element | null {
  const rows = useMemo(() => {
    const fails = new Map<string, number[]>()
    for (const f of series.failures) {
      const arr = fails.get(f.tag)
      if (arr) arr.push(f.t)
      else fails.set(f.tag, [f.t])
    }

    // Legend order, so the eye can move between the two without re-reading.
    const order = groups.flatMap((g) => g.tags)
    return order
      .filter((tag) => !hidden.has(tag))
      .map((tag) => {
        const i = series.tags.indexOf(tag)
        const col = series.values[i] ?? []
        const ok: number[] = []
        for (let k = 0; k < col.length; k++) {
          if (col[k] !== null && col[k] !== undefined) ok.push(series.t[k]!)
        }
        return { tag, ok, fail: fails.get(tag) ?? [] }
      })
      .filter((r) => r.ok.length + r.fail.length > 0)
    // geom is a positioning dependency, not a data one, but recomputing on it keeps
    // the marks correct after a resize.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series, hidden, groups, geom])

  if (rows.length === 0) return null

  const left = plot?.bbox ? plot.bbox.left / devicePixelRatio : 96
  const width = plot?.bbox ? plot.bbox.width / devicePixelRatio : 0
  const xOf = (t: number): number | null => {
    if (!plot) return null
    const x = plot.valToPos(t, 'x') - plot.bbox.left / devicePixelRatio
    if (x < 0 || (width > 0 && x > width)) return null
    return x
  }

  return (
    <div className="probe-lane">
      <div className="probe-lane-head tiny dim">
        probes <span className="ok">success</span> / <span className="bad">failure</span>
        <span className="faint"> — live outbounds are highlighted; a failed probe has no RTT, so it cannot appear on the chart</span>
      </div>
      {rows.map((r) => {
        const alive = aliveByTag[r.tag]
        return (
        <div
          key={r.tag}
          className={`probe-row ${alive === true ? 'up' : alive === false ? 'down' : 'unknown'}`}
        >
          {/* Name and counters share the chart's y-axis gutter, so the track still
              starts exactly where the plotting area does and every mark lines up with
              the sample above it. Counters live here rather than at the far end of the
              track: at twenty rows the eye reads name → numbers → timeline, and having
              to travel to the right edge and back for each row defeats the comparison
              the lane exists for. */}
          <span className="probe-legend" style={{ width: left - 6 }}>
            <span className="probe-tag mono" title={r.tag}>
              {r.tag}
            </span>
            {/* Both numbers, always. A missing failure count is indistinguishable from
                a zero one, and "0 failures" is exactly what you want to confirm. */}
            <span className="probe-count mono">
              <span className={r.ok.length > 0 ? 'ok' : 'faint'}>{r.ok.length}</span>
              <span className="faint">/</span>
              <span className={r.fail.length > 0 ? 'bad' : 'faint'}>{r.fail.length}</span>
            </span>
          </span>
          <span className="probe-track" style={{ width: width || undefined }}>
            {r.ok.map((t, i) => {
              const x = xOf(t)
              return x === null ? null : <span key={`o${i}`} className="probe-mark ok" style={{ left: x }} />
            })}
            {/* Failures drawn last so they are never hidden under a success mark at the
                same pixel — the failure is the event worth seeing. */}
            {r.fail.map((t, i) => {
              const x = xOf(t)
              return x === null ? null : <span key={`f${i}`} className="probe-mark bad" style={{ left: x }} />
            })}
          </span>
        </div>
        )
      })}
    </div>
  )
}
