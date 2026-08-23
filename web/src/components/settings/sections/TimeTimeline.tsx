import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchTimeBlocks, type DayBlocks, type TimeBlock } from '@/api/time';
import { layoutDayEvents } from '@/utils/calendar-date';
import { visibleInterval } from '@/utils/page-visibility';
import { log } from '@/utils/log';
import {
  HOUR_MIN, HOUR_PX, NOTE_FLOOR_MS, PX_PER_MIN,
  axisRange, clockLabel, dayLabel, dayLengthMin, dayStartMs, formatDuration, hourLabel,
  minuteOfDay, shiftDate, taskColor, type LegendRow,
} from './time-timeline';
import {
  KIND_LABEL, Lane, blockRangeLabel, durationLabel, place, type Placed,
} from './TimeTimelineLane';
import { TimeTimelineLegend } from './TimeTimelineLegend';
import '@/styles/time-timeline.css';

/**
 * Timeline — "how did my day actually go?" as blocks on an hour axis, built to
 * read like a calendar day view: quiet hour rules, blocks separated by a hairline,
 * in-block text only when it fits, a crisp now-line, one detail strip.
 *
 * THE HUMAN LANE AND THE AGENT LANE ARE PHYSICALLY SEPARATE COLUMNS, never one
 * merged track: the same rule the two tabs above encode, because a user read an
 * agent's 8h57m as their own working day and reported the data as broken. Agents
 * are also OFF by default, purple (a hue no task colour uses), and hatched, so the
 * two can't be confused even in a grayscale screenshot.
 *
 * DENSITY IS THE DESIGN PROBLEM (a real day: 75 minutes across 21 tasks). Three
 * rules come from that render: visual weight tracks time spent (sub-5-minute work
 * draws as a muted tick, never a full-saturation rectangle competing with an
 * hour-long block); no text is drawn that cannot fit its box; and the legend ranks
 * rather than dumps. Geometry and grouping are pure (time-timeline.ts).
 */

/** Remembers the agents toggle. `open-walnut-` prefix ⇒ synced by ui-prefs. */
const LS_AGENTS_KEY = 'open-walnut-time-timeline-agents';
/** Tallest the scroller gets before it scrolls instead of compressing hours. */
const MAX_GRID_PX = 620;



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

  const legendRows = useMemo(() => {
    const rows = new Map<string, LegendRow>();
    for (const p of human) {
      const row = rows.get(p.block.taskId);
      if (row) row.ms += p.block.trackedMs;
      else rows.set(p.block.taskId, { taskId: p.block.taskId, title: labelFor(p.block.taskId), ms: p.block.trackedMs });
    }
    return [...rows.values()];
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
  const drawn = !pending && !nothingDrawn;

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

      {drawn && (
        <div className="tt-totals">
          <span className="tt-total tt-total-human" data-testid="time-timeline-human-total">
            <i className="tt-swatch tt-swatch-human" /> You {formatDuration(humanMs)}
          </span>
          {showAgents && (
            <span className="tt-total tt-total-agent" data-testid="time-timeline-agent-total">
              <i className="tt-swatch tt-swatch-agent" /> Agents {formatDuration(agentMs)}
            </span>
          )}
          <NotDrawnNote day={dayData} />
        </div>
      )}

      {error && <div className="time-degraded">Error: {error}</div>}
      {dayData?.degraded && <div className="time-degraded">Showing a partial day: the read gave up before it finished.</div>}

      {pending && !error && <p className="time-empty">Loading…</p>}

      {nothingDrawn && (
        <p className="time-empty" data-testid="time-timeline-empty">
          {(dayData?.foldedMs ?? 0) > 0
            ? `${formatDuration(dayData!.foldedMs)} was tracked on ${dayLabel(date)}, but this day has been folded into daily totals — the hour-by-hour detail is no longer on disk. The other two tabs still have its numbers.`
            : `Nothing tracked on ${dayLabel(date)}. Time starts counting the moment you work in a session, triage a task, or chat here.`}
        </p>
      )}

      {drawn && (
        <div className="tt-body">
          {/* The plot and its lane titles are ONE flex child: three children in a
              two-column grid wrapped the legend under a 230px-wide plot. */}
          <div className="tt-plot" data-testid="time-timeline-plot">
            <div className="tt-lane-heads" data-agents={showAgents ? 'on' : 'off'}>
              <span className="tt-gutter" />
              <span className="tt-lane-head">You</span>
              {showAgents && <span className="tt-lane-head tt-lane-head-agent">Agents</span>}
            </div>

            <div className="tt-grid" ref={scrollRef} style={{ maxHeight: MAX_GRID_PX }}>
              <div
                className="tt-canvas"
                style={{ height: axisHeight, '--tt-hour-px': `${HOUR_PX}px` } as React.CSSProperties}
              >
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
                      emptyHint="no agent runtime today"
                      pickedTaskId={pickedTaskId}
                      hoverKey={hoverKey}
                      titleFor={labelFor}
                      onHover={setHoverKey}
                      onPick={setPickedTaskId}
                    />
                  )}
                </div>
                {isToday && nowMin >= axis.startMin && nowMin <= axis.endMin && (
                  // A child of the CANVAS, not of the lanes: the time then sits in
                  // the empty gutter instead of on top of whatever block is at
                  // this hour (red on a coloured block is unreadable).
                  <div
                    className="tt-now"
                    data-testid="time-timeline-now"
                    style={{ top: (nowMin - axis.startMin) * PX_PER_MIN }}
                  >
                    <span className="tt-now-time">{clockLabel(nowMin)}</span>
                    <span className="tt-now-rule" />
                  </div>
                )}
              </div>
            </div>
          </div>

          <TimeTimelineLegend
            rows={legendRows}
            agentMs={showAgents ? agentMs : 0}
            pickedTaskId={pickedTaskId}
            onPick={setPickedTaskId}
          />
        </div>
      )}

      {drawn && (
        <div className="tt-detail" data-testid="time-timeline-detail">
          {detail
            ? (
              <>
                <i
                  className="tt-swatch"
                  style={{ background: detail.block.kind === 'agent' ? 'var(--time-agent)' : taskColor(detail.block.taskId) }}
                />
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

/**
 * The one line about time that isn't on the chart. Two distinct reasons, two
 * sentences: "too short or too folded to place here" was one caption covering
 * both and read as nonsense. Silent under two minutes — a caption about 8
 * seconds is noise, not honesty.
 */
function NotDrawnNote({ day }: { day: DayBlocks }) {
  const notes: string[] = [];
  if (day.shortMs >= NOTE_FLOOR_MS) notes.push(`quick touches under 30s: ${formatDuration(day.shortMs)} not drawn`);
  if (day.foldedMs >= NOTE_FLOOR_MS) notes.push(`${formatDuration(day.foldedMs)} folded into daily totals`);
  if (notes.length === 0) return null;
  return (
    <span className="tt-unplaced" data-testid="time-timeline-notdrawn">
      {notes.join(' · ')}
    </span>
  );
}

function currentMinuteOfDay(): number {
  const now = new Date();
  return now.getHours() * HOUR_MIN + now.getMinutes();
}
