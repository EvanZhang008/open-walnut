import type { SessionMetaSlotProps, TaskMetaSlotProps } from '@open-walnut/plugin-api/web'
import type { TimePair, TimeTotals } from './api'
import { formatLane, formatLaneCompact, type TimePaths } from './task-routes'
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
 *    label there, so it is a pill instead: a person and `25m`, a spark and `1h`, with the
 *    exact numbers in its hover text (TimeChip).
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

const HumanIcon = () => (
  <svg className="wt-pill-icon is-human" width="11" height="11" viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="7.6" r="4.1" fill="currentColor" />
    <path d="M3.8 21.2c.6-4.6 4-7.4 8.2-7.4s7.6 2.8 8.2 7.4z" fill="currentColor" />
  </svg>
)

const AgentIcon = () => (
  <svg className="wt-pill-icon is-agent" width="11" height="11" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 1.8l2.5 7.7 7.7 2.5-7.7 2.5-2.5 7.7-2.5-7.7L1.8 12l7.7-2.5z" fill="currentColor" />
  </svg>
)

/**
 * The header pill (the user, 2026-10-26: "a pill like human icon: 2h, and agent icon: 8h").
 * Each lane is its icon, its name and one whole unit, "You 0m · Agent 9h" (2026-11-22 words audit:
 * icons alone did not say whose time each was). The names are `[data-fit-label]`: where the header
 * row has no room for them (a second column at 1280 px) the host folds the pill to its icons before
 * it would put it into "..." (session-header-fit.ts). Hovering grows nothing (2026-11-23, the user, on
 * what widens on hover outside a narrow list: "所有东西都放大真的是不太舒服"): the exact numbers
 * are its native tooltip, and for a screen reader its label; a click opens the day by day page.
 * The button's own text reads "You 2h · Agent 8h" (folded or not), which is what an
 * older host's "..." row prints; `data-header-value` gives a newer host the exact line.
 */
function TimeChip({ totals, onOpen }: { totals: TimeTotals; onOpen: () => void }) {
  const { all } = totals
  const human = formatLane(all.humanMs)
  const agent = formatLane(all.agentMs)
  const tip = [
    'Time on this session',
    laneLine('You', (p) => p.humanMs, totals),
    laneLine('Agent', (p) => p.agentMs, totals),
    'Click for day by day',
  ].join('\n')
  return (
    <span className="wt-pill">
      <button
        type="button"
        className="wt-chip"
        data-testid="time-session-chip"
        data-header-value={`You ${human} \u00b7 Agent ${agent}`}
        onClick={(e) => { e.stopPropagation(); onOpen() }}
        title={tip}
        aria-label={`Time on this session. ${laneLine('You', (p) => p.humanMs, totals)}. ${laneLine('Agent', (p) => p.agentMs, totals)}. Open day by day.`}
      >
        <HumanIcon />
        <span className="wt-pill-name" data-fit-label="">You </span>
        <span className="wt-fact-v is-human" data-cell="you-compact">{formatLaneCompact(all.humanMs)}</span>
        <span className="wt-fact-sep" data-fit-label="">{' \u00b7 '}</span>
        <AgentIcon />
        <span className="wt-pill-name" data-fit-label="">Agent </span>
        <span className="wt-fact-v is-agent" data-cell="agent-compact">{formatLaneCompact(all.agentMs)}</span>
      </button>
    </span>
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
