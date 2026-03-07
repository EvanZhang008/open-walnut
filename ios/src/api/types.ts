/**
 * Shared types between Walnut server and iOS client.
 * Manually maintained subset of server types — keep in sync.
 */

// ── WebSocket protocol ──

export type WsFrame =
  | { type: 'event'; name: string; data: unknown; seq: number }
  | { type: 'req'; id: string; method: string; payload: unknown }
  | { type: 'res'; id: string; ok: boolean; payload?: unknown; error?: string }

export type ConnectionState = 'connecting' | 'connected' | 'disconnected'

// ── Chat types ──

export interface ChatEntry {
  tag: 'ai' | 'ui'
  role: 'user' | 'assistant'
  content: unknown
  timestamp: string
  displayText?: string
  source?: string
  notification?: boolean
  taskId?: string
  sessionId?: string
  compacted?: boolean
}

export interface ChatHistoryResponse {
  messages: ChatEntry[]
  pagination: {
    page: number
    pageSize: number
    totalMessages: number
    totalPages: number
    hasMore: boolean
  }
}

export type MessageBlock =
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown>; status?: string; result?: string }
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: string; media_type: string; data: string } }

export interface TaskContext {
  id: string
  title: string
  category?: string
  project?: string
  status?: string
  phase?: string
  priority?: string
  starred?: boolean
}

// ── Task types ──

export type TaskStatus = 'todo' | 'in_progress' | 'done'
export type TaskPriority = 'immediate' | 'important' | 'backlog' | 'none'

export interface Task {
  id: string
  title: string
  status: TaskStatus
  priority: TaskPriority
  phase: string
  category: string
  project: string
  description: string
  summary: string
  note: string
  starred?: boolean
  needs_attention?: boolean
  due_date?: string
  created_at: string
  updated_at: string
  subtasks?: Array<{ id: string; title: string; done: boolean }>
}

// ── Chat message for display ──

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  timestamp: string
  isStreaming?: boolean
  source?: string
  notification?: boolean
  blocks?: MessageBlock[]
}
