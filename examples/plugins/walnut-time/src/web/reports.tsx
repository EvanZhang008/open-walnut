import type { DayTime, TimeHumanKind } from './api'
import { DayNav, type DayNavTestIds } from './day-nav'
import { TREND_DAYS, scopeLabel, type Scope, type ScopeMode } from './time-scope'
import { formatDuration } from './time-timeline'

/**
 * The scope bar, the Agents tab, and the pieces both report tabs draw with. The
 * Overview tab itself is overview.tsx; the folds it reasons about are time-scope.ts.
 *
 * Your time and agent runtime never share a row, a bar, or a headline number, and that
 * split is a scar. The first cut put a small human number and a big agent number in the
 * same row and stacked both into one bar; the user read "8h 57m" as their own working
 * day and reported the data as wrong. The Overview shows both clocks at once, side by
 * side, and the Agents tab holds the full fleet list.
 *
 * Everything here is a client-side fold over ONE summary fetch: scope, project and kind
 * filters all read `days[].tasks[]`, which already carries `byKind` and the server's
 * focus-tier flag.
 */

export type KindKey = 'all' | TimeHumanKind

/** Both report tabs share the scope, so the day nav is addressed under its own ids. */
const SCOPE_NAV_IDS: DayNavTestIds = {
  prev: 'time-app-scope-prev',
  next: 'time-app-scope-next',
  date: 'time-app-scope-date',
  today: 'time-app-scope-today',
}

const SCOPE_MODES: Array<{ value: ScopeMode; label: string }> = [
  { value: 'day', label: 'Day' },
  { value: 'week', label: `${TREND_DAYS} days` },
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

// ── The scope bar (shared by both report tabs) ──

/**
 * A day switcher, not a set of canned ranges.
 *
 * "Today / Yesterday / Last 7 days" could not answer "what about Tuesday?", which is
 * most of what anyone asks a time report. So the scope is the Timeline's own gesture
 * (walk days, jump back to today) plus a length toggle, and both report tabs read it.
 */
export function ReportFilters({
  scope, onScope, today, oldest, newest, project, onProject, projectOptions, kind, onKind, showKind,
}: {
  scope: Scope
  onScope: (value: Scope) => void
  today: string
  oldest: string
  newest: string
  project: string
  onProject: (value: string) => void
  projectOptions: string[]
  kind: KindKey
  onKind: (value: KindKey) => void
  showKind: boolean
}) {
  return (
    <div className="wt-filters">
      <DayNav
        date={scope.date}
        today={today}
        oldest={oldest}
        newest={newest}
        label={scopeLabel(scope)}
        testIds={SCOPE_NAV_IDS}
        onDate={(date) => onScope({ mode: scope.mode, date })}
      />

      <div className="wt-pills" role="group" aria-label="Scope length">
        {SCOPE_MODES.map((m) => (
          <button
            key={m.value}
            type="button"
            data-testid={`time-app-scope-${m.value}`}
            className={`wt-pill${scope.mode === m.value ? ' is-active' : ''}`}
            onClick={() => onScope({ mode: m.value, date: scope.date })}
          >
            {m.label}
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

// ── Tab 2: the agent fleet ──

export function AgentsReport({ rows, scopeText, loading }: {
  rows: Row[]
  /** The scope in the reader's terms ("today", "7 days to Aug 29"). */
  scopeText: string
  loading: boolean
}) {
  const total = rows.reduce((sum, r) => sum + r.ms, 0)
  const peak = Math.max(1, ...rows.map((r) => r.ms))

  return (
    <div data-testid="time-app-view-agents">
      <div className="wt-stat-row">
        <Stat label={`Agent runtime, ${scopeText}`} value={formatDuration(total)} tone="agent" />
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

// ── Shared pieces (the Overview draws with these too) ──

export function Group({ title, testId, rows, peak, tone }: {
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

export function Bar({ row, peak, tone }: { row: Row; peak: number; tone: 'human' | 'agent' }) {
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

export function Stat({ label, value, sub, hint, tone, text, testId }: {
  label: string
  value: string
  /** A second lane's number. Agent-toned, and never added to `value`. */
  sub?: string
  hint?: string
  tone?: 'human' | 'agent'
  text?: boolean
  testId?: string
}) {
  return (
    <div className={`wt-stat${tone ? ` wt-stat-${tone}` : ''}`} data-testid={testId}>
      <span className={`wt-stat-value${text ? ' is-text' : ''}`} title={text ? value : undefined}>
        {value}
      </span>
      {sub && <span className="wt-stat-sub">{sub}</span>}
      <span className="wt-stat-label">{label}</span>
      {hint && <span className="wt-stat-hint">{hint}</span>}
    </div>
  )
}

// ── Folds (pure) ──

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
