import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchTimeBlocks, type DayBlocks, type TimeBlock } from '@/api/time';
import { layoutDayEvents } from '@/utils/calendar-date';
import { visibleInterval } from '@/utils/page-visibility';
import { log } from '@/utils/log';
import {
  HOUR_MIN, HOUR_PX, PX_PER_MIN, TICK_BELOW_MS,
  axisRange, clockLabel, dayLabel, dayLengthMin, dayStartMs, formatDuration, hourLabel,
  minuteOfDay, shiftDate, taskColor,
} from './time-timeline';
import '@/styles/time-timeline.css';

/**
 * Timeline — "how did my day actually go?" as blocks on an hour axis.
 *
 * THE HUMAN LANE AND THE AGENT LANE ARE PHYSICALLY SEPARATE COLUMNS, never one
 * merged track: the same rule the two tabs above encode, because a user read an
 * agent's 8h57m as their own working day and reported the data as broken. Agents
 * are also OFF by default, purple (a hue no task color uses), and hatched, so the
 * two can't be confused even in a grayscale screenshot.
 *
 * The axis shows only the hours that carry time, padded by an hour — a full 24
 * rows answers the question with a scroll bar. Geometry and colors are pure
 * (time-timeline.ts) so the axis rules are unit tested.
 */

/** Remembers the agents toggle. `open-walnut-` prefix ⇒ synced by ui-prefs. */
const LS_AGENTS_KEY = 'open-walnut-time-timeline-agents';
/** Tallest the scroller gets before it scrolls instead of growing the page. */
const MAX_GRID_PX = 560;
/** A block shorter than this many px still gets a visible tick. */
const TICK_PX = 3;
/** Below this height a block cannot hold a legible label. */
const LABEL_MIN_PX = 22;

const KIND_LABEL: Record<TimeBlock['kind'], string> = {
  session: 'Session',
  triage: 'Triage',
  chat: 'Chat',
  agent: 'Agent',
};

interface Placed {
  key: string;
  block: TimeBlock;
  topPx: number;
  heightPx: number;
  lane: number;
  laneCount: number;
  tick: boolean;
}

function readAgentsPref(): boolean {
  try {
    return localStorage.getItem(LS_AGENTS_KEY) === '1';
  } catch {
    return false;
  }
}

export function TimeTimeline({ dates, today, titleFor }: {
  /** The days the section already fetched, ascending. Bounds the day nav. */
  dates: string[];
  today: string;
  titleFor: (taskId: string) => string;
}) {
  const [date, setDate] = useState(today);
  const [data, setData] = useState<DayBlocks | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAgents, setShowAgents] = useState(readAgentsPref);
  const [pickedTaskId, setPickedTaskId] = useState<string | null>(null);
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const landedFor = useRef<string>('');

  // The section owns the window; a day it never fetched has no summary to agree
  // with, so the arrows stop there rather than showing an unexplained empty day.
  const oldest = dates[0] ?? today;
  const newest = dates[dates.length - 1] ?? today;
  useEffect(() => {
    if (dates.length > 0 && (date < oldest || date > newest)) setDate(today);
  }, [dates.length, date, oldest, newest, today]);

  useEffect(() => {
    let live = true;
    setLoading(true);
    // Every kind in one round trip: the agents toggle is then instant, and a
    // refetch per toggle would make an answer the user already has flicker.
    fetchTimeBlocks(date)
      .then((res) => { if (live) { setData(res); setError(null); } })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        log.warn('time-timeline', 'blocks fetch failed', { date, error: message });
        if (live) setError(message);
      })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [date]);

  const toggleAgents = useCallback(() => {
    setShowAgents((prev) => {
      const next = !prev;
      try { localStorage.setItem(LS_AGENTS_KEY, next ? '1' : '0'); } catch { /* private mode */ }
      return next;
    });
  }, []);

  const startMs = useMemo(() => dayStartMs(date), [date]);
  const lengthMin = useMemo(() => dayLengthMin(date), [date]);

  // Now-line, re-anchored every 60s. Hidden tabs skip the tick; the catch-up on
  // return recomputes from the clock, so it is never stale.
  const [nowMin, setNowMin] = useState(() => currentMinuteOfDay());
  useEffect(() => visibleInterval(() => setNowMin(currentMinuteOfDay()), 60_000), []);
  const isToday = date === today;

  /**
   * The answer for the day being SHOWN. A day switch keeps the previous answer in
   * state until the new one lands, and rendering yesterday's blocks against
   * today's midnight clamped them all to the top edge of the axis — a visible
   * flash of wrong data. Anything but an exact date match is treated as pending.
   */
  const dayData = data && data.date === date ? data : null;
  /** Nothing to draw YET (first load, or a day switch still in flight). */
  const pending = dayData === null;

  /** Server-joined title first: the tasks list the section holds may not carry a
   *  completed or archived task that still owns time on this day. */
  const labelFor = useCallback(
    (taskId: string): string => dayData?.titles[taskId] || titleFor(taskId),
    [dayData, titleFor],
  );

  const { human, agent, axis } = useMemo(() => {
    const blocks = dayData?.blocks ?? [];
    const toSpan = (b: TimeBlock) => ({
      startMin: minuteOfDay(b.startTs, startMs, lengthMin),
      endMin: minuteOfDay(b.endTs, startMs, lengthMin),
    });
    const humanRaw = blocks.filter((b) => b.kind !== 'agent');
    const agentRaw = showAgents ? blocks.filter((b) => b.kind === 'agent') : [];
    const spans = [...humanRaw, ...agentRaw].map(toSpan);
    const range = axisRange(spans, { lengthMin, ...(isToday ? { nowMin } : {}) });
    return {
      human: place(humanRaw, 'h', range.startMin, startMs, lengthMin),
      agent: place(agentRaw, 'a', range.startMin, startMs, lengthMin),
      axis: range,
    };
  }, [dayData, showAgents, startMs, lengthMin, isToday, nowMin]);

  const legend = useMemo(() => {
    const rows = new Map<string, { taskId: string; title: string; ms: number }>();
    for (const p of human) {
      const row = rows.get(p.block.taskId);
      if (row) row.ms += p.block.trackedMs;
      else rows.set(p.block.taskId, { taskId: p.block.taskId, title: labelFor(p.block.taskId), ms: p.block.trackedMs });
    }
    return [...rows.values()].sort((a, b) => b.ms - a.ms || a.title.localeCompare(b.title));
  }, [human, labelFor]);

  const humanMs = human.reduce((sum, p) => sum + p.block.trackedMs, 0);
  const agentMs = agent.reduce((sum, p) => sum + p.block.trackedMs, 0);
  const axisHeight = (axis.endMin - axis.startMin) * PX_PER_MIN;

  // Land the initial scroll on the day's work (or on now, for today) — never at
  // the top of an axis whose first block is below the fold.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || pending || landedFor.current === date) return;
    const firstTop = human[0]?.topPx ?? agent[0]?.topPx;
    const target = isToday && nowMin >= axis.startMin
      ? (nowMin - axis.startMin) * PX_PER_MIN - el.clientHeight / 3
      : (firstTop ?? 0) - HOUR_PX / 2;
    el.scrollTop = Math.max(0, target);
    landedFor.current = date;
  }, [date, pending, human, agent, isToday, nowMin, axis.startMin]);

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.target !== e.currentTarget) return; // never steal a key from a control
    if (e.key === 'ArrowLeft' && date > oldest) { e.preventDefault(); setDate(shiftDate(date, -1)); }
    if (e.key === 'ArrowRight' && date < newest) { e.preventDefault(); setDate(shiftDate(date, 1)); }
  }, [date, oldest, newest]);

  const shown = [...human, ...agent];
  const detail = shown.find((p) => p.key === hoverKey)
    ?? (pickedTaskId !== null ? shown.find((p) => p.block.taskId === pickedTaskId) : undefined);
  const nothingDrawn = !pending && shown.length === 0;

  return (
    <div
      className="tt"
      data-testid="time-view-timeline"
      tabIndex={0}
      role="group"
      aria-label="Tracked time by hour"
      onKeyDown={onKeyDown}
    >
      <div className="tt-nav">
        <button
          className="tt-nav-btn"
          data-testid="time-timeline-prev"
          aria-label="Previous day"
          disabled={date <= oldest}
          onClick={() => setDate(shiftDate(date, -1))}
        >
          ‹
        </button>
        <span className="tt-nav-date" data-testid="time-timeline-date">
          {dayLabel(date)}
          {isToday && <em className="tt-nav-today">today</em>}
        </span>
        <button
          className="tt-nav-btn"
          data-testid="time-timeline-next"
          aria-label="Next day"
          disabled={date >= newest}
          onClick={() => setDate(shiftDate(date, 1))}
        >
          ›
        </button>
        <button
          className="tt-nav-reset"
          data-testid="time-timeline-today"
          disabled={isToday}
          onClick={() => setDate(today)}
        >
          Today
        </button>
        <label className="tt-agents-toggle">
          <input
            type="checkbox"
            data-testid="time-timeline-agents-toggle"
            checked={showAgents}
            onChange={toggleAgents}
          />
          <span>Include agents</span>
        </label>
      </div>

      {!pending && !nothingDrawn && (
        <div className="tt-totals">
          <span className="tt-total tt-total-human" data-testid="time-timeline-human-total">
            <i className="tt-swatch tt-swatch-human" /> You {formatDuration(humanMs)}
          </span>
          {showAgents && (
            <span className="tt-total tt-total-agent" data-testid="time-timeline-agent-total">
              <i className="tt-swatch tt-swatch-agent" /> Agents {formatDuration(agentMs)}
            </span>
          )}
          {dayData.unplacedMs > 0 && (
            <span className="tt-unplaced" data-testid="time-timeline-unplaced">
              {formatDuration(dayData.unplacedMs)} counted in the totals but too short or too folded to place here
            </span>
          )}
        </div>
      )}

      {error && <div className="time-degraded">Error: {error}</div>}
      {dayData?.degraded && <div className="time-degraded">Showing a partial day: the read gave up before it finished.</div>}

      {pending && !error && <p className="time-empty">Loading…</p>}

      {nothingDrawn
        ? (
          <p className="time-empty" data-testid="time-timeline-empty">
            {(dayData?.unplacedMs ?? 0) > 0
              ? 'This day has tracked time, but it was folded into daily totals — the per-block detail is no longer on disk. The other two tabs still have its numbers.'
              : `Nothing tracked on ${dayLabel(date)}. Time starts counting the moment you work in a session, triage a task, or chat here.`}
          </p>
        )
        : !pending && (
          <div className="tt-body">
            {/* The heads and the scroller are ONE grid child: three children in a
                two-column grid wrapped the legend under a 230px-wide plot. */}
            <div className="tt-plot">
              <div className="tt-lane-heads" data-agents={showAgents ? 'on' : 'off'}>
                <span className="tt-gutter" />
                <span className="tt-lane-head">You</span>
                {showAgents && <span className="tt-lane-head tt-lane-head-agent">Agents</span>}
              </div>

              <div className="tt-grid" ref={scrollRef} style={{ maxHeight: MAX_GRID_PX }}>
                <div className="tt-canvas" style={{ height: axisHeight }}>
                  <div className="tt-ruler">
                    {axis.hours.map((h) => (
                      <div className="tt-hour" key={h} style={{ height: HOUR_PX }}>
                        <span className="tt-hour-label">{hourLabel(h)}</span>
                      </div>
                    ))}
                  </div>
                  <div className="tt-lanes" data-agents={showAgents ? 'on' : 'off'}>
                    <Lane
                      testId="time-timeline-lane-human"
                      placed={human}
                      pickedTaskId={pickedTaskId}
                      hoverKey={hoverKey}
                      titleFor={labelFor}
                      onHover={setHoverKey}
                      onPick={setPickedTaskId}
                    />
                    {showAgents && (
                      <Lane
                        testId="time-timeline-lane-agent"
                        placed={agent}
                        pickedTaskId={pickedTaskId}
                        hoverKey={hoverKey}
                        titleFor={labelFor}
                        onHover={setHoverKey}
                        onPick={setPickedTaskId}
                      />
                    )}
                    {isToday && nowMin >= axis.startMin && nowMin <= axis.endMin && (
                      <div
                        className="tt-now"
                        data-testid="time-timeline-now"
                        style={{ top: (nowMin - axis.startMin) * PX_PER_MIN }}
                      >
                        <span className="tt-now-dot" />
                        <span className="tt-now-label">{clockLabel(nowMin)}</span>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>

            <aside className="tt-legend" data-testid="time-timeline-legend">
              {legend.map((row) => (
                <button
                  key={row.taskId || '__none__'}
                  className={`tt-legend-row${pickedTaskId === row.taskId ? ' is-picked' : ''}`}
                  data-time-task-id={row.taskId}
                  title={row.title}
                  onClick={() => setPickedTaskId((prev) => (prev === row.taskId ? null : row.taskId))}
                >
                  <i className="tt-swatch" style={{ background: taskColor(row.taskId) }} />
                  <span className="tt-legend-name">{row.title}</span>
                  <span className="tt-legend-ms">{formatDuration(row.ms)}</span>
                </button>
              ))}
              {showAgents && agentMs > 0 && (
                <div className="tt-legend-row tt-legend-static">
                  <i className="tt-swatch tt-swatch-agent" />
                  <span className="tt-legend-name">Agent turns</span>
                  <span className="tt-legend-ms">{formatDuration(agentMs)}</span>
                </div>
              )}
            </aside>
          </div>
        )}

      {!pending && !nothingDrawn && (
      <div className="tt-detail" data-testid="time-timeline-detail">
        {detail
          ? (
            <>
              <i className="tt-swatch" style={{ background: detail.block.kind === 'agent' ? 'var(--time-agent)' : taskColor(detail.block.taskId) }} />
              <strong className="tt-detail-title">{labelFor(detail.block.taskId)}</strong>
              <span className="tt-detail-meta">{blockRangeLabel(detail, startMs, lengthMin)}</span>
              <span className="tt-detail-meta">{durationLabel(detail.block)}</span>
              <span className="tt-detail-kind">{KIND_LABEL[detail.block.kind]}</span>
            </>
          )
          : <span className="tt-detail-hint">Hover a block for its task, hours and duration. Click one to highlight that task.</span>}
      </div>
      )}
    </div>
  );
}

function Lane({ testId, placed, pickedTaskId, hoverKey, titleFor, onHover, onPick }: {
  testId: string;
  placed: Placed[];
  pickedTaskId: string | null;
  hoverKey: string | null;
  titleFor: (taskId: string) => string;
  onHover: (key: string | null) => void;
  onPick: (taskId: string | null) => void;
}) {
  return (
    <div className="tt-lane" data-testid={testId}>
      {placed.map((p) => {
        const agent = p.block.kind === 'agent';
        const dimmed = pickedTaskId !== null && pickedTaskId !== p.block.taskId;
        const width = 100 / p.laneCount;
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
              dimmed ? 'is-dimmed' : '',
              hoverKey === p.key ? 'is-hover' : '',
            ].filter(Boolean).join(' ')}
            style={{
              top: p.topPx,
              height: p.heightPx,
              left: `calc(${p.lane * width}% + 1px)`,
              width: `calc(${width}% - 2px)`,
              ...(agent ? {} : { '--tt-block-color': taskColor(p.block.taskId) } as React.CSSProperties),
            }}
            title={`${titleFor(p.block.taskId)} — ${KIND_LABEL[p.block.kind]} · ${durationLabel(p.block)}`}
            onMouseEnter={() => onHover(p.key)}
            onMouseLeave={() => onHover(null)}
            onFocus={() => onHover(p.key)}
            onBlur={() => onHover(null)}
            onClick={() => onPick(pickedTaskId === p.block.taskId ? null : p.block.taskId)}
          >
            {p.heightPx >= LABEL_MIN_PX && (
              <span className="tt-block-label">{titleFor(p.block.taskId)}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** Blocks → pixel geometry, with overlaps packed side by side (never stacked). */
function place(blocks: TimeBlock[], prefix: string, axisStartMin: number, startMs: number, lengthMin: number): Placed[] {
  const spans = blocks.map((b, i) => ({
    id: `${prefix}${i}`,
    startMin: minuteOfDay(b.startTs, startMs, lengthMin),
    endMin: minuteOfDay(b.endTs, startMs, lengthMin),
  }));
  // Reuses the calendar's lane packer, so an overlap opens a second column
  // instead of hiding one block behind another.
  const lanes = layoutDayEvents(spans);
  return blocks.map((block, i) => {
    const span = spans[i]!;
    const lane = lanes.get(span.id) ?? { lane: 0, laneCount: 1 };
    const tick = block.ms < TICK_BELOW_MS;
    return {
      key: span.id,
      block,
      topPx: (span.startMin - axisStartMin) * PX_PER_MIN,
      // Never zero-height: a few minutes of real work must stay visible, and a
      // tick is styled differently so short work reads as short, not as noise.
      heightPx: Math.max((span.endMin - span.startMin) * PX_PER_MIN, TICK_PX),
      lane: lane.lane,
      laneCount: Math.max(1, lane.laneCount),
      tick,
    };
  });
}

function currentMinuteOfDay(): number {
  const now = new Date();
  return now.getHours() * HOUR_MIN + now.getMinutes();
}

function blockRangeLabel(p: Placed, startMs: number, lengthMin: number): string {
  const from = minuteOfDay(p.block.startTs, startMs, lengthMin);
  const to = minuteOfDay(p.block.endTs, startMs, lengthMin);
  return `${clockLabel(from)} – ${clockLabel(to)}`;
}

/**
 * The block's span, plus the recorded time when the two differ: a merged block
 * bridges gaps of up to five minutes, and a bare span would silently disagree
 * with the totals on the other tabs.
 */
function durationLabel(block: TimeBlock): string {
  const span = formatDuration(block.ms);
  if (block.ms - block.trackedMs < 60_000) return span;
  return `${span} (${formatDuration(block.trackedMs)} tracked)`;
}
