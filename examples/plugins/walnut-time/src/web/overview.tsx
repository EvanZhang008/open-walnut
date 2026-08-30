import { useMemo } from 'react'
import type { DayTime, TaskDayTime } from './api'
import { Bar, Group, Stat, type KindKey, type Row } from './reports'
import { TREND_DAYS, averageLanes, dayLanes, scopeDates, scopeHint, type DayLanes, type Scope } from './time-scope'
import { formatDuration } from './time-timeline'

/**
 * Overview — the four numbers first, then the week, then where the time went.
 *
 * It answers three questions at once because they are asked at once: how much today,
 * how much per day lately, and how much of that was the agents. Cards, then the trend,
 * then the task breakdown; the ranked bars used to be at the top and pushed the week's
 * shape below the fold, which made "am I above or below my average?" a scroll away.
 *
 * The two clocks are always both on screen and never summed. Agents run in parallel,
 * so a combined figure can exceed the wall clock; a reader once read an agent's 8h57m
 * as their own working day and reported the data as broken. Hence a separate card, a
 * separate bar, a separate hue — and the Agents tab for the full list.
 */

/** Agent rows on the Overview. Past this it is the Agents tab's question. */
const AGENT_TOP_ROWS = 5

export function OverviewReport({
  humanRows, agentRows, trendDays, scope, iosMs, today, loading, keep, kind, onPickDay, onOpenAgents,
}: {
  humanRows: Row[]
  agentRows: Row[]
  /** The trailing TREND_DAYS of the fetched window, regardless of scope. */
  trendDays: DayTime[]
  scope: Scope
  /** iPhone slice of the scope's human time; 0 when filtered or absent. */
  iosMs: number
  today: string
  loading: boolean
  keep: (taskId: string) => boolean
  kind: KindKey
  onPickDay: (date: string) => void
  onOpenAgents: () => void
}) {
  const humanMs = totalOf(humanRows)
  const agentMs = totalOf(agentRows)
  const focusMs = totalOf(humanRows.filter((r) => r.focus))
  const focusRows = humanRows.filter((r) => r.focus)
  const otherRows = humanRows.filter((r) => !r.focus)
  const peak = Math.max(1, ...humanRows.map((r) => r.ms))
  const agentTop = agentRows.slice(0, AGENT_TOP_ROWS)
  const agentPeak = Math.max(1, ...agentTop.map((r) => r.ms))

  // The trend and the average read the SAME filters as the cards below them, or a
  // project-filtered page would compare one project's day against everything's average.
  const humanMsOf = useMemo(
    () => (task: TaskDayTime) => (kind === 'all' ? task.humanMs : task.byKind[kind]),
    [kind],
  )
  const lanes = useMemo(() => dayLanes(trendDays, keep, humanMsOf), [trendDays, keep, humanMsOf])
  const average = useMemo(() => averageLanes(lanes), [lanes])
  const selected = useMemo(() => new Set(scopeDates(scope)), [scope])
  const hint = scopeHint(scope, today)

  return (
    <div data-testid="time-app-view-mine">
      <div className="wt-stat-row">
        <Stat
          label="Your time"
          value={formatDuration(humanMs)}
          sub={iosMs > 0 ? `iPhone ${formatDuration(iosMs)}` : undefined}
          subTone="human"
          hint={hint}
          tone="human"
          testId="time-app-stat-human"
        />
        <Stat
          label="Agent time"
          value={formatDuration(agentMs)}
          hint="their runtime, never added to yours"
          tone="agent"
          testId="time-app-stat-agent"
        />
        <Stat
          label={`Daily average, last ${TREND_DAYS} days`}
          value={formatDuration(average.humanMs)}
          sub={`Agents ${formatDuration(average.agentMs)}`}
          hint="per day, empty days included"
          tone="human"
          testId="time-app-stat-average"
        />
        <Stat
          label="Focus share"
          value={humanMs > 0 ? `${Math.round((focusMs / humanMs) * 100)}%` : '—'}
          hint="your time on focus-tier tasks"
          testId="time-app-stat-focus"
        />
      </div>

      <section className="wt-section">
        <div className="wt-section-head">
          <h2>Last {TREND_DAYS} days</h2>
          <span className="wt-section-hint">your time beside agent runtime, click a day to read it</span>
        </div>
        <LaneTrend lanes={lanes} today={today} selected={selected} onPick={onPickDay} />
        <div className="wt-legend">
          <span className="wt-legend-item"><i className="wt-swatch wt-swatch-human" /> Your time</span>
          <span className="wt-legend-item"><i className="wt-swatch wt-swatch-agent" /> Agent runtime</span>
        </div>
      </section>

      {humanRows.length === 0
        ? (
          <p className="wt-empty">
            {loading
              ? 'Loading…'
              : 'Nothing recorded for this scope yet. Your time starts counting the moment you interact with a session, a task, or the chat.'}
          </p>
        )
        : (
          <>
            <Group title="Focus tasks" testId="time-app-group-focus" rows={focusRows} peak={peak} tone="human" />
            <Group title="Other" testId="time-app-group-other" rows={otherRows} peak={peak} tone="human" />
          </>
        )}

      <section className="wt-section" data-testid="time-app-agents-top">
        <div className="wt-section-head">
          <h2>Agents ran</h2>
          <span className="wt-section-hint">
            {agentTop.length === 0 ? 'nothing here' : `top ${agentTop.length} by runtime`}
          </span>
          <button type="button" className="wt-section-link" data-testid="time-app-open-agents" onClick={onOpenAgents}>
            All agent runs →
          </button>
        </div>
        {agentTop.length > 0 && (
          <div className="wt-bars">
            {agentTop.map((row) => <Bar key={row.taskId || '__none__'} row={row} peak={agentPeak} tone="agent" />)}
          </div>
        )}
      </section>
    </div>
  )
}

/**
 * One day, two bars. A shared y-scale across BOTH lanes and all seven days, so the
 * comparison the chart invites (mine vs theirs, today vs Tuesday) is the comparison
 * the pixels actually make. Plain divs: a chart dependency in a plugin bundle would
 * cost more than this whole app.
 */
function LaneTrend({ lanes, today, selected, onPick }: {
  lanes: DayLanes[]
  today: string
  selected: Set<string>
  onPick: (date: string) => void
}) {
  const peak = Math.max(1, ...lanes.map((l) => Math.max(l.humanMs, l.agentMs)))
  return (
    <div className="wt-trend" data-testid="time-app-trend">
      {lanes.map((lane) => {
        const isSelected = selected.has(lane.date)
        return (
          <button
            type="button"
            key={lane.date}
            className={`wt-trend-day${lane.date === today ? ' is-today' : ''}${isSelected ? ' is-selected' : ''}`}
            data-testid="time-app-trend-day"
            data-date={lane.date}
            aria-pressed={isSelected}
            title={`${lane.date}: you ${formatDuration(lane.humanMs)}, agents ${formatDuration(lane.agentMs)}`}
            onClick={() => onPick(lane.date)}
          >
            <div className="wt-trend-pair">
              <span className="wt-trend-bar wt-trend-bar-human" style={{ height: barHeight(lane.humanMs, peak) }} />
              <span className="wt-trend-bar wt-trend-bar-agent" style={{ height: barHeight(lane.agentMs, peak) }} />
            </div>
            <span className="wt-trend-label">{lane.date.slice(5)}</span>
          </button>
        )
      })}
    </div>
  )
}

/** A floor so a real but tiny day is visible, and nothing at all for an empty one. */
function barHeight(ms: number, peak: number): string {
  if (ms <= 0) return '0%'
  return `max(3px, ${(ms / peak) * 100}%)`
}

function totalOf(rows: readonly Row[]): number {
  return rows.reduce((sum, row) => sum + row.ms, 0)
}
