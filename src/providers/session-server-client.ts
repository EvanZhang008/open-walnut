/**
 * Session Server Client — WebSocket client connecting Walnut to session server(s).
 *
 * Handles:
 * - Connection lifecycle (connect, reconnect with exponential backoff, health check)
 * - Command/response correlation (id-based)
 * - Event forwarding to the Walnut event bus
 * - Multiple connections (one per host: local + remotes)
 * - Interactive event routing (ask-question, permission-request)
 */

import WebSocket from 'ws'
import crypto from 'node:crypto'
import { bus, EventNames } from '../core/event-bus.js'
import { log } from '../logging/index.js'
import type {
  CommandFrame,
  ResponseFrame,
  EventFrame,
  WireFrame,
  CommandMethod,
  SessionEventName,
  SessionStartParams,
  SessionStartResult,
  SessionSendParams,
  SessionInterruptParams,
  SessionSetModeParams,
  SessionStopParams,
  SessionRespondToQuestionParams,
  SessionRespondToPermissionParams,
  SessionListResult,
  SessionResultData,
  SessionTextDeltaData,
  SessionToolUseData,
  SessionToolResultData,
  SessionInitData,
  SessionErrorData,
  SessionStatusData,
  SessionAskQuestionData,
  SessionPermissionRequestData,
  SessionPlanCompleteData,
  SessionCompactData,
} from '../session-server/types.js'

// ── Types ──

interface PendingRequest {
  resolve: (data: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export interface SessionServerClientOptions {
  /** WebSocket URL (e.g. ws://localhost:7890) */
  url: string
  /** Host name for logging/identification (e.g. 'local', 'remote-dev') */
  hostName?: string
  /** Command timeout in ms (default: 30000) */
  commandTimeoutMs?: number
  /** Reconnect on disconnect (default: true) */
  autoReconnect?: boolean
  /** Max reconnect attempts (default: 10) */
  maxReconnectAttempts?: number
  /** Event handler — called for every session event received */
  onEvent?: (event: EventFrame) => void
}

// ── Bus event name mapping ──

const SESSION_EVENT_TO_BUS: Record<SessionEventName, string | null> = {
  'session:init': null,  // Handled specially (resolve sessionReady)
  'session:text-delta': EventNames.SESSION_TEXT_DELTA,
  'session:tool-use': EventNames.SESSION_TOOL_USE,
  'session:tool-result': EventNames.SESSION_TOOL_RESULT,
  'session:ask-question': null,  // Handled via onEvent callback
  'session:permission-request': null,  // Handled via onEvent callback
  'session:plan-complete': null,  // Handled via onEvent callback
  'session:compact': null,  // Handled via onEvent callback
  'session:result': EventNames.SESSION_RESULT,
  'session:error': EventNames.SESSION_ERROR,
  'session:status': EventNames.SESSION_STATUS_CHANGED,
}

export class SessionServerClient {
  private ws: WebSocket | null = null
  private pendingRequests = new Map<string, PendingRequest>()
  private reconnectAttempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private destroyed = false
  private _connected = false

  private readonly url: string
  private readonly hostName: string
  private readonly commandTimeoutMs: number
  private readonly autoReconnect: boolean
  private readonly maxReconnectAttempts: number
  private readonly onEvent?: (event: EventFrame) => void

  constructor(options: SessionServerClientOptions) {
    this.url = options.url
    this.hostName = options.hostName ?? 'local'
    this.commandTimeoutMs = options.commandTimeoutMs ?? 30_000
    this.autoReconnect = options.autoReconnect ?? true
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? 10
    this.onEvent = options.onEvent
  }

  get connected(): boolean {
    return this._connected
  }

  /** Connect to the session server. Resolves when connection is open. */
  async connect(): Promise<void> {
    if (this._connected) return

    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.url)
      } catch (err) {
        reject(err)
        return
      }

      const onOpen = () => {
        cleanup()
        this._connected = true
        this.reconnectAttempts = 0
        log.session.info('session server client connected', { url: this.url, host: this.hostName })
        resolve()
      }

      const onError = (err: Error) => {
        cleanup()
        log.session.warn('session server client connection error', {
          url: this.url,
          host: this.hostName,
          error: err.message,
        })
        reject(err)
      }

      const cleanup = () => {
        this.ws!.removeListener('open', onOpen)
        this.ws!.removeListener('error', onError)
      }

      this.ws.on('open', onOpen)
      this.ws.on('error', onError)

      // Wire up persistent handlers
      this.ws.on('message', (raw) => this.handleMessage(raw))
      this.ws.on('close', () => this.handleClose())
    })
  }

  /** Disconnect and stop reconnection. */
  destroy(): void {
    this.destroyed = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    // Reject all pending requests
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Client destroyed'))
    }
    this.pendingRequests.clear()

    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
    this._connected = false
  }

  // ── Session commands ──

  async startSession(params: SessionStartParams): Promise<SessionStartResult> {
    const data = await this.sendCommand('session.start', params)
    return data as SessionStartResult
  }

  async sendMessage(params: SessionSendParams): Promise<{ ok: boolean }> {
    const data = await this.sendCommand('session.send', params)
    return data as { ok: boolean }
  }

  async interrupt(params: SessionInterruptParams): Promise<{ ok: boolean }> {
    const data = await this.sendCommand('session.interrupt', params)
    return data as { ok: boolean }
  }

  async setMode(params: SessionSetModeParams): Promise<{ ok: boolean }> {
    const data = await this.sendCommand('session.setMode', params)
    return data as { ok: boolean }
  }

  async stopSession(params: SessionStopParams): Promise<{ ok: boolean }> {
    const data = await this.sendCommand('session.stop', params)
    return data as { ok: boolean }
  }

  async respondToQuestion(params: SessionRespondToQuestionParams): Promise<{ ok: boolean }> {
    const data = await this.sendCommand('session.respondToQuestion', params)
    return data as { ok: boolean }
  }

  async respondToPermission(params: SessionRespondToPermissionParams): Promise<{ ok: boolean }> {
    const data = await this.sendCommand('session.respondToPermission', params)
    return data as { ok: boolean }
  }

  async listSessions(): Promise<SessionListResult> {
    const data = await this.sendCommand('session.list', {})
    return data as SessionListResult
  }

  async ping(): Promise<{ ok: boolean }> {
    const data = await this.sendCommand('ping', {})
    return data as { ok: boolean }
  }

  // ── Internal ──

  /**
   * Send a command and wait for the correlated response.
   */
  private sendCommand(method: CommandMethod, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error(`Not connected to session server (${this.hostName})`))
        return
      }

      const id = crypto.randomBytes(6).toString('hex')
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id)
        reject(new Error(`Command ${method} timed out after ${this.commandTimeoutMs}ms`))
      }, this.commandTimeoutMs)

      this.pendingRequests.set(id, { resolve, reject, timer })

      const frame: CommandFrame = { type: 'cmd', id, method, params }
      this.ws.send(JSON.stringify(frame))
    })
  }

  private handleMessage(raw: WebSocket.RawData): void {
    let frame: WireFrame
    try {
      frame = JSON.parse(raw.toString()) as WireFrame
    } catch {
      return
    }

    switch (frame.type) {
    case 'res':
      this.handleResponse(frame as ResponseFrame)
      break
    case 'event':
      this.handleEvent(frame as EventFrame)
      break
    }
  }

  private handleResponse(frame: ResponseFrame): void {
    const pending = this.pendingRequests.get(frame.id)
    if (!pending) return

    this.pendingRequests.delete(frame.id)
    clearTimeout(pending.timer)

    if (frame.ok) {
      pending.resolve(frame.data)
    } else {
      pending.reject(new Error(frame.error ?? 'Unknown error'))
    }
  }

  private handleEvent(frame: EventFrame): void {
    // Forward to custom event handler (for interactive events, plan-complete, compact)
    if (this.onEvent) {
      this.onEvent(frame)
    }

    // Map to bus events for standard session events
    const busEventName = SESSION_EVENT_TO_BUS[frame.name]
    if (busEventName) {
      this.forwardToBus(busEventName, frame)
    }
  }

  /**
   * Forward a session server event to the Walnut event bus.
   * Maps the event data to the format expected by existing bus subscribers.
   */
  private forwardToBus(busEventName: string, frame: EventFrame): void {
    const { sessionId, data } = frame

    switch (frame.name) {
    case 'session:text-delta': {
      const d = data as SessionTextDeltaData
      bus.emit(busEventName, {
        sessionId,
        taskId: (d as unknown as Record<string, unknown>).taskId,
        delta: d.delta,
      }, ['main-ai'], { source: 'session-server', urgency: 'urgent' })
      break
    }

    case 'session:tool-use': {
      const d = data as SessionToolUseData
      bus.emit(busEventName, {
        sessionId,
        taskId: (d as unknown as Record<string, unknown>).taskId,
        toolName: d.name,
        toolUseId: d.toolUseId,
        input: d.input,
        parentToolUseId: d.parentToolUseId,
      }, ['main-ai'], { source: 'session-server' })
      break
    }

    case 'session:tool-result': {
      const d = data as SessionToolResultData
      bus.emit(busEventName, {
        sessionId,
        taskId: (d as unknown as Record<string, unknown>).taskId,
        toolUseId: d.toolUseId,
        result: d.result,
      }, ['main-ai'], { source: 'session-server' })
      break
    }

    case 'session:result': {
      const d = data as SessionResultData
      bus.emit(busEventName, {
        sessionId,
        taskId: (d as unknown as Record<string, unknown>).taskId,
        result: d.result,
        totalCost: d.cost,
        duration: d.duration,
        isError: d.subtype !== 'success' && d.subtype !== 'interrupted',
        subtype: d.subtype,
      }, ['main-ai', 'session-runner'], { source: 'session-server' })
      break
    }

    case 'session:error': {
      const d = data as SessionErrorData
      bus.emit(busEventName, {
        sessionId,
        taskId: (d as unknown as Record<string, unknown>).taskId,
        error: d.error,
      }, ['main-ai', 'session-runner'], { source: 'session-server' })
      break
    }

    case 'session:status': {
      const d = data as SessionStatusData
      bus.emit(busEventName, {
        sessionId,
        process_status: d.status === 'running' ? 'running' : 'stopped',
        work_status: d.status === 'running' ? 'in_progress' : 'agent_complete',
        activity: d.activity,
      }, ['*'], { source: 'session-server', urgency: 'urgent' })
      break
    }

    default:
      // Other events are handled via onEvent callback
      break
    }
  }

  private handleClose(): void {
    this._connected = false
    log.session.info('session server client disconnected', { url: this.url, host: this.hostName })

    // Reject all pending requests
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Connection closed'))
    }
    this.pendingRequests.clear()

    // Auto-reconnect
    if (this.autoReconnect && !this.destroyed) {
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      log.session.warn('session server max reconnect attempts reached', {
        url: this.url,
        host: this.hostName,
        attempts: this.reconnectAttempts,
      })
      return
    }

    // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s max
    const delayMs = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30_000)
    this.reconnectAttempts++

    log.session.info('session server reconnecting', {
      url: this.url,
      host: this.hostName,
      attempt: this.reconnectAttempts,
      delayMs,
    })

    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.connect()
      } catch {
        // connect() logs the error; handleClose() will schedule next attempt
      }
    }, delayMs)
  }
}
