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
  const [hover, setHover] = useState<HoverPoint | null>(null)
  // The uPlot config is built once, but the cursor hook needs the CURRENT series and
  // visibility. Refs rather than a rebuild: recreating the plot on every sample would
  // throw away the zoom and flash the canvas.
  const seriesRef = useRef<RttSeries | null>(null)
  const hiddenRef = useRef<Set<string>>(hidden)
  seriesRef.current = series
  hiddenRef.current = hidden
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

  /** Is there anything to plot at all? See the placeholder below for why this matters. */
  const hasSamples = (series?.t.length ?? 0) > 0

  useEffect(() => {
    const host = hostRef.current
    if (!host || !series || !hasSamples) return

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
            setCursor: [
              (u: uPlot) => setHover(nearestLine(u, seriesRef.current, hiddenRef.current)),
            ],
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
                // No samples at all — no config open yet, or nothing probed. min and
                // max are null, every comparison below is NaN, and uPlot ends up with
                // no x ticks to label, so the axis takes zero height and the plot area
                // is given the whole canvas. The bottom gridline then sits on the edge
                // and its "0ms" label falls off it: the chart looks cropped rather
                // than empty. Same collapse the y axis is guarded against below.
                if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, MIN_SPAN]
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
              size: 108,
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
  }, [series, logScale, hasSamples])

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

  useEffect(() => {
    if (hasSamples) return
    plotRef.current?.destroy()
    plotRef.current = null
  }, [hasSamples])

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

      <div className="chart-wrap">
        {/* With no samples at all, uPlot lays out no x axis — it has no values to make
            ticks from — and then gives the plot area the whole canvas, so the bottom
            gridline sits on the edge and its "0ms" label is cut in half. The result
            reads as a broken chart rather than an empty one.

            Forcing an x range does not help: with no data rows uPlot never calls the
            scale callback. So nothing is mounted until there is something to draw, and
            the space is held by a placeholder of the same height — which also keeps the
            panel from jumping when the first probe lands.

            This is only the nothing-at-all case. Outbounds that exist and are all dead
            still get a real chart: there ARE samples then, and the forced y range below
            keeps its axis from collapsing the same way. */}
        {hasSamples ? (
          <div ref={hostRef} className="chart" />
        ) : (
          <div className="chart chart-empty" />
        )}
        {hover && (
          <div
            className="rtt-tip"
            style={{
              left: hover.left,
              top: hover.top,
              // Flip to the other side of the cursor near the right edge so the tip is
              // never clipped by the panel.
              transform: hover.flip ? 'translate(-100%, -50%)' : 'translate(0, -50%)',
            }}
          >
            <span className="rtt-tip-swatch" style={{ background: hover.color }} />
            <span className="mono">{hover.tag}</span>
            <span className="mono dim">{hover.value.toFixed(1)}ms</span>
          </div>
        )}
      </div>

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
interface HoverPoint {
  tag: string
  value: number
  color: string
  left: number
  top: number
  flip: boolean
}

/** How close, in pixels, the pointer must be to a line before it is named. */
const HOVER_PROX = 22

/**
 * Which line is under the pointer.
 *
 * uPlot's own `cursor.focus` snaps to the nearest data POINT, which is the wrong answer
 * here: probes are interleaved, so at any given x exactly one series has a sample and
 * every other series is a drawn-but-empty span. Asking "which point is nearest" would
 * name whichever outbound happened to be probed last, no matter which line the pointer
 * is actually on.
 *
 * So each series is interpolated at the cursor's x — between its own neighbouring
 * samples, which is exactly what spanGaps draws — and the closest resulting y wins.
 * That names the line you are pointing at, which is the question being asked.
 */
function nearestLine(
  u: uPlot,
  series: RttSeries | null,
  hidden: Set<string>,
): HoverPoint | null {
  const { left, top } = u.cursor
  // uPlot parks the cursor off-canvas when the pointer leaves.
  if (series == null || left == null || top == null || left < 0 || top < 0) return null

  const xVal = u.posToVal(left, 'x')
  // The cursor and valToPos work in PLOT-AREA coordinates; the tip is positioned inside
  // the chart wrapper, which also contains the axis gutter and padding. Same offset the
  // probe lane needed — getting it wrong shifts the tip off the line it names.
  const offX = u.bbox.left / devicePixelRatio
  const offY = u.bbox.top / devicePixelRatio
  let best: HoverPoint | null = null
  let bestDist = HOVER_PROX

  for (let i = 0; i < series.tags.length; i++) {
    const tag = series.tags[i]!
    if (hidden.has(tag)) continue
    const col = series.values[i]
    if (!col) continue

    // On the line: vertical distance to the interpolated path. Past either end of the
    // series there is no path — spanGaps connects samples, it does not extend beyond
    // them — so fall back to the straight-line distance to its nearest endpoint, which
    // is what lets the newest sample still be named.
    let y = interpolateAt(series.t, col, xVal)
    let dist: number
    if (y != null) {
      dist = Math.abs(u.valToPos(y, 'y') - top)
    } else {
      const near = nearestSample(u, series.t, col, left, top)
      if (near == null) continue
      y = near.v
      dist = near.dist
    }

    const py = u.valToPos(y, 'y')
    if (dist < bestDist) {
      bestDist = dist
      best = {
        tag,
        value: y,
        color: PALETTE[i % PALETTE.length]!,
        left: offX + left + 12,
        top: offY + py,
        flip: left > u.bbox.width / devicePixelRatio - 150,
      }
    }
  }
  return best
}

/** Straight-line pixel distance to a series' closest actual sample. */
function nearestSample(
  u: uPlot,
  t: number[],
  col: (number | null)[],
  left: number,
  top: number,
): { v: number; dist: number } | null {
  let best: { v: number; dist: number } | null = null
  for (let k = 0; k < col.length; k++) {
    const v = col[k]
    if (v == null) continue
    const dx = u.valToPos(t[k]!, 'x') - left
    const dy = u.valToPos(v, 'y') - top
    const dist = Math.sqrt(dx * dx + dy * dy)
    if (!best || dist < best.dist) best = { v, dist }
  }
  return best
}

/** Linear interpolation between a series' own non-null neighbours, or null outside them. */
function interpolateAt(t: number[], col: (number | null)[], x: number): number | null {
  let lo = -1
  let hi = -1
  for (let k = 0; k < col.length; k++) {
    if (col[k] == null) continue
    if (t[k]! <= x) lo = k
    else {
      hi = k
      break
    }
  }
  if (lo < 0 && hi < 0) return null
  // Beyond the series' own ends there is no line to be near — spanGaps connects
  // samples, it does not extend past them.
  if (lo < 0 || hi < 0) return null
  const t0 = t[lo]!
  const t1 = t[hi]!
  const v0 = col[lo]!
  const v1 = col[hi]!
  if (t1 === t0) return v0
  return v0 + ((v1 - v0) * (x - t0)) / (t1 - t0)
}

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

  const left = plot?.bbox ? plot.bbox.left / devicePixelRatio : 108
  const width = plot?.bbox ? plot.bbox.width / devicePixelRatio : 0
  /**
   * Time to an offset inside the track.
   *
   * valToPos returns CSS pixels measured from the PLOTTING AREA's origin, not from the
   * canvas, so the axis gutter must not be subtracted again. Doing so shifted every mark
   * left by the width of that gutter: the newest probe landed at 85% of the track with a
   * permanent empty margin on the right, and the oldest went negative and was dropped
   * altogether. The lane looked plausible, which is why it survived — the track lined up
   * with the plot area, only its contents did not.
   */
  const xOf = (t: number): number | null => {
    if (!plot) return null
    const x = plot.valToPos(t, 'x')
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
