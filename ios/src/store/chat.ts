/**
 * Chat store — conversation list, per-conversation messages, one live SSE
 * stream for the active conversation.
 *
 * Caching: conversations + message tails persist to AsyncStorage so the app
 * renders instantly (stale-while-revalidate); network refresh follows.
 */

import AsyncStorage from '@react-native-async-storage/async-storage'
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { createConversation, fetchConversations, fetchMessages, sendMessage } from '../api/client'
import { ConversationStream } from '../api/stream'
import { ApiError, type ApiMessage, type ConversationSummary } from '../api/types'
import { useConnectionStore } from './connection'

const PAGE = 50
const CACHE_TAIL = 60

interface ChatState {
  conversations: ConversationSummary[]
  activeId: string | null
  messages: Record<string, ApiMessage[]>
  hasMore: Record<string, boolean>

  loadingList: boolean
  loadingMessages: boolean
  sending: boolean
  /** A turn is running on the active conversation (send disabled). */
  streaming: boolean
  /** Accumulated live assistant text for the in-flight turn. */
  streamText: string
  /** Latest tool/thinking status line, e.g. "Read". */
  activity: string | null
  error: string | null

  initialize: () => Promise<void>
  refreshConversations: () => Promise<void>
  select: (id: string | null) => void
  startNewConversation: () => void
  loadMessages: (id: string) => Promise<void>
  loadOlder: () => Promise<void>
  send: (text: string) => Promise<boolean>
  clearError: () => void
  connectStream: () => void
  closeStream: () => void
}

// Stream + delta buffer live outside React state (high-frequency writes).
let stream: ConversationStream | null = null
let deltaBuffer = ''
let flushTimer: ReturnType<typeof setTimeout> | null = null

function reportNet(err: unknown): void {
  if (err instanceof ApiError && err.status === 0) {
    useConnectionStore.getState().reportReachability(false)
  }
}

export const useChatStore = create<ChatState>()(
  persist(
    (set, get) => {
      const flushDeltas = () => {
        flushTimer = null
        if (!deltaBuffer) return
        const chunk = deltaBuffer
        deltaBuffer = ''
        set((s) => ({ streamText: s.streamText + chunk }))
      }

      const finalizeTurn = (convId: string, turnId: string, fullText: string) => {
        if (flushTimer) clearTimeout(flushTimer)
        flushTimer = null
        deltaBuffer = ''
        set((s) => {
          const msgs = s.messages[convId] ?? []
          const id = `turn-${turnId}`
          const last = [...msgs].reverse().find((m) => m.role === 'assistant' && !m.kind)
          // Skip append when replayed history already contains this reply.
          const dup = msgs.some((m) => m.id === id) || (fullText !== '' && last?.text === fullText)
          const next = dup || !fullText
            ? msgs
            : [...msgs, { id, role: 'assistant' as const, text: fullText, createdAt: new Date().toISOString() }]
          return {
            messages: { ...s.messages, [convId]: next },
            streaming: false,
            streamText: '',
            activity: null,
          }
        })
        // Reconcile with canonical server history (real ids, tool/thinking rows).
        void get().loadMessages(convId)
        void get().refreshConversations()
      }

      return {
        conversations: [],
        activeId: null,
        messages: {},
        hasMore: {},
        loadingList: false,
        loadingMessages: false,
        sending: false,
        streaming: false,
        streamText: '',
        activity: null,
        error: null,

        initialize: async () => {
          await get().refreshConversations()
          const { activeId, conversations } = get()
          const valid = activeId && conversations.some((c) => c.id === activeId)
          const target = valid ? activeId : conversations[0]?.id ?? null
          get().select(target)
        },

        refreshConversations: async () => {
          set({ loadingList: true })
          try {
            const conversations = await fetchConversations()
            useConnectionStore.getState().reportReachability(true)
            set({ conversations, loadingList: false })
          } catch (err) {
            reportNet(err)
            set({ loadingList: false })
          }
        },

        select: (id) => {
          const alreadyLive = id === get().activeId && stream != null
          if (!alreadyLive) {
            set({ activeId: id, streaming: false, streamText: '', activity: null, error: null })
            get().connectStream()
          }
          // Always revalidate — cached messages render instantly meanwhile.
          if (id) void get().loadMessages(id)
        },

        startNewConversation: () => {
          // Lazy: the conversation is created server-side on first send.
          get().select(null)
        },

        loadMessages: async (id) => {
          set({ loadingMessages: true })
          try {
            const msgs = await fetchMessages(id, PAGE)
            useConnectionStore.getState().reportReachability(true)
            set((s) => ({
              messages: { ...s.messages, [id]: msgs },
              hasMore: { ...s.hasMore, [id]: msgs.length >= PAGE },
              loadingMessages: false,
            }))
          } catch (err) {
            reportNet(err)
            set({ loadingMessages: false })
          }
        },

        loadOlder: async () => {
          const { activeId, messages, hasMore, loadingMessages } = get()
          if (!activeId || loadingMessages || hasMore[activeId] === false) return
          const current = messages[activeId] ?? []
          const oldest = current.find((m) => !m.pending)
          if (!oldest) return
          set({ loadingMessages: true })
          try {
            const older = await fetchMessages(activeId, PAGE, oldest.id)
            set((s) => ({
              messages: { ...s.messages, [activeId]: [...older, ...(s.messages[activeId] ?? [])] },
              hasMore: { ...s.hasMore, [activeId]: older.length >= PAGE },
              loadingMessages: false,
            }))
          } catch (err) {
            reportNet(err)
            set({ loadingMessages: false })
          }
        },

        send: async (text) => {
          const state = get()
          if (state.sending || state.streaming) return false
          set({ sending: true, error: null })

          let convId = state.activeId
          try {
            if (!convId) {
              const created = await createConversation()
              convId = created.id
              set({ activeId: convId })
              get().connectStream()
            }
            const localMsg: ApiMessage = {
              id: `local-${Date.now()}`,
              role: 'user',
              text,
              createdAt: new Date().toISOString(),
              pending: true,
            }
            set((s) => ({
              messages: { ...s.messages, [convId!]: [...(s.messages[convId!] ?? []), localMsg] },
            }))
            await sendMessage(convId, text)
            useConnectionStore.getState().reportReachability(true)
            // Turn accepted — solidify the optimistic bubble; SSE delivers
            // message-start shortly.
            set((s) => ({
              messages: {
                ...s.messages,
                [convId!]: (s.messages[convId!] ?? []).map((m) =>
                  m.id === localMsg.id ? { ...m, pending: false } : m
                ),
              },
              sending: false,
              streaming: true,
              streamText: '',
              activity: null,
            }))
            return true
          } catch (err) {
            reportNet(err)
            // Roll back the optimistic user message.
            if (convId) {
              set((s) => ({
                messages: { ...s.messages, [convId!]: (s.messages[convId!] ?? []).filter((m) => !m.pending) },
              }))
            }
            const busy = err instanceof ApiError && err.code === 'turn_active'
            set({
              sending: false,
              streaming: busy,
              error: busy
                ? 'The assistant is already replying — wait for it to finish.'
                : err instanceof Error ? err.message : 'Failed to send',
            })
            return false
          }
        },

        clearError: () => set({ error: null }),

        connectStream: () => {
          get().closeStream()
          const convId = get().activeId
          if (!convId) return
          stream = new ConversationStream(convId, {
            onStart: () => set({ streaming: true, streamText: '', activity: null, error: null }),
            onDelta: ({ delta }) => {
              deltaBuffer += delta
              if (!flushTimer) flushTimer = setTimeout(flushDeltas, 60)
            },
            onTool: ({ name }) => set({ activity: name }),
            onThinking: () => set({ activity: 'Thinking' }),
            onEnd: ({ turnId, fullText }) => finalizeTurn(convId, turnId, fullText),
            onTurnError: ({ message }) => {
              flushDeltas()
              set({ streaming: false, activity: null, error: message })
            },
            onConnectionChange: (ok) => useConnectionStore.getState().reportReachability(ok),
          })
          stream.open()
        },

        closeStream: () => {
          stream?.close()
          stream = null
          if (flushTimer) clearTimeout(flushTimer)
          flushTimer = null
          deltaBuffer = ''
        },
      }
    },
    {
      name: 'walnut.chat',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (s) => ({
        conversations: s.conversations,
        activeId: s.activeId,
        // Cache only recent tails — full history refetches on demand.
        messages: Object.fromEntries(
          Object.entries(s.messages).map(([k, v]) => [k, v.slice(-CACHE_TAIL)])
        ),
      }),
    }
  )
)
