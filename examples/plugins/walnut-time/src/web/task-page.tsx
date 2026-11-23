import { useMemo, useState } from 'react'
import type { SessionTime, TaskTime, TimePair, TimeTotals } from './api'
import { formatLane, type TimePage, type TimePaths } from './task-routes'
import type { TaskTimeStore } from './task-time-store'
import { dayLabel } from './time-timeline'
import { FoldChevron } from './fold-chevron'

/**
 * One task's time (or one session's), day by day: where the task detail slot and the
 * session header chip lead (addresses in task-routes.ts).
 *
 * It reads the same cache as the two slots, so arriving from either costs no second
 * request, and the numbers on the page are the numbers that were clicked.
 *
 * Sessions are named by their titles and never by their ids: an id means nothing to
 * a person reading a page.
 */

interface TaskTimePageProps {
  page: TimePage
  store: TaskTimeStore
  paths: TimePaths
  basePath: string
  navigate(path: string, options?: { replace?: boolean }): void
}

export function TaskTimePage({ page, store, paths, basePath, navigate }: TaskTimePageProps) {
  const task = store.useTask(page.kind === 'task' ? page.id : null)
  const session = store.useSession(page.kind === 'session' ? page.id : null)
  const entry = page.kind === 'task' ? task : session
  const data = entry.data

  // Back to wherever the click came from (Home and its columns, the task popup);
  // a fresh tab opened on this URL has nowhere to go back to, so it goes Home.
  const back = () => {
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0
    if (idx > 0) window.history.back()
    else navigate('/')
  }

  const title = page.kind === 'task'
    ? (data as TaskTime | undefined)?.title ?? 'Task'
    : (data as SessionTime | undefined)?.title ?? 'Session'

  return (
    <div className="wt-root wt-task-page" data-testid="time-task-page" data-kind={page.kind}>
      <header className="wt-header">
        <div className="wt-task-head">
          <nav className="wt-crumbs" aria-label="Breadcrumb">
            <button type="button" className="wt-crumb" onClick={() => navigate(basePath)}>Time</button>
            <span aria-hidden="true">›</span>
            <span>{page.kind === 'task' ? 'Time on a task' : 'Time in a session'}</span>
          </nav>
          <h1 data-testid="time-task-title">{title}</h1>
          <p>
            Your time and agent time on this {page.kind === 'task' ? 'task' : 'session'} are counted separately, day by day.
            They often overlap (you and an agent work at the same moment, and sessions run in parallel), so they are never added together.
          </p>
        </div>
        <div className="wt-task-actions">
          <button type="button" className="btn btn-ghost" onClick={back} data-testid="time-task-back">Back</button>
          {page.kind === 'task' && (
            <button type="button" className="btn" onClick={() => navigate(`/tasks/${encodeURIComponent(page.id)}`)}>
              Open task
            </button>
          )}
          {page.kind === 'task' && (
            <button type="button" className="btn" onClick={() => store.refreshTask(page.id)}>Refresh</button>
          )}
        </div>
      </header>

      {entry.unavailable && (
        <div className="wt-degraded">Time is recorded on the Mac that runs Walnut, so this page can only be read there.</div>
      )}
      {entry.error && !data && <div className="wt-degraded" data-testid="time-task-error">Could not load: {entry.error}</div>}
      {data?.degraded && <div className="wt-degraded">Showing a partial answer: the store was still warming up.</div>}
      {data && !data.historyComplete && (
        <div className="wt-degraded">Still reading older days, so the totals may still grow.</div>
      )}

      {!data && !entry.unavailable && !entry.error && <p className="wt-empty">Loading…</p>}
      {data && page.kind === 'task' && (
        <TaskBody
          data={data as TaskTime}
          focus={page.session}
          onFocus={(sid) => navigate(paths.task(page.id, sid ?? undefined), { replace: true })}
        />
      )}
      {data && page.kind === 'session' && <SessionBody data={data as SessionTime} />}
    </div>
  )
}

function Totals({ totals, label }: { totals: TimeTotals; label: string }) {
  const cards: Array<[string, TimePair]> = [['Total', totals.all], ['Today', totals.today], ['Last 7 days', totals.week]]
  return (
    <div className="wt-stat-row wt-task-totals" aria-label={label} data-testid="time-task-totals">
      {cards.map(([name, pair]) => (
        <div key={name} className="wt-stat" data-total={name}>
          <span className="wt-stat-label">{name}</span>
          <span className="wt-task-lanes">
            <span className="wt-task-lane is-human"><span>You</span><b className={zeroClass(pair.humanMs)}>{formatLane(pair.humanMs)}</b></span>
            <span className="wt-task-lane is-agent"><span>Agent</span><b className={zeroClass(pair.agentMs)}>{formatLane(pair.agentMs)}</b></span>
          </span>
        </div>
      ))}
    </div>
  )
}

/** A lane with no time at all reads quieter than one with time. */
function zeroClass(ms: number): string | undefined {
  return ms <= 0 ? 'is-zero' : undefined
}

function laneClass(lane: 'human' | 'agent', ms: number): string {
  return ms <= 0 ? `is-${lane} is-zero` : `is-${lane}`
}

/** Each lane has its own scale: agent hours would flatten your minutes to nothing on a shared one. */
/** The day list's column heads: which number is whose, in the words and colours of the
 *  totals above, so a row reads without the cards (2026-11-21 UI audit). Built from the
 *  rows' own classes and the same idle lane, so the heads stay over their values at every width. */
function DayHead({ max }: { max: TimePair }) {
  return (
    <div className="wt-task-day-row wt-task-day-head" aria-hidden="true">
      <span className="wt-task-day-date" />
      <span className="wt-task-bars" data-idle={idleLane(max)}>
        <span className="wt-task-bar is-human"><b>You</b><i style={{ width: 0 }} /></span>
        <span className="wt-task-bar is-agent"><b>Agent</b><i style={{ width: 0 }} /></span>
      </span>
      <span className="wt-task-day-caret" />
    </div>
  )
}

/**
 * Each lane has its own scale: agent hours would flatten your minutes to nothing on a shared one.
 * A lane with no time on any day (its `max` is 0) is marked idle and keeps only its value.
 */
/** The lane with no time on any day (its `max` is 0) while the other has some. */
function idleLane(max: TimePair): 'human' | 'agent' | undefined {
  return max.humanMs === 0 && max.agentMs > 0 ? 'human' : max.agentMs === 0 && max.humanMs > 0 ? 'agent' : undefined
}

function Bars({ pair, max }: { pair: TimePair; max: TimePair }) {
  const pct = (v: number, m: number) => (m > 0 ? Math.max(v > 0 ? 2 : 0, Math.round((v / m) * 100)) : 0)
  const idle = idleLane(max)
  return (
    <span className="wt-task-bars" data-idle={idle}>
      <span className="wt-task-bar is-human" title={`You: ${formatLane(pair.humanMs)}`}>
        <b className={zeroClass(pair.humanMs)}>{formatLane(pair.humanMs)}</b>
        <i style={{ width: `${pct(pair.humanMs, max.humanMs)}%` }} />
      </span>
      <span className="wt-task-bar is-agent" title={`Agent: ${formatLane(pair.agentMs)}`}>
        <b className={zeroClass(pair.agentMs)}>{formatLane(pair.agentMs)}</b>
        <i style={{ width: `${pct(pair.agentMs, max.agentMs)}%` }} />
      </span>
    </span>
  )
}

function maxOf(pairs: TimePair[]): TimePair {
  return pairs.reduce((m, p) => ({ humanMs: Math.max(m.humanMs, p.humanMs), agentMs: Math.max(m.agentMs, p.agentMs) }), { humanMs: 0, agentMs: 0 })
}

/** "Today · Tue, Oct 6", "Sat, Oct 3", and the year for a day in another year. */
function dayName(date: string, today: string): string {
  if (date === today) return `Today · ${dayLabel(date)}`
  return date.slice(0, 4) === today.slice(0, 4) ? dayLabel(date) : `${dayLabel(date)}, ${date.slice(0, 4)}`
}

function TaskBody({ data, focus, onFocus }: { data: TaskTime; focus: string | null; onFocus(sessionId: string | null): void }) {
  const [openDays, setOpenDays] = useState<Set<string>>(() => new Set(data.days[0] ? [data.days[0].date] : []))
  const names = useMemo(() => {
    // An untitled session is named by when it last ran, never by its id.
    const out = new Map<string, string>()
    for (const s of data.sessions) out.set(s.sessionId, data.sessionTitles[s.sessionId] || `Untitled session (${dayLabel(s.lastDate)})`)
    return out
  }, [data])
  const focused = focus && data.sessions.some((s) => s.sessionId === focus) ? focus : null

  // Narrowed to one session: its share of each day it has time on.
  const rows = useMemo(() => {
    if (!focused) return data.days.map((d) => ({ date: d.date, pair: d as TimePair, day: d }))
    return data.days.flatMap((d) => {
      const share = d.sessions.find((s) => s.sessionId === focused)
      return share ? [{ date: d.date, pair: share as TimePair, day: null }] : []
    })
  }, [data, focused])
  const max = useMemo(() => maxOf(rows.map((r) => r.pair)), [rows])
  const focusedTotals = focused ? data.sessions.find((s) => s.sessionId === focused)?.totals : undefined

  if (data.days.length === 0) {
    return <p className="wt-empty" data-testid="time-task-empty">Nothing recorded on this task yet.</p>
  }

  const toggle = (date: string) => setOpenDays((prev) => {
    const next = new Set(prev)
    if (next.has(date)) next.delete(date)
    else next.add(date)
    return next
  })

  return (
    <>
      <Totals totals={focusedTotals ?? data.totals} label={focused ? 'This session' : 'This task'} />

      {data.sessions.length > 0 && (
        <section className="wt-section">
          <div className="wt-section-head"><h2>Sessions</h2></div>
          <div className="wt-task-sessions" role="tablist" aria-label="Narrow to one session">
            <button
              type="button"
              role="tab"
              aria-selected={!focused}
              className={`wt-task-session${!focused ? ' is-active' : ''}`}
              onClick={() => onFocus(null)}
              data-testid="time-task-session-all"
            >
              <span className="wt-task-session-name">Whole task</span>
            </button>
            {data.sessions.map((s) => (
              <button
                key={s.sessionId}
                type="button"
                role="tab"
                aria-selected={focused === s.sessionId}
                className={`wt-task-session${focused === s.sessionId ? ' is-active' : ''}`}
                onClick={() => onFocus(s.sessionId)}
                data-testid="time-task-session"
                data-session-id={s.sessionId}
              >
                <span className="wt-task-session-name">{names.get(s.sessionId)}</span>
                <span className="wt-task-session-v">
                  <span className={laneClass('human', s.totals.all.humanMs)}>{formatLane(s.totals.all.humanMs)}</span>
                  <span aria-hidden="true">·</span>
                  <span className={laneClass('agent', s.totals.all.agentMs)}>{formatLane(s.totals.all.agentMs)}</span>
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="wt-section">
        <div className="wt-section-head">
          <h2>Day by day</h2>
          <span className="wt-section-hint">{focused ? names.get(focused) : 'Open a day to see its sessions'}</span>
        </div>
        <DayHead max={max} />
        <ol className="wt-task-days wn-list-box" data-testid="time-task-days">
          {rows.map(({ date, pair, day }) => {
            const expandable = !!day && (day.sessions.length > 0)
            const open = expandable && openDays.has(date)
            return (
              <li key={date} className={`wt-task-day${open ? ' is-open' : ''}`} data-date={date} data-testid="time-task-day">
                <button
                  type="button"
                  className="wt-task-day-row"
                  onClick={expandable ? () => toggle(date) : undefined}
                  aria-expanded={expandable ? open : undefined}
                  disabled={!expandable}
                >
                  <span className="wt-task-day-date">{dayName(date, data.today)}</span>
                  <Bars pair={pair} max={max} />
                  <span className="wt-task-day-caret" aria-hidden="true">{expandable && <FoldChevron open={open} />}</span>
                </button>
                {open && day && (
                  <ul className="wt-task-day-sessions">
                    {day.sessions.map((s) => (
                      <li key={s.sessionId}>
                        <button type="button" className="wt-task-day-session" onClick={() => onFocus(s.sessionId)} title="Narrow to this session">
                          {names.get(s.sessionId)}
                        </button>
                        <span className={laneClass('human', s.humanMs)}>You {formatLane(s.humanMs)}</span>
                        <span className={laneClass('agent', s.agentMs)}>Agent {formatLane(s.agentMs)}</span>
                      </li>
                    ))}
                    {(day.other.humanMs > 0 || day.other.agentMs > 0) && (
                      <li className="is-other">
                        <span className="wt-task-day-session-label">Outside a session</span>
                        <span className={laneClass('human', day.other.humanMs)}>You {formatLane(day.other.humanMs)}</span>
                        <span className={laneClass('agent', day.other.agentMs)}>Agent {formatLane(day.other.agentMs)}</span>
                      </li>
                    )}
                  </ul>
                )}
              </li>
            )
          })}
        </ol>
      </section>
    </>
  )
}

function SessionBody({ data }: { data: SessionTime }) {
  const max = useMemo(() => maxOf(data.days), [data])
  if (data.days.length === 0) {
    return <p className="wt-empty" data-testid="time-task-empty">Nothing recorded on this session yet.</p>
  }
  return (
    <>
      <Totals totals={data.totals} label="This session" />
      <section className="wt-section">
        <div className="wt-section-head"><h2>Day by day</h2></div>
        <DayHead max={max} />
        <ol className="wt-task-days wn-list-box" data-testid="time-task-days">
          {data.days.map((d) => (
            <li key={d.date} className="wt-task-day" data-date={d.date} data-testid="time-task-day">
              <div className="wt-task-day-row">
                <span className="wt-task-day-date">{dayName(d.date, data.today)}</span>
                <Bars pair={d} max={max} />
                <span className="wt-task-day-caret" aria-hidden="true" />
              </div>
            </li>
          ))}
        </ol>
      </section>
    </>
  )
}
