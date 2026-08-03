/**
 * SessionManager — Unified session management abstraction for Claude Code sessions.
 *
 * ARCHITECTURE:
 * ClaudeCodeSession delegates ALL process lifecycle + I/O to a SessionManager.
 * The manager encapsulates HOW and WHERE the Claude CLI process runs:
 *
 *   Local daemon          — Process on local macOS via direct WebSocket
 *   RemoteSessionManager — Process on remote machine via walnut-daemon WebSocket
 *
 * WHY:
 * Before this abstraction, ClaudeCodeSession had 60+ lines of if(sshTarget)
 * branches, 5x instanceof RemoteIO checks, and transport logic leaked into
 * session-health-monitor, sessions.ts routes, and session-chat.ts.
 * The daemon architecture also fixes SSH orphan processes and 6-11s latency.
 *
 * DESIGN PRINCIPLE:
 * - SessionManager is the ONLY interface ClaudeCodeSession uses for I/O
 * - No remote/local branching in consumer code
 * - Inline subagents flow through onOutput (parent_tool_use_id in JSONL)
 * - Team members are separate sessions with their own manager instances
 *
 * REGISTRY:
 * A global Map<sessionId, SessionManager> allows any subsystem (health monitor,
 * liveness checks, routes) to look up the active manager for a session.
 * This replaces ad-hoc isDaemonConnected() calls for remote liveness.
 */

import type { SshTarget } from './session-io.js'
import { RemoteSessionManager } from './remote-session-manager.js'
import { localDaemon } from './local-daemon.js'
import type { DaemonTaskState } from './daemon-connection.js'

// ── Output Events ──

/**
 * A single JSONL line from the Claude CLI output stream.
 * Includes inline subagent events (identified by parent_tool_use_id).
 */
export interface OutputEvent {
  /** Raw JSONL line (unparsed — handleStreamLine does the parsing) */
  line: string
  /** L1 versioned-event position: byte offset at the END of this line in the
   *  daemon's append-only stream file. Monotonic per session, identical live vs
   *  replay. Consumers use it as the consumed-offset watermark (a result whose
   *  v exceeds the persisted watermark was NEVER processed, whatever any boolean
   *  guard claims — incident 10e7df54). Absent on old daemons. */
  v?: number
}

// ── Session History ──

/**
 * Complete session history including main JSONL and subagent data.
 * Used by readHistory() for displaying full conversation tree.
 */
export interface SessionHistory {
  /** Main canonical JSONL content */
  main: string
  /** Subagent JSONL files: Map<filename, content> */
  subagents: Map<string, string>
}

// ── Start Options ──

export interface TransportStartOptions {
  /** Claude CLI arguments (e.g. ['-p', '--output-format', 'stream-json', ...]) */
  args: string[]
  /** Working directory for the Claude process */
  cwd: string
  /** Initial message to send */
  message: string
  /** True when resuming an existing session (--resume) */
  resume?: boolean
  /** True when forking a session (--fork-session) */
  fork?: boolean
  /** Callback for each JSONL line from the output stream */
  onOutput: (event: OutputEvent) => void
  /** Callback when the Claude process exits. stderr is included for remote sessions (read from .jsonl.err on the remote host). */
  onExit: (code: number, stderr?: string) => void
  /**
   * When the initial Quick Start message was spilled to a local temp file,
   * the authoritative pointer to that file. Remote transports upload it to
   * the same absolute path on the remote host before the session starts.
   *
   * Note: `message` has already been rewritten to reference this path as a
   * pointer prompt by the time it reaches here — this field is what drives
   * the upload and avoids regex-scraping the message body.
   */
  spillFile?: { localPath: string }
  /** Permission mode — daemon uses this to auto-respond to control_request. */
  mode?: 'bypass' | 'plan' | 'accept' | 'default'
}

// ── Attach Options ──

export interface TransportAttachOptions {
  /** Claude session ID to reattach to */
  sessionId: string
  /** Byte offset to resume streaming from (skip already-processed data) */
  fromOffset?: number
  /** Callback for each JSONL line */
  onOutput: (event: OutputEvent) => void
  /** Callback when the Claude process exits. stderr is included for remote sessions. */
  onExit: (code: number, stderr?: string) => void
  /** Permission mode — daemon updates session mode on reattach. */
  mode?: 'bypass' | 'plan' | 'accept' | 'default'
}

// ── Start Result ──

export interface TransportStartResult {
  /** PID of the spawned process (local PID for local, SSH PID for remote) */
  pid: number
  /** Path to the local JSONL output file (for health monitoring, rename, etc.) */
  outputFile: string
  /** Current file size at start time (for resume offset tracking) */
  fileSize: number
}

// ── Attach Result ──

export interface TransportAttachResult {
  /** PID of the process being monitored */
  pid: number
  /** Whether the Claude process is still alive */
  alive: boolean
  /** Path to the local JSONL output file */
  outputFile: string
  /** Pending control_request the daemon is tracking (for remote sessions). */
  pendingCtrl?: { reqId: string; toolName: string; request: Record<string, unknown>; receivedAt: number } | null
}

// ── SessionManager Interface ──

/**
 * Unified session manager. ClaudeCodeSession only depends on this interface.
 *
 * Implementations:
 *   Local daemon (RemoteSessionManager w/ __local__ host) — Local WebSocket
 *   RemoteSessionManager — Remote WebSocket daemon via SSH tunnel
 *
 * Lifecycle:
 *   start() → [send() | writeMessage()] → [stop() | interrupt() | kill()] → cleanup()
 *   attach() → [send() | writeMessage()] → ...
 */
export interface SessionManager {
  // ── Startup / Attach ──

  /**
   * Start a new Claude CLI process (or resume an existing session).
   * Sets up FIFO, output file, spawns the process, and begins streaming.
   */
  start(opts: TransportStartOptions): Promise<TransportStartResult>

  /**
   * Reattach to a running session after server restart.
   * Recovers FIFO pipe and starts tailing from the given offset.
   */
  attach(opts: TransportAttachOptions): Promise<TransportAttachResult>

  // ── Messaging ──

  /**
   * Write a follow-up message via the FIFO pipe (stream-json format).
   * Returns true if written successfully, false if pipe is broken.
   */
  writeMessage(message: string): Promise<boolean> | boolean

  /**
   * Write raw JSON to the FIFO (no stream-json wrapping).
   * Used for control_response messages (--permission-prompt-tool stdio protocol).
   */
  writeRaw(json: string): Promise<boolean> | boolean

  /**
   * Write a synthetic user event to the output file (for dedup).
   * Claude CLI doesn't echo user messages — this fills the gap.
   */
  writeSyntheticUserEvent(message: string, walnutMessageId: string): void

  // ── Process Control ──

  /**
   * Gracefully stop the process (SIGINT → wait → SIGTERM).
   * Used before respawning — does NOT clean up FIFO or modify session state.
   */
  stop(): Promise<void>

  /**
   * Kill the process immediately (SIGTERM + remote kill for SSH).
   * Marks resultEmitted so no spurious events fire.
   */
  kill(): void

  /**
   * Interrupt: close pipe, gracefully stop, wait for flush.
   * Two-phase: SIGINT → wait 5s → SIGTERM fallback.
   */
  interrupt(): Promise<void>

  /**
   * Check if the underlying process is alive.
   * For local: PID check. For remote: daemon status query.
   */
  isAlive(): Promise<boolean>

  /**
   * L2: PULL the daemon-authoritative background-task state (source of truth) to reconcile a
   * lost-terminal event without guessing liveness. Returns null when the daemon can't be reached
   * or has no record — callers treat null as "no authoritative answer, keep current state".
   * Optional — only daemon-backed managers implement it.
   */
  getState?(): Promise<DaemonTaskState | null>

  /**
   * Set the permission mode for this session on the daemon.
   * Returns true if mode was set successfully, false on failure or no-op.
   * Optional — only implemented by daemon-backed managers.
   */
  setMode?(mode: string): Promise<boolean>

  // ── Session Management ──

  /**
   * Rename output + pipe files when the real Claude session ID arrives.
   * Called after the system init event provides the actual session_id.
   */
  renameForSession(sessionId: string): void

  /**
   * Detach from the session without killing it.
   * Stops tailing and monitoring. Process continues running.
   */
  detach(): void

  /**
   * Full cleanup — delete pipe and output files.
   */
  cleanup(): Promise<void>

  /**
   * Delete the FIFO pipe (but not the output file).
   */
  deletePipe(): void

  // ── Message Processing ──

  /**
   * Prepare an outbound message for sending.
   * For remote sessions: upload local images to remote host, rewrite paths.
   * For local sessions: no-op (returns message unchanged).
   */
  prepareOutbound(message: string): Promise<string>

  /**
   * Process inbound text from the Claude response.
   * For remote sessions: download remote images, rewrite paths to local.
   * For local sessions: no-op (returns text unchanged).
   *
   * `streaming: true` marks the text as a PARTIAL delta: image paths touching
   * the chunk edges are skipped (they may be split mid-path across deltas and
   * rewriting the fragment corrupts the text permanently).
   */
  processInbound(text: string, sessionId: string, cwd?: string, opts?: { streaming?: boolean }): string

  // ── Streaming Control ──

  /**
   * Flush any buffered data from the tailer (call when process exits).
   */
  flushTail(): void

  /**
   * Stop tailing the output file.
   */
  stopTail(): void

  // ── Properties ──

  /** PID of the monitored process (local PID or SSH PID). Null before start. */
  readonly pid: number | null

  /** Path to the local JSONL output file. Null before start (or always null for remote). */
  readonly outputFile: string | null

  /** Whether the manager has an active write pipe (FIFO). */
  readonly hasPipe: boolean

  /** Current byte offset in the output file. */
  readonly tailOffset: number

  /** Current size of the output file in bytes. */
  readonly fileSize: number

  /** Process name for liveness checks ('claude' for local, 'daemon' for remote). */
  readonly processName: string

  /** Host key (null for local sessions). */
  readonly host: string | null

  /** Whether this is a remote session. */
  readonly isRemote: boolean

  /**
   * Per-session cache for remote→local image path rewriting.
   * Exposed so ClaudeCodeSession can pass it to processInbound().
   */
  readonly imageCache: Map<string, string>

  /**
   * Timestamp (ms) of the last output event received.
   * Used by health monitor for idle timeout checks.
   *
   * Local daemon: derived from output file mtime (persistent on disk).
   * Remote daemon: in-memory timestamp updated on each daemon event.
   *
   * Returns 0 if no events have been received yet.
   */
  readonly lastEventAt: number
}

// ── Registry ──

const _registry = new Map<string, SessionManager>()

/** Register a SessionManager for a given session ID. */
export function registerSessionManager(sid: string, m: SessionManager): void {
  // Evict + detach any prior manager for this sid. Without this, a second
  // RemoteSessionManager registered for the same session (e.g. a rehydrate
  // path that lost the race, or a reconnect that built a fresh instance) stays
  // subscribed to the shared daemon connection — both instances then forward
  // every JSONL line, doubling streamed text (each has its own _seenUuids, so
  // uuid dedup can't catch the cross-instance copy). Detach releases the old
  // instance's event listener before the new one takes over.
  const prev = _registry.get(sid)
  if (prev && prev !== m) {
    try { prev.detach() } catch { /* best-effort — old instance may already be torn down */ }
  }
  _registry.set(sid, m)
}

/** Unregister a SessionManager when a session is cleaned up or renamed. */
export function unregisterSessionManager(sid: string): void {
  _registry.delete(sid)
}

/** Look up the active SessionManager for a session ID. */
export function getRegisteredSessionManager(sid: string): SessionManager | undefined {
  return _registry.get(sid)
}

// ── Backward-compat aliases ──

/** @deprecated Use SessionManager instead */
export type SessionTransport = SessionManager

/** @deprecated Use createSessionManager instead */
export const createTransport = createSessionManager

/** @deprecated Use getRegisteredSessionManager instead */
export const getRegisteredTransport = getRegisteredSessionManager

// ── Factory ──

/**
 * Create the appropriate SessionManager based on whether this is local or remote.
 *
 * Unified architecture: ALL sessions go through a daemon (local or remote).
 * - Remote host with sshTarget: remote daemon via SSH tunnel
 * - No host or '__local__': local daemon via direct WebSocket
 *
 * @param tmpId — temporary ID for file naming (random hex or session ID on resume)
 * @param host — host key from config.hosts (null = local)
 * @param sshTarget — resolved SSH connection parameters
 * @param _outputFileOverride — unused (kept for API compat during migration)
 * @param _cliCommand — unused (kept for API compat during migration)
 * @param directWsUrl — override WebSocket URL (tests, or explicit local daemon URL)
 */
export function createSessionManager(
  tmpId: string,
  host?: string,
  sshTarget?: SshTarget,
  _outputFileOverride?: string,
  _cliCommand?: string,
  directWsUrl?: string,
): SessionManager {
  if (host && sshTarget) {
    return new RemoteSessionManager(tmpId, host, sshTarget, directWsUrl)
  }

  // Unified architecture: all sessions (local + remote) go through a daemon.
  // Local daemon runs on macOS, connected via direct WebSocket (no SSH tunnel).
  // This ensures consistent permission policy, FIFO management, and session
  // survival across Walnut restarts.
  //
  // Local session: route through local daemon.
  // Lazy-start daemon if it wasn't bootstrapped at server startup — this
  // catches cases where server startup bootstrap failed silently or a test
  // harness created sessions without calling startServer() first.
  const wsUrl = directWsUrl || localDaemon.wsUrl
  if (!wsUrl) {
    throw new Error('Local daemon not running. Call localDaemon.ensureRunning() before creating sessions.')
  }
  return new RemoteSessionManager(tmpId, '__local__', null, wsUrl)
}

/**
 * Lazy bootstrap helper — ensures local daemon is running before session creation.
 * Callers that create local sessions should await this first if startup bootstrap
 * may not have run (e.g. in tests or after a failed server startup).
 */
export async function ensureLocalDaemon(): Promise<void> {
  if (!localDaemon.wsUrl) {
    await localDaemon.ensureRunning()
  }
}
