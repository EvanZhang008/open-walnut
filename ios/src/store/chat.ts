/**
 * Chat store — manages messages, streaming, and chat history.
 * Core logic ported from web/src/hooks/useChat.ts.
 */

import { create } from 'zustand'
import { wsClient } from '../api/ws'
import { fetchChatHistory } from '../api/client'
import type { ChatMessage, ChatEntry, TaskContext, MessageBlock } from '../api/types'

interface ChatStore {
  messages: ChatMessage[]
  isStreaming: boolean
  error: string | null
  isLoading: boolean
  hasMore: boolean
  currentPage: number
  taskContext: TaskContext | null
  streamBuffer: string

  // Actions
  initialize: () => void
  cleanup: () => void
  sendMessage: (text: string) => void
  stopGeneration: () => void
  loadHistory: () => Promise<void>
  loadOlderMessages: () => Promise<void>
  setTaskContext: (ctx: TaskContext | null) => void
  clearMessages: () => void
}

let flushTimer: ReturnType<typeof setTimeout> | null = null
let streamingMessageId: string | null = null

// Monotonic counter — guarantees unique IDs across all message sources
let msgIdSeq = 0
function nextMsgId(prefix: string): string {
  return `${prefix}-${++msgIdSeq}`
}

// Track initialization to prevent duplicate WebSocket subscriptions
let initialized = false

/**
 * Transform entity refs (<task-ref>, <session-ref>) to readable markdown.
 * The server stores these as XML tags with labels; iOS renders them as bold text.
 */
function transformEntityRefs(text: string): string {
  // <task-ref id="abc" label="Project / Title" /> → **Project / Title**
  // Also handles self-closing without space: <task-ref ... />
  text = text.replace(
    /<task-ref\s+id="[^"]*"\s+label="([^"]*)"\s*\/>/g,
    '**$1**'
  )
  // Handle task-ref without label (just show shortened ID)
  text = text.replace(
    /<task-ref\s+id="([^"]*)"\s*\/>/g,
    '`$1`'
  )
  // <session-ref id="abc" label="Session Name" /> → *Session Name*
  text = text.replace(
    /<session-ref\s+id="[^"]*"\s+label="([^"]*)"\s*\/>/g,
    '*$1*'
  )
  text = text.replace(
    /<session-ref\s+id="([^"]*)"\s*\/>/g,
    '`$1`'
  )
  return text
}

function entryToMessage(entry: ChatEntry): ChatMessage {
  let blocks: MessageBlock[] | undefined
  let text = ''

  if (Array.isArray(entry.content)) {
    blocks = entry.content as MessageBlock[]
    text = blocks
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('')
  } else if (typeof entry.content === 'string') {
    text = entry.content
  } else {
    text = String(entry.content ?? '')
  }

  // Prefer displayText if available and text is empty
  if (!text && entry.displayText) text = entry.displayText

  // Transform entity refs to readable markdown
  text = transformEntityRefs(text)

  return {
    id: nextMsgId('entry'),
    role: entry.role,
    text,
    timestamp: entry.timestamp,
    source: entry.source,
    blocks,
  }
}

export const useChatStore = create<ChatStore>((set, get) => ({
  messages: [],
  isStreaming: false,
  error: null,
  isLoading: false,
  hasMore: true,
  currentPage: 1,
  taskContext: null,
  streamBuffer: '',

  initialize: () => {
    // Prevent duplicate WebSocket subscriptions on re-mount
    if (initialized) {
      // Already subscribed — just refresh history
      get().loadHistory()
      return
    }
    initialized = true

    // Load initial history
    get().loadHistory()

    // Subscribe to streaming events
    wsClient.onEvent('agent:text-delta', (data) => {
      const d = data as { text?: string; delta?: string }
      const delta = d.text ?? d.delta ?? ''
      if (!delta) return

      set((s) => ({ streamBuffer: s.streamBuffer + delta }))

      // Debounce flush to 50ms for smooth streaming
      if (!flushTimer) {
        flushTimer = setTimeout(() => {
          flushTimer = null
          const { streamBuffer, messages } = get()
          if (!streamBuffer || !streamingMessageId) return

          const updated = messages.map((m) =>
            m.id === streamingMessageId ? { ...m, text: m.text + streamBuffer, isStreaming: true } : m
          )
          set({ messages: updated, streamBuffer: '' })
        }, 50)
      }
    })

    wsClient.onEvent('agent:response', (data) => {
      // Flush any remaining buffer
      if (flushTimer) {
        clearTimeout(flushTimer)
        flushTimer = null
      }

      const { streamBuffer, messages } = get()
      const d = data as { text?: string; content?: MessageBlock[] }
      const finalText = d.text ?? ''

      // If we have a streaming message, finalize it
      if (streamingMessageId) {
        const updated = messages.map((m) => {
          if (m.id === streamingMessageId) {
            const raw = finalText || (m.text + streamBuffer)
            return { ...m, text: transformEntityRefs(raw), isStreaming: false }
          }
          return m
        })
        set({ messages: updated, isStreaming: false, streamBuffer: '', error: null })
      } else {
        // No streaming message — add the response directly
        if (finalText) {
          set((s) => ({
            messages: [...s.messages, {
              id: nextMsgId('resp'),
              role: 'assistant' as const,
              text: transformEntityRefs(finalText),
              timestamp: new Date().toISOString(),
            }],
            isStreaming: false,
            streamBuffer: '',
            error: null,
          }))
        } else {
          set({ isStreaming: false, streamBuffer: '' })
        }
      }
      streamingMessageId = null
    })

    wsClient.onEvent('agent:error', (data) => {
      const d = data as { error?: string; message?: string }
      const errMsg = d.error ?? d.message ?? 'An error occurred'

      // Finalize streaming message if active
      if (streamingMessageId) {
        const { messages, streamBuffer } = get()
        const updated = messages.map((m) =>
          m.id === streamingMessageId ? { ...m, text: m.text + streamBuffer, isStreaming: false } : m
        )
        set({ messages: updated })
      }

      set({ isStreaming: false, error: errMsg, streamBuffer: '' })
      streamingMessageId = null
    })

    // Chat history updated (e.g. from triage, cron, heartbeat)
    wsClient.onEvent('chat:history-updated', (data) => {
      const d = data as { entry?: ChatEntry }
      if (d.entry && !get().isStreaming) {
        // Dedup: skip if we already have a message with this timestamp and role
        const existing = get().messages
        const isDup = existing.some(
          (m) => m.timestamp === d.entry!.timestamp && m.role === d.entry!.role
        )
        if (!isDup) {
          const msg = entryToMessage(d.entry)
          set((s) => ({ messages: [...s.messages, msg] }))
        }
      }
    })
  },

  cleanup: () => {
    // Note: we keep WebSocket subscriptions alive across tab switches
    // since Zustand store persists. Only clear timers.
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
  },

  sendMessage: (text: string) => {
    const { taskContext } = get()

    // Add user message to local list
    const userMsg: ChatMessage = {
      id: nextMsgId('user'),
      role: 'user',
      text,
      timestamp: new Date().toISOString(),
    }

    // Create placeholder for assistant streaming
    const assistantId = nextMsgId('stream')
    streamingMessageId = assistantId
    const assistantMsg: ChatMessage = {
      id: assistantId,
      role: 'assistant',
      text: '',
      timestamp: new Date().toISOString(),
      isStreaming: true,
    }

    set((s) => ({
      messages: [...s.messages, userMsg, assistantMsg],
      isStreaming: true,
      error: null,
      streamBuffer: '',
    }))

    // Send via WebSocket RPC
    const payload: Record<string, unknown> = { message: text }
    if (taskContext) payload.taskContext = taskContext

    wsClient.sendRpc('chat', payload).catch((err) => {
      set({ error: err instanceof Error ? err.message : 'Failed to send message' })
    })
  },

  stopGeneration: () => {
    wsClient.sendRpc('chat:stop', {}).catch(() => {})
  },

  loadHistory: async () => {
    set({ isLoading: true })
    try {
      const resp = await fetchChatHistory(1, 50)
      const entries = resp.messages ?? []
      const msgs = entries
        .filter((e) => !e.compacted)
        .map(entryToMessage)
      set({
        messages: msgs,
        isLoading: false,
        hasMore: resp.pagination?.hasMore ?? false,
        currentPage: 1,
      })
    } catch (err) {
      set({ isLoading: false, error: err instanceof Error ? err.message : 'Failed to load history' })
    }
  },

  loadOlderMessages: async () => {
    const { hasMore, currentPage, isLoading } = get()
    if (!hasMore || isLoading) return

    set({ isLoading: true })
    try {
      const nextPage = currentPage + 1
      const resp = await fetchChatHistory(nextPage, 50)
      const entries = resp.messages ?? []
      const msgs = entries
        .filter((e) => !e.compacted)
        .map(entryToMessage)
      set((s) => ({
        messages: [...msgs, ...s.messages],
        isLoading: false,
        hasMore: resp.pagination?.hasMore ?? false,
        currentPage: nextPage,
      }))
    } catch {
      set({ isLoading: false })
    }
  },

  setTaskContext: (ctx) => set({ taskContext: ctx }),

  clearMessages: () => {
    set({ messages: [], hasMore: true, currentPage: 1, error: null })
  },
}))
