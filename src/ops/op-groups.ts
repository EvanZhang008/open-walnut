/**
 * op-groups.ts: every Walnut op belongs to exactly one group, and a role lists some groups.
 *
 * Why (2026-11-21, the user: "way too many tools in mcp, is there a way to organize them"): a
 * session listed about 240 Walnut tools in one flat list, almost half of them admin, setup or
 * plugin surface it never touches (127 of 276 ops had no call in 7 days). The groups give the
 * catalog a shape (`walnut tools list`, `tool_help`), and under the experiment
 * `mcp_tools_by_role` a Claude Code session lists only the groups its role uses.
 *
 * The table lives HERE, apart from the op definitions, so placing an op is one line in one file.
 * A core op is placed by its exact name or by its family's name prefix (an exact name wins, then
 * the longest prefix). A prefix is only for a closed family whose new member obviously belongs
 * with it (trigger_, board_); a new task_ op is placed by hand. A plugin op is in
 * `plugin:<plugin id>`, which no role lists. tests/unit/ops/op-groups.test.ts fails on a core op that
 * no group holds, so a new op cannot be left out.
 *
 * LISTING ONLY: a group or a role never decides whether an op runs. Every op stays callable by
 * name over MCP (both servers run an unlisted op as they run a deprecated one), through the CLI
 * (`walnut tools call <op>`) and through `tool_call`.
 *
 * Pure and dependency-free: the hub's MCP server, the CLI and the server's gateway import it.
 */

export interface OpGroupDef {
  id: string
  /** One line: what the group's tools are for. */
  title: string
  /** Exact op names. */
  ops?: readonly string[]
  /** Name prefixes of a closed family. */
  prefixes?: readonly string[]
}

/** The groups, in the order a catalog shows them: the ones a worker lists first. */
export const OP_GROUPS: readonly OpGroupDef[] = [
  {
    id: 'tasks', title: 'Find, start, message, update and close tasks',
    ops: [
      'task_list', 'task_get', 'task_get_bulk', 'task_create', 'task_update', 'task_complete', 'task_send',
      'task_history', 'task_start', 'task_stop', 'task_watch', 'task_dir', 'task_sessions', 'task_note_write',
      'task_report_set', 'task_not_done_settle', 'project_list',
      // Old names, still callable, never listed (registry.ts `deprecated`).
      'session_list', 'session_transcript', 'session_start', 'session_send',
    ],
  },
  {
    id: 'lookup', title: 'Search, what is open for you, call results, status, the app beside you, any other route',
    ops: ['search', 'open_items', 'op_result', 'request_get', 'walnut_status', 'app_state', 'api', 'op_card_record'],
  },
  {
    id: 'memory', title: 'Your memory folder and skills, the user\'s memory, Walnut\'s skills',
    ops: ['memory_read', 'memory_write', 'agent_memory_read', 'agent_memory_write', 'agent_skill_read', 'agent_skill_write', 'skill_read'],
  },
  { id: 'notes', title: 'The user\'s notes: search, read, write, edit, attach, and an ask to read a locked one', prefixes: ['note_', 'locked_note_'] },
  {
    id: 'hosts', title: 'Run commands, copy files and use MCP servers or web services on a host, and see the hosts',
    ops: [
      'host_exec', 'host_exec_read', 'host_exec_pinned', 'host_exec_stop', 'host_exec_list', 'host_copy', 'host_copy_result',
      'host_list', 'host_get', 'host_load', 'host_http',
    ],
    // The fleet line every session reads names host_mcp_list, host_mcp_call and host_http (hosts/fleet-prompt.ts).
    prefixes: ['host_mcp_'],
  },
  { id: 'triggers', title: 'Watches: a check script that wakes a session when something changes', ops: ['usage_watch'], prefixes: ['trigger_'] },
  { id: 'subagents', title: 'Walnut subagents: start one, message it, read it, stop it', prefixes: ['subagent_'] },
  { id: 'browser', title: 'The user\'s own browser', ops: ['browser', 'browser_status'] },
  { id: 'board', title: 'A team\'s Board: sections, cards, posts, lanes, reminders', prefixes: ['board_'] },
  { id: 'threads', title: 'Threads: the user\'s requests, one per subject', prefixes: ['thread_'] },
  { id: 'inbox', title: 'Letters to the user and his answers', prefixes: ['human_inbox_'] },
  { id: 'brief', title: 'The Brief of Main or a VP', ops: ['brief_read', 'brief_write'] },
  { id: 'org', title: 'The org: Main, the VPs, their duties and reports', prefixes: ['org_'] },
  {
    id: 'task_admin', title: 'Rearrange work: move, merge, pin, bulk edits, restarts, engines, transfers, whole teams',
    ops: [
      'task_move', 'task_merge', 'task_pin_set', 'task_focus_tier_set', 'task_restart', 'task_switch_engine',
      'task_update_bulk', 'task_complete_bulk', 'task_ask_answer_withdraw', 'message_send_now', 'task_delete',
      'task_session_set', 'task_transfer', 'transfer_get', 'team_stop', 'team_resume',
    ],
  },
  { id: 'alarms', title: 'Walnut\'s own health alarms', ops: ['health_monitor', 'health_alarm_set', 'health_monitor_settings'] },
  {
    id: 'projects', title: 'Projects and folders: create, settings, tracking, private copies, workspaces',
    ops: ['task_make_local', 'task_sync_to_project', 'workspace_providers'],
    prefixes: ['project_', 'folder_'],
  },
  { id: 'topics', title: 'Topics: group chats of tasks', prefixes: ['topic_'] },
  { id: 'routing', title: 'Routers and the inbox triage rules', prefixes: ['router_', 'triage_'] },
  { id: 'approvals', title: 'Approvals, passwords and the secrets shared with hosts', ops: ['secret_list'], prefixes: ['approval_', 'password_'] },
  { id: 'health', title: 'The user\'s health data, places and day reviews', ops: ['day_review'], prefixes: ['health_', 'places_'] },
  { id: 'time', title: 'Where the user\'s time went: reports, timelines, work hours, meetings', prefixes: ['time_'] },
  {
    id: 'mcp', title: 'The MCP servers Walnut runs here, and a host\'s daemon and profile',
    ops: ['host_daemon_update', 'host_profile_get'],
    prefixes: ['mcp_'],
  },
  { id: 'checks', title: 'Checks Walnut runs: task statuses, the mode you may start work in, links in a text, feature nodes, security alerts', ops: ['status_check', 'task_start_check', 'link_check', 'reply_language_check', 'feature_node_connections', 'security_alert_check'] },
  { id: 'settings', title: 'Plugin settings, message hints and tag display', ops: ['plugin_settings', 'plugin_settings_set'], prefixes: ['hint_', 'tag_display_'] },
]

/** A core op no group holds (the guard test keeps it empty); listed for every role, never hidden. */
export const OTHER_GROUP = 'other'

/** The group of every plugin op: `plugin:<plugin id>`. */
export const PLUGIN_GROUP_PREFIX = 'plugin:'

const byName = new Map<string, string>()
for (const g of OP_GROUPS) for (const name of g.ops ?? []) byName.set(name, g.id)
const byPrefix: Array<{ prefix: string; id: string }> = OP_GROUPS
  .flatMap((g) => (g.prefixes ?? []).map((prefix) => ({ prefix, id: g.id })))
  .sort((a, b) => b.prefix.length - a.prefix.length)
const titles = new Map(OP_GROUPS.map((g) => [g.id, g.title]))
const order = new Map(OP_GROUPS.map((g, i) => [g.id, i]))

/** The group a core op's name places it in, or undefined when none does. */
export function coreGroupOf(name: string): string | undefined {
  return byName.get(name) ?? byPrefix.find((p) => name.startsWith(p.prefix))?.id
}

/** The group of one op: its table group (core), `plugin:<owner>` (a plugin's), or OTHER_GROUP. */
export function groupOfOp(name: string, owner: string = 'core'): string {
  if (owner !== 'core') return `${PLUGIN_GROUP_PREFIX}${owner}`
  return coreGroupOf(name) ?? OTHER_GROUP
}

/** What a group's tools are for ('' for one the table does not name). */
export function groupTitle(id: string): string {
  if (id.startsWith(PLUGIN_GROUP_PREFIX)) return `The ${id.slice(PLUGIN_GROUP_PREFIX.length)} plugin`
  if (id === OTHER_GROUP) return 'Not placed in a group yet'
  return titles.get(id) ?? ''
}

/** Sorts group ids the way a catalog shows them: the table's order, then plugins by name, then other. */
export function compareGroups(a: string, b: string): number {
  const rank = (id: string) => order.get(id) ?? (id === OTHER_GROUP ? OP_GROUPS.length + 1 : OP_GROUPS.length)
  return rank(a) - rank(b) || a.localeCompare(b)
}

/** One catalog section: a group, its title and how many ops it holds. */
export interface GroupSummary { id: string; title: string; count: number }

/** The sections of a catalog, in catalog order, from its rows' groups. */
export function summarizeGroups(rows: ReadonlyArray<{ group?: string }>): GroupSummary[] {
  const counts = new Map<string, number>()
  for (const r of rows) { const g = r.group ?? OTHER_GROUP; counts.set(g, (counts.get(g) ?? 0) + 1) }
  return [...counts.keys()].sort(compareGroups).map((id) => ({ id, title: groupTitle(id), count: counts.get(id)! }))
}

/**
 * Who a Claude Code session is, for what it lists (the experiment `mcp_tools_by_role`):
 *   worker         an ordinary task session
 *   thread_keeper  a task that keeps Threads (org/keeps-threads.ts) but is no org node
 *   org            Main, a VP (a lead), an Ask of the Personal AI
 * A router keeps its own four ops (router/gateway-policy.ts) and never gets a role here.
 */
export type ListingRole = 'worker' | 'thread_keeper' | 'org'

export const LISTING_ROLES: readonly ListingRole[] = ['worker', 'thread_keeper', 'org']

/** The groups a worker lists: its own work, hosts, watches, helpers and a team's Board. */
const WORKER_GROUPS = ['tasks', 'lookup', 'memory', 'notes', 'hosts', 'triggers', 'subagents', 'browser', 'board'] as const

/**
 * What each role lists: whole groups, plus single ops every session's own instructions name
 * (the charter names thread_list). Every role lists the inbox: a task that sends a letter also
 * reads, marks and answers it (5 days of real sessions, 2026-11-26: of 13,581 Walnut MCP calls by
 * tasks, 45 were to tools this table did not list for them, 17 of those human_inbox_ ones; Main and
 * the VPs made 2,096 calls, none to a tool they do not list).
 *
 * Plugin ops (`allPlugins`): a plugin is one the user installed and turned on for himself, and
 * Main, the VPs and his asks are where his requests about it land ("check my mail", "what is on my
 * calendar"), so the org lists every plugin's tools. Nothing in a prompt names them (a plugin's
 * tools are named by the user's words), so there is no narrower signal there. A worker lists a
 * plugin's tools only when its task comes from that plugin (Task.source, the plugin that syncs its
 * project: ToolListing.plugins); any other plugin op it reaches through the CLI.
 */
/** A sign-in in the user's browser (the browser group every role lists): the walnut-passwords skill names them. */
const SIGN_IN_OPS = ['password_use', 'password_wait'] as const

export const ROLE_LISTINGS: Readonly<Record<ListingRole, { groups: readonly string[]; ops: readonly string[]; allPlugins: boolean }>> = {
  worker: { groups: [...WORKER_GROUPS, 'inbox'], ops: ['thread_list', ...SIGN_IN_OPS], allPlugins: false },
  thread_keeper: { groups: [...WORKER_GROUPS, 'threads', 'inbox'], ops: SIGN_IN_OPS, allPlugins: false },
  org: { groups: [...WORKER_GROUPS, 'threads', 'inbox', 'brief', 'org', 'task_admin', 'alarms'], ops: SIGN_IN_OPS, allPlugins: true },
}

/** What one session lists: its role, and the plugins its task uses (a worker lists only those plugins' ops). */
export interface ToolListing { role: ListingRole; plugins?: readonly string[] }

/** Whether a role (or a session's listing) lists the op. Listing only: an op it does not list still runs by name. */
export function listedForRole(listing: ListingRole | ToolListing, name: string, owner: string = 'core'): boolean {
  const { role, plugins = [] } = typeof listing === 'string' ? { role: listing } : listing
  const spec = ROLE_LISTINGS[role]
  if (owner !== 'core') return spec.allPlugins || plugins.includes(owner)
  if (spec.ops.includes(name)) return true
  const group = groupOfOp(name, owner)
  return group === OTHER_GROUP || spec.groups.includes(group)
}

/** The role an env value names (WALNUT_MCP_ROLE), or undefined for none or an unknown one. */
export function listingRoleOf(value: unknown): ListingRole | undefined {
  return typeof value === 'string' && (LISTING_ROLES as readonly string[]).includes(value.trim()) ? value.trim() as ListingRole : undefined
}

/** The env var the hub's MCP mount reads its role from (core/sessions/profiles.ts walnutMcpProfile sets it). */
export const WALNUT_MCP_ROLE_ENV = 'WALNUT_MCP_ROLE'

/** The experiment that turns per-role listing on (core/experimental.ts). */
export const ROLE_LISTING_EXPERIMENT = 'mcp_tools_by_role'
