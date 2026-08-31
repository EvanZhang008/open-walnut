import { useMemo, useState, type CSSProperties } from 'react'
import type { OutsideTimelineApp, TimeBlock } from './api'
import {
  TICK_BELOW_MS, clockLabel, formatDuration, hourLabel, planDrawMerge, taskColor,
  type AxisRange,
} from './time-timeline'
import { LANE_BAR_MIN_PX, LANE_ROWS, LANE_TRACK_PX, laneBar } from './time-views'

/**
 * View C — task swimlanes.
 *
 * Turned sideways: one ROW per task, time along X. This is the view that answers
 * "when was this task touched, and how many times did I get pulled off it", a
 * question the vertical views can only answer by scanning colours.
 *
 * Two structural rules make it stay readable at real density:
 *
 * 1. The title lives in a fixed left column, in full. No bar ever carries text, so
 *    a 40-second touch and a 40-minute stretch are both legible and nothing has to
 *    be truncated to fit inside a rectangle.
 * 2. Rows are capped. The top LANE_ROWS tasks get their own row and EVERYTHING else
 *    is aggregated into one grey row, because twenty rows of one bar each is the
 *    same confetti problem in a different orientation. The grey row EXPANDS on
 *    click — the cap is a default, not a wall.
 *
 * Agents are a separate bottom row, hatched purple, and appear only when the
 * toggle is on. Outside apps (screen time) are their own slate rows above it,
 * again toggle-only. Both toggles deliberately affect THIS VIEW ONLY: the tape and
 * the chapters are about a human's attention, and mixing an 8-hour agent run into
 * a 3-hour human day is exactly the misreading this feature area was burned by.
 */

/** Outside-app rows before their own "其他" fold. Tighter than the task cap:
 *  app rows are context, not the subject of the chart. */
const OUTSIDE_LANE_ROWS = 6

/** What a lane bar needs — tasks and outside apps both flatten into this.
 *  `kind` exists because planDrawMerge groups by (kind, taskId). */
interface LaneSpan {
  taskId: string
  kind: string
  startTs: string
  endTs: string
  trackedMs: number
}

interface LaneRow {
  key: string
  taskId: string | null
  title: string
  ms: number
  blocks: LaneSpan[]
  kind: 'task' | 'others' | 'agent' | 'outside' | 'outside-others'
  /** Merged rows only: expand/collapse state + how many rows are folded in. */
  expandable?: { expanded: boolean; count: number; toggle: () => void }
  /** Expanded children render slightly indented. */
  child?: boolean
  /** Merged rows: name the ITEM a bar belongs to, so its tooltip is not just
   *  the row's own "其他 N 个" label. Null = fall back to the row title. */
  barLabel?: (spanId: string) => string | null
}

const spanOf = (b: TimeBlock): LaneSpan => ({
  taskId: b.taskId, kind: b.kind, startTs: b.startTs, endTs: b.endTs, trackedMs: b.trackedMs,
})

export function TimeLanes({ blocks, totals, agentMs, showAgents, outside, outsideDropped, axis, minuteOf, nowMin, labelFor }: {
  /** Per-task MERGED blocks (not the serial ribbon): rows want runs of work. */
  blocks: TimeBlock[]
  /** Ranked per-task human totals for the day, descending. */
  totals: ReadonlyArray<{ taskId: string; ms: number }>
  agentMs: number
  showAgents: boolean
  /** Outside-app intervals (screen time), or null when the toggle is off. */
  outside: OutsideTimelineApp[] | null
  /** Apps past the SERVER's cap: counted, but no intervals arrived for them. */
  outsideDropped: { apps: number; ms: number } | null
  axis: AxisRange
  minuteOf: (iso: string) => number
  nowMin: number | null
  labelFor: (taskId: string) => string
}) {
  const [tasksOpen, setTasksOpen] = useState(false)
  const [appsOpen, setAppsOpen] = useState(false)

  const rows = useMemo<LaneRow[]>(() => {
    const human = blocks.filter((b) => b.kind !== 'agent')
    const top = totals.slice(0, LANE_ROWS)
    const topIds = new Set(top.map((t) => t.taskId))
    const taskRow = (t: { taskId: string; ms: number }, child: boolean): LaneRow => ({
      key: `t-${t.taskId}`,
      taskId: t.taskId,
      title: labelFor(t.taskId),
      ms: t.ms,
      blocks: human.filter((b) => b.taskId === t.taskId).map(spanOf),
      kind: 'task',
      ...(child ? { child: true } : {}),
    })
    const out: LaneRow[] = top.map((t) => taskRow(t, false))

    const restTotals = totals.slice(LANE_ROWS)
    if (restTotals.length > 0) {
      out.push({
        key: 'others',
        taskId: null,
        title: tasksOpen ? `收起这 ${restTotals.length} 个任务` : `其他 ${restTotals.length} 个任务(快碰合并)`,
        ms: restTotals.reduce((sum, t) => sum + t.ms, 0),
        // Expanded: the merged bars move into the child rows below.
        blocks: tasksOpen ? [] : human.filter((b) => !topIds.has(b.taskId)).map(spanOf),
        kind: 'others',
        expandable: { expanded: tasksOpen, count: restTotals.length, toggle: () => setTasksOpen((v) => !v) },
        // A merged bar's tooltip names ITS task, not the row's "其他 N 个" label.
        barLabel: (id) => (id ? labelFor(id) : null),
      })
      if (tasksOpen) for (const t of restTotals) out.push(taskRow(t, true))
    }

    if (outside && outside.length > 0) {
      const appRow = (a: OutsideTimelineApp, child: boolean): LaneRow => ({
        key: `o-${a.bundleId || a.app}`,
        taskId: null,
        title: a.app,
        ms: a.ms,
        blocks: a.blocks.map((b) => ({
          taskId: '', kind: 'outside', startTs: b.startTs, endTs: b.endTs, trackedMs: b.ms,
        })),
        kind: 'outside',
        ...(child ? { child: true } : {}),
      })
      for (const a of outside.slice(0, OUTSIDE_LANE_ROWS)) out.push(appRow(a, false))
      const restApps = outside.slice(OUTSIDE_LANE_ROWS)
      // Apps the server capped away have no intervals, but their TIME is real:
      // they ride the merged row's count and total so nothing silently vanishes.
      const dropped = outsideDropped ?? { apps: 0, ms: 0 }
      if (restApps.length + dropped.apps > 0) {
        const nameOf = new Map(restApps.map((a) => [a.bundleId || a.app, a.app]))
        const count = restApps.length + dropped.apps
        out.push({
          key: 'outside-others',
          taskId: null,
          title: appsOpen ? `收起这 ${count} 个 app` : `其他 ${count} 个 app`,
          ms: restApps.reduce((sum, a) => sum + a.ms, 0) + dropped.ms,
          blocks: appsOpen ? [] : restApps.flatMap((a) => a.blocks.map((b) => ({
            // Distinct taskId per app: two apps' bars must not draw-merge into one.
            taskId: a.bundleId || a.app, kind: 'outside', startTs: b.startTs, endTs: b.endTs, trackedMs: b.ms,
          }))),
          kind: 'outside-others',
          expandable: { expanded: appsOpen, count, toggle: () => setAppsOpen((v) => !v) },
          barLabel: (id) => nameOf.get(id) ?? null,
        })
        if (appsOpen) {
          for (const a of restApps) out.push(appRow(a, true))
          if (dropped.apps > 0) {
            out.push({
              key: 'outside-dropped',
              taskId: null,
              title: `还有 ${dropped.apps} 个 app(用时太短,未逐个展开)`,
              ms: dropped.ms,
              blocks: [],
              kind: 'outside',
              child: true,
            })
          }
        }
      }
    }

    if (showAgents) {
      out.push({
        key: 'agent',
        taskId: null,
        title: '🤖 Agent turns',
        ms: agentMs,
        blocks: blocks.filter((b) => b.kind === 'agent').map(spanOf),
        kind: 'agent',
      })
    }
    return out
  }, [blocks, totals, agentMs, showAgents, outside, outsideDropped, tasksOpen, appsOpen, labelFor])

  const showNow = nowMin !== null && nowMin >= axis.startMin && nowMin <= axis.endMin
  // Only the FRACTION crosses into CSS. The offset past the name column is done in
  // the stylesheet with that column's own width token, so the two can never disagree
  // — a px offset computed here against a hard-coded column width lands the now-line
  // an hour off the moment the narrow layout changes that width.
  const nowFrac = nowMin !== null && showNow
    ? (nowMin - axis.startMin) / Math.max(1, axis.endMin - axis.startMin)
    : 0

  if (rows.length === 0) {
    return <p className="wt-empty" data-testid="time-app-lanes-empty">Nothing tracked on this day.</p>
  }

  return (
    <div className="wt-tl" data-testid="time-app-lanes">
      <div className="wt-tl-axis">
        <span />
        <div className="wt-tl-hours">
          {axis.hours.map((h) => (
            <span key={h} style={{ left: `${hourPct(h, axis)}%` }}>{hourLabel(h)}</span>
          ))}
        </div>
      </div>

      <div className="wt-tl-rows">
        {rows.map((row) => (
          <div
            className={`wt-tl-row is-${row.kind}${row.child ? ' is-child' : ''}`}
            key={row.key}
            data-testid={`time-app-lanes-row-${row.kind}`}
          >
            <div className="wt-tl-name">
              <i
                className="wt-tl-dot"
                style={row.kind === 'task' && row.taskId !== null
                  ? { background: taskColor(row.taskId) }
                  : undefined}
              />
              {/* Full title, one line, real tooltip: the whole point of a left column. */}
              {row.expandable ? (
                <button
                  type="button"
                  className="wt-tl-nm wt-tl-expand"
                  data-testid={`time-app-lanes-expand-${row.kind}`}
                  aria-expanded={row.expandable.expanded}
                  title={row.expandable.expanded ? '收起' : `展开 ${row.expandable.count} 行`}
                  onClick={row.expandable.toggle}
                >
                  <span className="wt-tl-chev" aria-hidden="true">{row.expandable.expanded ? '▾' : '▸'}</span>
                  {row.title}
                </button>
              ) : (
                <span className="wt-tl-nm" title={row.title}>{row.title}</span>
              )}
              <span className="wt-tl-tt">{formatDuration(row.ms)}</span>
            </div>
            <div className="wt-tl-track">
              {axis.hours.slice(1).map((h) => (
                <i key={h} className="wt-tl-grid" style={{ left: `${hourPct(h, axis)}%` }} />
              ))}
              <Bars row={row} axis={axis} minuteOf={minuteOf} labelFor={labelFor} />
            </div>
          </div>
        ))}
        {nowMin !== null && showNow && (
          <div
            className="wt-tl-now"
            data-testid="time-app-lanes-now"
            style={{ '--wt-now-frac': nowFrac.toFixed(4) } as CSSProperties}
            title={clockLabel(nowMin)}
          />
        )}
      </div>
    </div>
  )
}

function Bars({ row, axis, minuteOf, labelFor }: {
  row: LaneRow
  axis: AxisRange
  minuteOf: (iso: string) => number
  labelFor: (taskId: string) => string
}) {
  const bars = useMemo(() => {
    const spans = row.blocks.map((b) => ({
      taskId: b.taskId,
      kind: b.kind,
      startMin: minuteOf(b.startTs),
      endMin: minuteOf(b.endTs),
      block: b,
    }))
    // The horizontal twin of the tape's proportionality problem: a 30s bar is drawn
    // 5px wide, and two of them a minute apart would overlap on screen. Merge what
    // would be drawn touching, at THIS view's scale.
    const pxPerMin = LANE_TRACK_PX / Math.max(1, axis.endMin - axis.startMin)
    const runs = planDrawMerge(spans, { pxPerMin, minPx: LANE_BAR_MIN_PX, gapPx: 1 })
    return runs.map((run) => {
      const first = spans[run[0]!]!
      let endMin = first.endMin
      let ms = 0
      for (const i of run) {
        const s = spans[i]!
        ms += s.block.trackedMs
        if (s.endMin > endMin) endMin = s.endMin
      }
      const geom = laneBar(first.startMin, endMin, axis, { tick: ms < TICK_BELOW_MS })
      return { key: `${first.taskId}-${first.startMin}`, geom, ms, taskId: first.taskId, startMin: first.startMin, endMin }
    })
  }, [row.blocks, axis, minuteOf])

  return (
    <>
      {bars.map((bar) => (
        <div
          key={bar.key}
          className={`wt-tl-bar${bar.geom.tick ? ' is-tick' : ''}`}
          data-testid="time-app-lanes-bar"
          data-time-task-id={bar.taskId}
          style={{
            left: `${bar.geom.leftPct}%`,
            width: `${bar.geom.widthPct}%`,
            ...(row.kind === 'task' ? { background: taskColor(bar.taskId) } : {}),
          }}
          title={`${barTitle(row, bar.taskId, labelFor)} · ${clockLabel(bar.startMin)}–${clockLabel(bar.endMin)} · ${formatDuration(bar.ms)}`}
        />
      ))}
    </>
  )
}

/** A bar's tooltip names the thing the bar IS: the task, the app, or — inside a
 *  merged row — the specific item the merged bar came from. */
function barTitle(row: LaneRow, spanId: string, labelFor: (taskId: string) => string): string {
  if (row.kind === 'task') return labelFor(spanId)
  return row.barLabel?.(spanId) ?? row.title
}

function hourPct(hour: number, axis: AxisRange): number {
  return ((hour * 60 - axis.startMin) / Math.max(1, axis.endMin - axis.startMin)) * 100
}
