/**
 * SSE stream for a conversation's agent turns (react-native-sse EventSource,
 * a pure-JS XHR-based implementation that works in React Native).
 *
 * Reconnect model:
 * - Within one EventSource instance, the library auto-reconnects (5s poll) and
 *   sends the last seen `id:` as the Last-Event-ID header on its own.
 * - When WE create a fresh instance (screen re-open, app foreground), we pass
 *   the tracked last seq as `?lastEventId=` so the server replays only missed
 *   events instead of the whole current turn.
 */

import EventSource from 'react-native-sse'
import { getBaseUrl, getToken } from './config'
import type { SseHandlers } from './types'

type WalnutEvents = 'message-start' | 'text-delta' | 'tool' | 'thinking' | 'message-end'

function parse<T>(raw: string | null): T | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

export class ConversationStream {
  private es: EventSource<WalnutEvents> | null = null
  private lastEventId: number | null = null
  private closed = false

  constructor(
    private readonly conversationId: string,
    private readonly handlers: SseHandlers
  ) {}

  open(): void {
    const base = getBaseUrl()
    if (!base || this.closed) return

    const qs = this.lastEventId != null ? `?lastEventId=${this.lastEventId}` : ''
    const url = `${base}/api/v1/conversations/${encodeURIComponent(this.conversationId)}/stream${qs}`
    const token = getToken()

    const es = new EventSource<WalnutEvents>(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      pollingInterval: 4000, // auto-reconnect cadence after drops
    })
    this.es = es

    es.addEventListener('open', () => this.handlers.onConnectionChange?.(true))

    // The 'error' listener receives BOTH transport failures (timeout, HTTP
    // error — no `data` field) AND server-sent SSE events literally named
    // `error` (turn failures — carry a JSON `data` payload). Disambiguate.
    es.addEventListener('error', (ev) => {
      const server = ev as { data?: string | null; lastEventId?: string | null }
      if (typeof server.data === 'string') {
        this.track(server.lastEventId ?? null)
        const data = parse<{ message?: string }>(server.data)
        if (data?.message) this.handlers.onTurnError?.({ message: data.message })
        return
      }
      this.handlers.onConnectionChange?.(false)
    })

    es.addEventListener('message-start', (ev) => {
      this.track(ev.lastEventId)
      const data = parse<{ turnId: string }>(ev.data)
      if (data) this.handlers.onStart?.(data)
    })
    es.addEventListener('text-delta', (ev) => {
      this.track(ev.lastEventId)
      const data = parse<{ delta: string }>(ev.data)
      if (data?.delta) this.handlers.onDelta?.(data)
    })
    es.addEventListener('tool', (ev) => {
      this.track(ev.lastEventId)
      const data = parse<{ name: string }>(ev.data)
      if (data?.name) this.handlers.onTool?.(data)
    })
    es.addEventListener('thinking', (ev) => {
      this.track(ev.lastEventId)
      this.handlers.onThinking?.()
    })
    es.addEventListener('message-end', (ev) => {
      this.track(ev.lastEventId)
      const data = parse<{ turnId: string; fullText: string }>(ev.data)
      if (data) this.handlers.onEnd?.(data)
    })
  }

  private track(id: string | null): void {
    const n = id != null ? Number(id) : NaN
    if (Number.isFinite(n)) this.lastEventId = n
  }

  close(): void {
    this.closed = true
    this.es?.removeAllEventListeners()
    this.es?.close()
    this.es = null
  }
}
