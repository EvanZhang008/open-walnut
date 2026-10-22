/** Shared Inbox item contract. This module has no runtime dependencies. */
export interface InboxMailSource {
  kind: 'mail'
  account: string
  message: string
}
export interface InboxItemDisplay {
  sender?: { name?: string; address?: string }
  sentAt?: string
  accountLabel?: string
  accountHint?: string
}
export interface InboxReadObservation { read: boolean; observedAt: string }
export type InboxOpIntent = 'mark_read' | 'find_task' | 'create_task' | 'attach_task'
export type InboxItemAction =
  | { id: string; kind: 'op'; intent: InboxOpIntent }
  | { id: string; kind: 'reply_ai'; label: string; question: string }
export interface InboxLetterItem {
  id: string
  subject: string
  summary: string
  source: InboxMailSource
  display?: InboxItemDisplay
  readObservation?: InboxReadObservation
  actions: InboxItemAction[]
  /** Present only on stored data that failed validation. No action may run. */
  unavailableReason?: string
  receipts?: InboxItemReceipt[]
}
export interface InboxFrozenInput {
  goal?: string
  title?: string
  project?: string
  selectedTaskId?: string
  retryStart?: boolean
  markReadAgain?: boolean
}
export interface InboxLaunchParameters {
  host: string
  cwd: string
  engine: string
  model: string
  mode: string
}
export interface InboxPlannedOp { tool: 'mail_mark_read' | 'task_create' | 'task_start' | 'task_send'; args: Record<string, unknown> }
export interface InboxTaskCandidate {
  id: string
  title: string
  project: string
  phase: string
}
export interface InboxTaskPreview extends InboxTaskCandidate {
  description?: string
  summary?: string
  activity?: Array<{ text: string; at?: string }>
  updatedAt?: string
}
export interface InboxTaskPage {
  tasks: InboxTaskCandidate[]
  total: number
  offset: number
  limit: number
  hasMore: boolean
}
export interface InboxCurrentTaskStatus {
  taskId: string
  phase?: string
  status: 'running' | 'starting' | 'idle' | 'stopped' | 'error' | 'waiting_permission' | 'waiting_user' | 'waiting' | 'completed' | 'unavailable' | 'deleted'
  observedAt: string
  sessionId?: string
  reason?: string
}
export interface InboxExistingWork {
  taskId: string
  task?: InboxTaskPreview
  status: 'saved' | 'confirmed' | 'deleted' | 'unavailable'
  goal?: string
  intent?: InboxOpIntent
  targetTaskId?: string
}
export interface InboxActionRestriction { code: string; message: string }
export interface InboxItemPlan {
  id: string
  version: number
  actionId: string
  intent: InboxOpIntent | 'reply_ai'
  letterId: string
  itemId: string
  source: InboxMailSource
  input: InboxFrozenInput
  ops: InboxPlannedOp[]
  taskId?: string
  messageId?: string
  idempotencyKey?: string
  launch?: InboxLaunchParameters
  task?: InboxTaskPreview
  createdAt: string
  expiresAt: string
}
export interface InboxItemPrepareRequest extends InboxFrozenInput { actionId: string }
export interface InboxItemPrepareResponse {
  plan?: InboxItemPlan
  projects: Array<{ name: string }>
  source: InboxMailSource
  existingWork?: InboxExistingWork
  restrictions: InboxActionRestriction[]
  receipts: InboxItemReceipt[]
  currentTask?: InboxCurrentTaskStatus
}
export interface InboxItemExecuteRequest {
  actionId: string
  requestId: string
  confirmed?: boolean
  planId: string
  planVersion: number
}
export interface InboxItemReceipt {
  actionId: string
  requestId: string
  requestIds?: string[]
  planId: string
  planVersion: number
  revision: number
  updatedAt: string
  status: 'pending' | 'success' | 'failure'
  intent: InboxOpIntent | 'reply_ai'
  source: InboxMailSource
  input: InboxFrozenInput
  stage: 'accepted' | 'marking_read' | 'creating' | 'starting' | 'sending' | 'delivering' | 'finished'
  taskId?: string
  taskCreated?: boolean
  messageId?: string
  startAttemptId?: string
  execution?: 'starting' | 'running' | 'unconfirmed' | 'not_started'
  startedAt?: string
  delivery?: 'queued' | 'deferred' | 'skipped' | 'failed' | 'unconfirmed'
  reason?: string
  code?: string
  recovery: Array<'check_status' | 'retry_mark_read' | 'retry_create' | 'retry_start' | 'open_task' | 'mark_read_again'>
  attempts?: InboxItemAttempt[]
}
export interface InboxItemAttempt {
  requestId: string
  status: 'pending' | 'success' | 'failure'
  updatedAt: string
  execution?: 'starting' | 'running' | 'unconfirmed' | 'not_started'
  reason?: string
}
export interface InboxItemExecutionResponse {
  itemId: string
  receipts: InboxItemReceipt[]
  currentTask?: InboxCurrentTaskStatus
  readObservation?: InboxReadObservation
  restrictions: InboxActionRestriction[]
}
export interface InboxItemExecuteResponse extends InboxItemExecutionResponse { receipt: InboxItemReceipt }
