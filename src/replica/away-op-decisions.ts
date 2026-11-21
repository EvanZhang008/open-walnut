/**
 * What a host's follower does with each op a session or a plugin job on that host calls while
 * the leader is away (the `host-local-calls` capability: local-calls.ts runs the call through
 * the op's own routes, dispatch.ts decides each route by its row in route-table.ts):
 *
 *   host    answered here: a read from this replica's copies (with this host's journal folded
 *           over them), or a write journaled for the leader with its answer given now
 *   held    kept whole and run by the leader on its return (the caller hears it was held)
 *   leader  `needs_leader` with a reason: a session's call then falls back to the daemon's own
 *           offline answer (offline-host-core.ts handle) while that still exists; a plugin
 *           job's answer is final
 *
 * `by` names the module that answers a write here (or refuses it with its own reason) when the
 * route's row alone does not say it. One row per op in the registry (src/ops), checked by
 * tests/replica/away-op-decisions.test.ts: an op with no row, a stale row, or a row the route
 * table contradicts fails it. tools.list and walnut_status read it (capability-router.ts,
 * away-reads.ts) to tell a caller what answers here.
 */

export type AwayOpAnswer = 'host' | 'held' | 'leader'
export interface AwayOpDecision { answer: AwayOpAnswer; why: string; by?: string }

const read = (why = 'a read on this replica\'s copies (the route table\'s read default)'): AwayOpDecision => ({ answer: 'host', why })
const host = (why: string, by?: string): AwayOpDecision => ({ answer: 'host', why, ...(by ? { by } : {}) })
const leader = (why: string, by?: string): AwayOpDecision => ({ answer: 'leader', why, ...(by ? { by } : {}) })
/** A write route with no away row: route-table.ts answers needs_leader. */
const macWrite = (what: string): AwayOpDecision => leader(`${what} is the leader's to write; its route has no away row (needs_leader)`)

/** An op only a session on the Mac may run: the follower answers it as the leader does, with the refusal. */
const LOCAL_ONLY = 'refused for a session off the Mac, here as on the leader (the op is localHostGateway: ops/executor.ts originRefusal)'

const CALLS = 'src/replica/away-calls.ts'
const TRIGGERS = 'src/replica/away-triggers.ts'
const SENDS = 'src/replica/away-sends.ts'
const STARTS = 'src/replica/away-starts.ts'
const WRITES = 'src/replica/away-writes.ts'
const NOTES = 'src/replica/away-notes.ts'

export const AWAY_OP_DECISIONS: Readonly<Record<string, AwayOpDecision>> = {
  // ── tasks ──
  task_list: read('the task copy with this host\'s journal folded over it, tasks made here included (away-reads.ts)'),
  task_get: read('the task copy folded with this host\'s journal; a task made here answers from the overlay with its session (away-reads.ts)'),
  task_get_bulk: read('each projected row folded with this host\'s journal; a task made here is projected, not "not found" (away-reads.ts)'),
  task_create: host('journaled as task-create (and started here when it asks to); a `need` placement asks the fleet, which needs the leader', WRITES),
  task_update: host('queueable fields journaled as task-fields, checked by the leader\'s field rules; a `report` line or another field needs the leader', WRITES),
  task_update_bulk: host('each row as task_update: journaled as task-fields', WRITES),
  task_complete: host('journaled as task-fields (phase COMPLETE)', WRITES),
  task_complete_bulk: host('each row as task_complete: journaled as task-fields', WRITES),
  task_note_write: host('a replace (the default) is the note field, journaled as task-fields; an append needs the leader (task_writes_need_mac)', WRITES),
  task_report_set: macWrite('The status line'),
  task_not_done_settle: macWrite('A not-done settle'),
  task_ask_answer_withdraw: macWrite('Withdrawing an answer'),
  task_merge: leader('merging tasks rewrites both rows and their sessions: task_writes_need_mac'),
  task_delete: leader('a delete is the leader\'s: task_writes_need_mac'),
  task_pin_set: host('a pin or unpin is a Focus write journaled for the leader', WRITES),
  task_focus_tier_set: host('a tier change journaled as task-move', WRITES),
  task_move: macWrite('Moving a task to another project or folder'),
  task_start: host('a task made on this host while away starts here from the leader\'s template; a task made on the leader, a resume or another host needs the leader', STARTS),
  task_stop: macWrite('Stopping a task\'s session or start queue'),
  task_restart: macWrite('Restarting a session'),
  task_switch_engine: macWrite('Switching a task\'s engine'),
  task_session_set: macWrite('Changing a running session\'s model or effort'),
  task_transfer: macWrite('A transfer to another Walnut'),
  transfer_get: read('this server\'s own transfer jobs; a transfer starts only on the leader (task_transfer), so one it runs reads transfer_not_found here until it is back'),
  task_watch: macWrite('A watch on a task'),
  task_make_local: macWrite('Making a synced task local'),
  task_sync_to_project: macWrite('Syncing a task to its project\'s provider'),
  task_history: read('the task\'s conversation: a session on this host is read here (self-host.ts, host-history.ts), one elsewhere needs the leader'),
  task_sessions: read('the sessions copy; a task made here lists its sessions here (away-reads.ts)'),
  task_dir: read(),
  tag_display_list: read(),
  tag_display_set: macWrite('Tag display settings'),
  team_stop: macWrite('Stopping a team'),
  team_resume: macWrite('Resuming a team'),

  // ── messages and requests ──
  task_send: host('a send to a session running here, a reply asked for or not, and an in_reply_to answer are delivered here; a target not running here is held for the leader', SENDS),
  session_send: host('as task_send (deprecated name)', SENDS),
  session_start: host('as task_start (deprecated name)', STARTS),
  request_get: read('the requests copy with the requests this host opened or settled alone folded over it (away-requests.ts)'),
  open_items: read('the caller\'s task, its subtasks, and its open requests both ways: the requests copy plus this host\'s own (away-requests.ts)'),
  message_send_now: macWrite('Sending a queued message now'),
  op_result: read('this server\'s own record of an op call it ran (op-calls.ts)'),

  // ── sessions and status ──
  session_list: read('the sessions copy plus the sessions this host started alone, this host\'s with their state now (away-read-folds.ts)'),
  session_transcript: read('a session on this host is read here; one elsewhere needs the leader (session_on_mac)'),
  walnut_status: host('this replica\'s status, saying the leader is away, what waits for it and what answers here', 'src/replica/away-read-folds.ts'),
  app_state: read(),
  status_check: read(),
  search: read('the search copy this host keeps, with the tasks made here that match first (away-read-folds.ts)'),

  // ── memory, notes, skills ──
  memory_read: read(),
  memory_write: macWrite('The user\'s memory'),
  agent_memory_read: read(),
  agent_memory_write: host('an append to MEMORY.md is journaled as agent-memory, a named file is held for the leader; a replace needs the leader', CALLS),
  agent_skill_read: read(),
  agent_skill_write: macWrite('A skill file'),
  brief_read: read(),
  brief_write: macWrite('A Brief'),
  note_read: read('the notes this host keeps (notes-source.ts)'),
  note_write: host('journaled as a note record (note-write rows)', NOTES),
  note_edit: host('journaled as a note record (note-write rows)', NOTES),
  note_attach: leader('an attachment needs the leader: note_changes_need_mac'),
  note_search: read('the notes this host keeps'),
  skill_read: read(),

  // ── projects and folders ──
  project_list: read(),
  project_create: macWrite('A new project'),
  project_delete: macWrite('Deleting a project'),
  project_metadata_get: read(),
  project_metadata_update: macWrite('Project settings'),
  project_tracking_get: read(),
  project_tracking_ensure: host('a project whose tracking note is recorded: its note is read here, or written as a note record (note-write) when missing; one with no recorded note needs the leader to record it (project metadata: project_writes_need_mac)'),
  project_make_local: macWrite('Making a project local'),
  folder_list: read(),
  folder_create: leader('a new folder needs the leader: task_writes_need_mac'),
  folder_move: leader('moving a folder needs the leader: task_writes_need_mac'),
  folder_add_tasks: leader('filing tasks into a folder needs the leader: task_writes_need_mac'),

  // ── boards ──
  board_get: read('the Board copy with this host\'s journaled Board writes applied (away-reads.ts overlayBoard)'),
  board_set: host('journaled as a board record, checked against the Board shown here', WRITES),
  board_edit: host('journaled as a board record, checked against the Board shown here', WRITES),
  board_post: host('journaled as a board record under a post id minted here', WRITES),
  board_project_set: host('journaled as a board record', WRITES),
  board_post_delete: macWrite('Deleting a Board post'),
  board_remind: macWrite('A Board reminder'),
  board_lanes_set: macWrite('A Board\'s lanes'),
  board_card_set: macWrite('A Board card'),

  // ── org and threads ──
  org_get: read(),
  org_send: leader('a letter to a node goes through the leader\'s org contact route (needs_leader)'),
  org_vp_set: macWrite('An org VP'),
  org_node_create: macWrite('A new org node'),
  org_node_edit: macWrite('An org node'),
  org_avatar_set: macWrite('An avatar'),
  org_duty_set: macWrite('A node\'s duty'),
  org_report: macWrite('An org report'),
  org_pin: macWrite('An org pin'),
  thread_list: read(),
  thread_create: macWrite('A new thread'),
  thread_update: macWrite('A thread'),
  thread_split: macWrite('Splitting a thread'),
  thread_file: macWrite('Filing a thread'),
  thread_move: macWrite('Moving a thread'),
  topic_list: read(),
  topic_read: read(),
  topic_create: macWrite('A new topic'),
  topic_post: macWrite('A topic post'),
  topic_members: macWrite('Topic members'),
  topic_close: macWrite('Closing a topic'),
  topic_mail: macWrite('A topic mail'),
  router_context: leader('routing is kept on the leader: its route answers not_supported_cloud on every follower', 'src/web/routes/router-v1.ts'),
  router_create: macWrite('A router'),
  router_update: macWrite('A router'),
  router_list_self: macWrite('A router\'s links'),
  router_route: macWrite('Routing a message'),
  feature_node_connections: read(),

  // ── inbox and triage ──
  human_inbox_send: host('a letter checked by the leader\'s letter rules, journaled as a letter record with its body as a blob', CALLS),
  human_inbox_reply: macWrite('A reply in a letter\'s thread'),
  human_inbox_list: read('the inbox copy, as the leader last shipped it to this replica'),
  human_inbox_get: read('the inbox copy and its bodies'),
  human_inbox_mark: macWrite('A letter\'s state'),
  human_inbox_answer: macWrite('An answer to a letter'),
  triage_rule_list: read(),
  triage_rule_set: macWrite('A triage rule'),
  triage_rule_delete: macWrite('Deleting a triage rule'),
  triage_route: macWrite('Routing by a triage rule'),

  // ── triggers ──
  trigger_list: host('the routines copy with this host\'s own triggers over it (follower.triggers)', TRIGGERS),
  trigger_create: host('validated by the leader\'s rules, armed here at once and journaled as the op record the leader replays', TRIGGERS),
  trigger_test: host('the check run once on this host (follower.trigger.test)', TRIGGERS),
  trigger_pause: host('a trigger this host runs: paused here and journaled', TRIGGERS),
  trigger_resume: host('a trigger paused here: resumed and journaled', TRIGGERS),
  trigger_delete: host('a trigger this host runs: removed here and journaled', TRIGGERS),
  trigger_update: leader('any change but on/off needs the leader (trigger_update)', TRIGGERS),
  trigger_templates: read(),
  trigger_template_check: macWrite('A template check'),

  // ── health, places, time ──
  health_status: host(LOCAL_ONLY),
  health_sleep: host(LOCAL_ONLY),
  health_daily: host(LOCAL_ONLY),
  health_series: host(LOCAL_ONLY),
  health_samples: host(LOCAL_ONLY),
  health_recordings: host(LOCAL_ONLY),
  day_review: host(LOCAL_ONLY),
  health_monitor: leader('the health monitor runs on the leader only: its route answers not_running on every follower', 'src/web/routes/health-monitor-v1.ts'),
  health_alarm_set: macWrite('A health alarm'),
  health_monitor_settings: macWrite('Health monitor settings'),
  places_status: host(LOCAL_ONLY),
  places_visits: host(LOCAL_ONLY),
  places_label_set: macWrite('A place label'),
  time_summary: leader('time tracking is the leader\'s: its route answers not_supported_cloud on every follower', 'src/web/routes/time.ts'),
  time_report: leader('time tracking is the leader\'s: its route answers not_supported_cloud on every follower', 'src/web/routes/time-report.ts'),
  time_timeline: host(LOCAL_ONLY),
  time_work_hours_set: macWrite('Work hours'),
  time_meeting_attendance_set: macWrite('Meeting attendance'),
  time_meetings_ignore_set: macWrite('Ignored meetings'),

  // ── plugins, MCP, hints ──
  plugin_settings: read('the config copy (plugins themselves run on the leader)'),
  plugin_settings_set: macWrite('Plugin settings'),
  mcp_servers: read('this replica\'s view of the MCP servers (the route default); not checked against the leader\'s'),
  mcp_tools: read('this replica\'s view of the MCP servers (the route default); not checked against the leader\'s'),
  mcp_read: macWrite('An MCP resource read (a POST)'),
  mcp_call: macWrite('An MCP tool call'),
  hint_list: read(),
  hint_set: macWrite('A hint'),
  hint_reset: macWrite('A hint'),
  workspace_providers: read(),
  link_check: host('runs in this server\'s own process: no route'),
  api: host('any route: answered by that route\'s own row here (reads on the copies; a write without an away row needs the leader)'),

  // ── hosts, exec, copies ──
  host_list: leader('the fleet is the leader\'s: fleet_needs_mac'),
  host_get: leader('the fleet is the leader\'s: fleet_needs_mac'),
  host_load: leader('the fleet is the leader\'s: fleet_needs_mac'),
  host_profile_get: read(),
  host_exec: leader('a command on a host goes through the leader: host_exec_needs_mac'),
  host_exec_read: leader('a command on a host goes through the leader: host_exec_needs_mac'),
  host_exec_list: leader('a command on a host goes through the leader: host_exec_needs_mac'),
  host_exec_stop: leader('a command on a host goes through the leader: host_exec_needs_mac'),
  host_exec_pinned: macWrite('A pinned host command'),
  host_mcp_list: leader('MCP on a host goes through the leader: its route answers leader_only on every follower', 'src/web/routes/host-exec-v1.ts'),
  host_mcp_tools: leader('MCP on a host goes through the leader: its route answers leader_only on every follower', 'src/web/routes/host-exec-v1.ts'),
  host_mcp_result: leader('MCP on a host goes through the leader: its route answers leader_only on every follower', 'src/web/routes/host-exec-v1.ts'),
  host_mcp_call: macWrite('An MCP call on a host'),
  host_http: macWrite('An HTTP call through a host'),
  host_copy: leader('a copy between hosts goes through the leader: host_copy_needs_mac'),
  host_copy_result: leader('a copy between hosts goes through the leader: host_copy_needs_mac'),
  host_daemon_update: leader('a daemon update goes through the leader: host_exec_needs_mac'),

  // ── secrets, approvals, vault, browser ──
  secret_list: leader('secrets are the leader\'s: secrets_need_mac'),
  approval_list: leader('approvals are kept on the leader: its route answers leader_only on every follower', 'src/web/routes/approvals-v1.ts'),
  approval_request: macWrite('An approval request'),
  approval_wait: macWrite('Waiting on an approval'),
  approval_consume: macWrite('Using an approval'),
  approval_cancel: macWrite('Cancelling an approval'),
  password_list: leader('the vault is the leader\'s: its route answers vault_not_here on every follower', 'src/web/routes/vault-agent-v1.ts'),
  password_use: macWrite('Using a password'),
  password_wait: macWrite('Waiting on a password'),
  password_cancel: macWrite('Cancelling a password use'),
  password_sync_bitwarden: macWrite('A vault sync'),
  browser: macWrite('A browser action'),
  browser_status: read(),
  security_alert_check: leader('the browser runs on the leader: its route answers unavailable (503) on every follower', 'src/web/routes/browser-v1.ts'),

  // ── subagents ──
  subagent_run: macWrite('A subagent run'),
  subagent_send: macWrite('A message to a subagent'),
  subagent_read: leader('subagents run through the leader: its route answers leader_only on every follower', 'src/web/routes/subagents-v1.ts'),
  subagent_stop: macWrite('Stopping a subagent'),
  op_card_record: macWrite('An op card record (deprecated)'),
}

/** The ops a host's follower answers itself while the leader is away (`host` and `held` rows). */
export function opsAnsweredHere(): string[] {
  return Object.entries(AWAY_OP_DECISIONS).filter(([, d]) => d.answer !== 'leader').map(([name]) => name)
}
