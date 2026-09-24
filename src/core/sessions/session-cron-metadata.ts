import { randomUUID } from 'node:crypto'
import { bus, eventData, EventNames } from '../event-bus.js'
import { normalizeSessionCronJobs, type SessionCronMetadata } from '../types.js'

export function createSessionCronMetadataStore(changed: (value: SessionCronMetadata) => void) {
  const epoch = randomUUID()
  let revision = 0
  // Deletion tombstones reject replies still in flight on the same connection.
  const hosts = new Map<string, { token: object; daemonEpoch: string; revisions: Map<string, number>; deleted: Set<string>; sessions: Map<string, SessionCronMetadata> }>()
  const publish = (host: NonNullable<ReturnType<typeof hosts.get>>, value: SessionCronMetadata) => {
    const next = { ...value, epoch, revision: ++revision }
    host.sessions.set(value.sessionId, next)
    changed(next)
  }
  return {
    connect(hostname: string, token: object, daemonEpoch: string) {
      const previous = hosts.get(hostname)
      const host = { token, daemonEpoch, revisions: new Map<string, number>(), deleted: new Set<string>(), sessions: previous?.sessions ?? new Map<string, SessionCronMetadata>() }
      hosts.set(hostname, host)
      for (const value of host.sessions.values()) publish(host, { ...value, stale: true })
    },
    apply(hostname: string, token: object, raw: unknown) {
      const host = hosts.get(hostname)
      if (!host || host.token !== token || !raw || typeof raw !== 'object') return false
      const value = raw as SessionCronMetadata
      if (value.epoch !== host.daemonEpoch || typeof value.sessionId !== 'string' || !value.sessionId
        || value.sessionId.length > 256 || !Number.isSafeInteger(value.revision) || value.revision <= (host.revisions.get(value.sessionId) ?? 0)
        || !['active', 'inactive', 'unknown'].includes(value.presence)
        || ![null, 'cron', 'wakeup'].includes(value.source)
        || typeof value.known !== 'boolean' || typeof value.stale !== 'boolean'
        || !Number.isFinite(value.observedAt)
        || !(value.validUntil === null || Number.isFinite(value.validUntil))) return false
      if (host.deleted.has(value.sessionId)) return false
      host.revisions.set(value.sessionId, value.revision)
      // Malformed details drop only the details: presence still tells the truth.
      const jobs = normalizeSessionCronJobs(value.jobs)
      publish(host, {
        sessionId: value.sessionId, epoch: value.epoch, revision: value.revision,
        presence: value.presence, source: value.source, known: value.known,
        stale: value.stale, observedAt: value.observedAt, validUntil: value.validUntil,
        ...(jobs ? { jobs } : {}),
      })
      return true
    },
    disconnect(hostname: string, token: object) {
      const host = hosts.get(hostname)
      if (!host || host.token !== token) return
      for (const value of host.sessions.values()) {
        if (!value.stale) publish(host, { ...value, stale: true })
      }
      host.token = {}
    },
    remove(sid: string): boolean {
      let removed = false
      for (const host of hosts.values()) {
        if (host.sessions.delete(sid)) removed = true
        host.revisions.delete(sid)
        host.deleted.add(sid)
      }
      return removed
    },
    get(sid: string): SessionCronMetadata | null {
      let latest: SessionCronMetadata | null = null
      for (const host of hosts.values()) {
        const value = host.sessions.get(sid)
        if (value && (!latest || value.revision > latest.revision)) latest = value
      }
      return latest
    },
    list(ids: Iterable<string>): Record<string, SessionCronMetadata> {
      const result: Record<string, SessionCronMetadata> = Object.create(null)
      for (const sid of ids) {
        const value = this.get(sid)
        if (value) result[sid] = value
      }
      return result
    },
  }
}

export const sessionCronMetadata = createSessionCronMetadataStore((value) => {
  bus.emit('session:cron-metadata', value, ['*'], { source: 'daemon-cron-metadata' })
})

bus.subscribe('session-cron-metadata', (event) => {
  const ids = eventData<'session:deleted'>(event).sessionIds
  if (!Array.isArray(ids)) return
  for (const sid of ids) if (typeof sid === 'string' && sid) sessionCronMetadata.remove(sid)
}, { global: true, interest: [EventNames.SESSION_DELETED] })
