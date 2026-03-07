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

  if (!text && entry.displayText) text = entry.displayText

  return {
    id: `${entry.timestamp}-${entry.role}-${Math.random().toString(36).slice(2, 6)}`,
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
            const fullText = finalText || (m.text + streamBuffer)
            return { ...m, text: fullText, isStreaming: false }
          }
          return m
        })
        set({ messages: updated, isStreaming: false, streamBuffer: '', error: null })
      } else {
        // No streaming message — add the response directly
        if (finalText) {
          set((s) => ({
            messages: [...s.messages, {
              id: `resp-${Date.now()}`,
              role: 'assistant' as const,
              text: finalText,
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
        const msg = entryToMessage(d.entry)
        set((s) => ({ messages: [...s.messages, msg] }))
      }
    })
  },

  cleanup: () => {
    wsClient.offEvent('agent:text-delta', () => {})
    wsClient.offEvent('agent:response', () => {})
    wsClient.offEvent('agent:error', () => {})
    wsClient.offEvent('chat:history-updated', () => {})
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
  },

  sendMessage: (text: string) => {
    const { taskContext } = get()

    // Add user message to local list
    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      text,
      timestamp: new Date().toISOString(),
    }

    // Create placeholder for assistant streaming
    const assistantId = `stream-${Date.now()}`
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
