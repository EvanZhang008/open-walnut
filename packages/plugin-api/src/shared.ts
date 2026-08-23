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

export type TaskPhase = 'TODO' | 'IN_PROGRESS' | 'AGENT_COMPLETE' | 'COMPLETE'
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
