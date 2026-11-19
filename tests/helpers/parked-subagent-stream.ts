/**
 * The 2026-11-19 stream shape of a background subagent the CLI (2.1.322) parks while its own
 * background command runs and then starts again under the same call (src/providers/bg-task-resume.ts),
 * neutralized. `working` marks every prefix length at which the subagent is at work; `done` is the
 * length once it really reported done.
 */
const SID = 'bg-resume-sid'
const AGENT = 'agent-sub-1'
const CALL = 'toolu_agent_call_1'

export const sys = (subtype: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'system', subtype, session_id: SID, ...extra })
const level = (ids: string[]) =>
  sys('background_tasks_changed', { tasks: ids.map((id) => ({ task_id: id, task_type: id.startsWith('agent') ? 'local_agent' : 'local_bash' })) })
const agentStart = () => sys('task_started', { task_id: AGENT, task_type: 'local_agent', description: 'Rework the merge', tool_use_id: CALL, is_backgrounded: true })
const agentParked = (summary: string) => [
  sys('task_updated', { task_id: AGENT, patch: { status: 'completed', end_time: 1 } }),
  sys('task_notification', { task_id: AGENT, status: 'completed', tool_use_id: CALL, summary }),
]
const bashStart = (id: string, call: string) =>
  sys('task_started', { task_id: id, task_type: 'local_bash', description: 'Run the e2e', tool_use_id: call, owned_by_subagent: true, is_backgrounded: true })
const bashDone = (id: string, call: string) => [
  sys('task_updated', { task_id: id, patch: { status: 'completed', end_time: 2 } }),
  sys('task_notification', { task_id: id, status: 'completed', tool_use_id: call, summary: 'Background command completed (exit code 0)' }),
]
const result = (followup: boolean) => JSON.stringify({
  type: 'result', subtype: 'success', is_error: false, session_id: SID, result: 'Waiting on the subagent.',
  ...(followup ? { origin: { kind: 'task-notification' } } : {}),
})
const subagentTool = (i: number) => JSON.stringify({
  type: 'assistant', session_id: SID, parent_tool_use_id: CALL,
  message: { id: `m${i}`, role: 'assistant', content: [{ type: 'tool_use', id: `tu${i}`, name: 'Bash', input: { command: 'cat results.txt' } }] },
})

/** The stream, with a mark at each point the subagent is still at work. */
export function parkedSubagentStream(): { lines: string[]; working: number[]; done: number } {
  const lines: string[] = []
  const working: number[] = []
  const mark = () => working.push(lines.length)
  lines.push(sys('init'), JSON.stringify({ type: 'user', session_id: SID, message: { role: 'user', content: 'Fix the merge and run the e2e.' } }))
  lines.push(level([AGENT]), agentStart(), subagentTool(1))
  lines.push(result(false), sys('session_state_changed', { state: 'idle' }))
  mark()
  // The subagent starts its own background command and is parked while it runs.
  lines.push(level([AGENT, 'bash-1']), bashStart('bash-1', 'toolu_bash_1'))
  lines.push(...agentParked('I am waiting for the e2e run.'), level(['bash-1']))
  mark()
  // The main agent's follow-up turn for that notification, then idle.
  lines.push(sys('session_state_changed', { state: 'running' }), sys('init'), result(true), sys('session_state_changed', { state: 'idle' }))
  mark()
  // Its command ends: one empty level line, then the CLI starts the subagent again under the same call.
  lines.push(...bashDone('bash-1', 'toolu_bash_1'), level([]))
  lines.push(level([AGENT]), agentStart())
  mark()
  lines.push(sys('task_progress', { task_id: AGENT, description: 'Running Read results' }), subagentTool(2))
  mark()
  // A foreground command of the subagent's own starts and ends while the main turn is idle.
  lines.push(sys('task_started', { task_id: 'bash-2', task_type: 'local_bash', tool_use_id: 'toolu_bash_2', owned_by_subagent: true, is_backgrounded: false }))
  lines.push(sys('task_notification', { task_id: 'bash-2', status: 'completed', tool_use_id: 'toolu_bash_2' }))
  mark()
  // Its final report: now it is really done.
  lines.push(...agentParked('Step 2 is committed.'), level([]))
  return { lines, working, done: lines.length }
}

export const PARKED = { SID, AGENT, CALL, sys }
