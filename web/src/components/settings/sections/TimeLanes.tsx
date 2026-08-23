import { useMemo } from 'react';
import type { TimeBlock } from '@/api/time';
import {
  TICK_BELOW_MS, clockLabel, formatDuration, hourLabel, planDrawMerge, taskColor,
  type AxisRange,
} from './time-timeline';
import { LANE_BAR_MIN_PX, LANE_NAME_PX, LANE_ROWS, LANE_TRACK_PX, laneBar } from './time-views';

/**
 * View C — task swimlanes.
 *
 * Turned sideways: one ROW per task, time along X. This is the view that answers
 * "when was this task touched, and how many times did I get pulled off it" — a
 * question the vertical views can only answer by scanning colours.
 *
 * Two structural rules make it stay readable at real density:
 *
 * 1. The title lives in a fixed left column, in full. No bar ever carries text, so
 *    a 40-second touch and a 40-minute stretch are both legible and nothing has to
 *    be truncated to fit inside a rectangle.
 * 2. Rows are capped. The top LANE_ROWS tasks get their own row and EVERYTHING else
 *    is aggregated into one grey row, because twenty rows of one bar each is the
 *    same confetti problem in a different orientation.
 *
 * Agents are a separate bottom row, hatched purple, and appear only when the
 * toggle is on. That toggle deliberately affects THIS VIEW ONLY: the tape and the
 * chapters are about a human's attention, and mixing an 8-hour agent run into a
 * 3-hour human day is exactly the misreading this feature area was burned by.
 */

interface LaneRow {
  key: string;
  taskId: string | null;
  title: string;
  ms: number;
  blocks: TimeBlock[];
  kind: 'task' | 'others' | 'agent';
}

export function TimeLanes({ blocks, totals, agentMs, showAgents, axis, minuteOf, nowMin, labelFor }: {
  /** Per-task MERGED blocks (not the serial ribbon): rows want runs of work. */
  blocks: TimeBlock[];
  /** Ranked per-task human totals for the day, descending. */
  totals: ReadonlyArray<{ taskId: string; ms: number }>;
  agentMs: number;
  showAgents: boolean;
  axis: AxisRange;
  minuteOf: (iso: string) => number;
  nowMin: number | null;
  labelFor: (taskId: string) => string;
}) {
  const rows = useMemo<LaneRow[]>(() => {
    const human = blocks.filter((b) => b.kind !== 'agent');
    const top = totals.slice(0, LANE_ROWS);
    const topIds = new Set(top.map((t) => t.taskId));
    const out: LaneRow[] = top.map((t) => ({
      key: `t-${t.taskId}`,
      taskId: t.taskId,
      title: labelFor(t.taskId),
      ms: t.ms,
      blocks: human.filter((b) => b.taskId === t.taskId),
      kind: 'task',
    }));

    const restTotals = totals.slice(LANE_ROWS);
    if (restTotals.length > 0) {
      out.push({
        key: 'others',
        taskId: null,
        title: `其他 ${restTotals.length} 个任务(快碰合并)`,
        ms: restTotals.reduce((sum, t) => sum + t.ms, 0),
        blocks: human.filter((b) => !topIds.has(b.taskId)),
        kind: 'others',
      });
    }

    if (showAgents) {
      out.push({
        key: 'agent',
        taskId: null,
        title: '🤖 Agent turns',
        ms: agentMs,
        blocks: blocks.filter((b) => b.kind === 'agent'),
        kind: 'agent',
      });
    }
    return out;
  }, [blocks, totals, agentMs, showAgents, labelFor]);

  const showNow = nowMin !== null && nowMin >= axis.startMin && nowMin <= axis.endMin;
  // Offset past the fixed name column: the rows grid spans it, so a bare percentage
  // would put the now-line an hour or more to the left of the real time.
  const nowFrac = showNow ? (nowMin! - axis.startMin) / Math.max(1, axis.endMin - axis.startMin) : 0;
  const nowLeft = `calc(${LANE_NAME_PX}px + (100% - ${LANE_NAME_PX}px) * ${nowFrac.toFixed(4)})`;

  if (rows.length === 0) {
    return <p className="time-empty" data-testid="time-lanes-empty">Nothing tracked on this day.</p>;
  }

  return (
    <div className="tl" data-testid="time-lanes">
      <div className="tl-axis">
        <span />
        <div className="tl-hours">
          {axis.hours.map((h) => (
            <span key={h} style={{ left: `${hourPct(h, axis)}%` }}>{hourLabel(h)}</span>
          ))}
        </div>
      </div>

      <div className="tl-rows">
        {rows.map((row) => (
          <div className={`tl-row is-${row.kind}`} key={row.key} data-testid={`time-lanes-row-${row.kind}`}>
            <div className="tl-name">
              <i
                className="tl-dot"
                style={row.kind === 'task'
                  ? { background: taskColor(row.taskId!) }
                  : undefined}
              />
              {/* Full title, one line, real tooltip: the whole point of a left column. */}
              <span className="tl-nm" title={row.title}>{row.title}</span>
              <span className="tl-tt">{formatDuration(row.ms)}</span>
            </div>
            <div className="tl-track">
              {axis.hours.slice(1).map((h) => (
                <i key={h} className="tl-grid" style={{ left: `${hourPct(h, axis)}%` }} />
              ))}
              <Bars row={row} axis={axis} minuteOf={minuteOf} labelFor={labelFor} />
            </div>
          </div>
        ))}
        {showNow && (
          <div className="tl-now" data-testid="time-lanes-now" style={{ left: nowLeft }} title={clockLabel(nowMin!)} />
        )}
      </div>
    </div>
  );
}

function Bars({ row, axis, minuteOf, labelFor }: {
  row: LaneRow;
  axis: AxisRange;
  minuteOf: (iso: string) => number;
  labelFor: (taskId: string) => string;
}) {
  const bars = useMemo(() => {
    const spans = row.blocks.map((b) => ({
      taskId: b.taskId,
      kind: b.kind,
      startMin: minuteOf(b.startTs),
      endMin: minuteOf(b.endTs),
      block: b,
    }));
    // The horizontal twin of the tape's proportionality problem: a 30s bar is drawn
    // 5px wide, and two of them a minute apart would overlap on screen. Merge what
    // would be drawn touching, at THIS view's scale.
    const pxPerMin = LANE_TRACK_PX / Math.max(1, axis.endMin - axis.startMin);
    const runs = planDrawMerge(spans, { pxPerMin, minPx: LANE_BAR_MIN_PX, gapPx: 1 });
    return runs.map((run) => {
      const first = spans[run[0]!]!;
      let endMin = first.endMin;
      let ms = 0;
      for (const i of run) {
        const s = spans[i]!;
        ms += s.block.trackedMs;
        if (s.endMin > endMin) endMin = s.endMin;
      }
      const geom = laneBar(first.startMin, endMin, axis, { tick: ms < TICK_BELOW_MS });
      return { key: `${first.taskId}-${first.startMin}`, geom, ms, taskId: first.taskId, startMin: first.startMin, endMin };
    });
  }, [row.blocks, axis, minuteOf]);

  return (
    <>
      {bars.map((bar) => (
        <div
          key={bar.key}
          className={`tl-bar${bar.geom.tick ? ' is-tick' : ''}`}
          data-testid="time-lanes-bar"
          data-time-task-id={bar.taskId}
          style={{
            left: `${bar.geom.leftPct}%`,
            width: `${bar.geom.widthPct}%`,
            ...(row.kind === 'task' ? { background: taskColor(bar.taskId) } : {}),
          }}
          title={`${row.kind === 'task' ? labelFor(bar.taskId) : row.title} · ${clockLabel(bar.startMin)}–${clockLabel(bar.endMin)} · ${formatDuration(bar.ms)}`}
        />
      ))}
    </>
  );
}

function hourPct(hour: number, axis: AxisRange): number {
  return ((hour * 60 - axis.startMin) / Math.max(1, axis.endMin - axis.startMin)) * 100;
}
