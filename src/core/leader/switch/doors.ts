/**
 * The outward doors: the few functions every send to the outside world and every timer or
 * trigger fire passes (docs/reference/leader-switch.md, "Outward doors"). Each one asks
 *
 *     if (leaderPermitActive()) assertOutwardDoor('<kind>', opId)
 *
 * before it acts; a send with a stable key of one logical send (a mail) registers its op id with
 * the witnesses instead (beginOutwardSend, OutwardDoor.opIds). This module imports nothing of
 * the permit: with the experiment `switchable_leader` off no checker is ever registered,
 * `leaderPermitActive()` is false and no permit code is reached. With it on, the server's permit runtime (runtime.ts) registers
 * one, and a door refuses (PermitNotHeld) whenever this machine may not act.
 *
 * tests/core/leader/switch/outward-doors-ratchet.test.ts fails when a new outward door
 * appears without the check.
 *
 * The same doors keep a copy of the person's data off his real accounts. A server on such a copy
 * (an ephemeral server, a snapshot the ephemeral launcher marked: accountIsolationReason in
 * core/remote-sync-isolation.ts) holds its mail accounts, calendars, trackers and plugins with their
 * live credentials, so
 * at boot it closes every door that reaches an account (DOOR_REACH 'account', closeAccountDoors),
 * whatever the permit says. Such a door asks `accountDoorsGuarded()` instead of
 * `leaderPermitActive()`; tests/core/leader/switch/account-doors-isolation.test.ts holds it
 * (2026-11-27: an ephemeral server's Mail page marked real Gmail messages read).
 */

/** Every kind of door, one per choke point (OUTWARD_DOORS below names their files). */
export type OutwardDoorKind =
  | 'mail-send'
  | 'mail-unsubscribe'
  | 'mail-write'
  | 'push'
  | 'apns'
  | 'cron-fire'
  | 'trigger-fire'
  | 'trigger-arm'
  | 'plugin-jobs'
  | 'calendar-write'
  | 'session-wake'
  | 'task-sync'
  | 'plugin-fetch'
  | 'git-push'
  | 'companion-upload'
  | 'host-credential'
  | 'mcp-write'

/** One function that checks a door, and what a refusal there does. */
export interface OutwardDoor {
  kind: OutwardDoorKind
  /** Relative to src/. */
  file: string
  /** The function (or method) whose body checks the door. */
  fn: string
  /** What happens to the work when the door refuses, so that it is done later, once. */
  onRefusal: string
  /**
   * The send registers its op id with the witnesses first (beginOutwardSend: registered once
   * ever, begun once, its outcome reported with reportOutwardSend), so no two holders ever send it.
   * Only for a stable key of one logical send whose duplicate would harm (a mail). Absent: the
   * door asks the permission only, because the act has no such key (a create, an upload, a
   * plugin request, a push to a phone, a timer or a fire whose own ledger dedups it).
   */
  opIds?: true
}

/**
 * Every door function. tests/core/leader/switch/outward-doors-ratchet.test.ts reads each body
 * for the check, and pins the primitives behind them (a provider send, a push URL, a daemon
 * configure) to their call sites, so a new way out fails there until it gets a door here.
 */
export const OUTWARD_DOORS: readonly OutwardDoor[] = [
  { kind: 'mail-send', file: 'integrations/mail/approvals.ts', fn: 'consoleSend', onRefusal: 'throws to the caller before the revision bump and the freeze: the draft is as it was (a route answers 503). Refused at mintAndSend (before the approval), the freeze is undone on the spot' },
  { kind: 'mail-send', file: 'integrations/mail/approvals.ts', fn: 'mintAndSend', onRefusal: 'throws before the approval is minted; an answered letter stays for the reconcile of the server that may send. Refused later at sends.execute, once the ledger row exists, the send is QUEUED for every caller (writeLedgerAndRun runQueued answers the approved row, never "did not act"): the reconcile of a server that may send runs it once' },
  { kind: 'mail-send', file: 'integrations/mail/sends.ts', fn: 'execute', opIds: true, onRefusal: 'begins op mail:<idempotency key> before the claim: a refusal for want of the permission leaves the row approved for the reconcile of a server that may send (within 24 h of the approval, else it settles failed). A known op settles the row by its state, never sent again under that id: sent as sent; not-sent as failed; unknown as failed while the row is still approved (never claimed, so never sent), else unknown' },
  { kind: 'mail-send', file: 'core/topics/topic-mail.ts', fn: 'passOnce', onRefusal: 'the pass is skipped silently, like a held server; a refusal inside a send clears its marker and is not a failure' },
  { kind: 'mail-unsubscribe', file: 'integrations/mail/unsubscribe.ts', fn: 'run', onRefusal: 'throws before the ledger claim, so no lock is held; an answered letter runs again once the doors open (held on disk, cache/leader-deferred-work.json: a restart keeps it); no op id: a click after a failure is a new attempt, the HTTP rungs are idempotent, and the mailto rung sends through sends.execute (op ids); a mailto row settles from its send (onSendSettled, and before any reclaim), so a queued mail is never minted twice' },
  { kind: 'mail-write', file: 'integrations/mail/service.ts', fn: 'markRead', onRefusal: 'throws to the caller before the provider is asked (a route answers 503)' },
  { kind: 'mail-write', file: 'integrations/mail/service.ts', fn: 'markReadMany', onRefusal: 'throws to the caller before the provider is asked (a route answers 503)' },
  { kind: 'mail-write', file: 'integrations/mail/invites.ts', fn: 'respond', onRefusal: 'throws to the caller before the answer is sent (a route answers 503)' },
  { kind: 'mail-write', file: 'integrations/mail/mail-filter-moves.ts', fn: 'move', onRefusal: 'throws before the provider is asked: no row settled, no attempt counted; the run waits for the doors to open' },
  { kind: 'apns', file: 'core/push/apns.ts', fn: 'sendApns', onRefusal: 'returns attempted: false, notPermitted, never throws' },
  { kind: 'push', file: 'core/push/deliver.ts', fn: 'sendExpo', onRefusal: 'returns attempted: false, notPermitted, never throws' },
  { kind: 'push', file: 'core/push/quiet-hold.ts', fn: 'holdPushForQuiet', onRefusal: 'a letter, thread, approval or general push is held (on disk), and one push says what waited once the doors open' },
  { kind: 'push', file: 'core/push/quiet-hold.ts', fn: 'releaseHeld', onRefusal: 'keeps the held items and releases them once the doors open' },
  { kind: 'cron-fire', file: 'core/cron/timer.ts', fn: 'findDueJobs', onRefusal: 'takes no slot: it stays due (never advanced) for the server holding the permission, whose catch-up runs it once' },
  { kind: 'cron-fire', file: 'core/cron/jobs.ts', fn: 'wakeAtMsOf', onRefusal: 'no refused slot wakes the timer' },
  { kind: 'cron-fire', file: 'core/cron/timer.ts', fn: 'armTimer', onRefusal: 'polls once a minute, and ticks the moment the doors open' },
  { kind: 'cron-fire', file: 'core/cron/ops.ts', fn: 'run', onRefusal: "returns { ok: true, ran: false, reason: 'not-permitted' } before the slot is marked running" },
  { kind: 'cron-fire', file: 'core/cron/timer.ts', fn: 'executeJob', onRefusal: "backstop: releases the running marker, the slot stays due; a Run answers ran: false, 'not-permitted'" },
  { kind: 'trigger-fire', file: 'core/cron/ops.ts', fn: 'relayCheckRun', onRefusal: "a Run of a check asks no daemon: { ok: true, ran: false, reason: 'not-permitted' }" },
  { kind: 'trigger-fire', file: 'core/routines/trigger-events.ts', fn: 'claimFire', onRefusal: "returns a 'wait' verdict: not claimed, not acked, the daemon replays it" },
  { kind: 'trigger-fire', file: 'core/routines/trigger-events.ts', fn: 'deliverFires', onRefusal: 'nothing runs and nothing is acked: the daemon replays it' },
  { kind: 'trigger-fire', file: 'core/routines/trigger-events.ts', fn: 'sweepOwedFires', onRefusal: 'nothing runs: the fires stay kept on the trigger (owedFires) for the next lap of a server that may deliver' },
  { kind: 'trigger-arm', file: 'providers/daemon-connection.ts', fn: 'pushTriggersOnce', onRefusal: 'sends no set; every host is pushed again once the doors open' },
  { kind: 'trigger-arm', file: 'providers/service-set-move-checks.ts', fn: 'dropWalnutScope', onRefusal: 'throws before the shared daemon is told anything; the service set move gives up this try, releases its hold and looks again later' },
  { kind: 'plugin-jobs', file: 'providers/service-set-move-checks.ts', fn: 'dropWalnutScope', onRefusal: 'throws before the shared daemon is told anything; the service set move gives up this try, releases its hold and looks again later' },
  { kind: 'plugin-jobs', file: 'core/plugin-jobs/manager.ts', fn: 'reconcileOnce', onRefusal: 'throws before any upload; the host waits in checking (no error, no back-off) and the pass runs once the doors open' },
  { kind: 'calendar-write', file: 'integrations/calendar/service.ts', fn: 'updateEvent', onRefusal: 'throws to the caller (a route answers 503)' },
  { kind: 'calendar-write', file: 'integrations/calendar/service.ts', fn: 'createEvent', onRefusal: 'throws to the caller (a route answers 503); no op id: no caller hands a stable key for one create' },
  { kind: 'calendar-write', file: 'integrations/calendar/service.ts', fn: 'deleteEvent', onRefusal: 'throws to the caller (a route answers 503)' },
  { kind: 'session-wake', file: 'core/task-wait-until.ts', fn: 'sweepWaitUntil', onRefusal: 'drops no deadline and looks again a minute later' },
  { kind: 'session-wake', file: 'core/task-wait-until.ts', fn: 'arm', onRefusal: 'a passed deadline re-arms after a minute, not a second' },
  { kind: 'session-wake', file: 'core/sessions/promise-alarm.ts', fn: 'firePromiseAlarms', onRefusal: 'clears no alarm and looks again a minute later' },
  { kind: 'session-wake', file: 'core/sessions/promise-alarm.ts', fn: 'arm', onRefusal: 'a due alarm re-arms after a minute, not a second' },
  { kind: 'session-wake', file: 'core/boards/board-reminders.ts', fn: 'sweepBoardReminders', onRefusal: 'fires nothing and keeps every deadline (one log line per closed period); the sweep runs once the doors open' },
  { kind: 'session-wake', file: 'core/boards/board-reminders.ts', fn: 'fire', onRefusal: 'throws before the reminder is marked fired; the sweep holds it, as above' },
  { kind: 'session-wake', file: 'core/boards/board-reminders.ts', fn: 'arm', onRefusal: 'a due reminder re-arms after a minute, not a second' },
  { kind: 'session-wake', file: 'core/org/lead-waits.ts', fn: 'tellLead', onRefusal: 'wakes no lead session and leaves the note untold; the lead is told once the doors open' },
  { kind: 'task-sync', file: 'core/private-tasks/sync-guard.ts', fn: 'guardSync', onRefusal: 'every write method (SYNC_METHOD_DOORS) throws: a push stamps sync_error for the sync loop (no card), a create is not an attempt, a remote delete, a list rename and a moved copy run once the doors open (held on disk, cache/leader-deferred-work.json: a restart keeps them; a delete of a source with confirmRemoteDeleted is also retried by the sync loop from its tombstone)' },
  { kind: 'plugin-fetch', file: 'core/plugins/server-api.ts', fn: 'fetch', onRefusal: 'a write method throws to the plugin; reads still go' },
  { kind: 'plugin-fetch', file: 'core/plugins/copy-network-guard.ts', fn: 'pluginNetworkRefusal', onRefusal: "a plugin's own fetch or node:http(s) write (installed on a copy only, guardPluginNetworkOnCopy) rejects or throws before anything leaves; reads and local hosts still go" },
  { kind: 'git-push', file: 'integrations/git-sync.ts', fn: 'syncInner', onRefusal: 'the push is skipped, the pull still runs' },
  { kind: 'git-push', file: 'integrations/git-compaction.ts', fn: 'compactionDoorRefusal', onRefusal: 'asked by the server before it forks the compaction worker (which ends in a force push): the run is skipped and the daily timer tries again' },
  { kind: 'companion-upload', file: 'core/cloud-ingest.ts', fn: 'postToCloudIngest', onRefusal: "answers 'failed' (never 'unsupported', which would take the bridge): the periodic sweep of a server that may send heals it" },
  { kind: 'companion-upload', file: 'core/cloud-ingest.ts', fn: 'postToCloudReplica', onRefusal: "answers { ok: false, outcome: 'failed' }: the next round of a server that may send carries it" },
  { kind: 'companion-upload', file: 'core/cloud-ingest.ts', fn: 'postToCloudJournal', onRefusal: 'throws: the handover keeps the records for its next run' },
  { kind: 'companion-upload', file: 'core/cloud-ingest.ts', fn: 'postToCloudHostReplica', onRefusal: "answers { ok: false, errorKind: 'not-permitted' }: the next round carries it" },
  { kind: 'companion-upload', file: 'core/projection-cache.ts', fn: 'pushViaBridge', onRefusal: "answers 'failed' and forgets the delivery: the periodic sweep heals it" },
  { kind: 'companion-upload', file: 'web/routes/events-v1.ts', fn: 'forwardMobileEventToBridge', onRefusal: 'answers false, as with no lane' },
  { kind: 'companion-upload', file: 'integrations/cloud-bridge-config.ts', fn: 'mintMachineToken', onRefusal: 'creates and revokes no companion device: answers null like any failed mint (the bridge config is not changed), the re-mint window not spent; the next bridge push of a server that may send mints it' },
  { kind: 'companion-upload', file: 'integrations/cloud-bridge-config.ts', fn: 'adoptOnce', onRefusal: 'offers nothing and keeps the offer for the next mint or start' },
  { kind: 'companion-upload', file: 'integrations/cloud-bridge-config.ts', fn: 'revokeBridgeTokens', onRefusal: 'deletes no companion device and answers every name as failed: the leader tries them again at its next ban read (session-channel/leader-issue.ts)' },
  { kind: 'host-credential', file: 'core/session-channel/leader-issue.ts', fn: 'issueOnce', onRefusal: 'throws before the credential is minted or sent: the host keeps what it holds, and the check runs again at its next link' },
  { kind: 'host-credential', file: 'core/leader/switch/host-follow.ts', fn: 'prepareOldMachineAsHost', onRefusal: 'answers not ok before the credential is minted: the handover is refused with that reason and this server leads on' },
  { kind: 'mcp-write', file: 'core/hosts/host-mcp.ts', fn: 'hostMcpCall', onRefusal: "throws HostExecError 503 not_permitted before the host is dialed: no tool of that host's MCP servers runs, read-only ones included (the host lists no hints)" },
  { kind: 'mcp-write', file: 'core/mcp-servers/connection.ts', fn: 'call', onRefusal: "throws McpCallError 'refused' (stage before-call) before the server is asked: a plugin's post, reaction or mark through walnut.mcp (Slack) is not sent; tools the server marks readOnlyHint still go" },
]

/**
 * What each kind of door reaches. 'account': an account of the person's outside this Walnut (his
 * mailbox, calendar, phone, trackers, the data repo, his cloud companion, an MCP server's service):
 * a server on a copy of his data never opens it (closeAccountDoors). 'walnut': this Walnut's own
 * timers, sessions and daemons, which a copy runs on its own. What those run is not behind these
 * doors: a session's own tools, a trigger's check script and a plugin job run outside the server
 * (a copy starts no plugin jobs, plugin-jobs/index.ts). A new kind fails to compile until it is
 * placed here.
 */
export const DOOR_REACH: Readonly<Record<OutwardDoorKind, 'account' | 'walnut'>> = {
  'mail-send': 'account',
  'mail-unsubscribe': 'account',
  'mail-write': 'account',
  push: 'account',
  apns: 'account',
  'calendar-write': 'account',
  'task-sync': 'account',
  'plugin-fetch': 'account',
  'git-push': 'account',
  'companion-upload': 'account',
  'mcp-write': 'account',
  'cron-fire': 'walnut',
  'trigger-fire': 'walnut',
  'trigger-arm': 'walnut',
  'plugin-jobs': 'walnut',
  'session-wake': 'walnut',
  'host-credential': 'walnut',
}

export type OutwardDoorChecker = (kind: OutwardDoorKind, opId: string) => void

let checker: OutwardDoorChecker | null = null
let query: (() => boolean) | null = null

/** Why this process never writes to the person's accounts (closeAccountDoors), or null. */
let accountIsolation: string | null = null
/** The account kinds a closed process still opens on purpose (closeAccountDoors `open`). */
let accountKindsOpen: ReadonlySet<OutwardDoorKind> = new Set()

/** A closed account door refuses `kind` now. */
function accountDoorClosed(kind: OutwardDoorKind): boolean {
  return accountIsolation !== null && DOOR_REACH[kind] === 'account' && !accountKindsOpen.has(kind)
}

/** Whether the write permission guards the outward doors in this process. */
export function leaderPermitActive(): boolean {
  return checker !== null
}

/**
 * Whether a door that reaches an account (DOOR_REACH 'account') must ask: the permit guards this
 * process, or it runs on a copy of the person's data (closeAccountDoors). The check such a door
 * makes before it acts, in place of `leaderPermitActive()`.
 */
export function accountDoorsGuarded(): boolean {
  return checker !== null || accountIsolation !== null
}

/**
 * A server on a copy of the person's data (core/remote-sync-isolation.ts accountIsolationReason)
 * closes every door that reaches an account for the life of the process; the permit and the other
 * doors are untouched. `why` is said in each refusal. `open` names account kinds kept open on
 * purpose (task-sync while WALNUT_ALLOW_REMOTE_SYNC_IN_TEST=1, its documented end-to-end test of a
 * sync plugin). Null opens them all again (each boot decides afresh; tests).
 */
export function closeAccountDoors(why: string | null, open: readonly OutwardDoorKind[] = []): void {
  accountIsolation = why
  accountKindsOpen = new Set(why === null ? [] : open)
}

/** Why the account doors are closed in this process (closeAccountDoors), or null. */
export function accountDoorsClosedWhy(): string | null {
  return accountIsolation
}

/** Throws (the permit's PermitNotHeld) when this machine may not act now. */
export function assertOutwardDoor(kind: OutwardDoorKind, opId: string): void {
  if (accountDoorClosed(kind)) throw isolationRefusal(kind, opId, accountIsolation!)
  checker?.(kind, opId)
}

/**
 * A closed account door's refusal: the permit's kind (isPermitRefusal), so the door does what its
 * onRefusal says, marked `isolated` so a route can say why (doorRefusalMessage).
 */
function isolationRefusal(kind: OutwardDoorKind, opId: string, why: string): Error {
  const err = new Error(
    `This Walnut is an isolated test server (${why}), so it never changes your real accounts:`
    + ` it did not act (${kind} ${opId}).`,
  )
  err.name = 'PermitNotHeld'
  ;(err as Error & { isolated?: true }).isolated = true
  return err
}

/**
 * `assertOutwardDoor` for a door that must never throw (a push sender, a fire claim): the
 * refusal's message, or null when this machine may act. Any other error still throws.
 */
export function outwardDoorRefusal(kind: OutwardDoorKind, opId: string): string | null {
  try {
    assertOutwardDoor(kind, opId)
    return null
  } catch (err) {
    if (!isPermitRefusal(err)) throw err
    return (err as Error).message || 'this machine does not hold the write permission'
  }
}

/**
 * Whether the doors are open now, without acting (a timer deciding whether a slot is due).
 * True when no permit guards this process.
 */
export function outwardDoorsOpen(): boolean {
  return query ? query() : true
}

/** A permit guards this process and its doors are closed now (a timer holds its due work back). */
export function doorsClosed(): boolean {
  return checker !== null && !outwardDoorsOpen()
}

/** How often a timer holding due work back behind closed doors looks again. */
export const DOORS_CLOSED_RECHECK_MS = 60_000

/**
 * The shortest delay of a timer whose due work fires only through a door: `openFloorMs` while
 * the doors are open, a minute while they are closed (no 1 s loop over work it may not fire).
 */
export function doorTimerFloorMs(openFloorMs = 1_000): number {
  return doorsClosed() ? DOORS_CLOSED_RECHECK_MS : openFloorMs
}

/** The permit runtime only: null unregisters both. */
export function setOutwardDoorChecker(c: OutwardDoorChecker | null, open: (() => boolean) | null = null): void {
  checker = c
  query = c ? open ?? (() => false) : null
  if (!c) {
    sender = null
    heldSaid.clear()
  }
}

/**
 * A restore drill's trial server (src/core/trial-start/): it holds no write permission and asks
 * none, so every door refuses for the life of the process, as they do in a switch's trial that
 * the witnesses have not let act. The refusal is the permit's kind (isPermitRefusal), so each
 * door does what its onRefusal says.
 */
export function closeOutwardDoorsForTrial(purpose: string): void {
  setOutwardDoorChecker((kind, opId) => {
    const err = new Error(`a ${purpose} trial server never acts outward (refused: ${kind} ${opId})`)
    err.name = 'PermitNotHeld'
    throw err
  }, () => false)
}

/**
 * A send's op id, registered with the witnesses before it goes out (permit core, "Outward
 * sends"): what the runtime registers. `begin` throws PermitNotHeld when the send may not go
 * (no permission, an id an earlier holder left unknown, one known as sent); `report` says how it
 * ended: 'sent', 'not-sent' (it surely never left: the request never reached the network), or
 * 'unknown' (left as it is: never sent again, listed for a person).
 */
export interface OutwardSender {
  begin(kind: OutwardDoorKind, opId: string): Promise<void>
  report(opId: string, outcome: 'sent' | 'not-sent' | 'unknown'): void
}

let sender: OutwardSender | null = null

/** The permit runtime only: null unregisters. */
export function setOutwardSender(s: OutwardSender | null): void {
  sender = s
}

/**
 * Before a send with a stable op id (only a mail's idempotency key, sends.ts execute): register
 * it and begin it, then reportOutwardSend once it ends. No-op while no permit guards this process.
 */
export async function beginOutwardSend(kind: OutwardDoorKind, opId: string): Promise<void> {
  if (accountDoorClosed(kind)) throw isolationRefusal(kind, opId, accountIsolation!)
  if (!checker) return
  if (!sender) { assertOutwardDoor(kind, opId); return }
  await sender.begin(kind, opId)
}

/** After a send begun with beginOutwardSend. No-op while no permit guards this process. */
export function reportOutwardSend(opId: string, outcome: 'sent' | 'not-sent' | 'unknown'): void {
  if (checker) sender?.report(opId, outcome)
}

const onceListeners = new Map<string, () => void>()

/**
 * Run `fn` once, the next time the doors open (this machine got the permission): work a refusal
 * held back (a trigger push, the held pushes, a routine's timer) goes then. In memory: work a
 * restart must not lose is held on disk instead (src/core/deferred-door-work.ts). One
 * subscription per `key`: a second call with the same key replaces the first, so a refusal
 * repeated every minute subscribes once. Never called while no permit guards.
 */
export function onceOutwardDoorsOpened(key: string, fn: () => void): void {
  onceListeners.set(key, fn)
}

const heldSaid = new Set<string>()

/**
 * Work a closed door held back, the one pattern of every holder (board reminders, held pushes,
 * filter moves, plugin jobs, creates): `say` (its one log line) once per period of closed doors
 * for `key`, and `fn` once the doors open (onceOutwardDoorsOpened, same key, so a refusal
 * repeated every minute subscribes once). The period ends when the doors open.
 */
export function holdUntilDoorsOpen(key: string, fn: () => void, say?: () => void): void {
  if (say && !heldSaid.has(key)) {
    heldSaid.add(key)
    say()
  }
  onceOutwardDoorsOpened(key, () => {
    heldSaid.delete(key)
    fn()
  })
}

/**
 * Tests only: forget every subscription, as a restart does (what a closed door held in memory is
 * gone; what it held on disk, deferred-door-work.ts, is not).
 */
export function _forgetDoorsOpenedListenersForTesting(): void {
  onceListeners.clear()
  heldSaid.clear()
}

/**
 * Where work a closed door held is kept on disk, relative to the home (src/core/deferred-door-work.ts).
 * Here, so the permit runtime can tell at boot whether there is any without loading that module.
 */
export const DEFERRED_DOOR_WORK_FILE = 'cache/leader-deferred-work.json'

/** The permit runtime only. */
export function notifyOutwardDoorsOpened(): void {
  const once = [...onceListeners.values()]
  onceListeners.clear()
  for (const fn of once) {
    try { fn() } catch { /* one listener never stops the others */ }
  }
}

/**
 * What a route answers (503) for a refused door: the person asked for something this server may
 * not do now, which is neither their mistake nor a crash.
 */
export const NOT_LEADER_MESSAGE = 'This Walnut server does not hold the write permission right now (another server leads,'
  + ' or this one is still starting), so it did not act. Try again in a moment.'

/**
 * The sentence a route answers for a refused door: a closed account door (closeAccountDoors) says
 * that this Walnut is a copy, any other the permit's NOT_LEADER_MESSAGE.
 */
export function doorRefusalMessage(err: unknown): string {
  return isIsolationRefusal(err) ? (err as Error).message : NOT_LEADER_MESSAGE
}

/** A refusal of a closed account door (closeAccountDoors), not of the permit. */
export function isIsolationRefusal(err: unknown): boolean {
  return isPermitRefusal(err) && (err as { isolated?: unknown }).isolated === true
}

/** A refusal a door can tell from its own errors. */
export function isPermitRefusal(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { name?: unknown }).name === 'PermitNotHeld'
}

/** How a known op stands (permit runtime, beginSend): the begin was refused because of it. */
export type KnownOpState = 'sent' | 'not-sent' | 'unknown' | 'sending'

/**
 * A begin refused because its op is known already (field `opKnown`, its state in `opState`), or
 * null for any other error, a refusal for want of the permission included (a later server that may
 * send retries that one). A known op is never sent again under its id, whatever the permission:
 * 'sent' and 'not-sent' are its outcome; 'unknown' an earlier holder registered it and never said
 * how it ended; 'sending' this process began it and has not reported yet.
 */
export function knownOpState(err: unknown): KnownOpState | null {
  if (!isPermitRefusal(err)) return null
  const e = err as { opKnown?: unknown; opState?: unknown }
  if (e.opKnown !== true) return null
  return e.opState === 'sent' || e.opState === 'not-sent' || e.opState === 'sending' ? e.opState : 'unknown'
}
