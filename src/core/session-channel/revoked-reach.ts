/**
 * Every way a host reaches this leader, or this leader reaches it, and what a revoke does to each
 * (leader-issue.ts revokeHostDoorNow: a ban of the host's machine under any of its names,
 * revoked-hosts.ts). One row per member, keyed by where it lives in the source:
 *
 *   door, issue, channel, start, send   the door, its key, the session channel, a new session, input
 *   daemon-event:<ev>    each event its daemon sends up its link (daemon-connection.ts, and every
 *                        file that takes a link's events with .onEvent); `*` is the fan-out
 *   consumer:<file>      each file that takes a daemon link's events (.onEvent)
 *   daemon-answer, daemon-hello   its answers to this leader's commands, and its hello
 *   stream:<from>        each kind of stream the host opens toward this leader
 *   journal:<kind>       each kind of its offline journal's records
 *   copy:<push>          each push of this leader's state to its daemon (DaemonConnection.push*)
 *   cmd:<name>           each command a daemon takes (its command switch, daemon-standalone.ts) and
 *                        each this leader sends (`.send('<name>'`)
 *   op:<name>            each op that can aim at a host (a `host` input, or a host_* name)
 *
 * Refused: what the host would begin or write here, and what would hand it this Walnut's data, a
 * credential or a new process: the person who revokes a host no longer trusts it. Each refused row
 * names the entry (`check.file`, `check.fn`) whose body reads the ban (revokedAs and its wrappers).
 * A process there or this Walnut's data handed to it goes only for a person's own call (the
 * `person` rows, checked at the command gate): never a session's, a routine's, a trigger's or a
 * peer's. Stays: the reads this leader aims at the host and brings back (the host cannot begin one),
 * and the person's own input to a session already running there, so it can be finished or stopped.
 * To end those too, remove the host from the config.
 *
 * tests/core/session-channel/revoked-reach-ratchet.test.ts enumerates every member from the source
 * and fails on one this table does not classify, and on a refused row whose entry reads no ban.
 * The revoke's answer lists both verdicts.
 */

export interface ReachCheck { file: string; fn: string }
export type Reach =
  | { verdict: 'refused'; what: string; check: ReachCheck }
  | { verdict: 'stays'; what: string; why: string }

const refused = (what: string, file: string, fn: string): Reach => ({ verdict: 'refused', what, check: { file, fn } })
const stays = (what: string, why: string): Reach => ({ verdict: 'stays', what, why })
const rows = (r: Reach, names: readonly string[], prefix: string): Record<string, Reach> => Object.fromEntries(names.map((n) => [`${prefix}${n}`, r]))

const DC = 'src/providers/daemon-connection.ts'
const relay = (what: string, fn: string): Reach => refused(`${what}, relayed by its daemon`, DC, fn)

const HELD = refused('its offline journal: held on the host, nothing read or acked, drained whole after an allow', 'src/core/offline-handover.ts', 'async function handover(')
/** Every kind of journal record: all held by the one check before the drain reads anything, and again each round. */
const JOURNAL_KINDS = [
  'row', 'settle', 'delivery', 'op', 'settings', 'resume', 'stop',
  'task-fields', 'task-create', 'task-move', 'board', 'device-revoke', 'note', 'session', 'session-meta', 'inbox-state', 'chat-turn',
  'memory', 'note-move', 'note-attachment', 'conversation-edit', 'letter', 'inbox-reply', 'inbox-reply-pictures', 'inbox-reply-direct',
  'agent-memory', 'device-actor', 'routine-run', 'trigger-create', 'trigger-update', 'held-op', 'plugin-job-actor', 'task-start',
] as const

/** The events of the leader's own sessions there, read by their handlers (the fan-out). */
const SESSION_EVENT = stays('the events of sessions this leader runs there (their output, state, exit)', 'the leader\'s own sessions, until they end; nothing they say starts or adopts a session (that is the channel, refused)')

const SPAWN = refused('a new process there: a start, a cold --resume, an ACP start, a one-shot run (every source)', 'src/providers/ephemeral-session-gate.ts', 'export function gateSessionCommand(')
const INPUT = stays('input to a session already running there (a message, a mode, a stop, its state, a permission denied)',
  'only a person\'s own lines are handed out for it (session-message-queue.ts parks every other row, one with no sender too, with why); a tool allowed there goes only for a person (the person rows); a stop must reach it')
const AIM = stays('the reads this leader runs there and the answers it brings back (files, git, logs, ports, usage, its task directories and jobs)',
  'only an answer comes back, and the host cannot begin one (its own sessions\' calls are refused at the gateway)')
/** A process there, or this Walnut's data handed to it: only a person's own call (core/session-channel/person-call.ts), checked at the command gate. */
const PERSON = refused('a process there or this Walnut\'s data handed to it (exec, a file written or moved, a commit, an HTTP call, MCP, a trigger\'s run, a terminal, a service update), and a tool allowed there, unless a person\'s own call: never a session\'s, a routine\'s, a trigger\'s or a peer\'s',
  'src/providers/ephemeral-session-gate.ts', 'export function gateSessionCommand(')
const LINE_FILES = stays('the pictures and files of a line handed out to a session there', 'the queue hands out only a person\'s lines there (send), so they go as that person\'s')
const STREAM = stays('the frames of a stream already open there', 'its opening (stream.open) goes only for a person\'s own call')
const NOT_THIS_LINK = stays('commands a host\'s own server, the companion\'s bridge or a backup leader sends a daemon (follower, phone relay, lead-host calls)',
  'this leader never sends them on a host\'s link; the companion\'s own token for it is deleted at the revoke (leader-issue.ts revokeBridge)')
const CONFIG = stays('the leader\'s own settings of the machine (its hooks, server, network, workspace and turn settings, its leader)',
  'they carry no secret of this Walnut and no data of its tasks; the hooks are guards on the sessions still there')
const ANSWER = stays('the answers to a relay the daemon brought (each refused while revoked)', 'the refusal itself goes back this way')
const LOCAL_ONLY = stays('frames for this Mac\'s own daemon or a feature node (the phone\'s events, a browser\'s sign-in)', 'they never go to a host\'s daemon link')
const TASK_START = refused('a task\'s session there, before its workspace or folder is made (task_create and session_start start through it)', 'src/core/sessions/task-start.ts', 'async function prepareLaunch(')
const AIM_OP = stays('the ops that read there and bring the answer back (a job\'s output, a copy\'s state, MCP servers, its load, its secrets\' names, its workspace kinds)',
  'only an answer comes back; the ops that run a process or hand it data are refused unless a person\'s own call (the person rows)')
const READ_HERE = stays('the ops that read this leader\'s own records of the host (its config row, its profile)', 'nothing goes to the host')
const NOT_A_MACHINE = stays('ops whose `host` input names a member, not a machine (a topic\'s or a router\'s host)', 'they never reach a machine')
const TRIGGER_ANSWER = stays('the acks and claims of trigger checks this leader asks for', 'its fires stay unacked on the host (refused), so nothing new is armed or run')

export const REVOKED_REACH: Readonly<Record<string, Reach>> = {
  door: refused('its door: the record keeps no key, so no socket proves itself', 'src/core/session-channel/host-door.ts', 'async function onHello('),
  issue: refused('a door credential for it under any name, or for the machine id it names', 'src/core/session-channel/host-credentials.ts', 'export async function mintHostCredential('),
  channel: refused('its session channel on every link: nothing it sends is applied, and no link is kept or taken', 'src/core/session-channel/leader-side.ts', 'function refuseRevoked('),
  start: refused('a new session aimed at it, on either path (its service\'s or the leader\'s own)', 'src/providers/claude-code-session.ts', 'private async assertStartRouting('),
  send: refused('a line a person did not type, into a session there (a peer\'s, a routine\'s, a recovery\'s): parked with why', 'src/core/session-message-queue.ts', 'async function revokedHostOfSession('),
  expose: refused('the tunnel: placed back here', 'src/core/expose/placement.ts', 'export function exposePlacement('),
  'person-local': stays('a process on this computer that sends no session id and no automation mark (curl, the CLI with its session env unset)',
    'it reads as the person (web/routes/person-caller.ts), so it can still send the person rows there: the mark guards against an agent working through Walnut\'s tools, not a hostile process on this Mac'),
  'acp-allow': refused('a tool allowed in an ACP session there by anyone but a person (a deny still goes)', 'src/providers/acp-session.ts', 'async resolvePermissionRequest('),

  'daemon-hello': stays('its daemon\'s hello (machine id, version, capabilities)', 'how the leader knows the machine is the revoked one'),
  'daemon-answer': stays('its daemon\'s answers to this leader\'s commands', 'answers to the leader\'s own calls'),
  'daemon-event:*': SESSION_EVENT,
  'daemon-event:stream-': stays('the frames of streams this leader opened to the host', 'answers to the leader\'s own calls; a stream the host opens is judged by its kind (stream: rows)'),
  'daemon-event:cron-metadata': stays('its sessions\' cron state', 'shown only, kept in memory, never written to a task, session or note'),
  'daemon-event:launcher-facts': stays('its launcher\'s facts', 'kept on the link only, to read its service\'s version'),
  'daemon-event:leader-lost': stays('its note that the companion led it', 'the leader takes the lead back: its own act (the journal it then drains is held)'),
  'daemon-event:oneshot.': stays('the output of one-shot runs this leader started there', 'answers to the leader\'s own calls (a new one is refused: cmd:oneshot.run)'),
  'daemon-event:gateway-request': refused('its sessions\' `walnut` calls (every op, origin host:<key>)', 'src/core/peers/capability-router.ts', 'export async function handleGatewayCapability('),
  'daemon-event:offline-journal': HELD,
  'daemon-event:stt-request': relay('a voice input to transcribe', 'private async handleSttRequest('),
  'daemon-event:launch-request': relay('a new session from the phone', 'private async handleLaunchRequest('),
  'daemon-event:control-request': relay('a model, effort or fork change of a session from the phone', 'private async handleControlRequest('),
  'daemon-event:message-request': relay('a message into a session from the phone', 'private async handleMessageRequest('),
  'daemon-event:trigger.checked': relay('its triggers\' check reports', 'private dispatchTriggerEvent('),
  'daemon-event:trigger.fired': relay('its triggers\' fires (kept unacked on the host)', 'private dispatchTriggerEvent('),
  // The session handlers' own event names (consumer files below).
  ...rows(SESSION_EVENT, ['jsonl', 'exit', 'session_state', 'attached', 'acp_state', 'bridge-offline', 'agent', 'snapshot', 'stderr_tail'], 'daemon-event:'),

  'consumer:src/providers/remote-session-manager.ts': SESSION_EVENT,
  'consumer:src/providers/acp-session.ts': SESSION_EVENT,
  'consumer:src/providers/cloud-session-link.ts': SESSION_EVENT,
  'consumer:src/providers/subagent-poller.ts': SESSION_EVENT,
  'consumer:src/providers/session-server-client.ts': stays('the events of a session server this leader runs', 'not a host\'s daemon link'),
  'consumer:src/host-server/daemon-link.ts': stays('the host server\'s own link to its local daemon', 'runs on the host, never on this leader'),
  'consumer:src/core/link/daemon-connection-link.ts': stays('the link wrapper that hands events on', 'it passes them to the consumers above'),
  'consumer:src/core/org/held-threads.ts': stays('a thread waiting on a session\'s turn', 'reads the leader\'s own sessions\' events only'),

  'stream:follower': refused('its own server\'s calls to this leader (its forwarded writes and its reads)', DC, 'private async plugFollowerStream('),
  'stream:companion': refused('the companion\'s streams through its daemon', DC, 'private streamEndpoint('),
  'stream:hub': refused('its streams into the ports this leader opens to it', DC, 'private streamEndpoint('),

  ...rows(HELD, JOURNAL_KINDS, 'journal:'),

  'copy:pushHostSlice': refused('its copy of tasks, notes and memory (the host slice)', DC, '  pushHostSlice(): void {'),
  'copy:pushHostReplica': refused('its replica\'s files and pictures', DC, '  pushHostReplica(): void {'),
  'copy:pushSkillSync': refused('this Walnut\'s skills', DC, '  pushSkillSync(): void {'),
  'copy:pushTriggers': refused('this Walnut\'s triggers (their checks and prompts)', DC, '  pushTriggersNow(): Promise<void> {'),
  'copy:pushTriggersNow': refused('this Walnut\'s triggers (their checks and prompts)', DC, '  pushTriggersNow(): Promise<void> {'),
  'copy:pushBridgeConfig': refused('the cloud bridge: turned off there, never a machine token (none is minted for it)', DC, '  pushBridgeConfig(): void {'),
  'copy:pushDaemonHooks': stays('the compiled hook rules', 'guards on the sessions still running there; withholding them would loosen them'),
  'copy:pushCopiesAgain': stays('the copies again after an allow', 'each push above reads the ban itself'),

  ...rows(SPAWN, ['start', 'acpStart', 'acpNewSession', 'oneshot.run', 'oneshot.prewarm', 'bridgeResume', 'agent.start', 'agent.newSession'], 'cmd:'),
  'cmd:host.slice': refused('its copy of tasks, notes and memory', DC, '  pushHostSlice(): void {'),
  'cmd:skills.sync': refused('this Walnut\'s skills', DC, '  pushSkillSync(): void {'),
  'cmd:triggers.configure': refused('this Walnut\'s triggers', DC, '  pushTriggersNow(): Promise<void> {'),
  'cmd:bridge.configure': refused('a machine token for the cloud bridge (the bridge is turned off there)', DC, '  pushBridgeConfig(): void {'),
  ...rows(refused('its replica\'s files and pictures', DC, '  pushHostReplica(): void {'), ['replica.put', 'replica.sync', 'replica.drop', 'attachments.put', 'attachments.sync', 'attachments.drop', 'attachments.status'], 'cmd:'),
  ...rows(refused('a secret of the person\'s (new or rotated)', 'src/core/secrets/fleet-secrets.ts', 'export function reconcileHost('), ['secrets.put', 'secrets.sync'], 'cmd:'),
  'cmd:jobs.configure': refused('a plugin\'s jobs and their settings (its jobs are taken off it)', 'src/core/plugin-jobs/manager.ts', 'async function reconcileOnce('),
  ...rows(PERSON, ['exec.run', 'exec.script', 'fs.write', 'fs.writePart', 'fs.copy', 'fs.mkdir', 'fs.rename', 'fs.rm', 'git.commitStart', 'http.request',
    'mcp.call', 'mcp.tools', 'triggers.test', 'triggers.run', 'transfer.apply', 'transfer.fetch', 'workspace.create', 'workspace.runScript',
    'turns.restore', 'vscode.ensure', 'stream.open', 'taskdir.ensure', 'service.update'], 'cmd:'),
  ...rows(INPUT, ['send', 'sendRaw', 'appendUserMarker', 'setMode', 'acpSend', 'acpSteer', 'acpRespond', 'acpCancel', 'acpSetConfigOption', 'acpSubscribe', 'acpState', 'acpStop',
    'agent.send', 'agent.steer', 'agent.respond', 'agent.cancel', 'agent.setOption', 'agent.subscribe', 'agent.state', 'agent.stop', 'subscribe-agent', 'unsubscribe-agent',
    'attach', 'detach', 'getState', 'status', 'stop', 'kill', 'rename', 'cancelPendingStart', 'forceSettlePermissionRequests', 'line.fate', 'turns.guard', 'oneshot.cancel'], 'cmd:'),
  ...rows(LINE_FILES, ['upload.part', 'image.save'], 'cmd:'),
  ...rows(AIM, ['exec.list', 'exec.read', 'exec.kill', 'fs.find', 'fs.grep', 'fs.ls', 'fs.read', 'fs.readBounded', 'fs.readImage', 'fs.readRange',
    'fs.resolvePath', 'fs.stat', 'git.commitJob', 'git.commitPlan', 'git.diff', 'git.ensureExcluded', 'git.fileLog',
    'git.fileShow', 'git.refs', 'git.status', 'logs.tail', 'ports.list', 'ports.stop', 'taskdir.list', 'taskdir.prune', 'taskdir.pruneBuilds',
    'taskdir.pruneCaches', 'taskdir.remove', 'taskdir.sizes', 'transcript.archive', 'transcript.restore', 'transcript.rewindProbe', 'usage.codexOutside', 'usage.costState', 'usage.scan',
    'usage.sessionCost', 'usage.budget.get', 'usage.budget.list', 'history.readyKeys', 'history.readyView', 'read-history', 'markers.find', 'changes.compute', 'changes.file', 'cli.holder',
    'caller.check', 'host.facts', 'host.fix', 'host.preflight', 'host.vitals', 'host.load', 'host.endpoint', 'hello', 'ping', 'list', 'net.status', 'net.identity', 'net.probe',
    'hub.status', 'server.status', 'bridge.status', 'vscode.status', 'mcp.list', 'mcp.result', 'turns.list', 'turns.diff',
    'transfer.pack', 'transfer.reach', 'transfer.realpath', 'transfer.scan', 'transfer.clear', 'transfer.recent',
    'workspace.detect', 'workspace.job', 'workspace.status', 'workspace.repos', 'workspace.remove', 'workspace.scriptsFile', 'replica.status', 'triggers.state.snapshot',
    'jobs.status', 'jobs.logs', 'jobs.http', 'sessions.describeExternal', 'sessions.discoverExternal', 'acpHostEngines', 'acpModelCatalog', 'invalidateModelCatalog',
    'secrets.list', 'secrets.remove', 'offline.drain', 'offline.ack', 'offline.blob', 'cron.metadata', 'desktop.restart', 'desktop.updateStatus', 'demo.quiesce',
    'adoptAppliedSettings', 'undoExpectedTeardown', 'write-inbox'], 'cmd:'),
  ...rows(CONFIG, ['hooks.configure', 'server.configure', 'net.configure', 'net.forward', 'net.invites', 'net.join', 'workspace.configure', 'leader.configure', 'leader.claim',
    'leader.spawnTemplate', 'turns.configure', 'usage.budget.configure', 'cron.supervision', 'service.handover'], 'cmd:'),
  ...rows(ANSWER, ['control-result', 'launch-result', 'message-result', 'stt-result', 'gateway-result', 'feature.result'], 'cmd:'),
  ...rows(LOCAL_ONLY, ['mobile-event', 'fill_login', 'fill_code', 'tabs', 'feature.request'], 'cmd:'),
  ...rows(STREAM, ['stream.lane', 'stream.accept', 'stream.data', 'stream.ack', 'stream.end', 'stream.close', 'stream.resize', 'client.role'], 'cmd:'),
  ...rows(NOT_THIS_LINK, ['follower.hello', 'follower.status', 'follower.report', 'follower.sessions', 'follower.send', 'follower.permission', 'follower.op', 'follower.peer',
    'follower.pending', 'follower.triggers', 'follower.trigger.test', 'follower.gateway', 'follower.trigger.deliver', 'follower.start',
    'session.launch', 'session.control', 'session.permission', 'session.message', 'stt', 'bridge.peer', 'leader.witness', 'leader.deliver', 'leader.settings', 'leader.control'], 'cmd:'),
  ...rows(TRIGGER_ANSWER, ['triggers.ack', 'triggers.claim'], 'cmd:'),

  'op:subagent_run': refused('a subagent there, before any copy of the caller\'s work goes', 'src/core/subagents/registry.ts', 'export async function startLightSubagent('),
  ...rows(TASK_START, ['task_start', 'task_create', 'session_start'], 'op:'),
  'op:task_move': refused('a task moved there, before its old session stops or its work is packed', 'src/core/sessions/engine-switch.ts', 'async function switchFrom('),
  'op:task_transfer': refused('a task\'s work moved there as a new task, before its workspace or conversation is packed', 'src/core/transfer/planner.ts', 'export function planTransfer('),
  ...rows(PERSON, ['host_exec', 'host_exec_pinned', 'host_http', 'host_copy', 'host_mcp_tools', 'host_mcp_call', 'host_daemon_update', 'trigger_test'], 'op:'),
  ...rows(AIM_OP, ['host_exec_read', 'host_exec_stop', 'host_exec_list', 'host_copy_result', 'host_mcp_list', 'host_mcp_result', 'host_load', 'secret_list', 'workspace_providers'], 'op:'),
  ...rows(READ_HERE, ['host_list', 'host_get', 'host_profile_get'], 'op:'),
  'op:trigger_create': stays('a trigger aimed at it', 'kept here only: its push to the host is refused (copy:pushTriggers), so nothing is armed there'),
  ...rows(NOT_A_MACHINE, ['topic_create', 'topic_members', 'router_create'], 'op:'),
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
