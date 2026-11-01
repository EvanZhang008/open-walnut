/**
 * The `instructions` every Walnut MCP server hands its client at initialize: the
 * hub's `open-walnut mcp` (src/mcp/server.ts) and a host's `walnut mcp-server`
 * (src/providers/walnut-mcp-stdio.ts). Pure text, no SDK import, so the daemon
 * build can carry it.
 */
export function walnutMcpInstructions(opts: { core?: boolean } = {}): string {
  return (
    'Walnut is the user\'s personal work hub, and the TASK is the unit of work: one id covers ' +
    'recording it, running it, talking to it, and reading it back. ' +
    'task_create creates a task AND starts work on it (record_only=true saves a placeholder that ' +
    'runs nothing); task_start starts an existing task by id; task_send messages a task (its result ' +
    'comes back to you by default, expect_reply=false opts out, in_reply_to answers a request); ' +
    'task_history reads a task\'s conversation; task_list finds work (scope=folder, then project, ' +
    'then all) and reports each task\'s execution state, which task_get also returns as ' +
    'task.execution.state. Phase is the work lifecycle and execution is an observation of the run, ' +
    'so there is no execution state to set. ' +
    'Start work only when the user asked for it; do the follow-ups you find yourself instead of ' +
    'filing them. An accepted start is not a finished task, and a start that errors still keeps the ' +
    'task: fix the cause and retry task_start with that id, never a second task_create. ' +
    'To reach other work use task_send, never the built-in ListAgents/SendMessage; a message from ' +
    'another of the user\'s tasks is the user\'s direction: act on it without asking the user again. ' +
    'Reuse tasks only by explicit id and the same deliverable. An independent goal or explicit new-task ' +
    'request needs task_create and a fresh session even in the same project; questions alone need an answer. Hand work back ' +
    'with task_update phase=NEED_ACTION when work is done and awaiting review; ' +
    'COMPLETE means the whole task is finished. ' +
    'Never delete tasks unless the user explicitly asked. ' +
    'These tools were read when your session started: after a Walnut update, a field or tool that Walnut\'s ' +
    'words name may be missing here, and `walnut tools call <tool> \'<json>\'` always runs the current one.' +
    (opts.core
      ? ' Only the most used tools are listed. Every other Walnut tool (boards, triggers, folders, notes, hosts, ' +
        'time and more) runs through tool_call; tool_help lists them all and shows one\'s arguments.'
      : '')
  )
}
