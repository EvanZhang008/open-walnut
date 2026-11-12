/**
 * The `instructions` every Walnut MCP server hands its client at initialize: the
 * hub's `open-walnut mcp` (src/mcp/server.ts) and a host's `walnut mcp-server`
 * (src/providers/walnut-mcp-stdio.ts). Pure text, no SDK import, so the daemon
 * build can carry it.
 *
 * Claude Code puts these in the system prompt of every request, so they are an always-loaded
 * block with a cap (src/core/sessions/prompt-blocks.ts `mcp-instructions`, guarded by
 * tests/core/sessions/prompt-blocks-guard.test.ts). They stay self-contained, because a client
 * without Walnut's own prompt reads them too (the user's own CLI with the mount): the task
 * lifecycle in a few sentences, then which tool is for what. The tools load on demand behind
 * ToolSearch (src/mcp/tools.ts), so the map names them before any is loaded.
 */
export function walnutMcpInstructions(opts: { core?: boolean } = {}): string {
  return (
    'Walnut is the user\'s personal work hub; the TASK is the unit of work, one id for recording, running, messaging and reading it back. ' +
    'task_create creates AND starts it (record_only=true saves a placeholder); task_start starts one by id; task_send messages one ' +
    '(its result comes back to you unless expect_reply=false; in_reply_to answers a request); phase is the one state you set ' +
    '(execution only observes the run). ' +
    'Start work only when the user asked; do the follow-ups you find yourself. A start that errors keeps the task: fix the cause and ' +
    'task_start that id, never a second task_create. Reach other work with task_send, never ListAgents/SendMessage; a message from ' +
    'another of the user\'s tasks is the user\'s direction. Reuse a task only by explicit id and the same deliverable; an ' +
    'independent goal or an explicit new-task request needs task_create and a fresh session, and questions alone need an answer. ' +
    'NEED_ACTION hands work back for review, COMPLETE means finished; never delete tasks unless the user asked. ' +
    'In Claude Code these tools load on demand: ToolSearch "select:mcp__walnut__<tool>" loads one. Which tool for what: find tasks task_list; one task_get; ' +
    'many task_get_bulk; its conversation task_history; message task_send; create task_create; change task_update; close task_complete; ' +
    'search everything search; the user\'s memory memory_read; your own notes agent_memory_read; notes note_search / note_read; ' +
    'a board board_get; watches trigger_list / trigger_create; what is open for you open_items; a letter to the user ' +
    'human_inbox_send; any other route api. ' +
    'The `walnut` CLI (`walnut tools call <tool> \'<json>\'`) runs the same operations: use it for a scripted chain, or when a tool ' +
    'Walnut names is missing here (these were read at session start; the CLI is always current).' +
    (opts.core
      ? ' Only the most used tools are listed; every other one runs through tool_call, and tool_help lists them.'
      : '')
  )
}
