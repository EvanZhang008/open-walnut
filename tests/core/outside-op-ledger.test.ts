/**
 * Ledger: every op that answers data says whose words its answer carries.
 *
 * 2026-11-26, issue #23 and its review (M2, M3, M4, M5): an agent with no mail op read the newest
 * mails through trigger_template_check, calendar titles through time_timeline, a mail plugin's letter
 * subjects through org_report. Each was a core op nobody had asked "does this answer quote an outside
 * party?". So every op that answers data (every readonly op, plus the ones below that answer content
 * from a write route) is classified here:
 *
 * - `outside`: its answer carries words an outside party wrote, and it frames them for an agent
 *   (core/outside-content.ts); `by` names the file and the function that does it.
 * - `plain`: its answer is Walnut's own, the user's, or an agent's own words; `why` says which.
 * - `gap`: it carries outside words and does not frame them yet. A known debt, named so it is not
 *   forgotten: the list may only shrink.
 *
 * A core op that declares `outside` (an MCP tool's answer) is framed by the executor and is ledgered
 * as outside with that frame, a write op too. A plugin op (op.outside set by the plugin host) is
 * framed the same way and is not listed. A new op fails here until someone classifies it.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { listOpEntries } from '../../src/ops/index.js'
import { outsideApiRouteOf } from '../../src/ops/outside-api-routes.js'

const ROOT = path.resolve(import.meta.dirname, '../..')

/** Ops that answer content from a write route, classified with the readonly ones. */
const DATA_WRITE_OPS = ['org_report', 'trigger_template_check', 'trigger_test'] as const

type Entry =
  /** `via`: for a handler op with no `bind`, the route(s) it reads the outside words from. */
  | { kind: 'outside'; how: string; by: `${string}.ts:${string}`; via?: readonly string[] }
  | { kind: 'plain'; why: string }
  | { kind: 'gap'; why: string }

const plain = (why: string): Entry => ({ kind: 'plain', why })
const USERS = 'the user\'s own data'

const LEDGER: Readonly<Record<string, Entry>> = {
  // Outside words, framed.
  day_review: { kind: 'outside', how: 'calendar event titles in one envelope under calendar.items', by: 'src/ops/day-review.ts:frameOutsideData', via: ['/api/plugins/calendar/events'] },
  human_inbox_get: { kind: 'outside', how: 'an outside letter\'s words, turns and mail items in envelopes (letter-outside.ts says which)', by: 'src/ops/letter-rows.ts:readLetter', via: ['/human-inbox/:id', '/human-inbox/:id/body'] },
  human_inbox_list: { kind: 'outside', how: 'an outside letter\'s subject, preview, options and answered label in one envelope per row', by: 'src/ops/letter-rows.ts:envelope', via: ['/human-inbox'] },
  router_context: { kind: 'outside', how: 'what the item\'s sender wrote in one envelope, Walnut\'s fields beside it in their shape', by: 'src/core/router/context-frame.ts:frameRouterContext', via: ['/router/context'] },
  time_timeline: { kind: 'outside', how: 'days and sources (calendar titles, plugin labels) in one envelope', by: 'src/ops/time-outside.ts:framedTimeline' },
  time_report: { kind: 'outside', how: 'the item group\'s rows (plugin item labels) in one envelope', by: 'src/ops/time-outside.ts:framedReportItems' },
  trigger_template_check: { kind: 'outside', how: 'the plugin\'s items in one envelope for a session; plain for the stored check', by: 'src/ops/trigger-test-frame.ts:framedTemplateCheck', via: ['/trigger-templates/:template/check'] },
  trigger_test: { kind: 'outside', how: 'what the script printed in one envelope under result.output', by: 'src/ops/trigger-test-frame.ts:framedTestRun' },
  org_report: { kind: 'outside', how: 'subjects it quotes of outside letters replaced by a reference, the subjects in one envelope', by: 'src/core/org/report-outside.ts:agentReport', via: ['/org/report'] },

  app_state: { kind: 'outside', how: 'each App\'s state (plugin-written JSON) in one envelope, its label beside it', by: 'src/ops/work.ts:frameOutsideData' },
  topic_read: { kind: 'outside', how: 'a person member\'s message (by mail) with its text in one envelope; the user\'s, agents\' and Walnut\'s plain', by: 'src/ops/topics.ts:framedTopicRead', via: ['/api/topics/:id'] },
  topic_list: { kind: 'outside', how: 'the last message\'s line in one envelope when a person member (by mail) wrote it', by: 'src/ops/topics.ts:framedTopicList', via: ['/api/topics'] },
  // An MCP tool's answer: the op declares `outside` (outside-answer.ts MCP_ANSWER_OUTSIDE) and the executor frames it.
  mcp_read: { kind: 'outside', how: 'the tool\'s text, data and content in one envelope, isError beside it', by: 'src/ops/outside-answer.ts:frameOpAnswer' },
  mcp_call: { kind: 'outside', how: 'as mcp_read', by: 'src/ops/outside-answer.ts:frameOpAnswer' },
  host_mcp_call: { kind: 'outside', how: 'the tool\'s text and structured answer in one envelope, the call\'s status beside it', by: 'src/ops/outside-answer.ts:frameOpAnswer' },
  host_http: { kind: 'outside', how: 'the fetched body and headers in one envelope, status, url and timing beside it', by: 'src/ops/outside-answer.ts:frameOpAnswer' },
  host_mcp_result: { kind: 'outside', how: 'as host_mcp_call; a call still running or a tools list is not framed', by: 'src/ops/outside-answer.ts:frameOpAnswer' },

  // Known gaps: outside words, not framed yet. None left; a new one needs GAP_MAX raised, which the ratchet refuses.

  // Walnut's, the user's or an agent's own words.
  agent_memory_read: plain('the node\'s own memory folder, written by its own session'),
  agent_skill_read: plain('the node\'s own skills, written by its own session'),
  approval_list: plain('Walnut\'s records of the asks its own ops made: the op, its target, the agent\'s stated reason, the user\'s answer'),
  board_get: plain('the team\'s Board, written by its leader\'s session, and the user\'s own marks on it'),
  brief_read: plain('the node\'s Brief: its own words for the user'),
  browser_status: plain('the user\'s browser settings: which browsers let agents in and the sites he allowed'),
  feature_node_connections: plain('Walnut\'s own connection log'),
  folder_list: plain(USERS),
  health_daily: plain('numbers from the user\'s own devices'),
  health_monitor: plain('Walnut\'s own alarms about itself'),
  health_recordings: plain('numbers from the user\'s own devices'),
  health_samples: plain('numbers from the user\'s own devices'),
  health_series: plain('numbers from the user\'s own devices'),
  health_sleep: plain('numbers from the user\'s own devices'),
  health_status: plain('which of the user\'s health types synced, and when'),
  hint_list: plain('Walnut\'s own message hints'),
  host_copy_result: plain('the result of a copy the caller started between the user\'s own hosts'),
  host_exec_list: plain('the commands agents ran on the user\'s own hosts'),
  host_exec_read: plain('the output of a command the agent ran on the user\'s own host, as its own shell output would be'),
  host_get: plain(USERS),
  host_list: plain(USERS),
  host_load: plain('Walnut\'s measure of the user\'s own hosts'),
  host_mcp_list: plain('the MCP servers the user configured on another host'),
  host_mcp_tools: plain('the tools of an MCP server the user configured, as Claude Code itself lists them to the model'),
  host_profile_get: plain(USERS),
  link_check: plain('Walnut\'s check of the links in the caller\'s own text: whether each exists'),
  mcp_servers: plain('the MCP servers the user configured'),
  mcp_tools: plain('the tools of an MCP server the user configured, as Claude Code itself lists them to the model'),
  memory_read: plain('the user\'s memory'),
  note_read: plain('the user\'s own notes'),
  note_search: plain('the user\'s own notes'),
  op_card_record: plain('internal: a receipt for the CLI\'s own record'),
  op_result: plain('Walnut\'s ledger of what one of the caller\'s own calls did'),
  open_items: plain('what is open for the caller: its own asks, tasks and letters'),
  org_get: plain('the user\'s org: its nodes and their tasks'),
  password_list: plain('names of the user\'s saved logins, never their values'),
  places_status: plain(USERS),
  places_visits: plain('where the user went: his own labels and the address his phone looked up, data and not prose'),
  plugin_settings: plain('the user\'s settings of his plugins'),
  project_list: plain(USERS),
  project_metadata_get: plain(USERS),
  project_tracking_get: plain('a project\'s tracking note, written by the user and his agents'),
  reply_language_check: plain('Walnut\'s verdict on the caller\'s own text'),
  request_get: plain('the state of the caller\'s own request'),
  search: plain('the user\'s tasks, memory and session transcripts; outside text in a transcript was framed when its session read it'),
  secret_list: plain('names of the user\'s secrets, never their values'),
  security_alert_check: plain('Walnut\'s sanitized records of its own browser and host actions'),
  session_list: plain('the user\'s sessions'),
  session_transcript: plain('a session\'s own turns, as the session panel shows them'),
  skill_read: plain('a skill the user installed'),
  subagent_read: plain('a subagent of the caller\'s own session: its state and its answer, its own words'),
  status_check: plain('Walnut\'s check of its own stored statuses'),
  tag_display_list: plain(USERS),
  task_dir: plain('the task\'s own folder'),
  task_get: plain('the user\'s tasks (a synced task\'s remote text is judged with the sync plugins, out of this ledger)'),
  task_get_bulk: plain('the user\'s tasks, as task_get'),
  task_history: plain('a task\'s conversation: the user\'s and its agents\' turns'),
  task_list: plain('the user\'s tasks, as task_get'),
  task_sessions: plain('the user\'s sessions of a task'),
  task_start_check: plain('Walnut\'s verdict on whether the caller may start a task'),
  thread_get: plain('the user\'s requests as a node filed them'),
  thread_list: plain('the user\'s requests as a node filed them'),
  time_summary: plain('minutes per day, no labels'),
  transfer_get: plain('the result of the caller\'s own transfer'),
  triage_rule_list: plain('the user\'s routing rules'),
  trigger_list: plain('triggers the user or his agents armed: names, prompts, schedules'),
  trigger_templates: plain('what the user\'s plugins offer to watch, in their own catalog words (as their op descriptions)'),
  walnut_status: plain('Walnut\'s own state'),
  workspace_providers: plain('the workspace providers this machine has, and their inputs'),
}

/** The known gaps may only shrink: framing one moves it to `outside`. 4 on 2026-11-26, 0 the same day. */
const GAP_MAX = 0

/** The executor's frame of an op that declares `outside` (registry.ts OpOutside). */
const EXECUTOR_FRAME = 'src/ops/outside-answer.ts:frameOpAnswer'

/** Core ops only: a plugin's op is framed by the executor on its own (server-api.ts sets `outside`). */
const coreOps = listOpEntries().filter((e) => e.owner === 'core').map((e) => e.op)
const dataOps = coreOps
  .filter((op) => op.tags.readonly || (DATA_WRITE_OPS as readonly string[]).includes(op.name) || !!op.outside)
  .map((op) => op.name)
  .sort()

describe('ledger: every op that answers data says whose words it carries', () => {
  it('every such op is classified, and every entry is still such an op', () => {
    const missing = dataOps.filter((name) => !(name in LEDGER))
    expect(missing, 'a new op answers data: classify it in LEDGER (outside with how it frames, plain with why)').toEqual([])
    expect(Object.keys(LEDGER).filter((name) => !dataOps.includes(name)).sort(), 'a ledger entry for an op that is gone or no longer answers data').toEqual([])
  })

  it('every outside entry names the function that frames it, in the file it says', () => {
    for (const [name, entry] of Object.entries(LEDGER)) {
      if (entry.kind !== 'outside') continue
      const [file, fn] = entry.by.split(':') as [string, string]
      const text = fs.readFileSync(path.join(ROOT, file), 'utf8')
      expect(text, `${name}: ${entry.by}`).toMatch(new RegExp(`\\b${fn}\\(`))
    }
  })

  it('every plain entry says why, and the known gaps only shrink', () => {
    for (const [name, entry] of Object.entries(LEDGER)) {
      if (entry.kind !== 'outside') expect(entry.why.length, name).toBeGreaterThan(12)
    }
    const gaps = Object.entries(LEDGER).filter(([, e]) => e.kind === 'gap').map(([name]) => name)
    expect(gaps.length, `known gaps: ${gaps.join(', ')}; frame one and lower GAP_MAX, never raise it`).toBeLessThanOrEqual(GAP_MAX)
  })
  it('an op the executor frames declares `outside`, and every core op that declares it is ledgered so', () => {
    for (const op of coreOps) {
      const entry = LEDGER[op.name]
      if (op.outside) expect(entry, `${op.name} declares outside`).toMatchObject({ kind: 'outside', by: EXECUTOR_FRAME })
      else if (entry?.kind === 'outside') expect(entry.by, `${op.name} names the executor's frame but declares no outside`).not.toBe(EXECUTOR_FRAME)
    }
  })

  it('the route of every outside op is framed when an agent reaches it through the api op', () => {
    // 2026-11-26 review R1: seven outside ops framed their answer, but `api` on their own route read it plain.
    const routed = (p: string) => (p.startsWith('/api/') ? p : `/api/v1${p}`).split('?')[0]!.replace(/:\w+/g, 'x')
    for (const op of coreOps) {
      const entry = LEDGER[op.name]
      if (entry?.kind !== 'outside') continue
      const paths = op.bind ? [op.bind.path] : entry.via ?? []
      expect(paths.length, `${op.name}: a handler op with no bind names the route(s) it reads outside words from in its entry's via`).toBeGreaterThan(0)
      for (const p of paths) {
        expect(outsideApiRouteOf(routed(p)), `${op.name}: ${routed(p)} answers outside words: add it to OUTSIDE_API_ROUTES (src/ops/outside-api-routes.ts)`).toBeDefined()
      }
    }
  })

  it('every core op that answers an MCP tool call frames it; only the catalog ops (servers, tools) read plain', () => {
    // A server's and its tools' names and descriptions are the user's configuration, as Claude Code lists them.
    const CATALOG = ['host_mcp_list', 'host_mcp_tools', 'mcp_servers', 'mcp_tools']
    const mcpOps = coreOps.filter((op) => /(^|_)mcp(_|$)/.test(op.name) || /\/mcp(\/|-|$)/.test(op.bind?.path ?? ''))
    const plainOnes = mcpOps.filter((op) => !op.outside).map((op) => op.name).sort()
    expect(plainOnes, 'a new op relays an MCP tool\'s answer: give it `outside: MCP_ANSWER_OUTSIDE` (outside-answer.ts)').toEqual(CATALOG)
    for (const op of mcpOps.filter((o) => o.outside)) expect(op.outside!.fields, op.name).toEqual(expect.arrayContaining(['text']))
  })
})
