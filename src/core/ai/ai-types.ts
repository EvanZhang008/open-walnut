/**
 * One call for a plugin, an App or Walnut itself to use the user's AI (docs/plan/plugin-ai.md).
 *
 * The caller describes the work; Walnut picks the route. Nothing here names a provider, a key or
 * an engine: those are whatever the user already set up.
 */

/** What the model may need beyond the prompt. Any of these makes the call an agent run. */
export interface AiNeeds {
  /** Walnut or plugin op names the agent may call with `walnut tools call <op>`. */
  ops?: string[]
  /** File access inside `cwd`. */
  files?: 'read' | 'edit'
  /** Command prefixes the agent may run, e.g. `python3 -m pytest`. */
  commands?: string[]
  /** Absolute folder the agent works in. */
  cwd?: string
}

export interface AiRunRequest {
  prompt: string
  /** Data the caller already has (a ticket, an answer). Framed as data, never as instructions. */
  context?: string | Record<string, unknown> | unknown[]
  system?: string
  /** A JSON Schema: the answer is parsed into `json` and checked against its required fields and types. */
  format?: { schema: Record<string, unknown> }
  needs?: AiNeeds
  /** The same key continues the same conversation. */
  conversation?: string
  /** quick = the fast model, deep = the strongest one. Default normal. */
  effort?: 'quick' | 'normal' | 'deep'
  /** Lowers the default deadline (60 s direct, 10 min agent); never raises it. */
  timeoutMs?: number
  /** A person waits for this answer (an App's button), so it goes ahead of background work. */
  interactive?: boolean
  onText?: (delta: string) => void
  signal?: AbortSignal
}

export interface AiRunResult {
  text: string
  json?: unknown
  route: 'direct' | 'agent'
  engine: string
  model?: string
  costUsd?: number
  conversation?: string
  durationMs: number
}

/** Who is calling: the budget, the switch and the lanes are keyed by this. */
export interface AiCaller {
  kind: 'plugin' | 'walnut'
  /** Plugin id, or a Walnut feature name. */
  id: string
  name?: string
  /** A folder that belongs to the caller, the agent's cwd when the request names none. */
  homeDir?: string
}

export type AiErrorCode =
  | 'ai_bad_request'
  | 'ai_disabled'
  | 'ai_budget'
  | 'ai_busy'
  | 'ai_unconfigured'
  | 'ai_no_engine'
  | 'ai_timeout'
  | 'ai_aborted'
  | 'ai_format'
  | 'ai_failed'

export class AiError extends Error {
  /** What the failed run had already cost (an agent turn that timed out), counted against the budget. */
  costUsd?: number
  constructor(readonly code: AiErrorCode, message: string) {
    super(message)
    this.name = 'AiError'
  }
}

export function isAiError(error: unknown): error is AiError {
  return error instanceof AiError || (!!error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
    && String((error as { code: string }).code).startsWith('ai_'))
}
