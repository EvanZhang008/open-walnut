/**
 * Light subagents: one prompt a session runs inside its own turn on an engine of its
 * choice (Codex, OpenCode, Goose, Pi, Gemini, Claude), the way Claude Code's Agent tool
 * runs a subagent: in its own directory on its own host, or (`host`) on another host in
 * a copy of its work there (on-host.ts). No task, no board row: a run lives in the
 * server's memory, shows in the parent session's Background tasks panel, and ends with
 * its answer.
 */
import type { SessionEngine } from '../types.js'

/**
 * The lane of a subagent's session (core/subagents/on-host.ts; core/sessions: a lane is kept out
 * of the lists and the capacity count). Its `walnut` calls act as its caller's, so it gets none of
 * the hooks that read "what is still open for you" (session-settings-hooks.ts): those are its
 * caller's, and answering them would take over its own answer.
 */
export const SUBAGENT_LANE_PREFIX = 'subagent:'
export function isSubagentLane(lane: string | undefined): boolean { return !!lane?.startsWith(SUBAGENT_LANE_PREFIX) }

export type LightSubagentStatus = 'running' | 'completed' | 'failed' | 'stopped'

/** Why a run could not start or did not finish, as one code a caller can branch on. */
export type LightSubagentErrorCode =
  | 'bad_request'
  | 'no_session'
  | 'engine_unavailable'
  | 'model_unavailable'
  | 'host_unreachable'
  /** The host it was aimed at is revoked (session-channel/revoked-hosts.ts). */
  | 'host_revoked'
  | 'too_many'
  | 'not_found'
  | 'timed_out'
  | 'stopped'
  | 'engine_error'
  /** The caller's work could not be copied to the other host, or set up there. */
  | 'work_copy_failed'
  /** A message to a subagent that was closed (stopped, idle too long, its session gone). */
  | 'closed'
  /** This server is stopping: the next one takes the subagent up (registry.ts). */
  | 'restarting'

export class LightSubagentError extends Error {
  constructor(readonly code: LightSubagentErrorCode, message: string, readonly status = 409, readonly data: Record<string, unknown> = {}) {
    super(message)
    this.name = 'LightSubagentError'
  }
}

/** What a runner reports while it works: the panel row's meta line and reader. */
export type LightProgress =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; toolName: string }
  | { kind: 'tokens'; tokens: number }

export interface LightRunSpec {
  /** The worker's own id on the host (never a session id). */
  runtimeId: string
  /** The run's id (sa-...), as its caller knows it. */
  runId?: string
  engine: SessionEngine
  /** The parent session's host ('__local__' = this machine). */
  host: string
  cwd: string
  /** Absent: the engine's own default (Walnut never picks one). */
  model?: string
  effort?: string
  prompt: string
  /** The parent runs with full access: the child may act without asking; else it only reads. */
  fullAccess: boolean
  /** The parent session's record id. */
  parentSid: string
  /**
   * The id its `walnut` calls name (WALNUT_SESSION_ID), so they act for the parent as a
   * Claude Code subagent's do: the parent's own id on its host's daemon (an ACP parent's
   * runtime id, which is what the daemon's gateway knows it by).
   */
  callerSid: string
  /** When the run's own limit ends (epoch ms): the host's daemon stops the worker then too. */
  deadlineAt: number
  /** When the run started (epoch ms). */
  startedAt?: number
  parentTaskId?: string
  /** The parent's Walnut mode: a session subagent (on-host.ts) runs in the same one when it never waits on a person. */
  parentMode?: import('../types.js').SessionMode
  /**
   * Set when the run goes to another host than its parent's (`host`): it works there in a
   * copy of the parent's work at `fromCwd` on `fromHost` (work-copy.ts), as a session of
   * its own (on-host.ts), and the files it names come back to the parent's task directory.
   */
  away?: { fromHost: string; fromCwd: string }
  /** With `away`: reads the caller's grant on that host again; throws once the user revoked it. Called right before the session starts there. */
  stillGranted?: () => Promise<void>
  signal: AbortSignal
  onProgress: (p: LightProgress) => void
  /** What a restart must keep changed (its session named, its copy placed, a file returned): the registry writes it down. */
  onState?: () => void
}

export interface LightRunResult {
  answer: string
  tokens?: number
  /** Things the run went on without (an effort the engine does not offer). */
  warnings: string[]
  /** A run on another host: the files it named, copied back (`to` is on the parent's host). */
  files?: ReturnedFile[]
  /** A run on another host: what of the parent's work it got, and what was left behind there. */
  work?: string[]
}

export interface ReturnedFile { from: string; to: string; bytes: number }

export type LightRunner = (spec: LightRunSpec) => Promise<LightRunResult>

export const LIGHT_SUBAGENT_ENGINES: readonly SessionEngine[] = ['codex', 'antigravity', 'opencode', 'goose', 'pi', 'gemini', 'dsh', 'custom', 'claude']

/** What a turn a restart cut off is asked again, once its session is idle and its own end was not seen. */
export const RESUME_PROMPT = '[Walnut] Walnut\'s server restarted while you were answering, so the answer you were working on was not received. '
  + 'If you had finished, send that final answer again, in full. If not, carry on, and end with your whole answer.'
