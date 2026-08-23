/**
 * The timeline's lane: blocks placed on the hour axis, plus the two folds that
 * decide what a lane actually draws.
 *
 * Split out of TimeTimeline.tsx to keep both files readable. The view owns state,
 * fetching and the axis; this file owns "these records become these rectangles".
 */

import type React from 'react';
import type { TimeBlock } from '@/api/time';
import { layoutDayEvents } from '@/utils/calendar-date';
import {
  BLOCK_GAP_PX, LABEL_MIN_PX, LABEL_TWO_LINE_PX, MIN_BLOCK_PX, PX_PER_MIN, TICK_BELOW_MS,
  clockLabel, formatDuration, minuteOfDay, planDrawMerge, taskColor,
} from './time-timeline';

export const KIND_LABEL: Record<TimeBlock['kind'], string> = {
  session: 'Session',
  triage: 'Triage',
  chat: 'Chat',
  agent: 'Agent',
};

export interface Placed {
  key: string;
  block: TimeBlock;
  topPx: number;
  heightPx: number;
  lane: number;
  laneCount: number;
  tick: boolean;
  /** 0 = no room for text at all, 1 = one line, 2 = two. */
  labelLines: 0 | 1 | 2;
}

export function Lane({ testId, placed, emptyHint, pickedTaskId, hoverKey, titleFor, onHover, onPick }: {
  testId: string;
  placed: Placed[];
  /** Shown when the lane is open but has nothing on it — "empty" beats "broken". */
  emptyHint?: string;
  pickedTaskId: string | null;
  hoverKey: string | null;
  titleFor: (taskId: string) => string;
  onHover: (key: string | null) => void;
  onPick: (taskId: string | null) => void;
}) {
  return (
    <div className="tt-lane" data-testid={testId}>
      {placed.length === 0 && emptyHint && <p className="tt-lane-empty">{emptyHint}</p>}
      {placed.map((p) => {
        const agent = p.block.kind === 'agent';
        const dimmed = pickedTaskId !== null && pickedTaskId !== p.block.taskId;
        const width = 100 / p.laneCount;
        const title = titleFor(p.block.taskId);
        return (
          <button
            key={p.key}
            // NOT `data-task-id`: the time tracker bills any signal inside a
            // div[data-task-id] to that task, so a report block carrying it would
            // charge the task you merely LOOKED at here.
            data-time-task-id={p.block.taskId}
            data-time-kind={p.block.kind}
            className={[
              'tt-block',
              agent ? 'tt-block-agent' : 'tt-block-human',
              p.tick ? 'is-tick' : '',
              p.labelLines === 1 ? 'is-short' : '',
              dimmed ? 'is-dimmed' : '',
              hoverKey === p.key ? 'is-hover' : '',
            ].filter(Boolean).join(' ')}
            style={{
              top: p.topPx,
              height: p.heightPx,
              left: `calc(${p.lane * width}% + 2px)`,
              width: `calc(${width}% - 4px)`,
              ...(agent ? {} : { '--tt-block-color': taskColor(p.block.taskId) } as React.CSSProperties),
            }}
            title={`${title} — ${KIND_LABEL[p.block.kind]} · ${durationLabel(p.block)}`}
            onMouseEnter={() => onHover(p.key)}
            onMouseLeave={() => onHover(null)}
            onFocus={() => onHover(p.key)}
            onBlur={() => onHover(null)}
            onClick={() => onPick(pickedTaskId === p.block.taskId ? null : p.block.taskId)}
          >
            {/* Text is drawn ONLY when the box can hold it: an 8px sliver
                rendered a clipped "No ta…" over its own edges. One line = the
                title; two = title then duration, the way a calendar reads. */}
            {p.labelLines > 0 && <span className="tt-block-label">{title}</span>}
            {p.labelLines === 2 && <span className="tt-block-time">{formatDuration(p.block.ms)}</span>}
          </button>
        );
      })}
    </div>
  );
}

/** Blocks → pixel geometry, with overlaps packed side by side (never stacked). */
export function place(raw: TimeBlock[], prefix: string, axisStartMin: number, startMs: number, lengthMin: number): Placed[] {
  const toMin = (iso: string) => minuteOfDay(iso, startMs, lengthMin);
  // A visual second pass on top of the server's fold: same-task slivers whose
  // 8px minimum heights would collide become ONE readable rectangle. See
  // planDrawMerge for why the inflation makes this necessary.
  const blocks = planDrawMerge(raw.map((b) => ({
    taskId: b.taskId, kind: b.kind, startMin: toMin(b.startTs), endMin: toMin(b.endTs),
  }))).map((run) => foldRun(run.map((i) => raw[i]!)));

  const spans = blocks.map((b, i) => ({
    id: `${prefix}${i}`,
    startMin: toMin(b.startTs),
    endMin: toMin(b.endTs),
  }));
  // Reuses the calendar's lane packer, so an overlap opens a second column
  // instead of hiding one block behind another.
  const lanes = layoutDayEvents(spans);
  return blocks.map((block, i) => {
    const span = spans[i]!;
    const lane = lanes.get(span.id) ?? { lane: 0, laneCount: 1 };
    // A hairline of separation, so two adjacent slices read as two. Never at the
    // cost of the minimum: 30s of real work stays visible.
    const raw = (span.endMin - span.startMin) * PX_PER_MIN;
    const heightPx = Math.max(raw - BLOCK_GAP_PX, MIN_BLOCK_PX);
    return {
      key: span.id,
      block,
      topPx: (span.startMin - axisStartMin) * PX_PER_MIN,
      heightPx,
      lane: lane.lane,
      laneCount: Math.max(1, lane.laneCount),
      tick: block.ms < TICK_BELOW_MS,
      labelLines: heightPx >= LABEL_TWO_LINE_PX ? 2 : heightPx >= LABEL_MIN_PX ? 1 : 0,
    };
  });
}

/**
 * One run of draw-adjacent blocks → one block. `ms` stays the WALL span and
 * `trackedMs` the sum of what was recorded, the same two-number contract the
 * server publishes, so the tooltip and the totals keep agreeing.
 */
function foldRun(run: TimeBlock[]): TimeBlock {
  if (run.length === 1) return run[0]!;
  const first = run[0]!;
  let endTs = first.endTs;
  let trackedMs = 0;
  for (const b of run) {
    trackedMs += b.trackedMs;
    if (Date.parse(b.endTs) > Date.parse(endTs)) endTs = b.endTs;
  }
  return {
    taskId: first.taskId,
    kind: first.kind,
    startTs: first.startTs,
    endTs,
    ms: Math.max(Date.parse(endTs) - Date.parse(first.startTs), trackedMs),
    trackedMs,
  };
}

export function blockRangeLabel(p: Placed, startMs: number, lengthMin: number): string {
  const from = minuteOfDay(p.block.startTs, startMs, lengthMin);
  const to = minuteOfDay(p.block.endTs, startMs, lengthMin);
  return `${clockLabel(from)} – ${clockLabel(to)}`;
}

/**
 * The block's span, plus the recorded time when the two differ: a merged block
 * bridges gaps of up to five minutes, and a bare span would silently disagree
 * with the totals on the other tabs.
 */
export function durationLabel(block: TimeBlock): string {
  const span = formatDuration(block.ms);
  if (block.ms - block.trackedMs < 60_000) return span;
  return `${span} (${formatDuration(block.trackedMs)} tracked)`;
}
