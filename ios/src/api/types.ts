/**
 * Types for the frozen /api/v1 REST+SSE contract (docs/api-v1.md).
 */

// ── Errors ──

export interface ApiErrorBody {
  error: { code: string; message: string }
  // Endpoint-specific extras ride at the top level (e.g. note conflict).
  [key: string]: unknown
}

export class ApiError extends Error {
  readonly code: string
  readonly status: number
  /** Endpoint-specific extras, e.g. { serverHash, serverContent } on note 409. */
  readonly extra: Record<string, unknown>

  constructor(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.extra = extra
  }
}

// ── Status ──

export interface ServerStatus {
  mode: 'LIVE' | 'REPLICA'
  cloud: boolean
  version: string
  serverTime: string
  lastSyncAt?: string
}

// ── Chat ──

export interface ConversationSummary {
  id: string
  title?: string
  updatedAt: string
  messageCount: number
}

export type MessageKind = 'tool' | 'thinking'

export interface ApiMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  createdAt: string
  kind?: MessageKind
  /** Client-only flags for optimistic entries. */
  pending?: boolean
  streaming?: boolean
}

// ── SSE events ──

export type SseEventName =
  | 'message-start'
  | 'text-delta'
  | 'tool'
  | 'thinking'
  | 'message-end'
  | 'error'

export interface SseHandlers {
  onStart?: (data: { turnId: string }) => void
  onDelta?: (data: { delta: string }) => void
  onTool?: (data: { name: string }) => void
  onThinking?: () => void
  onEnd?: (data: { turnId: string; fullText: string }) => void
  onTurnError?: (data: { message: string }) => void
  onConnectionChange?: (connected: boolean) => void
}

// ── Notes ──

export interface NoteTreeNode {
  name: string
  path: string
  type: 'file' | 'folder'
  kind?: 'note' | 'attachment'
  children?: NoteTreeNode[]
}

export interface NoteContent {
  content: string
  contentHash: string
  updatedAt: string
}

export interface NoteWriteResult {
  contentHash: string
  updatedAt: string
}
