/**
 * Every read of one task or one session the leader serves, and what a host replica answers for
 * it while the Mac is away when the task was made on this host or its session runs here
 * (docs/plan/one-service-every-host.md, "Phase 1 as built"). The ratchet in
 * tests/replica/route-table-coverage.test.ts walks the real app: a new GET route under
 * /api/tasks, /api/v1/tasks, /api/sessions or /api/v1/sessions fails it until a row here decides
 * it. A `leader` row answers with its route table row's why, or (MADE_HERE) with
 * task_made_here_needs_mac, which tests/replica/away-task-made-here-reads.test.ts calls on the
 * real routes.
 *
 *   host       answered on this host, in the shape the leader gives
 *   leader     a clean 503 needs_leader with its why (never a wrong "not found" or "unknown")
 *   unchanged  answered from this replica's copies as for any task or session while away; not a
 *              read that follows a task started here (the reason says what it reads)
 */
export type AwayTaskReadDecision = { answer: 'host' | 'leader' | 'unchanged'; why: string }

const ROW = 'the copy row with the journal and the session started here folded in (overlay.ts, task-row-fold.ts)'
export const MADE_HERE = 'a task made here that its route cannot find: 503 task_made_here_needs_mac (away-reads.ts); a task of the copy: its route as before'
const RECORD = 'the session record: the copy, or this replica\'s row of a session it started (session-tracker.ts installAwaySessions), its live state read first (away-reads.ts, ask-launch.ts fresh)'
const SELF_HOST = 'a session of this host: its daemon through the follower link (self-host.ts, WP6), or its stream file for an older daemon (away-session-reads.ts); a session elsewhere: needs_leader session_on_mac'
const HOST_DAEMON = 'a session of this host: a local route row (route-table.ts, local: session) read through its daemon on the follower link (self-host.ts, WP6); with an older daemon, needs_leader session_files_need_mac (away-session-reads.ts)'
const VIA_DAEMON = 'the session\'s host data through its daemon connection, which for a session of this host is the follower link (self-host.ts, WP6), as for any session of this host; not traced here for one started while the Mac is away'
const RECORD_FIELDS = 'fields of the session record (the copy, or this replica\'s row of a session it started)'

export const AWAY_TASK_READS: Readonly<Record<string, AwayTaskReadDecision>> = {
  // ── Tasks ──
  'GET /api/tasks': { answer: 'host', why: `task_list: ${ROW}; a row only the overlay holds gets the Mac's session enrichment` },
  'GET /api/tasks/bulk': { answer: 'host', why: `task_get_bulk: ${ROW}, projected by the Mac's projection (task-bulk-get.ts); a task made here is no longer "not found"` },
  'GET /api/tasks/:id': { answer: 'host', why: `task_get: ${ROW}, with the Mac's session enrichment (execution running, idle, waiting)` },
  'GET /api/tasks/:id/pull-requests': { answer: 'leader', why: MADE_HERE },
  'GET /api/tasks/:id/changes': { answer: 'leader', why: MADE_HERE },
  // With the change-status experiment off it answers 409 disabled for every task, before any lookup.
  'GET /api/tasks/:id/changes/stage': { answer: 'leader', why: MADE_HERE },
  'GET /api/v1/tasks': { answer: 'host', why: `the phone's list: ${ROW}` },
  'GET /api/v1/tasks/:id': { answer: 'host', why: `task_history's task read and the phone's detail: ${ROW} (no enrichment, as the Mac's v1 route)` },
  'GET /api/v1/tasks/:id/sessions': { answer: 'host', why: 'task_history\'s session list: for a task made here, the Mac\'s answer (engine-switch-v1.ts taskSessionsAnswer) over this host\'s sessions' },
  'GET /api/v1/tasks/:id/board': { answer: 'host', why: 'the Board with this host\'s journal records folded in (away-reads.ts overlayBoard), as before' },
  'GET /api/v1/tasks/:id/board/owner': { answer: 'unchanged', why: 'the team owner from the copy\'s tasks' },
  'GET /api/v1/tasks/:id/board/open-choice': { answer: 'unchanged', why: 'a Board choice from the copy' },
  'GET /api/v1/tasks/:id/wake-sources': { answer: 'leader', why: MADE_HERE },
  'GET /api/v1/tasks/:id/agent-memory': { answer: 'leader', why: MADE_HERE },
  'GET /api/v1/tasks/:id/memory-files': { answer: 'leader', why: MADE_HERE },
  'GET /api/v1/tasks/:id/memory-files/:name': { answer: 'leader', why: MADE_HERE },
  'GET /api/v1/tasks/:id/agent-skills': { answer: 'leader', why: MADE_HERE },
  'GET /api/v1/tasks/:id/agent-skills/:name': { answer: 'leader', why: MADE_HERE },
  'GET /api/v1/tasks/:id/watch': { answer: 'leader', why: MADE_HERE },
  'GET /api/v1/tasks/:id/brief': { answer: 'leader', why: MADE_HERE },
  'GET /api/v1/tasks/:id/threads': { answer: 'leader', why: MADE_HERE },
  'GET /api/v1/tasks/:id/threads/:thread': { answer: 'leader', why: MADE_HERE },
  'GET /api/v1/tasks/:id/transfer-options': { answer: 'leader', why: MADE_HERE },
  // ── Task lists and aggregates ──
  'GET /api/tasks/enriched': { answer: 'host', why: `the console's enriched list: ${ROW}; the Mac's route adds no session enrichment here either` },
  'GET /api/v1/tasks/enriched': { answer: 'unchanged', why: 'the copy\'s tasks only: a task made here is not in it until the Mac has it' },
  'GET /api/tasks/groups': { answer: 'unchanged', why: 'folders from the copy' },
  'GET /api/v1/tasks/groups': { answer: 'unchanged', why: 'folders from the copy' },
  'GET /api/tasks/meta/tags': { answer: 'unchanged', why: 'tag counts from the copy\'s tasks' },
  'GET /api/v1/tasks/meta/tags': { answer: 'unchanged', why: 'tag counts from the copy\'s tasks' },
  'GET /api/v1/tasks/meta/tag-display': { answer: 'unchanged', why: 'tag display settings from the config copy' },
  'GET /api/tasks/meta/sprints': { answer: 'unchanged', why: 'sprint counts from the copy\'s tasks' },
  'GET /api/v1/tasks/meta/sprints': { answer: 'unchanged', why: 'sprint counts from the copy\'s tasks' },
  'GET /api/tasks/suggest-accuracy': { answer: 'unchanged', why: 'the suggestion record of this replica\'s own store' },
  'GET /api/tasks/board-counts': { answer: 'unchanged', why: 'tier counts from the copy\'s tasks' },
  // ── Session lists ──
  'GET /api/sessions': { answer: 'unchanged', why: 'the sessions list from the copy and this replica\'s rows (session-tracker.ts withAway), as before' },
  'GET /api/v1/sessions': { answer: 'unchanged', why: 'the phone\'s sessions list from the copy, as before' },
  'GET /api/sessions/recent': { answer: 'unchanged', why: 'recent sessions from the copy, as before' },
  'GET /api/v1/sessions/recent': { answer: 'unchanged', why: 'recent sessions from the copy, as before' },
  'GET /api/sessions/summaries': { answer: 'unchanged', why: 'session summaries from the copy, as before' },
  'GET /api/v1/sessions/summaries': { answer: 'unchanged', why: 'session summaries from the copy, as before' },
  'GET /api/sessions/status': { answer: 'unchanged', why: 'session statuses from the copy and this replica\'s rows, as before' },
  'GET /api/sessions/mention-index': { answer: 'unchanged', why: 'the mention index from the copy, as before' },
  'GET /api/sessions/live-activity': { answer: 'unchanged', why: 'this replica\'s own live activity registry, as before' },
  'GET /api/sessions/working-dirs': { answer: 'unchanged', why: 'working folders from the copy\'s sessions, as before' },
  'GET /api/sessions/git-status': { answer: 'unchanged', why: 'git glances through each session\'s host, as before' },
  'GET /api/sessions/claude-default-efforts': { answer: 'unchanged', why: 'Claude Code\'s own effort per model, as this replica\'s copy of the recent session records shows it' },
  'GET /api/sessions/host-model-catalogs': { answer: 'unchanged', why: 'model catalogs from the config copy, as before' },
  'GET /api/sessions/ask-walnut-launch': { answer: 'unchanged', why: 'the Ask Walnut launch picks from the copies, as before' },
  'GET /api/v1/sessions/launch-options': { answer: 'unchanged', why: 'launch options from the config copy, as before' },
  'GET /api/sessions/list-dirs': { answer: 'leader', why: 'route-table.ts needs_leader files_need_mac' },
  'GET /api/v1/sessions/list-dirs': { answer: 'leader', why: 'route-table.ts needs_leader files_need_mac' },
  // ── Sessions: the record, the conversation ──
  'GET /api/sessions/task/:taskId': { answer: 'host', why: `the sessions of a task: ${RECORD}` },
  'GET /api/sessions/:sessionId': { answer: 'host', why: RECORD },
  'GET /api/v1/sessions/:id': { answer: 'host', why: RECORD },
  'GET /api/sessions/:sessionId/history': { answer: 'host', why: SELF_HOST },
  'GET /api/v1/sessions/:id/history': { answer: 'host', why: SELF_HOST },
  'GET /api/v1/sessions/:id/transcript': { answer: 'host', why: `task_history's conversation: ${SELF_HOST}` },
  'GET /api/sessions/:sessionId/subagent/:agentId/history': { answer: 'host', why: HOST_DAEMON },
  'GET /api/v1/sessions/:id/subagent/:agentId/history': { answer: 'host', why: HOST_DAEMON },
  'GET /api/sessions/:sessionId/find': { answer: 'unchanged', why: VIA_DAEMON },
  'GET /api/v1/sessions/:id/chat-earlier': { answer: 'unchanged', why: VIA_DAEMON },
  'GET /api/v1/sessions/:id/messages/:messageId': { answer: 'unchanged', why: VIA_DAEMON },
  'GET /api/v1/sessions/:id/stream': { answer: 'unchanged', why: VIA_DAEMON },
  // ── Sessions: the files and the changes behind them ──
  'GET /api/sessions/:sessionId/changes': { answer: 'host', why: HOST_DAEMON },
  'GET /api/sessions/:sessionId/changes/file': { answer: 'host', why: HOST_DAEMON },
  'GET /api/sessions/:sessionId/changes/refs': { answer: 'unchanged', why: VIA_DAEMON },
  'GET /api/sessions/:sessionId/changes/summary': { answer: 'unchanged', why: VIA_DAEMON },
  'GET /api/sessions/:sessionId/changes/triage': { answer: 'unchanged', why: VIA_DAEMON },
  'GET /api/v1/sessions/:id/changes': { answer: 'host', why: HOST_DAEMON },
  'GET /api/v1/sessions/:id/changes/file': { answer: 'host', why: HOST_DAEMON },
  'GET /api/v1/sessions/:id/changes/refs': { answer: 'unchanged', why: VIA_DAEMON },
  'GET /api/sessions/:sessionId/turns': { answer: 'unchanged', why: VIA_DAEMON },
  'GET /api/sessions/:sessionId/turns/:n/diff': { answer: 'unchanged', why: VIA_DAEMON },
  'GET /api/sessions/:sessionId/commit/plan': { answer: 'unchanged', why: VIA_DAEMON },
  'GET /api/sessions/:sessionId/commit/jobs': { answer: 'unchanged', why: VIA_DAEMON },
  'GET /api/sessions/:sessionId/commit/jobs/:jobId': { answer: 'unchanged', why: VIA_DAEMON },
  'GET /api/sessions/:sessionId/plan': { answer: 'unchanged', why: VIA_DAEMON },
  'GET /api/v1/sessions/:id/plan': { answer: 'unchanged', why: VIA_DAEMON },
  'GET /api/sessions/:sessionId/workflow': { answer: 'unchanged', why: VIA_DAEMON },
  'GET /api/v1/sessions/:id/workflow': { answer: 'unchanged', why: VIA_DAEMON },
  'GET /api/sessions/:sessionId/slash-commands': { answer: 'unchanged', why: VIA_DAEMON },
  'GET /api/sessions/:sessionId/vscode-uri': { answer: 'unchanged', why: VIA_DAEMON },
  'GET /api/sessions/:sessionId/servers': { answer: 'unchanged', why: VIA_DAEMON },
  // ── Sessions: settings and side state from the record ──
  'GET /api/sessions/:sessionId/controls': { answer: 'unchanged', why: RECORD_FIELDS },
  'GET /api/v1/sessions/:id/controls': { answer: 'unchanged', why: RECORD_FIELDS },
  'GET /api/sessions/:sessionId/settings': { answer: 'unchanged', why: RECORD_FIELDS },
  'GET /api/v1/sessions/:id/settings': { answer: 'unchanged', why: RECORD_FIELDS },
  'GET /api/sessions/:sessionId/permission-decisions': { answer: 'unchanged', why: RECORD_FIELDS },
  'GET /api/sessions/:sessionId/side-questions': { answer: 'unchanged', why: RECORD_FIELDS },
  'GET /api/v1/sessions/:id/side-questions': { answer: 'unchanged', why: RECORD_FIELDS },
  'GET /api/sessions/:sessionId/side-threads': { answer: 'unchanged', why: RECORD_FIELDS },
  'GET /api/sessions/:sessionId/supervision': { answer: 'unchanged', why: RECORD_FIELDS },
  'GET /api/v1/sessions/:id/thread-ai-calls': { answer: 'unchanged', why: RECORD_FIELDS },
  'GET /api/v1/sessions/:id/queue': { answer: 'unchanged', why: 'this replica\'s own message queue for the session (empty: a message here goes through follower.send)' },
  'GET /api/sessions/:sessionId/model-catalog': { answer: 'unchanged', why: 'the engine\'s model list from this replica\'s config copy' },
  'GET /api/sessions/:sessionId/models': { answer: 'unchanged', why: 'the engine\'s model list from this replica\'s config copy' },
  'GET /api/v1/sessions/:id/model-options': { answer: 'unchanged', why: 'the engine\'s model list from this replica\'s config copy' },
  'GET /api/sessions/:sessionId/cost': { answer: 'unchanged', why: 'the session\'s spend from this replica\'s own usage store, as for any session while away (the Mac counts usage)' },
  'GET /api/v1/sessions/:id/cost': { answer: 'unchanged', why: 'the phone\'s model sheet: the same spend as GET /api/sessions/:sessionId/cost from this replica\'s own usage store, and the budget its host\'s daemon knows (null when it does not answer)' },
  'GET /api/sessions/:sessionId/cost/compare': { answer: 'unchanged', why: 'the session\'s spend from this replica\'s own usage store, as for any session while away (the Mac counts usage)' },
}
