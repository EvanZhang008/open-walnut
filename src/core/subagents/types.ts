/**
 * Light subagents: one prompt a session runs inside its own turn on an engine of its
 * choice (Codex, OpenCode, Goose, Pi, Gemini, Claude), in its own directory on its own
 * host, the way Claude Code's Agent tool runs a subagent. No task, no session record,
 * no board row: a run lives in the server's memory, shows in the parent session's
 * Background tasks panel, and ends with its answer.
 */
import type { SessionEngine } from '../types.js'

export type LightSubagentStatus = 'running' | 'completed' | 'failed' | 'stopped'

/** Why a run could not start or did not finish, as one code a caller can branch on. */
export type LightSubagentErrorCode =
  | 'bad_request'
  | 'no_session'
  | 'engine_unavailable'
  | 'model_unavailable'
  | 'host_unreachable'
  | 'too_many'
  | 'not_found'
  | 'timed_out'
  | 'stopped'
  | 'engine_error'

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
  parentTaskId?: string
  signal: AbortSignal
  onProgress: (p: LightProgress) => void
}

export interface LightRunResult {
  answer: string
  tokens?: number
  /** Things the run went on without (an effort the engine does not offer). */
  warnings: string[]
}

export type LightRunner = (spec: LightRunSpec) => Promise<LightRunResult>

export const LIGHT_SUBAGENT_ENGINES: readonly SessionEngine[] = ['codex', 'opencode', 'goose', 'pi', 'gemini', 'dsh', 'custom', 'claude']
