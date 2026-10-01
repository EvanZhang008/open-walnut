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
  dueDate?: string
  startDate?: string
  endDate?: string
  createdAt: string
  updatedAt: string
  completedAt?: string
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
