export interface Disposable {
  dispose(): void | Promise<void>
}

export interface PluginLogger {
  trace(message: string, data?: Record<string, unknown>): void
  debug(message: string, data?: Record<string, unknown>): void
  info(message: string, data?: Record<string, unknown>): void
  warn(message: string, data?: Record<string, unknown>): void
  error(message: string, data?: Record<string, unknown>): void
  fatal(message: string, data?: Record<string, unknown>): void
  child(name: string): PluginLogger
}

/**
 * The task lifecycle. `WAITING` (added in 0.5.2) is a task parked until something
 * happens; it belongs to the `todo` status bucket. A plugin receives it only when
 * its manifest declares `"phases": ["WAITING"]`; otherwise the host folds it onto
 * TODO before any call (see `legacyPhase`). Treat an unknown phase as TODO.
 */
export type TaskPhase = 'TODO' | 'WAITING' | 'IN_PROGRESS' | 'NEED_ACTION' | 'COMPLETE'
/** The phase set before WAITING existed, for mappings that must stay exhaustive on the old set. */
export type LegacyTaskPhase = Exclude<TaskPhase, 'WAITING'>
/** Fold a phase onto the set every plugin API version has known. */
export function legacyPhase(phase: TaskPhase): LegacyTaskPhase {
  return phase === 'WAITING' ? 'TODO' : phase
}
export type TaskPriority = 'immediate' | 'important' | 'backlog' | 'none'

export interface WalnutTask {
  id: string
  title: string
  phase: TaskPhase
  priority: TaskPriority
  project?: string
  description: string
  summary: string
  note?: string
  parentTaskId?: string
  dependsOn?: string[]
  tags?: string[]
  source: string
  /** The folder the task is filed in, inside its project. Absent at the project root. */
  groupId?: string
  /** Every provider session ever linked to the task, the current one included. It
   *  outlives completion, which clears the task's live session slot. */
  sessionIds?: string[]
  /** On the pinned board. */
  pinned?: boolean
  /** The pinned task's tier: `focus`, `wait` (Parked) or a custom tier id. Absent on a
   *  pinned task means Satellite. The retired `backlog` is never served; a plugin may
   *  still send it and it lands in `wait`. */
  focusTier?: string
  /** The pinned task's place in the pinned order (ascending = top first), across tiers. */
  pinOrder?: number
  dueDate?: string
  startDate?: string
  endDate?: string
  createdAt: string
  updatedAt: string
  completedAt?: string
  /** Kept to its plugin's own view (manifest `taskVisibility: "plugin"`): the board, task
   *  lists, default search, the Org page and needs-you counts never show it. */
  pluginOnly?: boolean
}

export interface WalnutTaskSummary extends Omit<WalnutTask, 'description' | 'summary' | 'note'> {
  hasDescription: boolean
  hasSummary: boolean
  hasNote: boolean
}

export interface WalnutErrorShape {
  code: string
  message: string
  details?: unknown
}

export class WalnutPluginError extends Error {
  readonly code: string
  readonly details?: unknown

  constructor(error: WalnutErrorShape) {
    super(error.message)
    this.name = 'WalnutPluginError'
    this.code = error.code
    this.details = error.details
  }
}

/**
 * What a request to the user's AI may need beyond its prompt. Any of these makes Walnut run it
 * as an agent session (on the daemon, hidden from the user's lists) instead of one direct answer.
 */
export interface AiNeeds {
  /** Walnut or plugin op names the agent may call (`walnut tools call <op>`). Your own ops may be named without the plugin prefix. */
  ops?: string[]
  /** File access inside `cwd`. */
  files?: 'read' | 'edit'
  /** Command prefixes the agent may run, e.g. `python3 -m pytest`. Plain words only. */
  commands?: string[]
  /** Absolute folder the agent works in. Defaults to your plugin's data folder. */
  cwd?: string
}

export interface AiRunRequest {
  prompt: string
  /** Data you already have (a ticket, an answer). The model reads it as data, not instructions. */
  context?: string | Record<string, unknown> | unknown[]
  system?: string
  /** A JSON Schema. The answer is parsed into `json` and checked for its types and required fields. */
  format?: { schema: Record<string, unknown> }
  needs?: AiNeeds
  /** The same key continues the same conversation; `end(key)` forgets it. */
  conversation?: string
  /** quick = the fast model, deep = the strongest one. Default normal. */
  effort?: 'quick' | 'normal' | 'deep'
  /** Lower the default deadline (60 s direct, 10 min agent). */
  timeoutMs?: number
  /** A person is waiting (an App button): it goes ahead of background work. The web side sets it. */
  interactive?: boolean
  /** Answer text as it is written. */
  onText?(delta: string): void
  signal?: AbortSignal
}

export interface AiRunResult {
  text: string
  /** Present when the request had a `format`. */
  json?: unknown
  /** How Walnut ran it: one answer, or an agent session. */
  route: 'direct' | 'agent'
  engine: string
  model?: string
  /** What the provider reported (a subscription login reports a nominal figure). */
  costUsd?: number
  conversation?: string
  durationMs: number
}

/**
 * The user's AI, through whatever they set up in Walnut (a Claude Code login, a provider in
 * Settings). Your plugin never sees a key. Failures reject with an Error whose `code` is one of
 * ai_bad_request, ai_disabled, ai_budget, ai_busy, ai_unconfigured, ai_no_engine, ai_timeout,
 * ai_aborted, ai_format, ai_failed, and whose message can be shown to the person as it is.
 * The user can turn AI off for your plugin and sets its monthly budget in Settings, Plugins.
 */
export interface AiService {
  run(request: AiRunRequest): Promise<AiRunResult>
  /** Forget a conversation and stop its session. */
  end(conversation: string): Promise<{ ended: boolean }>
}
