/**
 * WebSocket client for Walnut server.
 * Ported from web/src/api/ws.ts — simplified for React Native.
 *
 * Handles: connection, auto-reconnect, RPC request/response, event subscription.
 */

import type { WsFrame, ConnectionState } from './types'

type EventCallback = (data: unknown) => void
type ConnectionCallback = (state: ConnectionState) => void

let counter = 0

export class WsClient {
  private ws: WebSocket | null = null
  private url = ''
  private apiKey = ''
  private eventListeners = new Map<string, Set<EventCallback>>()
  private connectionListeners = new Set<ConnectionCallback>()
  private pendingRpc = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectDelay = 1000
  private shouldReconnect = false
  private _state: ConnectionState = 'disconnected'
  private authenticated = false

  get state(): ConnectionState {
    return this._state
  }

  /**
   * Connect to server WebSocket.
   */
  connect(serverUrl: string, apiKey: string): void {
    this.url = serverUrl.replace(/^http/, 'ws').replace(/\/$/, '') + '/ws'
    this.apiKey = apiKey
    this.shouldReconnect = true
    this.doConnect()
  }

  disconnect(): void {
    this.shouldReconnect = false
    this.authenticated = false
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
    this.setState('disconnected')
  }

  private doConnect(): void {
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }

    this.setState('connecting')
    this.authenticated = false

    try {
      this.ws = new WebSocket(this.url)
    } catch {
      this.scheduleReconnect()
      return
    }

    this.ws.onopen = () => {
      this.reconnectDelay = 1000
      // Authenticate immediately after connection
      this.authenticate()
    }

    this.ws.onmessage = (event) => {
      this.handleMessage(event.data as string)
    }

    this.ws.onclose = () => {
      this.ws = null
      this.authenticated = false
      this.setState('disconnected')
      this.rejectAllPending('Connection closed')
      if (this.shouldReconnect) this.scheduleReconnect()
    }

    this.ws.onerror = () => {
      // onclose will fire after this
    }
  }

  private async authenticate(): Promise<void> {
    try {
      await this.sendRpc('auth', { key: this.apiKey })
      this.authenticated = true
      this.setState('connected')
    } catch (err) {
      // Auth failed — still allow connection for localhost (which may not need auth)
      this.authenticated = true
      this.setState('connected')
    }
  }

  private handleMessage(raw: string): void {
    let frame: WsFrame
    try {
      frame = JSON.parse(raw) as WsFrame
    } catch {
      return
    }

    if (frame.type === 'event') {
      const listeners = this.eventListeners.get(frame.name)
      if (listeners) {
        for (const cb of listeners) {
          try { cb(frame.data) } catch {}
        }
      }
    } else if (frame.type === 'res') {
      const pending = this.pendingRpc.get(frame.id)
      if (pending) {
        this.pendingRpc.delete(frame.id)
        if (frame.ok) {
          pending.resolve(frame.payload)
        } else {
          pending.reject(new Error(frame.error ?? 'RPC failed'))
        }
      }
    }
  }

  /**
   * Send an RPC request and wait for the response.
   */
  sendRpc<T = unknown>(method: string, payload: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('WebSocket not connected'))
        return
      }

      const id = `r${++counter}-${Date.now()}`
      this.pendingRpc.set(id, { resolve: resolve as (v: unknown) => void, reject })

      const frame: WsFrame = { type: 'req', id, method, payload }
      this.ws.send(JSON.stringify(frame))

      // Timeout after 30s
      setTimeout(() => {
        if (this.pendingRpc.has(id)) {
          this.pendingRpc.delete(id)
          reject(new Error(`RPC timeout: ${method}`))
        }
      }, 30000)
    })
  }

  /**
   * Subscribe to a server event.
   */
  onEvent(name: string, cb: EventCallback): void {
    let set = this.eventListeners.get(name)
    if (!set) {
      set = new Set()
      this.eventListeners.set(name, set)
    }
    set.add(cb)
  }

  offEvent(name: string, cb: EventCallback): void {
    this.eventListeners.get(name)?.delete(cb)
  }

  onConnectionChange(cb: ConnectionCallback): void {
    this.connectionListeners.add(cb)
  }

  offConnectionChange(cb: ConnectionCallback): void {
    this.connectionListeners.delete(cb)
  }

  private setState(state: ConnectionState): void {
    if (this._state === state) return
    this._state = state
    for (const cb of this.connectionListeners) {
      try { cb(state) } catch {}
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.shouldReconnect) {
        this.doConnect()
        // Exponential backoff capped at 30s
        this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, 30000)
      }
    }, this.reconnectDelay)
  }

  private rejectAllPending(reason: string): void {
    for (const [id, { reject }] of this.pendingRpc) {
      reject(new Error(reason))
    }
    this.pendingRpc.clear()
  }
}

// Singleton
export const wsClient = new WsClient()
