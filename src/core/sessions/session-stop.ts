import { randomUUID } from 'node:crypto'
import type { SessionRecord } from '../types.js'
import { describeStopRefusal, STOP_NOT_SENT_NO_OWNERSHIP_CHECK, stopProvenance } from './stop-provenance.js'

type StopRequest = NonNullable<SessionRecord['stopRequest']>

export class SessionStopSupersededError extends Error {
  readonly code = 'SESSION_STOP_SUPERSEDED'
  readonly status = 409
}

export function isSessionStopSuperseded(error: unknown): error is SessionStopSupersededError {
  return error instanceof Error && 'code' in error && error.code === 'SESSION_STOP_SUPERSEDED'
}

export interface SessionStopConnection {
  connected: boolean
  send(command: string, args: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>
  /** Daemon capabilities from hello; decides the stop's ownership fields (stop-provenance.ts). */
  hasCapability?(cap: string): boolean
}

export interface SessionStopDeps {
  get(sid: string): Promise<SessionRecord | null>
  save(sid: string, updates: Partial<SessionRecord>): Promise<SessionRecord>
  confirm(sid: string, request: StopRequest): Promise<SessionRecord | null>
  pending(host: string): Promise<SessionRecord[]>
  /** Every pending stop, on any host (startup arms their deadlines). */
  pendingAll?(): Promise<SessionRecord[]>
  park(sid: string): Promise<void>
  connection(host: string): Promise<SessionStopConnection | null>
  changed(record: SessionRecord): void
  /** Run `fn` after `ms` (tests drive their own clock); returns a cancel. */
  schedule?(fn: () => void, ms: number): () => void
}

/**
 * A stop the host did not confirm is sent again on these delays while it stays
 * pending, then only when the host reconnects (flush). 2026-11-03: a stop whose
 * CLI exited while a child of it still held the process group was answered
 * "process identity changed", and with the Mac's own host never reconnecting,
 * nothing asked again: every send and restart of that session was refused with
 * "awaiting host confirmation" for good, though one more stop confirmed it.
 */
export const STOP_RETRY_DELAYS_MS = [5_000, 15_000, 60_000, 300_000]

/**
 * Every stop ends with a result (listed in tests/core/sessions/lifecycle-waits-ratchet.test.ts).
 * A host that answered every try without confirming fails it once the tries are used up:
 * `state: 'failed'` with the reason, and the session takes messages again (a stop the host
 * refused would otherwise block it for good). A host that was offline keeps it pending,
 * sent again when the host comes back (flush), for at most STOP_OFFLINE_MAX_MS from the ask;
 * then it fails the same way.
 */
export const STOP_OFFLINE_MAX_MS = 24 * 60 * 60_000
export const STOP_HOST_UNAVAILABLE = 'Host unavailable; waiting for stop confirmation'

export function stopFailedText(lastError: string | undefined, tries: number): string {
  return `The host did not confirm the stop after ${tries} ${tries === 1 ? 'try' : 'tries'}`
    + `${lastError ? ` (last answer: ${lastError})` : ''}. The session takes messages again; stop it again if it is still running.`
}

export class SessionStopCoordinator {
  private readonly pending = new Map<string, Promise<unknown>>()
  /** Pending stops waiting for their next try: the try it is, and its cancel. */
  private readonly retries = new Map<string, { attempt: number; armed: boolean; cancel: () => void }>()

  constructor(private readonly deps: SessionStopDeps) {}

  private async serial<T>(sid: string, work: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(sid) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(work)
    this.pending.set(sid, next)
    try { return await next }
    finally { if (this.pending.get(sid) === next) this.pending.delete(sid) }
  }

  async fence(sid: string): Promise<string | null> {
    const record = await this.deps.get(sid)
    if (record?.stopRequest?.state === 'pending') throw new SessionStopSupersededError('Session stop is awaiting host confirmation')
    return record?.stopRequest?.id ?? null
  }

  async dispatch<T>(sid: string, fence: string | null, send: () => Promise<T>): Promise<T> {
    return this.serial(sid, async () => {
      if (await this.fence(sid) !== fence) throw new SessionStopSupersededError('Session delivery was superseded by a stop request')
      return send()
    })
  }

  async request(sid: string): Promise<StopRequest> {
    return this.serial(sid, async () => {
      const current = await this.deps.get(sid)
      if (!current) throw new Error('Session not found')
      const stopRequest: StopRequest = current.stopRequest?.state === 'pending'
        ? current.stopRequest
        : { id: randomUUID(), requestedAt: new Date().toISOString(), state: 'pending' }
      const record = await this.deps.save(sid, { stopRequest })
      this.deps.changed(record)
      return this.settle(sid, await this.deliver(record))
    })
  }

  /** After a try: a stop still pending is tried again later (STOP_RETRY_DELAYS_MS), one that settled is done. */
  private settle(sid: string, request: StopRequest): StopRequest {
    const held = this.retries.get(sid)
    if (request.state !== 'pending') {
      held?.cancel()
      this.retries.delete(sid)
      return request
    }
    if (held?.armed) return request
    const attempt = held?.attempt ?? 0
    const schedule = this.deps.schedule ?? ((fn: () => void, ms: number) => {
      const t = setTimeout(fn, ms)
      t.unref?.()
      return () => clearTimeout(t)
    })
    if (attempt >= STOP_RETRY_DELAYS_MS.length) {
      // Tries used up on a host that answered: the stop fails now.
      if (request.error !== STOP_HOST_UNAVAILABLE) {
        this.retries.delete(sid)
        void this.fail(sid, request.id, attempt + 1)
        return request
      }
      // An offline host: its reconnect sends it again (flush, which starts the tries over),
      // and the deadline fails it if the host never came back.
      this.armOfflineDeadline(sid, request, attempt)
      return request
    }
    const entry = { attempt: attempt + 1, armed: true, cancel: () => {} }
    this.retries.set(sid, entry)
    entry.cancel = schedule(() => {
      if (this.retries.get(sid) !== entry) return
      entry.armed = false
      void this.serial(sid, async () => {
        const current = await this.deps.get(sid)
        if (current?.stopRequest?.state !== 'pending' || current.stopRequest.id !== request.id) {
          if (this.retries.get(sid) === entry) this.retries.delete(sid)
          return
        }
        this.settle(sid, await this.deliver(current))
      }).catch(() => {})
    }, STOP_RETRY_DELAYS_MS[attempt]!)
    return request
  }

  private armOfflineDeadline(sid: string, request: StopRequest, attempt: number): void {
    const schedule = this.deps.schedule ?? ((fn: () => void, ms: number) => {
      const t = setTimeout(fn, ms)
      t.unref?.()
      return () => clearTimeout(t)
    })
    const asked = Date.parse(request.requestedAt)
    const left = Number.isFinite(asked) ? Math.max(0, asked + STOP_OFFLINE_MAX_MS - Date.now()) : 0
    const entry = { attempt, armed: true, cancel: () => {} }
    this.retries.set(sid, entry)
    entry.cancel = schedule(() => {
      if (this.retries.get(sid) !== entry) return
      this.retries.delete(sid)
      void this.fail(sid, request.id, attempt + 1)
    }, left)
  }

  /**
   * At startup: every stop still pending gets its deadline back, counted from its ask (the
   * retries were in memory). A host that connects sends it again (flush) and starts the tries over.
   */
  async resumeDeadlines(): Promise<number> {
    const records = await this.deps.pendingAll?.() ?? []
    let n = 0
    for (const record of records) {
      const sid = record.claudeSessionId
      const request = record.stopRequest
      if (request?.state !== 'pending' || this.retries.has(sid)) continue
      this.armOfflineDeadline(sid, request, STOP_RETRY_DELAYS_MS.length)
      n++
    }
    return n
  }

  async flush(host: string, connection?: SessionStopConnection): Promise<void> {
    for (const record of await this.deps.pending(host)) {
      await this.serial(record.claudeSessionId, async () => {
        const current = await this.deps.get(record.claudeSessionId)
        if (current?.stopRequest?.state !== 'pending') return
        // The host is back: its tries start over (an offline wait's deadline goes with them).
        const held = this.retries.get(record.claudeSessionId)
        if (held && !held.armed) return
        held?.cancel()
        this.retries.delete(record.claudeSessionId)
        this.settle(record.claudeSessionId, await this.deliver(current, connection))
      })
    }
  }

  /** The wait ran out: a stop still pending (the same one) fails with its reason. */
  private fail(sid: string, id: string, tries: number): Promise<void> {
    return this.serial(sid, async () => {
      const current = await this.deps.get(sid)
      const request = current?.stopRequest
      if (request?.state !== 'pending' || request.id !== id) return
      const failed: StopRequest = { id, requestedAt: request.requestedAt, state: 'failed', error: stopFailedText(request.error, tries) }
      const updated = await this.deps.confirm(sid, failed)
      if (updated) this.deps.changed(updated)
      const { log } = await import('../../logging/index.js')
      log.session.warn('session stop: the host never confirmed it; the session takes messages again', { sessionId: sid, stopRequestId: id, tries, lastError: request.error })
    }).catch(() => {})
  }

  private async deliver(record: SessionRecord, connection?: SessionStopConnection): Promise<StopRequest> {
    const sid = record.claudeSessionId
    const request = record.stopRequest!
    await this.deps.park(sid)
    let error: string | undefined
    try {
      const conn = connection ?? await this.deps.connection(record.host ?? '__local__')
      // A person's stop names this Walnut, so a daemon that records the session
      // for another Walnut refuses it (owner-home-v1, stop-provenance.ts).
      const provenance = conn?.connected ? stopProvenance(conn, 'human') : null
      if (!conn?.connected) error = STOP_HOST_UNAVAILABLE
      else if (!provenance) error = STOP_NOT_SENT_NO_OWNERSHIP_CHECK
      else {
        const reply = await conn.send('stop', { sid, reason: 'user', stopRequestId: request.id, ...provenance }, 10_000)
        if (reply.ok === true && reply.stopped === true) {
          const confirmed: StopRequest = { id: request.id, requestedAt: request.requestedAt, state: 'confirmed' }
          const updated = await this.deps.confirm(sid, confirmed)
          if (updated) this.deps.changed(updated)
          return updated?.stopRequest ?? (await this.deps.get(sid))?.stopRequest ?? request
        }
        error = describeStopRefusal(reply)
      }
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause)
    }
    const current = await this.deps.get(sid)
    if (current?.stopRequest?.id !== request.id) return current?.stopRequest ?? request
    const pending = { ...request, error }
    const updated = await this.deps.confirm(sid, pending)
    if (updated) this.deps.changed(updated)
    return updated?.stopRequest ?? (await this.deps.get(sid))?.stopRequest ?? request
  }
}

export const sessionStops = new SessionStopCoordinator({
  get: async (sid) => (await import('../session-tracker.js')).getSessionByClaudeId(sid),
  save: async (sid, updates) => (await import('../session-tracker.js')).updateSessionRecord(sid, updates),
  confirm: async (sid, request) => {
    const { updateSessionRecordConditionally } = await import('../session-tracker.js')
    return updateSessionRecordConditionally(sid, {
      stopRequest: request,
      ...(request.state === 'confirmed' ? {
        process_status: 'stopped' as const, pid: undefined,
        errorMessage: undefined, activity: undefined,
        status_reason: 'user_terminated' as const, status_changed_by: 'user' as const,
      } : {}),
    }, (current) => current.stopRequest?.id === request.id && current.stopRequest.state === 'pending')
  },
  pending: async (host) => (await import('../session-tracker.js')).listPendingSessionStops(host),
  pendingAll: async () => (await import('../session-tracker.js')).listPendingSessionStops(),
  park: async (sid) => {
    const { getQueue, parkMessages } = await import('../session-message-queue.js')
    const { STOP_PARKED_REASON } = await import('../relay-fates.js')
    const queue = (await getQueue(sid)).filter((message) => message.status !== 'parked')
    if (queue.length) await parkMessages(queue, STOP_PARKED_REASON, true)
  },
  connection: async (host) => (await import('../../providers/daemon-connection.js')).getConnectedDaemonConnection(host),
  changed: (record) => {
    void import('../session-tracker.js').then(({ emitSessionStatusChanged }) => {
      emitSessionStatusChanged(record, {}, ['*'], { source: 'session-stop' })
    }).catch(() => {})
  },
})
