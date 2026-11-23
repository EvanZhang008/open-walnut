/**
 * Every way a host reaches this leader, or this leader reaches it, and what a revoke does to each
 * (leader-issue.ts revokeHostDoorNow: a ban of the host's machine under any of its names,
 * revoked-hosts.ts). One row per member, keyed by where it lives in the source:
 *
 *   door                 the socket the host dials into this leader (host-door.ts)
 *   channel              its session channel, on either link (leader-side.ts, leader-apply.ts)
 *   start                a new session aimed at it, on any path (claude-code-session.ts)
 *   daemon-event:<ev>    each event its daemon sends up its link (daemon-connection.ts handleFrame
 *                        and the bulk socket's twin); `*` is the fan-out to the sessions' handlers
 *   daemon-answer, daemon-hello   the daemon's answers to this leader's commands, and its hello
 *   stream:<from>        each kind of stream the host opens toward this leader (streamEndpoint accept)
 *   journal:<kind>       each kind of its offline journal's records (offline-handover.ts applyRecord,
 *                        offline-merge/apply-v2.ts MAC_DRAINS)
 *   copy:<cmd>           each copy this leader pushes to its daemon (daemon-connection.ts repushCopy)
 *   op:<name>            each `host_*` op aimed at it (src/ops)
 *   send                 messages, stops and resumes of sessions this leader already runs there
 *
 * Refused: what the host would begin or write here. The person who revokes a host wants its new
 * work and its writes stopped, and the host's word is what they no longer take. Each such row
 * names the file whose check refuses it; every check goes through revokedAs.
 * Stays: what this leader itself aims at the host, and the answers to it. The person (or a session
 * here) chose it, the host cannot begin it, and only its answer comes back; to end those too,
 * remove the host from the config or turn it off.
 *
 * tests/core/session-channel/revoked-reach-ratchet.test.ts enumerates every member from the source
 * and fails on one this table does not classify. The revoke's answer lists the stays rows.
 */

export type Reach =
  | { verdict: 'refused'; what: string; check: string }
  | { verdict: 'stays'; what: string; why: string }

const refused = (what: string, check: string): Reach => ({ verdict: 'refused', what, check })
const stays = (what: string, why: string): Reach => ({ verdict: 'stays', what, why })

const RELAY_CHECK = 'src/providers/daemon-connection.ts'
const relay = (what: string): Reach => refused(`${what}, relayed by its daemon`, RELAY_CHECK)

const HELD = refused('its offline journal: held on the host, nothing read or acked, drained whole after an allow', 'src/core/offline-handover.ts')
/** Every kind of journal record: one row each, all held by the one check before the drain reads anything. */
const JOURNAL_KINDS = [
  // offline-handover.ts applyRecord (the first journal)
  'row', 'settle', 'delivery', 'op', 'settings', 'resume', 'stop',
  // offline-merge/apply-v2.ts MAC_DRAINS (the second journal and its actors)
  'task-fields', 'task-create', 'task-move', 'board', 'device-revoke', 'note', 'session', 'session-meta', 'inbox-state', 'chat-turn',
  'memory', 'note-move', 'note-attachment', 'conversation-edit', 'letter', 'inbox-reply', 'inbox-reply-pictures', 'inbox-reply-direct',
  'agent-memory', 'device-actor', 'routine-run', 'trigger-create', 'trigger-update', 'held-op', 'plugin-job-actor', 'task-start',
] as const

const AIMED = stays('host_exec, host_copy, host_http, host MCP and the other host_* ops a person or a session here aims at it',
  'the leader\'s own call: the host cannot begin one, and only its answer comes back (its own sessions\' calls are refused at the gateway)')
const READ_HERE = stays('host_list, host_get, host_profile_get and host_load', 'they read what this leader already holds of the host (its config row, its profile, its last load report)')
const COPIES = stays('the copies this leader pushes to its daemon (tasks, notes and memory for its replica, triggers, hooks, skills, its bridge setup)',
  'the leader\'s daemon link of a host in its config; what the host does with them comes back only through the refused rows')

export const REVOKED_REACH: Readonly<Record<string, Reach>> = {
  door: refused('its door: the record keeps no key, so no socket proves itself, and nothing is issued to it', 'src/core/session-channel/host-door.ts'),
  issue: refused('a door credential for it (an issue or a rotation)', 'src/core/session-channel/host-credentials.ts'),
  channel: refused('its session channel on every link: nothing it sends is applied, and no link is kept or taken', 'src/core/session-channel/leader-side.ts'),
  start: refused('a new session aimed at it, on either path (its service\'s or the leader\'s own)', 'src/providers/claude-code-session.ts'),
  send: stays('messages, stops and resumes of sessions this leader already runs there (the legacy path)',
    'the person\'s own aim at work that already runs, so it can be finished or stopped; nothing new starts there'),

  'daemon-hello': stays('its daemon\'s hello (machine id, version, capabilities)', 'how the leader knows the machine is the revoked one'),
  'daemon-answer': stays('its daemon\'s answers to this leader\'s commands', 'answers to the leader\'s own calls'),
  'daemon-event:*': stays('the events of sessions this leader runs there (their output, state and end)', 'the leader\'s own sessions, until they end'),
  'daemon-event:stream-': stays('the frames of streams this leader opened to the host', 'answers to the leader\'s own calls; a stream the host opens is judged by its kind (stream: rows)'),
  'daemon-event:cron-metadata': stays('its sessions\' cron state', 'shown only, kept in memory, never written to a task, session or note'),
  'daemon-event:launcher-facts': stays('its launcher\'s facts', 'kept on the link only, to read its service\'s version'),
  'daemon-event:leader-lost': stays('its note that the companion led it', 'the leader takes the lead back: its own act (the journal it then drains is held)'),
  'daemon-event:oneshot.': stays('the output of one-shot runs this leader started there', 'answers to the leader\'s own calls'),
  'daemon-event:gateway-request': refused('its sessions\' `walnut` calls (every op, origin host:<key>)', 'src/core/peers/capability-router.ts'),
  'daemon-event:offline-journal': HELD,
  'daemon-event:stt-request': relay('a voice input to transcribe'),
  'daemon-event:launch-request': relay('a new session from the phone'),
  'daemon-event:control-request': relay('a model, effort or fork change of a session from the phone'),
  'daemon-event:message-request': relay('a message into a session from the phone'),
  'daemon-event:trigger.checked': relay('its triggers\' check reports'),
  'daemon-event:trigger.fired': relay('its triggers\' fires (kept unacked on the host)'),

  'stream:follower': refused('its own server\'s calls to this leader (its forwarded writes and its reads)', RELAY_CHECK),
  'stream:companion': refused('the companion\'s streams through its daemon', RELAY_CHECK),
  'stream:hub': refused('its streams into the ports this leader opens to it', RELAY_CHECK),

  ...Object.fromEntries(JOURNAL_KINDS.map((k) => [`journal:${k}`, HELD])),

  'copy:host.slice': COPIES,
  'copy:skills.sync': COPIES,
  'copy:triggers.configure': COPIES,
  'copy:hooks.configure': COPIES,
  'copy:bridge.configure': COPIES,

  'op:host_exec': AIMED, 'op:host_exec_read': AIMED, 'op:host_exec_pinned': AIMED, 'op:host_exec_stop': AIMED, 'op:host_exec_list': AIMED,
  'op:host_copy': AIMED, 'op:host_copy_result': AIMED, 'op:host_http': AIMED, 'op:host_daemon_update': AIMED,
  'op:host_mcp_list': AIMED, 'op:host_mcp_tools': AIMED, 'op:host_mcp_call': AIMED, 'op:host_mcp_result': AIMED,
  'op:host_list': READ_HERE, 'op:host_get': READ_HERE, 'op:host_profile_get': READ_HERE, 'op:host_load': READ_HERE,
}

/** The sentences of a table's rows of one verdict, each once, in table order. */
function said(verdict: Reach['verdict']): string[] {
  const out = new Set<string>()
  for (const r of Object.values(REVOKED_REACH)) if (r.verdict === verdict) out.add(r.verdict === 'stays' ? `${r.what}: ${r.why}` : r.what)
  return [...out]
}

/** What a revoked host still gets from this leader, said in the revoke's answer (the stays rows), and how to end it. */
export const REVOKED_STILL_REACHES: readonly string[] = [...said('stays'), 'to end all of it, remove the host from the config or turn it off']
/** What a revoke ends, said in the same answer (the refused rows). */
export const REVOKED_REFUSED: readonly string[] = said('refused')
