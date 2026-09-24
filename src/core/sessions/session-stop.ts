import { randomUUID } from 'node:crypto'
import type { SessionRecord } from '../types.js'

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
}

export interface SessionStopDeps {
  get(sid: string): Promise<SessionRecord | null>
  save(sid: string, updates: Partial<SessionRecord>): Promise<SessionRecord>
  confirm(sid: string, request: StopRequest): Promise<SessionRecord | null>
  pending(host: string): Promise<SessionRecord[]>
  park(sid: string): Promise<void>
  connection(host: string): Promise<SessionStopConnection | null>
  changed(record: SessionRecord): void
}

export class SessionStopCoordinator {
  private readonly pending = new Map<string, Promise<unknown>>()

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
      return this.deliver(record)
    })
  }

  async flush(host: string, connection?: SessionStopConnection): Promise<void> {
    for (const record of await this.deps.pending(host)) {
      await this.serial(record.claudeSessionId, async () => {
        const current = await this.deps.get(record.claudeSessionId)
        if (current?.stopRequest?.state === 'pending') await this.deliver(current, connection)
      })
    }
  }

  private async deliver(record: SessionRecord, connection?: SessionStopConnection): Promise<StopRequest> {
    const sid = record.claudeSessionId
    const request = record.stopRequest!
    await this.deps.park(sid)
    let error: string | undefined
    try {
      const conn = connection ?? await this.deps.connection(record.host ?? '__local__')
      if (!conn?.connected) error = 'Host unavailable; waiting for stop confirmation'
      else {
        const reply = await conn.send('stop', { sid, reason: 'user', stopRequestId: request.id }, 10_000)
        if (reply.ok === true && reply.stopped === true) {
          const confirmed: StopRequest = { id: request.id, requestedAt: request.requestedAt, state: 'confirmed' }
          const updated = await this.deps.confirm(sid, confirmed)
          if (updated) this.deps.changed(updated)
          return updated?.stopRequest ?? (await this.deps.get(sid))?.stopRequest ?? request
        }
        error = typeof reply.error === 'string' ? reply.error : 'Daemon did not confirm the stop'
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
  park: async (sid) => {
    const { getQueue, parkMessages } = await import('../session-message-queue.js')
    const queue = (await getQueue(sid)).filter((message) => message.status !== 'parked')
    if (queue.length) await parkMessages(queue, 'Session stopped by user; retry explicitly to send', true)
  },
  connection: async (host) => (await import('../../providers/daemon-connection.js')).getConnectedDaemonConnection(host),
  changed: (record) => {
    void import('../session-tracker.js').then(({ emitSessionStatusChanged }) => {
      emitSessionStatusChanged(record, {}, ['*'], { source: 'session-stop' })
    }).catch(() => {})
  },
})
