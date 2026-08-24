import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { PluginLogger } from '@open-walnut/plugin-api/web'
import type { DayBlocks, TimeApi, TimeKind } from './api'
import {
  HOUR_MIN, NOTE_FLOOR_MS,
  axisRange, dayLabel, dayLengthMin, dayStartMs, formatDuration, minuteOfDay, shiftDate,
  type LegendRow,
} from './time-timeline'
import { buildChapters } from './time-chapters'
import { TAPE_PX_PER_MIN } from './time-views'
import { TimeTape } from './tape'
import { TimeChapters } from './chapters'
import { TimeLanes } from './lanes'

/**
 * Timeline — "how did my day actually go?", in three switchable readings of the
 * same day. The shell owns the day, the axis and the data; each view owns its own
 * geometry.
 *
 * WHY THREE. The first cut drew per-task blocks on an hour axis and packed
 * overlapping ones into parallel columns. That was rejected on real data, and the
 * root cause was in the DATA SHAPE, not the styling: merging a task's records over
 * a five-minute gap manufactures overlap with whatever happened inside that gap, so
 * the chart implied doing two things at once. Human attention is serial. So:
 *
 *   Tape      one serial ribbon        the honest texture of the day
 *   Chapters  a few cards              the story of the day
 *   Lanes     one row per task         when each task was touched
 *
 * The first two are built from the server's SERIAL ribbon (`raw=1`), which cannot
 * overlap by construction; only the swimlanes use per-task merged blocks, where
 * overlap between different rows is fine because rows are already separate.
 *
 * Agents appear in the swimlanes only, as their own hatched row. A user once read
 * an agent's 8h57m as their own working day and reported the data as broken; the
 * fix is structural separation, not a colour.
 */

/**
 * Remembers the sub-view and the agents toggle. The `open-walnut-` prefix is what
 * the console's ui-prefs mirror looks for, and the `-time-app-` middle keeps these
 * keys the PLUGIN's own: the Settings section has its own pair, and a plugin writing
 * a key the host owns would break the day the host changes that key's shape.
 */
const LS_VIEW_KEY = 'open-walnut-time-app-view'
const LS_AGENTS_KEY = 'open-walnut-time-app-agents'
/**
 * The retired console section's pair. Read once, as a fallback, so someone who had
 * settled on Lanes with agents shown does not silently land back on a bare Tape the
 * day this app replaced that section. Never written: the first change here writes the
 * plugin's own key, and from then on the legacy value is simply unread.
 */
const LEGACY_VIEW_KEY = 'open-walnut-time-timeline-view'
const LEGACY_AGENTS_KEY = 'open-walnut-time-timeline-agents'
/** The tape and the chapters are about a person's attention: never agent runtime. */
const HUMAN_KINDS: readonly TimeKind[] = ['session', 'triage', 'chat']

type ViewKey = 'tape' | 'chapters' | 'lanes'

const VIEWS: Array<{ key: ViewKey; label: string; hint: string }> = [
  { key: 'tape', label: '胶带 Tape', hint: 'One serial ribbon: what you were doing, minute by minute' },
  { key: 'chapters', label: '章节 Chapters', hint: 'The day split into stretches of work' },
  { key: 'lanes', label: '泳道 Lanes', hint: 'One row per task, time left to right' },
]

function readView(): ViewKey {
  try {
    const raw = localStorage.getItem(LS_VIEW_KEY) ?? localStorage.getItem(LEGACY_VIEW_KEY)
    if (raw === 'tape' || raw === 'chapters' || raw === 'lanes') return raw
  } catch { /* private mode */ }
  return 'tape'
}

function readAgentsPref(): boolean {
  try {
    return (localStorage.getItem(LS_AGENTS_KEY) ?? localStorage.getItem(LEGACY_AGENTS_KEY)) === '1'
  } catch {
    return false
  }
}

/**
 * A minute tick that skips hidden tabs and catches up on return. The console has a
 * shared helper for this; a plugin bundles standalone, so it keeps its own eight
 * lines rather than reaching into host internals.
 */
function visibleInterval(tick: () => void, everyMs: number): () => void {
  let timer: ReturnType<typeof setInterval> | undefined
  const start = () => {
    if (timer !== undefined) return
    timer = setInterval(tick, everyMs)
  }
  const stop = () => {
    if (timer === undefined) return
    clearInterval(timer)
    timer = undefined
  }
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') { stop(); return }
    tick()   // the clock moved while we were away, so re-anchor before resuming
    start()
  }
  if (document.visibilityState !== 'hidden') start()
  document.addEventListener('visibilitychange', onVisibility)
  return () => {
    document.removeEventListener('visibilitychange', onVisibility)
    stop()
  }
}

export function TimeTimeline({ api, log, dates, today, titleFor }: {
  api: TimeApi
  log: PluginLogger
  /** The days the app already fetched, ascending. Bounds the day nav. */
  dates: string[]
  today: string
  titleFor: (taskId: string) => string
}) {
  const [date, setDate] = useState(today)
  const [view, setView] = useState<ViewKey>(readView)
  const [showAgents, setShowAgents] = useState(readAgentsPref)
  /** The serial ribbon (views A + B) and the per-task blocks (view C). */
  const [ribbon, setRibbon] = useState<DayBlocks | null>(null)
  const [merged, setMerged] = useState<DayBlocks | null>(null)
  const [error, setError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const landedFor = useRef<string>('')

  // The app owns the window; a day it never fetched has no summary to agree with, so
  // the arrows stop there rather than showing an unexplained empty day.
  const oldest = dates[0] ?? today
  const newest = dates[dates.length - 1] ?? today
  useEffect(() => {
    if (dates.length > 0 && (date < oldest || date > newest)) setDate(today)
  }, [dates.length, date, oldest, newest, today])

  // BOTH shapes in one pass, in parallel: switching view is then instant, and the
  // two are different answers to different questions rather than two formats of one.
  useEffect(() => {
    let live = true
    Promise.all([
      api.blocks(date, { raw: true, kinds: HUMAN_KINDS }),
      api.blocks(date),
    ])
      .then(([raw, all]) => {
        if (!live) return
        setRibbon(raw)
        setMerged(all)
        setError(null)
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        log.warn('blocks fetch failed', { date, error: message })
        if (live) setError(message)
      })
    return () => { live = false }
  }, [api, log, date])

  const pickView = useCallback((next: ViewKey) => {
    setView(next)
    try { localStorage.setItem(LS_VIEW_KEY, next) } catch { /* private mode */ }
  }, [])

  const toggleAgents = useCallback(() => {
    setShowAgents((prev) => {
      const next = !prev
      try { localStorage.setItem(LS_AGENTS_KEY, next ? '1' : '0') } catch { /* private mode */ }
      return next
    })
  }, [])

  const startMs = useMemo(() => dayStartMs(date), [date])
  const lengthMin = useMemo(() => dayLengthMin(date), [date])
  const minuteOf = useCallback(
    (iso: string) => minuteOfDay(iso, startMs, lengthMin),
    [startMs, lengthMin],
  )

  // Now-line, re-anchored every 60s. Hidden tabs skip the tick; the catch-up on
  // return recomputes from the clock, so it is never stale.
  const [nowMinute, setNowMinute] = useState(() => currentMinuteOfDay())
  useEffect(() => visibleInterval(() => setNowMinute(currentMinuteOfDay()), 60_000), [])
  const isToday = date === today
  const nowMin = isToday ? nowMinute : null

  /**
   * The answer for the day being SHOWN. A day switch keeps the previous answer in
   * state until the new one lands, and rendering yesterday's blocks against today's
   * midnight clamped them all to the top edge of the axis, a visible flash of wrong
   * data. Anything but an exact date match is treated as pending.
   */
  const day = ribbon && ribbon.date === date ? ribbon : null
  const dayMerged = merged && merged.date === date ? merged : null
  const pending = day === null || dayMerged === null

  /** Server-joined title first: the task list the app holds may not carry a
   *  completed or archived task that still owns time on this day. */
  const labelFor = useCallback(
    (taskId: string): string => day?.titles[taskId] || dayMerged?.titles[taskId] || titleFor(taskId),
    [day, dayMerged, titleFor],
  )

  const slices = day?.blocks ?? []
  const humanMs = (day?.totals ?? []).reduce((sum, t) => sum + t.ms, 0)
  const agentMs = dayMerged?.agentTotalMs ?? 0

  /** One axis for all three views, so switching never moves the day. */
  const axis = useMemo(() => {
    const spans = slices.map((b) => ({ startMin: minuteOf(b.startTs), endMin: minuteOf(b.endTs) }))
    if (showAgents) {
      for (const b of dayMerged?.blocks ?? []) {
        if (b.kind === 'agent') spans.push({ startMin: minuteOf(b.startTs), endMin: minuteOf(b.endTs) })
      }
    }
    return axisRange(spans, { lengthMin, ...(nowMin !== null ? { nowMin } : {}) })
  }, [slices, dayMerged, showAgents, lengthMin, nowMin, minuteOf])

  const rankRows = useMemo<LegendRow[]>(
    () => (day?.totals ?? []).map((t) => ({ taskId: t.taskId, title: labelFor(t.taskId), ms: t.ms })),
    [day, labelFor],
  )

  /** Time between the first and last thing you did that wasn't work. */
  const idleMs = useMemo(() => {
    if (slices.length === 0) return 0
    const first = Date.parse(slices[0]!.startTs)
    let last = first
    for (const s of slices) last = Math.max(last, Date.parse(s.endTs))
    return Math.max(0, last - first - slices.reduce((sum, s) => sum + s.trackedMs, 0))
  }, [slices])

  // One source for the chaptering rule; the header must never disagree with the view.
  const chapterCount = useMemo(() => buildChapters(slices).length, [slices])

  // Land the initial scroll on the day's work (or on now, for today), never at the
  // top of an axis whose first block is below the fold.
  useEffect(() => {
    const el = scrollRef.current
    if (!el || pending || landedFor.current === `${date}|${view}`) return
    const target = nowMin !== null && nowMin >= axis.startMin
      ? (nowMin - axis.startMin) * TAPE_PX_PER_MIN - el.clientHeight / 3
      : 0
    el.scrollTop = Math.max(0, target)
    landedFor.current = `${date}|${view}`
  }, [date, view, pending, nowMin, axis.startMin])

  const onKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.target !== e.currentTarget) return   // never steal a key from a control
    if (e.key === 'ArrowLeft' && date > oldest) { e.preventDefault(); setDate(shiftDate(date, -1)) }
    if (e.key === 'ArrowRight' && date < newest) { e.preventDefault(); setDate(shiftDate(date, 1)) }
  }, [date, oldest, newest])

  const nothing = !pending && slices.length === 0 && (dayMerged?.blocks.length ?? 0) === 0
  const drawn = !pending && !nothing

  return (
    <div
      className="wt-tt"
      data-testid="time-app-timeline"
      tabIndex={0}
      role="group"
      aria-label="Tracked time by hour"
      onKeyDown={onKeyDown}
    >
      <div className="wt-tt-nav">
        <button
          className="wt-tt-nav-btn"
          data-testid="time-app-prev"
          aria-label="Previous day"
          disabled={date <= oldest}
          onClick={() => setDate(shiftDate(date, -1))}
        >
          ‹
        </button>
        <span className="wt-tt-nav-date" data-testid="time-app-date">
          {dayLabel(date)}
          {isToday && <em className="wt-tt-nav-today">today</em>}
        </span>
        <button
          className="wt-tt-nav-btn"
          data-testid="time-app-next"
          aria-label="Next day"
          disabled={date >= newest}
          onClick={() => setDate(shiftDate(date, 1))}
        >
          ›
        </button>
        <button
          className="wt-tt-nav-reset"
          data-testid="time-app-today"
          disabled={isToday}
          onClick={() => setDate(today)}
        >
          Today
        </button>

        <div className="wt-tt-switch" role="tablist" aria-label="Timeline view">
          {VIEWS.map((v) => (
            <button
              key={v.key}
              role="tab"
              aria-selected={view === v.key}
              className={`wt-tt-switch-btn${view === v.key ? ' is-active' : ''}`}
              data-testid={`time-app-view-${v.key}`}
              title={v.hint}
              onClick={() => pickView(v.key)}
            >
              {v.label}
            </button>
          ))}
        </div>

        {/* Shown only where it does something: agents exist in the swimlanes only. */}
        {view === 'lanes' && (
          <label className="wt-tt-agents-toggle">
            <input
              type="checkbox"
              data-testid="time-app-agents-toggle"
              checked={showAgents}
              onChange={toggleAgents}
            />
            <span>Include agents</span>
          </label>
        )}
      </div>

      {drawn && day && (
        <div className="wt-tt-totals">
          <span className="wt-tt-total wt-tt-total-human" data-testid="time-app-human-total">
            <i className="wt-tt-swatch wt-tt-swatch-human" /> You {formatDuration(humanMs)}
          </span>
          {view === 'tape' && idleMs >= NOTE_FLOOR_MS && (
            <span className="wt-tt-total-side" data-testid="time-app-idle">空闲 {formatDuration(idleMs)}</span>
          )}
          {view === 'chapters' && (
            <span className="wt-tt-total-side" data-testid="time-app-chaptercount">{chapterCount} 个章节</span>
          )}
          {view === 'lanes' && showAgents && (
            <span className="wt-tt-total wt-tt-total-agent" data-testid="time-app-agent-total">
              <i className="wt-tt-swatch wt-tt-swatch-agent" /> Agents {formatDuration(agentMs)}
            </span>
          )}
          <NotDrawnNote day={day} />
        </div>
      )}

      {error && <div className="wt-degraded">Error: {error}</div>}
      {(day?.degraded || dayMerged?.degraded) && (
        <div className="wt-degraded">Showing a partial day: the read gave up before it finished.</div>
      )}

      {pending && !error && <p className="wt-empty">Loading…</p>}

      {nothing && (
        <p className="wt-empty" data-testid="time-app-timeline-empty">
          {(day?.foldedMs ?? 0) > 0
            ? `${formatDuration(day!.foldedMs)} was tracked on ${dayLabel(date)}, but this day has been folded into daily totals — the hour-by-hour detail is no longer on disk. The other two tabs still have its numbers.`
            : `Nothing tracked on ${dayLabel(date)}. Time starts counting the moment you work in a session, triage a task, or chat here.`}
        </p>
      )}

      {drawn && day && dayMerged && view === 'lanes' && (
        <TimeLanes
          blocks={dayMerged.blocks}
          totals={day.totals}
          agentMs={agentMs}
          showAgents={showAgents}
          axis={axis}
          minuteOf={minuteOf}
          nowMin={nowMin}
          labelFor={labelFor}
        />
      )}

      {drawn && view !== 'lanes' && (
        <div className="wt-tt-scroll" ref={scrollRef}>
          {view === 'tape'
            ? (
              <TimeTape
                slices={slices}
                rows={rankRows}
                axis={axis}
                minuteOf={minuteOf}
                nowMin={nowMin}
                labelFor={labelFor}
              />
            )
            : (
              <TimeChapters
                slices={slices}
                axis={axis}
                minuteOf={minuteOf}
                nowMin={nowMin}
                labelFor={labelFor}
              />
            )}
        </div>
      )}
    </div>
  )
}

/**
 * The lines about time that aren't on the chart. Each reason gets its OWN sentence,
 * because they mean different things to a reader: one caption covering all of them
 * ("too short or too folded to place here") read as nonsense. Silent under two
 * minutes, since a caption about 8 seconds is noise rather than honesty.
 */
function NotDrawnNote({ day }: { day: DayBlocks }) {
  const notes: string[] = []
  if (day.shortMs >= NOTE_FLOOR_MS) notes.push(`quick touches under 30s: ${formatDuration(day.shortMs)} not drawn`)
  if (day.foldedMs >= NOTE_FLOOR_MS) notes.push(`${formatDuration(day.foldedMs)} folded into daily totals`)
  if ((day.overlapMs ?? 0) >= NOTE_FLOOR_MS) {
    notes.push(`${formatDuration(day.overlapMs ?? 0)} ran alongside other work (two windows?)`)
  }
  if (notes.length === 0) return null
  return (
    <span className="wt-tt-unplaced" data-testid="time-app-notdrawn">
      {notes.join(' · ')}
    </span>
  )
}

function currentMinuteOfDay(): number {
  const now = new Date()
  return now.getHours() * HOUR_MIN + now.getMinutes()
}
