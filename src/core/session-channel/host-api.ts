/**
 * The wire of the routes a leader calls on a host that runs and judges its sessions
 * (docs/plan/one-service-every-host.md, phase 2): the paths, the bodies and the answers, and the
 * live state a `live` channel record carries. One file both sides build against; the host's
 * routes are host-routes.ts, its records host-emitter.ts.
 *
 *   POST /host-api/sessions/start   StartBody -> StartAnswer
 *   POST /host-api/sessions/send    SESSION_SEND payload -> {ok:true} once queued on the host
 *   POST /host-api/sessions/interrupt SESSION_INTERRUPT payload -> {ok:true}
 *   POST /host-api/sessions/call    CallBody -> {ok:true, value} | {ok:false, error}
 *   POST /host-api/sessions/drop    DropBody -> {ok:true, dropped} once each is a `drop` record
 *                                   (sessions the leader deleted: leader-drops.ts)
 *   GET  /host-api/session-channel  WebSocket upgrade; frames are channel.ts ChannelFrame JSON
 *
 * Every route of a host whose switch is off answers `{ok:false, error:'host_runs_sessions_off'}`.
 */
import type { SessionStartEvent, SessionSendEvent, SessionInterruptEvent } from '../event-types.js'
import type { SessionProfile, SessionRecord, Task } from '../types.js'
import type { HostCallTarget } from './host-calls.js'

export const HOST_SESSIONS_PATH = '/host-api/sessions'
export const HOST_CHANNEL_PATH = '/host-api/session-channel'
export const HOST_SESSIONS_OFF = 'host_runs_sessions_off'
/** A host's answer to a command for a session it does not own (host-routes.ts). */
export const NOT_OWN_SESSION = 'not_own_session'

/**
 * Leader data a host needs to assemble one start, computed on the leader by today's code (its
 * session port). The host's port answers from it first for the start it came with
 * (host-port.ts), then from its own copies.
 */
export interface StartBundle {
  /** The task row as the leader holds it (a task the host's copy may not hold yet). */
  task?: Task
  /** The task's project metadata (getProjectMetadata), null for none. */
  projectMetadata?: Record<string, unknown> | null
  /** buildSessionContext's answer for this start. */
  sessionContext?: { systemPrompt: string }
  /** The resolved launch place; `cwd` also rides the start body. */
  place?: { cwd: string; host?: string }
  /** The session profile (persona, MCP mounts minus the secrets the host has itself). */
  profile?: SessionProfile
  /** The leader already ran prepareStartHints on the message: the host adds none. */
  hintsApplied?: boolean
}

/**
 * The start body: the SESSION_START payload with its leader-only file replaced by its text, the
 * bundle, and the bus source the leader's start carried (`busSource`: it decides how the first
 * message is framed, sessions/send-frame.ts; not a task's sync source, which its bundle's task keeps).
 */
export type StartBody = Omit<SessionStartEvent, 'largePromptFile'> & {
  largePrompt?: string
  /** Where the leader spilled `largePrompt`: the path its `message` names, which the host points at its own file instead. */
  largePromptPath?: string
  startBundle?: StartBundle
  busSource?: string
  /**
   * The leader's hand of an unseeded start (handed-sessions.ts): the host echoes it on that start's
   * born row (`row` {born, hand}). A host older than this ignores it, and its born row then waits
   * for the start's answer.
   */
  startHand?: string
  /**
   * The leader's rows of the task (start-task-rows.ts), projected as the sessions copy sends them: the
   * host takes them before it judges the start or resume. A host older than this ignores them.
   */
  taskRows?: SessionRecord[]
  /** The leader's clock when it read `taskRows`: a copy round the host took after it is newer. */
  taskRowsAt?: number
} & Partial<ResumeFields>

/**
 * A start that resumes a session the leader ran until now and that no CLI runs anywhere (its
 * leader's providers/host-resume.ts): the host checks that no CLI of it runs here, makes its row
 * its own (session-db.ts claimStartingRow, from `resumeRow` when its copy has none yet), queues
 * `queued` as a send would and drains them, which resumes the same CLI session id (`--resume`).
 * Only to a host that names SESSION_RESUME_CAP (switch.ts): an older one would start a new session.
 */
export interface ResumeFields {
  resumeSessionId: string
  /** The leader's row of it, as the leader holds it now. */
  resumeRow: SessionRecord
  queued: QueuedLine[]
}

/** What a hand id looks like: the host echoes nothing else. */
export const HAND_ID = /^[0-9a-f]{18}$/

export type StartAnswer = { ok: true; sessionId: string; title: string } | { ok: false; error: string; why?: string }

/**
 * One queued line a send hands to the host (the leader's queue row, its hints already in the text):
 * the host queues it under the same id (a repeat of the same id is queued once) and drains it.
 */
export interface QueuedLine {
  id?: string; message: string; userUuid?: string; lineUuid?: string; closesPrompt?: true; sentBy?: 'person' | 'agent'
  /**
   * A row the leader held (a message lined up for after the running turn, one held for a cold
   * session's next wake): the host keeps it held under the same reason and releases it itself
   * (its queue-after-turn and cold hold). Only those two reasons cross (HANDED_HOLD_REASONS).
   */
  held?: { reason: string; coldSend?: { source: string; endsWait?: true } }
}
/**
 * `queued`: the lines the leader had queued for this session, which go to the host's queue. A send
 * without it (one made on the host itself) queues its `message`. `holdOnly`: the lines are held
 * rows only, handed over with their hold; the host queues them and starts no delivery.
 */
export type SendBody = SessionSendEvent & { busSource?: string; queued?: QueuedLine[]; holdOnly?: true }
export type InterruptBody = SessionInterruptEvent & { busSource?: string }

export interface CallBody {
  sid: string
  target: HostCallTarget
  member: string
  args?: unknown[]
  /** A `history` read only: its id (for a cancel) and the version of its answer the leader holds (sessions/host-history-answer.ts). */
  read?: { id: string; known?: string }
  /** The positions of `args` the caller left undefined (host-calls.ts callArgsOut). */
  unset?: number[]
}

export type CallAnswer = { ok: true; value: unknown } | { ok: false; error: string }

/** Sessions of this host the leader deleted: the host drops its rows of them (leader-drops.ts). */
export interface DropBody { sids: string[] }

/**
 * What the leader reads of a running session at once (the proxy's sync getters), mirrored by the
 * host's `live` records: the newest one stands for every earlier one. A field the host cannot read
 * is absent.
 */
export interface LiveState {
  turnGen?: number
  processStatus?: string
  inTurn?: boolean | null
  turnRunning?: boolean
  turnStartedAt?: number
  pendingPermission?: boolean
  pendingPermissionRequests?: unknown[]
  mode?: string
  cliSlashCommands?: unknown
  appliedSettings?: unknown
  controlChannelState?: string
  backgroundTasks?: unknown
  outliving?: unknown[]
  cronArmed?: boolean
  teamActive?: boolean
  timestamps?: { lastClaudeOutputAt: number; lastMessageDeliveryAt: number }
  promptCache?: unknown
  controlRequestsPending?: number
  deliveryWait?: { reason: string; retryAt?: string } | null
  lastResultOrigin?: string
  teardownReason?: string
  consumedOffset?: number
  /** Why the host's own retriers continue this turn, and where they stopped (turn-run.ts TurnWait; turn-run-host.ts). */
  turnWaits?: Array<{ reason: string } & Record<string, unknown>>
  turnStops?: Array<{ reason: string } & Record<string, unknown>>
  acp?: { activity?: string; workerLive?: boolean; engineId?: string; sessionControls?: unknown; modelCatalog?: unknown }
  /** The host holds no live session for it now (it ended, or left the runner): nothing runs. */
  gone?: true
  /** Set on the leader, never sent: the host's link is gone past a bound, so what runs there is not known. */
  unknown?: true
}
