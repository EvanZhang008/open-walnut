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
import type { SessionProfile, Task } from '../types.js'
import type { HostCallTarget } from './host-calls.js'

export const HOST_SESSIONS_PATH = '/host-api/sessions'
export const HOST_CHANNEL_PATH = '/host-api/session-channel'
export const HOST_SESSIONS_OFF = 'host_runs_sessions_off'

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
  startBundle?: StartBundle
  busSource?: string
}

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
}
