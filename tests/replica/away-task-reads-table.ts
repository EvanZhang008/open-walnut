/**
 * Every read of one task or one session the leader serves, and what a host replica answers for
 * it while the Mac is away when the task was made on this host or its session runs here
 * (docs/plan/one-service-every-host.md, "Phase 1 as built"). The ratchet in
 * tests/replica/route-table-coverage.test.ts walks the real app: a new GET route under
 * /api/tasks, /api/v1/tasks, /api/sessions or /api/v1/sessions with an id in its path (and the
 * task lists) fails it until a row here decides it.
 *
 *   host       answered on this host, in the shape the leader gives
 *   leader     a clean 503 needs_leader with its why (never a wrong "not found" or "unknown")
 *   unchanged  answered from this replica's copies as for any task or session while away; not a
 *              read that follows a task started here (the reason says what it reads)
 */
export type AwayTaskReadDecision = { answer: 'host' | 'leader' | 'unchanged'; why: string }

const ROW = 'the copy row with the journal and the session started here folded in (overlay.ts, task-row-fold.ts)'
const MADE_HERE = 'a task made here that its route cannot find: 503 task_made_here_needs_mac (away-reads.ts); a task of the copy: its route as before'
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
  'GET /api/sessions/:sessionId/cost/compare': { answer: 'unchanged', why: 'the session\'s spend from this replica\'s own usage store, as for any session while away (the Mac counts usage)' },
}
