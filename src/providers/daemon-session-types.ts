/**
 * What createDaemonRuntime (daemon-standalone.ts) keeps its sessions and sockets in: one
 * session's record (SessionData), its subscribers, an agent subscription, and the data each
 * socket carries (WsData). Shared with the runtime's area modules, whose session code reads and
 * writes the same records. `W` is the runtime's socket type (a Bun ServerWebSocket<WsData>).
 */
import type { ChildProcess } from 'node:child_process'
import type { TurnRetryState, SessionMode, PendingCtrl } from './daemon-core.js'
import type { FoldState, SessionSnapshot } from './daemon-fold.js'
import type { SessionTailer } from './session-tailer.js'
import type { AgentFileState } from './agent-file-chunk.js'
import type { CronMetadataOrigin } from './daemon-cron-metadata.js'
import type { createDaemonCronRuntime } from './daemon-cron-runtime.js'

/** What the spawn journal records for a session once init names its id (a type, so it is a journal record as it is). */
export type SpawnInfo = { kind: 'new' | 'fork' | 'resume'; parent?: string; cwd?: string; home?: string; task?: string; walnut?: string }

/**
 * The runtime's per-session gate (DaemonSessionGate, daemon-cron-controller.ts): one start, send or
 * stop of a session at a time. Its work runs in a `then`, so work that answers at once is fine.
 */
export interface SessionGate { run<T>(sid: string, work: () => T | Promise<T>): Promise<T> }

/** The runtime's cron runtime (daemon-cron-runtime.ts), once Main made it; a module reads it through a getter. */
export type DaemonCronRuntime = Awaited<ReturnType<typeof createDaemonCronRuntime>>

/** A send's outcome (daemon-core.ts SendResult) read field by field: a variant without a field reads undefined. */
export type SendOutcome = { ok?: boolean; reason?: string; error?: string }

// L2: per-session background-task state. `resourceVersion` = byte offset of the latest
// applied event (monotonic, rebuildable from the jsonl). Served on `getState`.
export interface TaskStateEntry { status: string; v: number; t: number; description?: string; isBackgrounded?: boolean; toolUseId?: string }
export interface TaskState {
  tasks: Record<string, TaskStateEntry>
  resourceVersion: number
  updatedAt: number
  derivedRunning: number
  recentTransitions: Array<{ taskId: string; status: string; v: number; t: number }>
}

// A session's subscribers, remembering when someone last watched it (watchedAt): when the set
// was made (a start or an adoption, before the leader attaches) and whenever its last subscriber
// left. The idle scan counts idleness from the later of the last output and watchedAt, so a
// leader that restarts or a link that drops for a moment stops no session (2026-11-23: a Mac
// deploy dropped the leader's link for 10 s and the next scan stopped 17 sessions idle 2 to 4
// hours that it was about to subscribe to again).
export class Subscribers<T> extends Set<T> {
  watchedAt = Date.now()
  delete(ws: T): boolean { const had = super.delete(ws); if (had && this.size === 0) this.watchedAt = Date.now(); return had }
  clear(): void { if (this.size > 0) this.watchedAt = Date.now(); super.clear() }
}

export interface SessionData<W = unknown> {
  proc: ChildProcess | null
  pipePath: string
  jsonlPath: string
  pgidPath: string
  pid: number | null
  offset: number
  // L2: daemon-authoritative background-task state, materialized from task_* events in the
  // watcher loop and served on the `getState` RPC. Rebuilt from jsonl on adopt/discover.
  taskState: TaskState
  // Session-bound file tailer. Lifecycle = session process lifetime. NOT tied
  // to any WebSocket. Closed only by reapSession or daemon shutdown.
  watcher: { pollTimer: ReturnType<typeof setInterval>; offset: number; tailer?: SessionTailer } | null
  // Clients currently receiving push events. Add on cmdAttach/cmdStart,
  // remove on ws.close. Watcher is unaffected by subscriber churn — this
  // replaces the old per-ws watcher Map that tied file-tailing to WS
  // lifetime and caused "no watchers after reconnect" streaming loss.
  subscribers: Subscribers<W>
  exitCode: number | null
  // Phase B/C additions: daemon is the single source of truth for CLI/FIFO
  // lifecycle. `state` is the authoritative flag; `exitCode !== null` was
  // previously the only death signal but 3 different code paths toggled it,
  // which made idempotent cleanup hard. `parented=false` means the session
  // was adopted from the on-disk registry (e.g. across daemon restarts).
  state: 'running' | 'dead'
  exitReason: string | null
  exitedAt: number | null
  parented: boolean
  cliVersion?: string
  bootId?: string
  cronMetadataLoaded?: boolean
  cronMetadataLoading?: boolean
  cronMetadataOrigin?: CronMetadataOrigin
  startTime: string | null  // /proc/<pid>/stat start_time snapshot (Linux)
  cwd: string
  args: string[]
  orphanPollTimer: ReturnType<typeof setInterval> | null
  mode: SessionMode
  pendingCtrl: PendingCtrl | null
  // Epoch ms at which somebody DELIBERATELY asked this session to stop — our
  // own idle scanner, or any `stop` RPC (cmdStop). Stamped before the first
  // signal is sent (the death lands asynchronously, usually via orphan-poll
  // ESRCH, by which point the reason is gone) so reapSession can report a clean
  // exit code for a deliberate stop instead of a red error.
  // See daemon-core.ts CoreSessionData.intentionalStopAt.
  intentionalStopAt?: number | null
  // C1: incremental fold of the stream file → authoritative SessionSnapshot
  // (docs/plan/session-snapshot-source-of-truth.md §4). Maintains its own v
  // and bg map — coexists with taskState L2 (retirement is C4's call).
  foldState: FoldState
  // Last snapshot pushed to subscribers — change detection ignores bare v advance.
  lastPushedSnapshot?: SessionSnapshot | null
  // 50ms coalesce timer for snapshot pushes (death pushes skip it).
  snapshotTimer?: ReturnType<typeof setTimeout> | null
  spawnTs?: number   // latency instrumentation: CLI spawn ts
  sawInit?: boolean  // latency instrumentation: first init line seen
  spawnInfo?: SpawnInfo  // what the spawn journal records once init names the id
  // Scheduled-task (CLI cron) fire detection — see daemon-core detectCronFires.
  // Dedup map `${taskId}:${lastFiredAt}` → detectedAtMs; in-memory only.
  cronWarned?: Record<string, number>
  lastCronCheckTs?: number
  // Disk-side cron interest cache for the idle scan (60s scans × N sessions
  // would otherwise re-read scheduled_tasks.json every minute forever).
  diskCronCache?: { at: number; armed: boolean; reason: 'creator' | 'lock_holder' | null }
  // durable:true CronCreate corrections already injected, keyed by tool_use id.
  durableCronNudged?: Record<string, number>
  // Tailer self-heal: last forced watcher rebuild ts. Session-level (not watcher
  // closure) so the rebuilt watcher inherits the cooldown — a persistent error
  // (EMFILE) can't thrash rebuild every few seconds.
  lastWatcherHealAt?: number
  // Identity of the stream FILE (dev:ino:birthtimeMs, computed at spawn/adopt).
  // Rides every snapshot so walnut can tell "same file, higher v" from "the
  // file was recreated and v restarted at 0" (incident 019a7fe5). null when
  // stat failed; recomputed lazily by streamEpochOf.
  streamEpoch?: string | null
  // foldState.v of the last fold checkpoint written for this session.
  foldCheckpointV?: number
  /** The epoch of the file a stream compaction replaced with this one (stream-compact-core.ts). */
  rewrittenFrom?: string | null
  // Turn-error auto-retry (see daemon-core decideTurnRetry). Streak bookkeeping
  // persists in the registry so a daemon restart can't reset a 12h budget to 0.
  turnRetry?: TurnRetryState
  // Pending retry timer — cleared by any real send (the human took over) and by
  // reapSession, so a resume can never fire behind a user's back or after death.
  turnRetryTimer?: ReturnType<typeof setTimeout> | null
  // As in daemon-core.ts CoreSessionData, which reads them.
  outputStartOffset?: number
  stderrStartOffset?: number
  budgetGracefulStop?: boolean
  ttftSendTs?: number | null
  ttftSawFirstLine?: boolean
}

export interface AgentSub<W = unknown> {
  files: Map<string, AgentFileState>
  timer: ReturnType<typeof setInterval> | null
  rediscoverTimer: ReturnType<typeof setInterval> | null
  ws: W
  sid: string
  agent: string
  team?: string
}

export interface WsData {
  /** A client in this process (connect()): frames go to it as objects, never as JSON text. */
  deliverFrame?: (frame: Record<string, unknown>) => void
  /** Per-socket FIFO of payloads Bun refused to send (backpressure). Flushed on drain. */
  sendQueue?: string[]
  /** Total bytes currently held in sendQueue (for the overflow guard). */
  sendQueueBytes?: number
  /**
   * 'bridge' = the cloud dial-out socket. The cloud box is a semi-trusted
   * PUBLIC relay, so its inbound frames are restricted to the phone-proxy
   * command set (BRIDGE_ALLOWED_COMMANDS) — the full privileged RPC surface
   * (fs.write/start/bridge.configure/…) is reachable ONLY over the trusted
   * SSH-tunneled client path. Absent = trusted local/SSH client.
   *
   * 'follower' = a Walnut server on THIS host that follows the leader (the host
   * server, docs/plan/walnut-servers-everywhere.md), after `follower.hello`. It
   * reads (FOLLOWER_ALLOWED_COMMANDS) and is never taken for the leader: its
   * frames are not the primary heard, and no relay, gateway call, trigger or
   * cron note is ever sent to it.
   *
   * 'lane' = a second link of the leader's, for byte streams only, after
   * `stream.lane` ('stream-lane-v1'): it rides its own SSH connection, so a
   * stream's bytes never share the one the leader's sessions use, and the
   * session link outlives a connection a large stream broke. Streams only
   * (LANE_ALLOWED_COMMANDS); like a follower, never taken for the leader.
   *
   * 'probe' = a test server (an ephemeral one attached read only to a host it
   * shares with the real Walnut) after `client.role` ('client-role-v1'). It keeps
   * every command it had, but it is not a Walnut server of this host: it is never
   * taken for the leader, and no relay, gateway call, trigger event, phone request
   * or cron note is sent to it. Before this, whichever server's socket came first
   * got an env-less `walnut` call, and a test server answered the real one's
   * (2026-11-02: trigger_list said every trigger was off).
   */
  origin?: 'bridge' | 'follower' | 'lane' | 'probe'
  /** A follower's Walnut (the leader's data dir), set by follower.hello. */
  followerHome?: string
  /** That follower answers this host's `walnut` calls while its leader is away ('follower-gateway-v1'). */
  answersLocal?: boolean
  /** That follower also takes a same-host message while its leader answers (replica/away-sends.ts; 'follower-peer-v1'). */
  answersOnline?: boolean
  /** That follower delivers this host's unclaimed trigger fires while its leader is away ('follower-trigger-delivery-v1'). */
  deliversTriggers?: boolean
  /** That follower's host call entry socket ('host-call-entry-v1'), given to the sessions and jobs this daemon starts. */
  callSocket?: string
  /** A lane's Walnut, set by stream.lane. */
  laneHome?: string
  /** The Walnut this socket configured triggers for ('' = a push that named none); its fires go here. */
  triggerScope?: string
  /** A bridge link's Walnut ('' = an older server's link), set when it opens. */
  bridgeHome?: string
  /** When this socket last sent anything (a frame, a ping, a pong). See heardFrom. */
  lastHeardAt?: number
  /** When this socket was last told the companion leads its Walnut (see heardFrom). */
  leaderNudgedAt?: number
  /** Keepalive beats in a row this trusted socket stayed silent (0 once heard again). */
  missedBeats?: number
  /** The server process behind this socket, from its hello (`run`): a relay goes again only to the run it went to. */
  serverRun?: string
  /** When its hello named that run and said its server binds: until it does, a moment of grace (gatewayCandidates). */
  helloAt?: number
  /** When it opened: one that has named no run yet is `fresh` for the same grace (gatewayCandidates). */
  connectedAt?: number
  /** The ops that server names read-only (its hello's `readOps`): a relay of one may go to it from another run. */
  readOps?: Set<string>
}
