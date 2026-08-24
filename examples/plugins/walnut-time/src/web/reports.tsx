import type { DayTime, TimeHumanKind, TimeSummary } from './api'
import { formatDuration } from './time-timeline'

/**
 * The two report tabs: "My time" (your attention) and "Agents" (their runtime).
 *
 * They are SEPARATE tabs, never one mixed row, and that split is a scar. The first
 * cut of this feature put a small human number and a big agent number in the same
 * row and stacked both into one bar; the user read "8h 57m" as their own working day
 * and reported the data as wrong. A mixed row answers neither question, so the two
 * lanes never share a row, a bar, or a headline stat. You pick the question first.
 *
 * Everything here is a client-side fold over ONE 7-day summary fetch: range, project
 * and kind filters all read `days[].tasks[]`, which already carries `byKind` and the
 * server's focus-tier flag.
 */

export const TREND_DAYS = 7

export type RangeKey = 'today' | 'yesterday' | '7d'
export type KindKey = 'all' | TimeHumanKind

export const RANGES: Array<{ value: RangeKey; label: string }> = [
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: '7d', label: 'Last 7 days' },
]

export const KINDS: Array<{ value: KindKey; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'session', label: 'Sessions' },
  { value: 'triage', label: 'Triage' },
  { value: 'chat', label: 'Chat' },
]

export const NO_TASK_LABEL = 'No task (Inbox / chat)'
export const NO_PROJECT = 'Inbox'

export interface Row {
  taskId: string
  title: string
  ms: number
  focus: boolean
}

// ── The filter bar (shared by both report tabs) ──

export function ReportFilters({ range, onRange, project, onProject, projectOptions, kind, onKind, showKind }: {
  range: RangeKey
  onRange: (value: RangeKey) => void
  project: string
  onProject: (value: string) => void
  projectOptions: string[]
  kind: KindKey
  onKind: (value: KindKey) => void
  showKind: boolean
}) {
  return (
    <div className="wt-filters">
      <div className="wt-pills" role="group" aria-label="Date range">
        {RANGES.map((r) => (
          <button
            key={r.value}
            data-testid={`time-app-range-${r.value}`}
            className={`wt-pill${range === r.value ? ' is-active' : ''}`}
            onClick={() => onRange(r.value)}
          >
            {r.label}
          </button>
        ))}
      </div>

      <label className="wt-filter-field">
        <span className="wt-filter-label">Project</span>
        <select
          data-testid="time-app-project-filter"
          value={project}
          onChange={(e) => onProject(e.target.value)}
        >
          <option value="">All projects</option>
          {projectOptions.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
      </label>

      {showKind && (
        <div className="wt-pills" role="group" aria-label="Activity kind">
          {KINDS.map((k) => (
            <button
              key={k.value}
              data-testid={`time-app-kind-${k.value}`}
              className={`wt-pill${kind === k.value ? ' is-active' : ''}`}
              onClick={() => onKind(k.value)}
            >
              {k.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Tab 1: my attention ──

export function MyTimeReport({ rows, rangeLabel, loading, trendDays, today, keep, kind }: {
  rows: Row[]
  rangeLabel: string
  loading: boolean
  trendDays: DayTime[]
  today: string
  keep: (taskId: string) => boolean
  kind: KindKey
}) {
  const total = rows.reduce((sum, r) => sum + r.ms, 0)
  const focusMs = rows.filter((r) => r.focus).reduce((sum, r) => sum + r.ms, 0)
  const focusRows = rows.filter((r) => r.focus)
  const otherRows = rows.filter((r) => !r.focus)
  const peak = Math.max(1, ...rows.map((r) => r.ms))

  return (
    <div data-testid="time-app-view-mine">
      <div className="wt-stat-row">
        <Stat label={`Your time, ${rangeLabel.toLowerCase()}`} value={formatDuration(total)} tone="human" />
        <Stat
          label="Focus share"
          value={total > 0 ? `${Math.round((focusMs / total) * 100)}%` : '—'}
          hint="your time on focus-tier tasks"
        />
        <Stat
          label="Biggest destination"
          value={rows[0]?.title ?? '—'}
          hint={rows[0] ? formatDuration(rows[0].ms) : undefined}
          text
        />
      </div>

      {rows.length === 0
        ? (
          <p className="wt-empty">
            {loading
              ? 'Loading…'
              : 'Nothing recorded for this range yet. Your time starts counting the moment you interact with a session, a task, or the chat.'}
          </p>
        )
        : (
          <>
            <Group title="Focus tasks" testId="time-app-group-focus" rows={focusRows} peak={peak} tone="human" />
            <Group title="Other" testId="time-app-group-other" rows={otherRows} peak={peak} tone="human" />
          </>
        )}

      <section className="wt-section">
        <div className="wt-section-head">
          <h2>Last {TREND_DAYS} days</h2>
          <span className="wt-section-hint">your time per day, focus vs other</span>
        </div>
        <FocusTrend days={trendDays} today={today} keep={keep} kind={kind} />
        <div className="wt-legend">
          <span className="wt-legend-item"><i className="wt-swatch wt-swatch-focus" /> Focus tasks</span>
          <span className="wt-legend-item"><i className="wt-swatch wt-swatch-human" /> Other tasks</span>
        </div>
      </section>
    </div>
  )
}

/** One bar per day, stacked focus vs non-focus — both halves are YOUR time. */
function FocusTrend({ days, today, keep, kind }: {
  days: DayTime[]
  today: string
  keep: (taskId: string) => boolean
  kind: KindKey
}) {
  const bars = days.map((day) => {
    let focus = 0
    let other = 0
    for (const t of day.tasks) {
      if (!keep(t.taskId)) continue
      const ms = kind === 'all' ? t.humanMs : t.byKind[kind]
      if (ms <= 0) continue
      if (t.focus) focus += ms
      else other += ms
    }
    return { date: day.date, focus, other }
  })
  const peak = Math.max(1, ...bars.map((b) => b.focus + b.other))

  return (
    <div className="wt-trend" data-testid="time-app-trend">
      {bars.map((bar) => (
        <div className={`wt-trend-day${bar.date === today ? ' is-today' : ''}`} key={bar.date}>
          <div
            className="wt-trend-stack"
            title={`${bar.date}: focus ${formatDuration(bar.focus)}, other ${formatDuration(bar.other)}`}
          >
            <div className="wt-trend-seg wt-trend-other" style={{ height: `${(bar.other / peak) * 100}%` }} />
            <div className="wt-trend-seg wt-trend-focus" style={{ height: `${(bar.focus / peak) * 100}%` }} />
          </div>
          <span className="wt-trend-label">{bar.date.slice(5)}</span>
        </div>
      ))}
    </div>
  )
}

// ── Tab 2: the agent fleet ──

export function AgentsReport({ rows, rangeLabel, loading }: {
  rows: Row[]
  rangeLabel: string
  loading: boolean
}) {
  const total = rows.reduce((sum, r) => sum + r.ms, 0)
  const peak = Math.max(1, ...rows.map((r) => r.ms))

  return (
    <div data-testid="time-app-view-agents">
      <div className="wt-stat-row">
        <Stat label={`Agent runtime, ${rangeLabel.toLowerCase()}`} value={formatDuration(total)} tone="agent" />
        <Stat label="Tasks with agent time" value={String(rows.length)} />
      </div>

      <p className="wt-agent-note" data-testid="time-app-agent-caption">
        Agent turn time, not yours: agents can run in parallel, so totals can exceed the clock.
      </p>

      {rows.length === 0
        ? <p className="wt-empty">{loading ? 'Loading…' : 'No agent runs recorded for this range.'}</p>
        : <Group title="By task" testId="time-app-group-agents" rows={rows} peak={peak} tone="agent" />}
    </div>
  )
}

// ── Shared pieces ──

function Group({ title, testId, rows, peak, tone }: {
  title: string
  testId: string
  rows: Row[]
  peak: number
  tone: 'human' | 'agent'
}) {
  return (
    <section className="wt-section" data-testid={testId}>
      <div className="wt-section-head">
        <h2>{title}</h2>
        <span className="wt-section-hint">
          {rows.length === 0 ? 'nothing here' : `${rows.length} ${rows.length === 1 ? 'task' : 'tasks'}`}
        </span>
      </div>
      {rows.length > 0 && (
        <div className="wt-bars">
          {rows.map((row) => <Bar key={row.taskId || '__none__'} row={row} peak={peak} tone={tone} />)}
        </div>
      )}
    </section>
  )
}

function Bar({ row, peak, tone }: { row: Row; peak: number; tone: 'human' | 'agent' }) {
  return (
    // NOT `data-task-id`: Walnut's time tracker attributes any signal inside a
    // `div[data-task-id]` to that task, so a report row carrying it would bill the
    // task you merely LOOKED at in the report. Test hooks use a distinct name.
    <div className="wt-bar-row" data-time-task-id={row.taskId}>
      <div className="wt-bar-label" title={row.title}>
        {row.focus && <i className="wt-swatch wt-swatch-focus" aria-label="focus tier" />}
        <span className="wt-bar-title">{row.title}</span>
      </div>
      <div className="wt-bar-track">
        <div className={`wt-bar-fill wt-bar-fill-${tone}`} style={{ width: `${(row.ms / peak) * 100}%` }} />
      </div>
      <span className={`wt-bar-value wt-bar-value-${tone}`}>{formatDuration(row.ms)}</span>
    </div>
  )
}

function Stat({ label, value, hint, tone, text }: {
  label: string
  value: string
  hint?: string
  tone?: 'human' | 'agent'
  text?: boolean
}) {
  return (
    <div className={`wt-stat${tone ? ` wt-stat-${tone}` : ''}`}>
      <span className={`wt-stat-value${text ? ' is-text' : ''}`} title={text ? value : undefined}>
        {value}
      </span>
      <span className="wt-stat-label">{label}</span>
      {hint && <span className="wt-stat-hint">{hint}</span>}
    </div>
  )
}

// ── Folds (pure) ──

/** The days the selected range covers. `days` is ascending and ends at today. */
export function daysInRange(summary: TimeSummary | null, range: RangeKey): DayTime[] {
  const all = summary?.days ?? []
  if (all.length === 0 || !summary) return []
  if (range === '7d') return all
  const todayIdx = all.findIndex((d) => d.date === summary.today)
  const idx = range === 'today' ? todayIdx : todayIdx - 1
  const day = idx >= 0 ? all[idx] : undefined
  return day ? [day] : []
}

/** Sum one lane per task across the given days, biggest first. */
export function foldRows(
  days: DayTime[],
  keep: (taskId: string) => boolean,
  titleFor: (taskId: string) => string,
  msOf: (task: DayTime['tasks'][number]) => number,
): Row[] {
  const byTask = new Map<string, Row>()
  for (const day of days) {
    for (const task of day.tasks) {
      if (!keep(task.taskId)) continue
      const ms = msOf(task)
      if (ms <= 0) continue
      const row = byTask.get(task.taskId)
      if (row) {
        row.ms += ms
        row.focus = row.focus || task.focus
      } else {
        byTask.set(task.taskId, { taskId: task.taskId, title: titleFor(task.taskId), ms, focus: task.focus })
      }
    }
  }
  return [...byTask.values()].sort((a, b) => b.ms - a.ms || a.title.localeCompare(b.title))
}
