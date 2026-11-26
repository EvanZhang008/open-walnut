/**
 * Who writes which part of a session record (docs/plan/one-service-every-host.md, phase 2).
 *
 * A session that its host's own service assembles, runs and judges (`judge: 'host'`) is the
 * host's row: the host writes it and the leader keeps a copy of it. Inside that row a few fields
 * are the leader's own: what a person sets about a session from any screen (its title, archive
 * flag, note, output mode, pins, comments, thread fields) and the summaries the leader's hooks
 * write. The leader writes those on its own row and sends them down in the
 * `sessions` copy (replication/kinds/sessions.ts); the host never writes them. Every other field
 * is the host's: the leader never overwrites it, and the host's copy step never replaces it with
 * the leader's value.
 *
 * Every field of SessionRecord has an owner here: the table must name each key of the type
 * (`satisfies`), and tests/core/sessions/session-row-owner.test.ts reads the interface from
 * types.ts so a new field fails until it is given one.
 *
 * A row without `judge: 'host'` (every row today, and every row of a host that has not upgraded)
 * is the leader's whole: nothing here changes how it is written.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { SessionRecord } from '../types.js'
import { isHostReplica } from '../server-role.js'

export type SessionFieldOwner = 'host' | 'leader'

const H = 'host' as const
const L = 'leader' as const

export const SESSION_FIELD_OWNER = {
  claudeSessionId: H, taskId: H, legacyTaskId: H, project: H, process_status: H, mode: H, modeChosen: H,
  autoPermissionDenial: H, provider: H, engine: H, acpRuntimeId: H, acpJournalPath: H, acpCapabilities: H,
  acpControlCut: H, acpModel: H, acpModelName: H, acpConfig: H, acpStartMode: H, lastAcceptedAcpCommandId: H,
  type: H, activity: H, last_status_change: H, startedAt: H, lastActiveAt: H, messageCount: H, cwd: H, host: H,
  hostname: H, host_label: H, description: H, pid: H, outputFile: H, planFile: H, planCompleted: H,
  fromPlanSessionId: H, forkedFromSessionId: H, startedIdle: H, rewoundAtMessageUuid: H, inPlaceRewinds: H, pendingResumeSessionAt: H,
  appliedAppendSystemPrompt: H, appliedAppendSystemPromptRef: H, placeNoted: H, taskRoutingNoted: H, lastCompactUuid: H, lastCompactAt: H,
  asksSent: H, commitShas: H, mcpMountStatus: H, outputModeHookAt: H,
  model: H, cliModel: H, effort: H, effectiveEffort: H, modelMaxWindow: H, modelMaxWindowSource: H,
  modelMaxWindowModel: H, autoCompactAt: H, contextTokens: H, promptCache: H, idleCompaction: H,
  contextRecovery: H, safeguardSwitch: H, modelTemporary: H, contextStopsAt: H, idleCompactionLog: H,
  promptRefresh: H, planContent: H, lastTurnSpeed: H, speedTotals: H, firstTurnAt: H, errorMessage: H,
  errorKind: H, autoRecover: H, restartLoss: H, endpointWait: H, turn: H, usageLimit: H, usageLimitContinued: H,
  humanInputAt: H, chatInputAt: H, heldElsewhere: H, cwdGone: H, workspaceTold: H, folderMoved: H,
  cwdByPerson: H, ownFolderMove: H, startRefused: H, switchContext: H, taskCompleteStop: H, hostLost: H,
  status_reason: H, status_changed_by: H, status_history: H, errorCount: H, statusRevision: H,
  statusUpdatedAt: H, pendingPermission: H, promptAnswerLines: H, consumedOffset: H, streamEpoch: H,
  costWatermark: H, costWatermarkPid: H, lineLifecyclePid: H, lineQueuedPid: H, profile: H, lane: H, judge: H,
  // A stop is carried out where the session runs: the leader hands a person's stop of a host's
  // session to that host (sessions/session-lifecycle.ts terminateSession), whose stop coordinator
  // keeps it on its own row and fences its own queue with it (session-stop.ts).
  stopRequest: H,
  // The leader's: set by a person (any screen) or by the leader's own hooks.
  // The hints a send carries are planned where the send is made, on the leader (hints/hint-send.ts).
  output_mode_injected: L, hintState: L,
  // The leader's own copies of a host's told records (told-copies.ts): what the leader told that session.
  taskRoutingNotedByLeader: L, placeNotedByLeader: L, outputModeHookAtByLeader: L, workspaceToldByLeader: L,
  // An engine switch is the leader's (sessions/engine-switch*.ts write these on the leader, and the
  // host only reads them, from its copy): the switch's marks on the old and the new session.
  engineSwitch: L, 'supersededBy': L /* quoted, so the replaced-session guard does not read this key as a write of the mark */, leftContext: L,
  resumedBySwitch: L,
  title: L, archived: L, archive_reason: L, human_note: L, output_mode: L, threadAnchors: L, threadMeta: L,
  pinnedMessages: L, passageComments: L, summary: L, summaryGeneratedAt: L, recap: L, recapAt: L, overview: L,
  overviewAt: L,
} as const satisfies Record<keyof SessionRecord, SessionFieldOwner>

export type LeaderSessionField = { [K in keyof typeof SESSION_FIELD_OWNER]: typeof SESSION_FIELD_OWNER[K] extends 'leader' ? K : never }[keyof typeof SESSION_FIELD_OWNER]

export const LEADER_SESSION_FIELDS: readonly LeaderSessionField[] = (Object.keys(SESSION_FIELD_OWNER) as (keyof SessionRecord)[])
  .filter((k): k is LeaderSessionField => SESSION_FIELD_OWNER[k] === 'leader')

/** The owner of one field. A key the table does not know (a newer writer's) is the host's. */
export function sessionFieldOwner(field: string): SessionFieldOwner {
  return (SESSION_FIELD_OWNER as Record<string, SessionFieldOwner>)[field] ?? 'host'
}

/** Is this row run and judged by the service of its host (and so written by that host)? */
export function judgedByHost(row: Pick<SessionRecord, 'judge' | 'host'> | null | undefined): boolean {
  return !!row && row.judge === 'host' && typeof row.host === 'string' && row.host !== ''
}

/**
 * Is this row written here? On the host whose service judges it: yes. `hostKey` is this server's
 * own host key (a host replica's WALNUT_HOST_KEY); '' on the leader, where a host-judged row is
 * never its own.
 */
export function rowOwnedHere(row: Pick<SessionRecord, 'judge' | 'host'> | null | undefined, hostKey: string): boolean {
  return judgedByHost(row) && hostKey !== '' && row!.host === hostKey
}

/**
 * The row a host keeps when the leader's copy of one of its own rows arrives: its own value of
 * every host field, the leader's value of every leader field (an absent one is cleared). A field
 * only one side names follows its owner.
 */
export function mergeLeaderCopy(own: SessionRecord, fromLeader: SessionRecord): SessionRecord {
  const out: Record<string, unknown> = { ...own }
  for (const f of LEADER_SESSION_FIELDS) {
    const v = (fromLeader as unknown as Record<string, unknown>)[f]
    if (v === undefined) delete out[f]
    else out[f] = v
  }
  return out as unknown as SessionRecord
}

/**
 * The row a leader keeps when a host's change to one of its own rows arrives (the channel's `row`
 * record): the host's value of every host field the change names (null clears it: JSON carries no
 * undefined), the leader's own value of every leader field. `whole`: the change is the host's whole
 * row (born, or a rows frame), so a host field it leaves out is cleared too. With no row here yet
 * the change is the row, its leader fields included (the host set them when it made the session).
 */
export function mergeHostFacts(
  leaderRow: SessionRecord | null, change: Readonly<Record<string, unknown>>, whole: boolean,
  // Fields the change holds only cut (session-channel/fact-log.ts cutRowFields): the row's own value of each stays.
  cut: readonly string[] = [],
): SessionRecord {
  const out: Record<string, unknown> = leaderRow ? { ...leaderRow } : {}
  // A record from before a stop the host already answered here as done (host-judged-controls.ts
  // terminateOnHost): the same stop still pending in it. Neither that stop nor the process fields
  // it ends read as they were then; the host's record of the stop's end writes them.
  const stale = stopWentBack(leaderRow?.stopRequest, change.stopRequest)
  const keep = (k: string): boolean => (stale && STOP_ENDS.has(k)) || cut.includes(k)
  if (leaderRow && whole) {
    for (const k of Object.keys(out)) if (sessionFieldOwner(k) === 'host' && !(k in change) && !keep(k)) delete out[k]
  }
  for (const [k, v] of Object.entries(change)) {
    if (leaderRow && sessionFieldOwner(k) === 'leader') continue
    if (keep(k)) continue
    if (v === null || v === undefined) delete out[k]
    else out[k] = v
  }
  return out as unknown as SessionRecord
}

/** The host fields a stop's end writes (session-stop.ts confirm): an older record's never undo it. */
const STOP_ENDS: ReadonlySet<string> = new Set(['stopRequest', 'process_status', 'pid', 'activity', 'errorMessage', 'status_reason', 'status_changed_by'])

function stopWentBack(held: SessionRecord['stopRequest'] | undefined, next: unknown): boolean {
  if (!held || held.state === 'pending' || !next || typeof next !== 'object') return false
  const n = next as { id?: unknown; state?: unknown }
  return n.id === held.id && n.state === 'pending'
}

/** The fields of `patch` the leader may not write on a host's row: every host field it names. */
export function hostFieldsIn(patch: Readonly<Record<string, unknown>>): string[] {
  return Object.keys(patch).filter((k) => sessionFieldOwner(k) === 'host')
}

/**
 * The host a session's CLI runs on, as this server reaches it: undefined for this machine. A row
 * this host replica owns names its own host key, which is this machine here (never an ssh target).
 */
export function execHostOf(row: Pick<SessionRecord, 'judge' | 'host'>): string | undefined {
  if (!row.host || row.host === '__local__') return undefined
  // Only a host-judged row can be this host's own: no host key is read for any other.
  return judgedByHost(row) && rowOwnedHere(row, thisHostKey()) ? undefined : row.host
}

/**
 * The daemon link that reaches a session's CLI from this server: `'__local__'` for this machine
 * (a row of this machine's own, '' and `'__local__'` included, and a row this host replica owns),
 * else the row's host. The session classes ask this (or execHostOf), never the row's raw `host`:
 * on a host that runs its sessions an own row names the host's key, and a raw read of it would take
 * the remote branch for a session that runs right here (tests/providers/session-classes-one-path.test.ts).
 */
export function cliHostOf(row: Pick<SessionRecord, 'judge' | 'host'> | null | undefined): string {
  return (row ? execHostOf(row) : undefined) ?? '__local__'
}

/**
 * The name a read of a session's files goes by (DaemonFileReader and link() of hosts/link.ts, the
 * stream and transcript readers, their caches): the row's host, undefined for a row of none (a
 * reader that takes a string reads that as '__local__'). Not cliHostOf: on a host replica link.ts
 * refuses '__local__' and maps the host's own name to its follower link (replica/self-host.ts, and
 * session-reconcile.ts daemonStreamPathCandidates names its stream dir by it), so an own row's files
 * are read by the name the row carries. The CLI's pooled connection (the own-sessions link on a
 * host) is cliHostOf's.
 */
export function readHostOf(row: Pick<SessionRecord, 'host'> | null | undefined): string | undefined {
  return row?.host && row.host !== '__local__' ? row.host : undefined
}

/** This server's own host key: a host replica's WALNUT_HOST_KEY, '' on the leader (and anywhere else). */
export function thisHostKey(): string {
  return isHostReplica() ? (process.env.WALNUT_HOST_KEY ?? '').trim() : ''
}

const hostCopy = new AsyncLocalStorage<true>()

/**
 * Run `fn` as the writer of a host's rows on the leader: the channel that applies what the host
 * sent (its facts) is the one place a leader may write a host field of a host's row.
 */
export function writingAsHost<T>(fn: () => T): T {
  return hostCopy.run(true, fn)
}

export function isWritingAsHost(): boolean {
  return hostCopy.getStore() === true
}

/**
 * The part of a patch this server may write on `row`. The leader drops the host fields of a
 * host's row (outside writingAsHost); the host that owns a row drops its leader fields. Any other
 * row takes the whole patch. `dropped` names what was left out, for the caller's log.
 */
export function ownedPartOf<P extends Record<string, unknown>>(row: Pick<SessionRecord, 'judge' | 'host'>, patch: P, hostKey = thisHostKey()): { patch: P; dropped: string[] } {
  if (!judgedByHost(row)) return { patch, dropped: [] }
  const mine = rowOwnedHere(row, hostKey)
  if (!mine && isWritingAsHost()) return { patch, dropped: [] }
  const keep: SessionFieldOwner = mine ? 'host' : 'leader'
  const dropped = Object.keys(patch).filter((k) => sessionFieldOwner(k) !== keep)
  if (dropped.length === 0) return { patch, dropped }
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(patch)) if (sessionFieldOwner(k) === keep) out[k] = v
  return { patch: out as P, dropped }
}
