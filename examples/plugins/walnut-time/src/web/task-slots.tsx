import type { SessionMetaSlotProps, TaskMetaSlotProps } from '@open-walnut/plugin-api/web'
import type { TimePair, TimeTotals } from './api'
import { formatLane, type TimePaths } from './task-routes'
import type { TaskTimeStore } from './task-time-store'

/**
 * The two slots this plugin draws inside the console (`walnut.ui.slot`). Each is ONE
 * labelled fact ("Time") whose value is a single short line, `You 25m · Agent 1h 12m`
 * (all time), with the six numbers (Total / Today / 7 days for each lane) in its hover
 * text. A click opens the task's page in the Time app, day by day.
 *
 *  - `task.meta`: with a task's id and dates, in its details popup and on its page.
 *  - `session.meta`: at the top of the session's ⋮ menu, the page narrowed to it. When
 *    the user pins it to the session header (`placement: 'header'`), the host prints no
 *    label there, so it is a chip instead: a clock, then `25m · 1h 12m`.
 *
 * Both lanes are always shown and never summed, the rule every view here follows.
 * Both render nothing until there is an answer, and nothing at all where the
 * server cannot answer (a cloud replica), so a surface never carries a dead control.
 */

const isZero = (pair: TimePair) => pair.humanMs <= 0 && pair.agentMs <= 0

function laneLine(label: string, pick: (pair: TimePair) => number, totals: TimeTotals): string {
  return `${label}: ${formatLane(pick(totals.all))} total, ${formatLane(pick(totals.today))} today, ${formatLane(pick(totals.week))} in 7 days`
}

function TimeValue({ what, totals, testId, onOpen }: { what: string; totals: TimeTotals; testId: string; onOpen: () => void }) {
  const { all } = totals
  const tip = [
    `Time on this ${what}`,
    laneLine('You', (p) => p.humanMs, totals),
    laneLine('Agent', (p) => p.agentMs, totals),
    'Click for day by day',
  ].join('\n')
  return (
    <button
      type="button"
      className="wt-fact"
      data-testid={testId}
      onClick={(e) => { e.stopPropagation(); onOpen() }}
      title={tip}
      aria-label={`Time on this ${what}. ${laneLine('You', (p) => p.humanMs, totals)}. ${laneLine('Agent', (p) => p.agentMs, totals)}. Open day by day.`}
    >
      You <span className="wt-fact-v is-human" data-cell="you-total">{formatLane(all.humanMs)}</span>
      <span className="wt-fact-sep" aria-hidden="true">{' · '}</span>
      Agent <span className="wt-fact-v is-agent" data-cell="agent-total">{formatLane(all.agentMs)}</span>
    </button>
  )
}

/** The header chip: a clock stands in for the label the header row has no room for. */
function TimeChip({ totals, onOpen }: { totals: TimeTotals; onOpen: () => void }) {
  const { all } = totals
  const tip = [
    'Time on this session',
    laneLine('You', (p) => p.humanMs, totals),
    laneLine('Agent', (p) => p.agentMs, totals),
    'Click for day by day',
  ].join('\n')
  return (
    <button
      type="button"
      className="wt-chip"
      data-testid="time-session-chip"
      onClick={(e) => { e.stopPropagation(); onOpen() }}
      title={tip}
      aria-label={`Time on this session: you ${formatLane(all.humanMs)}, agent ${formatLane(all.agentMs)}. Open day by day.`}
    >
      <svg className="wt-chip-clock" width="11" height="11" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="8.6" fill="none" stroke="currentColor" strokeWidth="2.2" />
        <path d="M12 7.4V12l3.4 2.1" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className="wt-fact-v is-human">{formatLane(all.humanMs)}</span>
      <span className="wt-fact-sep" aria-hidden="true">{' · '}</span>
      <span className="wt-fact-v is-agent">{formatLane(all.agentMs)}</span>
    </button>
  )
}

export function createTimeSlots(store: TaskTimeStore, paths: TimePaths) {
  function TaskTime({ taskId, navigate }: TaskMetaSlotProps) {
    const { data, unavailable } = store.useTask(taskId)
    // Nothing recorded yet: no fact at all, rather than "0m" on every new task.
    if (unavailable || !data || isZero(data.totals.all)) return null
    return <TimeValue what="task" totals={data.totals} testId="time-task-fact" onOpen={() => navigate(paths.task(taskId))} />
  }

  function SessionTime({ sessionId, taskId, placement, navigate }: SessionMetaSlotProps) {
    const { data, unavailable } = store.useSession(sessionId)
    if (unavailable || !data || isZero(data.totals.all)) return null
    const owner = taskId ?? data.taskIds.find(Boolean)
    const target = owner ? paths.task(owner, sessionId) : paths.session(sessionId)
    if (placement === 'header') return <TimeChip totals={data.totals} onOpen={() => navigate(target)} />
    return <TimeValue what="session" totals={data.totals} testId="time-session-fact" onOpen={() => navigate(target)} />
  }

  return { TaskTime, SessionTime }
}
