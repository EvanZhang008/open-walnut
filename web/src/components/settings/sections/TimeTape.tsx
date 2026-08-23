import { useMemo, useState } from 'react';
import type { TimeBlock } from '@/api/time';
import {
  clockLabel, formatDuration, groupLegend, hourLabel, taskColor,
  type AxisRange, type LegendRow,
} from './time-timeline';
import { TAPE_HOUR_PX, TAPE_PX_PER_MIN, layoutTape } from './time-views';

/**
 * View A — the attention tape.
 *
 * ONE full-width ribbon, top to bottom, one colour at a time. The premise is the
 * whole reason this view exists: at any instant a person is doing exactly one
 * thing, so a chart that can show two things at once is drawing something that
 * never happened. Idle time is the grey base showing through, which makes "I wasn't
 * at the computer" readable without a label.
 *
 * Fragments are not hidden and not inflated — they are stripes. A minute of
 * switching looks like switching, an hour of one task looks like a slab, and that
 * texture is the honest answer to "where did my day go".
 *
 * The right column ranks the day by time. It is built from the server's per-task
 * TOTALS, not from the drawn segments, so a task whose whole day was 20-second
 * touches still appears — the ribbon and the ranking answer different questions and
 * must not be derived from each other.
 */

export function TimeTape({ slices, rows, axis, minuteOf, nowMin, labelFor }: {
  /** The serial ribbon, ascending. Non-overlapping by construction. */
  slices: TimeBlock[];
  /** Ranked per-task totals for the day (complete, including sub-floor work). */
  rows: LegendRow[];
  axis: AxisRange;
  minuteOf: (iso: string) => number;
  /** Minute-of-day for the now-line, or null when this isn't today. */
  nowMin: number | null;
  labelFor: (taskId: string) => string;
}) {
  const [hoverTaskId, setHoverTaskId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  const groups = useMemo(() => groupLegend(rows), [rows]);
  const height = (axis.endMin - axis.startMin) * TAPE_PX_PER_MIN;

  return (
    <div className="tp" data-testid="time-tape">
      <div className="tp-gutter" style={{ height }}>
        {axis.hours.map((h) => (
          <span
            key={h}
            className="tp-hour"
            style={{ top: (h * 60 - axis.startMin) * TAPE_PX_PER_MIN }}
          >
            {hourLabel(h)}
          </span>
        ))}
      </div>

      <Ribbon
        slices={slices}
        axis={axis}
        minuteOf={minuteOf}
        nowMin={nowMin}
        labelFor={labelFor}
        hoverTaskId={hoverTaskId}
        onHover={setHoverTaskId}
      />

      <div className="tp-rank" data-testid="time-tape-rank">
        <h4>Where it went</h4>
        {groups.main.map((row) => (
          <RankRow key={row.taskId} row={row} hoverTaskId={hoverTaskId} onHover={setHoverTaskId} />
        ))}
        {groups.hidden.length > 0 && !expanded && (
          <button className="tp-more" data-testid="time-tape-more" onClick={() => setExpanded(true)}>
            +{groups.hidden.length} more · {formatDuration(groups.hiddenMs)}
          </button>
        )}
        {expanded && groups.hidden.map((row) => (
          <RankRow key={row.taskId} row={row} hoverTaskId={hoverTaskId} onHover={setHoverTaskId} />
        ))}
        {expanded && (
          <button className="tp-more" onClick={() => setExpanded(false)}>Show fewer</button>
        )}
        {groups.quick.length > 0 && (
          <div className="tp-rrow is-quick" data-testid="time-tape-quick">
            <i className="tp-dot tp-dot-quick" />
            <span className="tp-rname">Quick touches · {groups.quick.length} tasks</span>
            <span className="tp-rtime">{formatDuration(groups.quickMs)}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function RankRow({ row, hoverTaskId, onHover }: {
  row: LegendRow;
  hoverTaskId: string | null;
  onHover: (taskId: string | null) => void;
}) {
  return (
    <div
      className={`tp-rrow${hoverTaskId === row.taskId ? ' is-lit' : ''}`}
      data-testid="time-tape-rrow"
      data-time-task-id={row.taskId}
      onMouseEnter={() => onHover(row.taskId)}
      onMouseLeave={() => onHover(null)}
    >
      <i className="tp-dot" style={{ background: taskColor(row.taskId) }} />
      {/* Full title in the tooltip: one line is the layout, not the content. */}
      <span className="tp-rname" title={row.title}>{row.title}</span>
      <span className="tp-rtime">{formatDuration(row.ms)}</span>
    </div>
  );
}

/**
 * The ribbon itself, reused at two scales: the day (Tape) and one expanded chapter.
 *
 * Segments are absolutely positioned on the axis and strictly proportional, so the
 * grey base showing between them IS the idle time — nothing has to be drawn to
 * represent "away", which is why a whole day fits without a legend for absence.
 */
export function Ribbon({ slices, axis, minuteOf, nowMin, labelFor, hoverTaskId, onHover, pxPerMin, testId }: {
  slices: TimeBlock[];
  axis: AxisRange;
  minuteOf: (iso: string) => number;
  nowMin: number | null;
  labelFor: (taskId: string) => string;
  hoverTaskId: string | null;
  onHover: (taskId: string | null) => void;
  pxPerMin?: number;
  testId?: string;
}) {
  const scale = pxPerMin ?? TAPE_PX_PER_MIN;
  const segments = useMemo(
    () => layoutTape(slices, axis.startMin, minuteOf, scale),
    [slices, axis.startMin, minuteOf, scale],
  );
  const height = (axis.endMin - axis.startMin) * scale;
  const showNow = nowMin !== null && nowMin >= axis.startMin && nowMin <= axis.endMin;
  return (
    <div
      className="tp-ribbon"
      data-testid={testId ?? 'time-tape-ribbon'}
      style={{ height, '--tp-hour-px': `${60 * scale}px` } as React.CSSProperties}
    >
      {/* Hour rules sit UNDER the segments: a ribbon is a solid object, and a line
          drawn over it would read as a cut in the work. */}
      {axis.hours.slice(1).map((h) => (
        <i key={h} className="tp-rule" style={{ top: (h * 60 - axis.startMin) * scale }} />
      ))}

      {segments.map((seg, i) => {
        const { taskId } = seg.slice;
        const dim = hoverTaskId !== null && hoverTaskId !== taskId;
        const title = labelFor(taskId);
        const from = clockLabel(minuteOf(seg.slice.startTs));
        const to = clockLabel(minuteOf(seg.slice.endTs));
        return (
          <div
            key={`${seg.slice.startTs}-${i}`}
            className={[
              'tp-seg',
              seg.hairline ? 'is-joined' : '',
              dim ? 'is-dim' : '',
              hoverTaskId === taskId ? 'is-lit' : '',
            ].filter(Boolean).join(' ')}
            data-time-task-id={taskId}
            data-testid="time-tape-seg"
            style={{ top: seg.topPx, height: seg.heightPx, background: taskColor(taskId) }}
            title={`${title} · ${from}–${to} · ${formatDuration(seg.slice.trackedMs)}`}
            onMouseEnter={() => onHover(taskId)}
            onMouseLeave={() => onHover(null)}
          >
            {seg.label > 0 && <span className="tp-seg-title">{title}</span>}
            {seg.label === 2 && <small>{from}–{to} · {formatDuration(seg.slice.ms)}</small>}
            {seg.label === 1 && <small>{formatDuration(seg.slice.ms)}</small>}
          </div>
        );
      })}

      {showNow && (
        <div className="tp-now" data-testid="time-tape-now" style={{ top: (nowMin! - axis.startMin) * scale }}>
          <i />
          <span>{clockLabel(nowMin!)}</span>
        </div>
      )}
    </div>
  );
}
