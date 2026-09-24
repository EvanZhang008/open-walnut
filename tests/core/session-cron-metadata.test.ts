import { describe, expect, it, vi } from 'vitest'
import { bus, EventNames } from '../../src/core/event-bus.js'
import { createSessionCronMetadataStore, sessionCronMetadata } from '../../src/core/sessions/session-cron-metadata.js'
import type { SessionCronMetadata } from '../../src/core/types.js'

const fact = (over: Partial<SessionCronMetadata> = {}): SessionCronMetadata => ({
  sessionId: 'session', epoch: 'daemon-1', revision: 1, presence: 'active', source: 'cron',
  known: true, stale: false, observedAt: 1000, validUntil: 2000, ...over,
})

describe('session cron metadata host feed', () => {
  it('hydrates multiple sessions without treating their revisions as one stream', () => {
    const changed = vi.fn()
    const store = createSessionCronMetadataStore(changed)
    const token = {}
    store.connect('local', token, 'daemon-1')
    expect(store.apply('local', token, fact({ sessionId: 'second', revision: 20 }))).toBe(true)
    expect(store.apply('local', token, fact())).toBe(true)
    expect(Object.keys(store.list(['session', 'second', 'unknown']))).toEqual(['session', 'second'])
    expect(changed).toHaveBeenCalledTimes(2)
    expect(store.get('session')?.epoch).not.toBe('daemon-1')
  })

  it('rejects stale responses and a disconnected socket after reconnection', () => {
    const store = createSessionCronMetadataStore(() => {})
    const old = {}; const current = {}
    store.connect('local', old, 'daemon-1')
    store.apply('local', old, fact({ revision: 3 }))
    expect(store.apply('local', old, fact({ revision: 2, presence: 'inactive' }))).toBe(false)
    store.disconnect('local', old)
    expect(store.get('session')?.stale).toBe(true)
    store.connect('local', current, 'daemon-2')
    expect(store.apply('local', old, fact({ revision: 4 }))).toBe(false)
    expect(store.apply('local', current, fact({ epoch: 'daemon-1', revision: 4 }))).toBe(false)
    expect(store.apply('local', current, fact({ epoch: 'daemon-2' }))).toBe(true)
    store.disconnect('local', old)
    expect(store.get('session')?.stale).toBe(false)
  })

  it('retains uncertainty when a new daemon cannot supply a prior session', () => {
    const store = createSessionCronMetadataStore(() => {})
    const token = {}
    store.connect('local', token, 'daemon-1')
    store.apply('local', token, fact())
    store.connect('local', {}, 'daemon-2')
    expect(store.get('session')).toMatchObject({ known: true, stale: true })
  })

  it('returns the same newest publication over HTTP and the event feed across host aliases', () => {
    const values: SessionCronMetadata[] = []
    const store = createSessionCronMetadataStore((value) => values.push(value))
    const first = {}; const second = {}
    store.connect('first', first, 'daemon-1')
    store.apply('first', first, fact())
    store.connect('second', second, 'daemon-2')
    store.apply('second', second, fact({ epoch: 'daemon-2', presence: 'inactive' }))
    expect(store.get('session')).toBe(values.at(-1))
    store.disconnect('first', first)
    expect(store.get('session')).toBe(values.at(-1))
    expect(store.get('session')?.stale).toBe(true)
  })

  it('forgets a deleted session and refuses the reply still in flight for it', () => {
    const changed = vi.fn()
    const store = createSessionCronMetadataStore(changed)
    const token = {}
    store.connect('local', token, 'daemon-1')
    store.apply('local', token, fact({ revision: 3 }))
    store.apply('local', token, fact({ sessionId: 'other', revision: 3 }))
    expect(store.remove('session')).toBe(true)
    expect(store.get('session')).toBeNull()
    expect(Object.keys(store.list(['session', 'other']))).toEqual(['other'])

    changed.mockClear()
    // Same connection, valid and newer: it must not re-create the deleted row.
    expect(store.apply('local', token, fact({ revision: 4 }))).toBe(false)
    expect(store.get('session')).toBeNull()
    expect(changed).not.toHaveBeenCalled()
    // A sibling session on that same connection keeps flowing.
    expect(store.apply('local', token, fact({ sessionId: 'other', revision: 4 }))).toBe(true)
    expect(store.get('other')).toMatchObject({ revision: expect.any(Number), presence: 'active' })
    expect(changed).toHaveBeenCalledTimes(1)
  })

  it('drops a deleted session without letting disconnect or reconnect resurrect it', () => {
    const store = createSessionCronMetadataStore(() => {})
    const first = {}
    store.connect('local', first, 'daemon-1')
    store.apply('local', first, fact())
    store.remove('session')
    // The disconnect sweep only re-publishes what is still held.
    store.disconnect('local', first)
    expect(store.get('session')).toBeNull()

    const second = {}
    store.connect('local', second, 'daemon-2')
    expect(store.get('session')).toBeNull()
    // Tombstones are connection-scoped: the new connection speaks for itself.
    expect(store.apply('local', second, fact({ epoch: 'daemon-2', revision: 1 }))).toBe(true)
    expect(store.get('session')).toMatchObject({ presence: 'active', stale: false })
  })

  it('reports nothing removed for a session it never held', () => {
    const store = createSessionCronMetadataStore(() => {})
    const token = {}
    store.connect('local', token, 'daemon-1')
    store.apply('local', token, fact())
    expect(store.remove('ghost')).toBe(false)
    expect(store.get('session')).toMatchObject({ presence: 'active' })
    expect(Object.keys(store.list(['session', 'ghost']))).toEqual(['session'])
  })

  it('carries well-formed job details and drops only the details when they are malformed', () => {
    const store = createSessionCronMetadataStore(() => {})
    const token = {}
    store.connect('local', token, 'daemon-1')
    const job = {
      id: '41935620', cron: '23 9 * * *', schedule: 'Every day at 9:23 AM', prompt: 'Daily disk inspection', promptTruncated: false,
      recurring: true, durable: false, createdAt: 1000, nextRunAt: 5000, expiresAt: 9000,
    }
    expect(store.apply('local', token, fact({ jobs: [job] }))).toBe(true)
    expect(store.get('session')?.jobs).toEqual([job])
    expect(store.apply('local', token, fact({ revision: 2 }))).toBe(true)
    expect(store.get('session')?.jobs).toBeUndefined()
    for (const malformed of [
      [{ ...job, id: '' }], [{ ...job, prompt: 'x'.repeat(2001) }], [{ ...job, recurring: 'yes' }], [{ ...job, nextRunAt: 'soon' }],
      [job, job], 'jobs', Array.from({ length: 33 }, (_, i) => ({ ...job, id: String(i) })),
    ]) {
      const revision = (store.get('session')?.revision ?? 0) + 1
      expect(store.apply('local', token, fact({ revision: revision + 100, jobs: malformed as never }))).toBe(true)
      expect(store.get('session')).toMatchObject({ presence: 'active' })
      expect(store.get('session')?.jobs).toBeUndefined()
    }
  })

  it.each([null, {}, { revision: NaN }, { presence: 'running' }, { validUntil: 'tomorrow' }])('rejects invalid metadata: %j', (invalid) => {
    const store = createSessionCronMetadataStore(() => {})
    const token = {}
    store.connect('local', token, 'daemon-1')
    expect(store.apply('local', token, invalid && Object.keys(invalid).length ? { ...fact(), ...invalid } : invalid)).toBe(false)
    expect(store.get('session')).toBeNull()
  })
})

describe('session cron metadata deletion wiring', () => {
  it('forgets a session when the tracker announces the record is gone', () => {
    const token = {}
    sessionCronMetadata.connect('wiring-host', token, 'daemon-1')
    expect(sessionCronMetadata.apply('wiring-host', token, fact({ sessionId: 'bus-deleted' }))).toBe(true)
    expect(sessionCronMetadata.apply('wiring-host', token, fact({ sessionId: 'bus-kept' }))).toBe(true)

    bus.emit(EventNames.SESSION_DELETED, { sessionIds: ['bus-deleted'] }, ['*'], { source: 'test' })

    expect(sessionCronMetadata.get('bus-deleted')).toBeNull()
    expect(sessionCronMetadata.apply('wiring-host', token, fact({ sessionId: 'bus-deleted', revision: 9 }))).toBe(false)
    expect(sessionCronMetadata.get('bus-kept')).toMatchObject({ presence: 'active' })
  })
})

describe('session cron metadata deletion wiring payloads', () => {
  it('ignores a deletion event whose session list is missing or malformed', () => {
    const token = {}
    sessionCronMetadata.connect('payload-host', token, 'daemon-1')
    expect(sessionCronMetadata.apply('payload-host', token, fact({ sessionId: 'payload-kept' }))).toBe(true)
    bus.emit(EventNames.SESSION_DELETED, { sessionIds: 'payload-kept' } as never, ['*'], { source: 'test' })
    bus.emit(EventNames.SESSION_DELETED, {} as never, ['*'], { source: 'test' })
    bus.emit(EventNames.SESSION_DELETED, { sessionIds: [42, '', null] } as never, ['*'], { source: 'test' })
    expect(sessionCronMetadata.get('payload-kept')).toMatchObject({ presence: 'active' })
  })
})
