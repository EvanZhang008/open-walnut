import { WebSocket } from 'ws'
import { cloudSessionEndpoint, recoverCloudSessionCredential } from '../core/cloud-ingest.js'
import type { DaemonEvent } from './daemon-connection.js'
import { SendHeldError } from './delivery-failure.js'

let activeDials = 0
const queuedDials: Array<() => void> = []
let refusedCredential: { token: string; retryAt: number } | null = null

async function withDialSlot<T>(dial: () => Promise<T>): Promise<T> {
  await new Promise<void>((resolve) => {
    if (activeDials < 2) { activeDials++; resolve() }
    else queuedDials.push(resolve)
  })
  try { return await dial() } finally {
    const next = queuedDials.shift()
    if (next) next()
    else activeDials--
  }
}

export class CloudSessionLink {
  private socket: WebSocket | null = null
  private opening: Promise<Record<string, unknown>> | null = null
  private retry: ReturnType<typeof setTimeout> | null = null
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private closed = false
  private attached = false
  private attachment: Record<string, unknown> = {}
  private generation = 0
  private pong = true
  private retryDelayMs = 5_000

  constructor(
    private readonly host: string,
    private readonly sid: string,
    private readonly fromOffset: () => number,
    private readonly onEvent: (event: DaemonEvent) => void,
  ) {}

  get connected(): boolean { return this.attached && this.socket?.readyState === WebSocket.OPEN }

  connect(): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(new SendHeldError('The session page no longer owns the cloud connection'))
    if (this.opening) return this.opening
    if (this.connected) return Promise.resolve(this.attachment)
    if (this.retry) { clearTimeout(this.retry); this.retry = null }
    const generation = this.generation
    const opening = this.open(generation).catch((err) => {
      this.scheduleRetry()
      throw err
    }).finally(() => {
      if (this.opening === opening) this.opening = null
    })
    this.opening = opening
    return opening
  }

  private open(generation: number): Promise<Record<string, unknown>> {
    return withDialSlot(() => this.openStream(generation))
  }

  private async openStream(generation: number): Promise<Record<string, unknown>> {
    if (this.closed || generation !== this.generation) throw new SendHeldError('The cloud session connection was cancelled')
    const endpoint = await cloudSessionEndpoint()
    if (this.closed || generation !== this.generation) throw new SendHeldError('The cloud session connection was cancelled')
    if (!endpoint) throw new SendHeldError('No companion connection is available for this session')
    if (refusedCredential?.token === endpoint.token && refusedCredential.retryAt > Date.now()) {
      throw new SendHeldError('The companion credential is awaiting recovery')
    }
    const url = new URL(`${endpoint.url}/session-stream`)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    url.searchParams.set('host', this.host)
    url.searchParams.set('sessionId', this.sid)
    url.searchParams.set('fromOffset', String(this.fromOffset()))
    const socket = new WebSocket(url, {
      headers: { Authorization: `Bearer ${endpoint.token}` },
      handshakeTimeout: 20_000,
      maxPayload: 32 * 1024 * 1024,
      perMessageDeflate: false,
    })
    this.socket = socket
    this.attached = false
    return new Promise((resolve, reject) => {
      let settled = false
      const deadline = setTimeout(() => fail('The companion did not confirm the session stream'), 25_000)
      const current = () => !this.closed && generation === this.generation && this.socket === socket
      const fail = (reason: string) => {
        if (!settled) { settled = true; clearTimeout(deadline); reject(new SendHeldError(reason)) }
        socket.terminate()
      }
      socket.on('unexpected-response', (_req, res) => {
        res.resume()
        if (res.statusCode === 401) {
          refusedCredential = { token: endpoint.token, retryAt: Date.now() + 30_000 }
          void recoverCloudSessionCredential(endpoint.token)
        }
        fail('The companion refused the session stream')
      })
      socket.on('message', (bytes) => {
        if (!current()) return
        let event: DaemonEvent
        try { event = JSON.parse(String(bytes)) as DaemonEvent } catch { fail('The companion sent an invalid session event'); return }
        if (!event || typeof event.ev !== 'string') { fail('The companion sent an invalid session event'); return }
        if (event.ev === 'attached') {
          if (event.ok !== true) { fail('The session host refused the cloud attachment'); return }
          this.attached = true
          this.attachment = event
          this.pong = true
          this.retryDelayMs = 5_000
          this.startHeartbeat(socket)
          this.onEvent(event)
          if (!settled) { settled = true; clearTimeout(deadline); resolve(event) }
          return
        }
        if (event.sid !== this.sid) return
        if (event.ev === 'bridge-offline') { fail('The session host bridge disconnected'); return }
        this.onEvent(event)
        if (event.ev === 'session_state' && event.state === 'running') {
          socket.close()
        }
      })
      socket.on('pong', () => { this.pong = true })
      socket.on('error', () => fail('The connection to the companion failed'))
      socket.on('close', () => {
        clearTimeout(deadline)
        if (!settled) { settled = true; reject(new SendHeldError('The session stream closed before its attachment was confirmed')) }
        if (!current()) return
        this.socket = null
        this.attached = false
        this.stopHeartbeat()
        this.scheduleRetry()
      })
    })
  }

  private scheduleRetry(): void {
    if (this.closed || this.retry) return
    const delay = this.retryDelayMs
    this.retryDelayMs = Math.min(30_000, delay * 2)
    this.retry = setTimeout(() => {
      this.retry = null
      if (!this.closed) void this.connect().catch(() => {})
    }, delay)
    this.retry.unref?.()
  }

  private startHeartbeat(socket: WebSocket): void {
    this.stopHeartbeat()
    this.heartbeat = setInterval(() => {
      if (this.socket !== socket || this.closed) return
      if (!this.pong) { socket.terminate(); return }
      this.pong = false
      try { socket.ping() } catch { socket.terminate() }
    }, 30_000)
    this.heartbeat.unref?.()
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
  }

  close(): void {
    this.closed = true
    this.generation++
    if (this.retry) clearTimeout(this.retry)
    this.retry = null
    this.stopHeartbeat()
    this.attached = false
    const socket = this.socket
    this.socket = null
    socket?.terminate()
  }
}
