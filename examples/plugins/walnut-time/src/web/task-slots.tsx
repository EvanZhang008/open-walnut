import type { SessionHeaderSlotProps, TaskDetailSlotProps } from '@open-walnut/plugin-api/web'
import type { TimePair, TimeTotals } from './api'
import { formatLane, type TimePaths } from './task-routes'
import type { TaskTimeStore } from './task-time-store'

/**
 * The two slots this plugin draws inside the console (`walnut.ui.slot`):
 *
 *  - `task.detail`: one compact table on a task's detail, You and Agent across
 *    Total / Today / 7 days. The whole table is one button into the task's page.
 *  - `session.header`: one chip on the session's tool row, `◷ 25m · 1h 12m`
 *    (you · agent, all time), with the six numbers in its hover text.
 *
 * Both lanes are always shown and never summed, the rule every view here follows.
 * Both render nothing until there is an answer, and nothing at all where the
 * server cannot answer (a cloud replica), so a surface never carries a dead control.
 */

const isZero = (pair: TimePair) => pair.humanMs <= 0 && pair.agentMs <= 0

function laneLine(label: string, pick: (pair: TimePair) => number, totals: TimeTotals): string {
  return `${label}: ${formatLane(pick(totals.all))} total, ${formatLane(pick(totals.today))} today, ${formatLane(pick(totals.week))} in 7 days`
}

export function createTimeSlots(store: TaskTimeStore, paths: TimePaths) {
  function TaskTimeSlot({ taskId, navigate }: TaskDetailSlotProps) {
    const { data, unavailable } = store.useTask(taskId)
    // Nothing recorded yet: no row at all, rather than an empty one on every new task.
    if (unavailable || !data || isZero(data.totals.all)) return null
    const { all, today, week } = data.totals
    const human = (p: TimePair) => p.humanMs
    const agent = (p: TimePair) => p.agentMs
    return (
      <button
        type="button"
        className="wt-slot-task"
        data-testid="time-task-slot"
        onClick={() => navigate(paths.task(taskId))}
        title="See this task's time day by day, and per session"
        aria-label={`Time on this task. ${laneLine('You', human, data.totals)}. ${laneLine('Agent', agent, data.totals)}. Open day by day.`}
      >
        <span className="wt-slot-grid">
          <span className="wt-slot-cap">Time</span>
          <span className="wt-slot-col">Total</span>
          <span className="wt-slot-col">Today</span>
          <span className="wt-slot-col">7 days</span>
          <span className="wt-slot-lane is-human">You</span>
          <span className="wt-slot-v" data-cell="you-total">{formatLane(all.humanMs)}</span>
          <span className="wt-slot-v" data-cell="you-today">{formatLane(today.humanMs)}</span>
          <span className="wt-slot-v" data-cell="you-week">{formatLane(week.humanMs)}</span>
          <span className="wt-slot-lane is-agent">Agent</span>
          <span className="wt-slot-v" data-cell="agent-total">{formatLane(all.agentMs)}</span>
          <span className="wt-slot-v" data-cell="agent-today">{formatLane(today.agentMs)}</span>
          <span className="wt-slot-v" data-cell="agent-week">{formatLane(week.agentMs)}</span>
        </span>
        <span className="wt-slot-more">Day by day ›</span>
      </button>
    )
  }

  function SessionTimeChip({ sessionId, taskId, navigate }: SessionHeaderSlotProps) {
    const { data, unavailable } = store.useSession(sessionId)
    if (unavailable || !data || isZero(data.totals.all)) return null
    const { all } = data.totals
    const owner = taskId ?? data.taskIds.find(Boolean)
    const target = owner ? paths.task(owner, sessionId) : paths.session(sessionId)
    const tip = [
      'Time on this session',
      laneLine('You', (p) => p.humanMs, data.totals),
      laneLine('Agent', (p) => p.agentMs, data.totals),
      'Click for day by day',
    ].join('\n')
    return (
      <button
        type="button"
        className="wt-slot-chip"
        data-testid="time-session-chip"
        onClick={() => navigate(target)}
        title={tip}
        aria-label={`Time on this session: you ${formatLane(all.humanMs)}, agent ${formatLane(all.agentMs)}`}
      >
        <svg className="wt-slot-clock" width="11" height="11" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="8.6" fill="none" stroke="currentColor" strokeWidth="2.2" />
          <path d="M12 7.4V12l3.4 2.1" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="wt-slot-v is-human">{formatLane(all.humanMs)}</span>
        <span className="wt-slot-sep" aria-hidden="true">{' · '}</span>
        <span className="wt-slot-v is-agent">{formatLane(all.agentMs)}</span>
      </button>
    )
  }

  return { TaskTimeSlot, SessionTimeChip }
}
