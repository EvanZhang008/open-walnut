/**
 * Property coverage for the SERVER-side cron metadata store
 * (src/core/sessions/session-cron-metadata.ts).
 *
 * The heart of it is a model store written from the documented rules — per-host
 * connection token + daemon epoch, per-session revision monotonicity, deletion
 * tombstones, malformed job details dropping only the details — that random
 * operation sequences are replayed against. Every publication the real store
 * makes is compared to the model's, in order, so the test pins the accept/reject
 * decision, the renumbered store revision AND the notification count at once.
 *
 * Seeds are printed in every failure message so a red run is replayable.
 */
import { describe, expect, it, vi } from 'vitest'
import { createSessionCronMetadataStore } from '../../src/core/sessions/session-cron-metadata.js'
import { normalizeSessionCronJobs, type SessionCronMetadata } from '../../src/core/types.js'

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function pick<T>(rng: () => number, values: readonly T[]): T {
  return values[Math.floor(rng() * values.length)]!
}

const fact = (over: Partial<SessionCronMetadata> = {}): SessionCronMetadata => ({
  sessionId: 'session', epoch: 'daemon-1', revision: 1, presence: 'active', source: 'cron',
  known: true, stale: false, observedAt: 1000, validUntil: 2000, ...over,
})

const job = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: '41935620', cron: '23 9 * * *', schedule: 'Every day at 9:23 AM',
  prompt: 'Daily disk inspection', promptTruncated: false, recurring: true, durable: false,
  createdAt: 1000, nextRunAt: 5000, expiresAt: 9000, ...over,
})

// ---------------------------------------------------------------------------
// Model store: the oracle. Mirrors the documented rules, not the code layout.
// ---------------------------------------------------------------------------

interface ModelHost {
  token: object
  daemonEpoch: string
  revisions: Map<string, number>
  deleted: Set<string>
  sessions: Map<string, SessionCronMetadata>
}

/** `epoch` is filled in by the caller from the real store's first publication:
 *  the store stamps its OWN random epoch, which no test can predict. */
function createModel(storeEpoch: () => string) {
  let revision = 0
  const hosts = new Map<string, ModelHost>()
  const published: SessionCronMetadata[] = []
  const publish = (host: ModelHost, value: SessionCronMetadata) => {
    const next = { ...value, epoch: storeEpoch(), revision: ++revision }
    host.sessions.set(value.sessionId, next)
    published.push(next)
  }
  return {
    published,
    hosts,
    connect(hostname: string, token: object, daemonEpoch: string) {
      const previous = hosts.get(hostname)
      // A reconnect keeps the remembered sessions but starts fresh revision
      // bookkeeping AND a fresh tombstone set (tombstones are connection-scoped).
      const host: ModelHost = {
        token,
        daemonEpoch,
        revisions: new Map(),
        deleted: new Set(),
        sessions: previous?.sessions ?? new Map(),
      }
      hosts.set(hostname, host)
      for (const value of [...host.sessions.values()]) publish(host, { ...value, stale: true })
    },
    apply(hostname: string, token: object, raw: unknown): boolean {
      const host = hosts.get(hostname)
      if (!host || host.token !== token) return false
      if (!raw || typeof raw !== 'object') return false
      const v = raw as Record<string, unknown>
      const sid = v.sessionId
      if (v.epoch !== host.daemonEpoch) return false
      if (typeof sid !== 'string' || !sid || sid.length > 256) return false
      if (!Number.isSafeInteger(v.revision)) return false
      if ((v.revision as number) <= (host.revisions.get(sid) ?? 0)) return false
      if (!['active', 'inactive', 'unknown'].includes(v.presence as string)) return false
      if (!(v.source === null || v.source === 'cron' || v.source === 'wakeup')) return false
      if (typeof v.known !== 'boolean' || typeof v.stale !== 'boolean') return false
      if (!Number.isFinite(v.observedAt)) return false
      if (!(v.validUntil === null || Number.isFinite(v.validUntil))) return false
      if (host.deleted.has(sid)) return false
      host.revisions.set(sid, v.revision as number)
      const jobs = normalizeSessionCronJobs(v.jobs)
      publish(host, {
        sessionId: sid, epoch: v.epoch as string, revision: v.revision as number,
        presence: v.presence as SessionCronMetadata['presence'],
        source: v.source as SessionCronMetadata['source'],
        known: v.known, stale: v.stale,
        observedAt: v.observedAt as number, validUntil: v.validUntil as number | null,
        ...(jobs ? { jobs } : {}),
      })
      return true
    },
    disconnect(hostname: string, token: object) {
      const host = hosts.get(hostname)
      if (!host || host.token !== token) return
      for (const value of [...host.sessions.values()]) {
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
  }
}

/** Why the model decided what it decided — a histogram over these doubles as the
 *  vacuity guard: a sequence that never reaches a branch has not tested it. */
type ApplyReason =
  | 'accepted' | 'no-host' | 'stale-token' | 'not-an-object' | 'epoch-mismatch'
  | 'bad-session-id' | 'unsafe-revision' | 'stale-revision' | 'bad-presence'
  | 'bad-source' | 'bad-flags' | 'bad-observed-at' | 'bad-valid-until' | 'tombstoned'

function classify(
  model: ReturnType<typeof createModel>,
  hostname: string,
  token: object,
  raw: unknown,
): ApplyReason {
  const host = model.hosts.get(hostname)
  if (!host) return 'no-host'
  if (host.token !== token) return 'stale-token'
  if (!raw || typeof raw !== 'object') return 'not-an-object'
  const v = raw as Record<string, unknown>
  if (v.epoch !== host.daemonEpoch) return 'epoch-mismatch'
  if (typeof v.sessionId !== 'string' || !v.sessionId || v.sessionId.length > 256) return 'bad-session-id'
  if (!Number.isSafeInteger(v.revision)) return 'unsafe-revision'
  if ((v.revision as number) <= (host.revisions.get(v.sessionId) ?? 0)) return 'stale-revision'
  if (!['active', 'inactive', 'unknown'].includes(v.presence as string)) return 'bad-presence'
  if (!(v.source === null || v.source === 'cron' || v.source === 'wakeup')) return 'bad-source'
  if (typeof v.known !== 'boolean' || typeof v.stale !== 'boolean') return 'bad-flags'
  if (!Number.isFinite(v.observedAt)) return 'bad-observed-at'
  if (!(v.validUntil === null || Number.isFinite(v.validUntil))) return 'bad-valid-until'
  if (host.deleted.has(v.sessionId)) return 'tombstoned'
  return 'accepted'
}

const HOSTS = ['host-a', 'host-b', 'host-c']
const SIDS = ['sid-1', 'sid-2', 'sid-3', 'sid-4']
const SEEDS = [3, 11, 20260916]

const INVALID_PATCHES: Array<Partial<Record<keyof SessionCronMetadata, unknown>>> = [
  { presence: 'armed' }, { presence: undefined }, { source: 'timer' }, { known: 'yes' },
  { stale: null }, { observedAt: Number.NaN }, { observedAt: '1000' }, { validUntil: 'soon' },
  { sessionId: '' }, { sessionId: 'x'.repeat(257) }, { epoch: 'daemon-other' },
]

const MALFORMED_JOBS: unknown[] = [
  [job({ id: '' })], [job({ recurring: 'yes' })], [job(), job()], 'jobs', 42,
  Array.from({ length: 33 }, (_, i) => job({ id: `dup-${i}` })),
]

describe('session cron metadata store — random operation sequences', () => {
  it.each(SEEDS)('matches the model store op for op (seed %i)', (seed) => {
    const rng = mulberry32(seed)
    const publishedReal: SessionCronMetadata[] = []
    let storeEpoch: string | null = null
    const store = createSessionCronMetadataStore((value) => {
      storeEpoch ??= value.epoch
      publishedReal.push(value)
    })
    const model = createModel(() => storeEpoch!)

    // Connection bookkeeping the model does not expose: which tokens are live.
    const tokens = new Map<string, { current: object; stale: object[]; daemonEpoch: string; live: boolean }>()
    let epochCounter = 0
    // A sequence that only ever rejects (or only accepts) proves nothing.
    const outcomes = { accepted: 0, rejected: 0, removed: 0, tombstoned: 0 }
    const reasons = new Map<ApplyReason, number>()

    const randomEnvelope = (hostname: string, sid: string): unknown => {
      const entry = tokens.get(hostname)
      const daemonEpoch = entry?.daemonEpoch ?? 'daemon-unknown'
      const lastAccepted = model.hosts.get(hostname)?.revisions.get(sid) ?? 0
      const revision = pick(rng, [
        lastAccepted + 1, lastAccepted + 1, lastAccepted + 2, lastAccepted + 7, lastAccepted + 3,
        lastAccepted, Math.max(0, lastAccepted - 1), 1.5, 0, Number.MAX_SAFE_INTEGER + 2,
      ])
      const value: Record<string, unknown> = {
        ...fact({
          sessionId: sid,
          epoch: rng() < 0.9 ? daemonEpoch : `daemon-stale-${epochCounter}`,
          revision: revision as number,
          presence: pick(rng, ['active', 'inactive', 'unknown']),
          source: pick(rng, ['cron', 'wakeup', null]),
          known: rng() < 0.7,
          stale: rng() < 0.25,
          observedAt: 1000 + Math.floor(rng() * 1000),
          validUntil: rng() < 0.3 ? null : 2000 + Math.floor(rng() * 1000),
        }),
      }
      const jobsRoll = rng()
      if (jobsRoll < 0.2) value.jobs = [job({ id: `${sid}-1` }), job({ id: `${sid}-2` })]
      else if (jobsRoll < 0.32) value.jobs = []
      else if (jobsRoll < 0.44) value.jobs = pick(rng, MALFORMED_JOBS)
      else if (jobsRoll < 0.5) value.jobs = undefined
      if (rng() < 0.15) Object.assign(value, pick(rng, INVALID_PATCHES))
      if (rng() < 0.03) return pick(rng, [null, undefined, 'metadata', 42, [fact()]])
      return value
    }

    // Open every host first, so the sequence spends its budget on the state
    // machine rather than on applies nobody is connected for.
    const connectHost = (hostname: string) => {
      const entry = tokens.get(hostname)
      const token = {}
      const daemonEpoch = `daemon-${++epochCounter}`
      if (entry) entry.stale.push(entry.current)
      tokens.set(hostname, { current: token, stale: entry?.stale ?? [], daemonEpoch, live: true })
      store.connect(hostname, token, daemonEpoch)
      model.connect(hostname, token, daemonEpoch)
    }
    // A disconnected host rejects EVERY apply, so an unbiased host pick spends
    // most of the sequence on one uninteresting branch. Bias the picks instead.
    const hostsWhere = (live: boolean) => HOSTS.filter((h) => !!tokens.get(h)?.live === live)
    const preferHost = (live: boolean, fallback: string) => {
      const candidates = hostsWhere(live)
      return candidates.length > 0 ? pick(rng, candidates) : fallback
    }

    for (const hostname of HOSTS) connectHost(hostname)

    for (let step = 0; step < 130; step++) {
      let hostname = pick(rng, HOSTS)
      const sid = pick(rng, SIDS)
      const label = `seed ${seed} step ${step} ${hostname} ${sid}`
      const roll = rng()
      if (roll < 0.16) {
        connectHost(preferHost(false, hostname))
      } else if (roll < 0.24) {
        hostname = preferHost(true, hostname)
        const entry = tokens.get(hostname)
        const token = entry && rng() < 0.75 ? entry.current : (entry?.stale.at(-1) ?? {})
        store.disconnect(hostname, token)
        model.disconnect(hostname, token)
        if (entry && token === entry.current) {
          entry.stale.push(entry.current)
          entry.live = false
        }
      } else if (roll < 0.28) {
        const target = rng() < 0.85 ? sid : 'never-held'
        const removed = store.remove(target)
        expect(removed, `${label} remove`).toBe(model.remove(target))
        if (removed) outcomes.removed++
        outcomes.tombstoned++
      } else {
        hostname = rng() < 0.85 ? preferHost(true, hostname) : hostname
        const entry = tokens.get(hostname)
        const token = entry && rng() < 0.85 ? entry.current : (entry?.stale.at(-1) ?? {})
        const envelope = randomEnvelope(hostname, sid)
        // Real store FIRST in every branch: the model needs the store's own
        // epoch, which it only learns from the store's first publication.
        const reason = classify(model, hostname, token, envelope)
        const actual = store.apply(hostname, token, envelope)
        expect(actual, `${label} apply`).toBe(model.apply(hostname, token, envelope))
        expect(actual, `${label} reason ${reason}`).toBe(reason === 'accepted')
        outcomes[actual ? 'accepted' : 'rejected']++
        reasons.set(reason, (reasons.get(reason) ?? 0) + 1)
      }

      expect(publishedReal, `${label} publications`).toEqual(model.published)
      for (const candidate of SIDS) {
        expect(store.get(candidate), `${label} get(${candidate})`).toEqual(model.get(candidate))
      }
      const expectedList: Record<string, SessionCronMetadata> = {}
      for (const candidate of SIDS) {
        const value = model.get(candidate)
        if (value) expectedList[candidate] = value
      }
      expect(store.list(SIDS), `${label} list`).toEqual(expectedList)
      expect(store.list([]), `${label} empty list`).toEqual({})
    }

    // Invariants over every publication the run produced.
    const spread = `${JSON.stringify(outcomes)} ${JSON.stringify([...reasons])}`
    expect(outcomes.accepted, `seed ${seed} accepted too little: ${spread}`).toBeGreaterThan(8)
    expect(outcomes.rejected, `seed ${seed} rejected too little: ${spread}`).toBeGreaterThan(8)
    expect(outcomes.removed, `seed ${seed} removed nothing: ${spread}`).toBeGreaterThan(0)
    // The branches every sequence must reach, or it is not testing the machine.
    for (const required of [
      'accepted', 'stale-token', 'stale-revision', 'unsafe-revision', 'epoch-mismatch',
    ] as const) {
      expect(reasons.get(required) ?? 0, `seed ${seed} never hit ${required}: ${spread}`).toBeGreaterThan(0)
    }
    expect(publishedReal.length, `seed ${seed} produced no publications`).toBeGreaterThan(5)
    let previousRevision = 0
    for (const [index, value] of publishedReal.entries()) {
      const label = `seed ${seed} publication ${index}`
      expect(value.revision, `${label} strictly increasing`).toBeGreaterThan(previousRevision)
      previousRevision = value.revision
      // The store stamps its own epoch; a daemon epoch must never leak out.
      expect(value.epoch, `${label} epoch`).toBe(storeEpoch)
      expect(value.epoch, `${label} not a daemon epoch`).not.toMatch(/^daemon-/)
      if ('jobs' in value) expect(Array.isArray(value.jobs), `${label} jobs shape`).toBe(true)
      expect(Object.keys(value).sort(), `${label} key set`).toEqual(
        ('jobs' in value
          ? ['epoch', 'jobs', 'known', 'observedAt', 'presence', 'revision', 'sessionId', 'source', 'stale', 'validUntil']
          : ['epoch', 'known', 'observedAt', 'presence', 'revision', 'sessionId', 'source', 'stale', 'validUntil']),
      )
    }
  })
})

describe('session cron metadata store — envelope shape gate', () => {
  it.each(INVALID_PATCHES)('rejects and publishes nothing for %j', (patch) => {
    const changed = vi.fn()
    const store = createSessionCronMetadataStore(changed)
    const token = {}
    store.connect('local', token, 'daemon-1')
    expect(store.apply('local', token, { ...fact(), ...patch })).toBe(false)
    expect(changed).not.toHaveBeenCalled()
    expect(store.get('session')).toBeNull()
    expect(store.get((patch as { sessionId?: string }).sessionId ?? 'session')).toBeNull()
  })

  it.each([null, undefined, 'metadata', 42, true, [fact()], new Date(0)])('rejects a non-envelope: %j', (raw) => {
    const store = createSessionCronMetadataStore(() => {})
    const token = {}
    store.connect('local', token, 'daemon-1')
    expect(store.apply('local', token, raw)).toBe(false)
    expect(store.get('session')).toBeNull()
  })
})

describe('session cron metadata store — published value invariants', () => {
  it('copies the observation verbatim and only renumbers epoch and revision', () => {
    const values: SessionCronMetadata[] = []
    const store = createSessionCronMetadataStore((value) => values.push(value))
    const token = {}
    store.connect('local', token, 'daemon-1')
    const input = fact({
      revision: 41, presence: 'inactive', source: 'wakeup', known: false, stale: true,
      observedAt: 1_757_000_000_123, validUntil: null, jobs: [job()] as never,
    })
    expect(store.apply('local', token, input)).toBe(true)
    const value = values.at(-1)!
    expect(value).toMatchObject({
      sessionId: 'session', presence: 'inactive', source: 'wakeup', known: false, stale: true,
      observedAt: 1_757_000_000_123, validUntil: null,
    })
    expect(value.jobs).toEqual([job()])
    expect(value.epoch).not.toBe('daemon-1')
    expect(value.revision).toBe(1)
    expect(store.get('session')).toBe(value)
  })

  it.each([
    ['undefined jobs', undefined, false],
    ['absent jobs key', 'absent', false],
    ['malformed jobs', 'jobs', false],
    ['empty jobs', [], true],
    ['one job', [job()], true],
  ])('publishes the jobs key only when the details survive: %s', (_label, jobs, present) => {
    const store = createSessionCronMetadataStore(() => {})
    const token = {}
    store.connect('local', token, 'daemon-1')
    const input = fact() as Record<string, unknown>
    if (jobs !== 'absent') input.jobs = jobs
    expect(store.apply('local', token, input)).toBe(true)
    const value = store.get('session')!
    expect('jobs' in value).toBe(present)
    if (present) expect(value.jobs).toEqual(jobs)
  })
})

describe('session cron metadata store — reconnect and disconnect sweeps', () => {
  it('marks every remembered session stale exactly once per reconnect', () => {
    const changed = vi.fn()
    const store = createSessionCronMetadataStore(changed)
    const first = {}
    store.connect('local', first, 'daemon-1')
    expect(store.apply('local', first, fact({ revision: 5 }))).toBe(true)
    expect(store.apply('local', first, fact({ sessionId: 'other', revision: 5, stale: true }))).toBe(true)

    changed.mockClear()
    const second = {}
    store.connect('local', second, 'daemon-2')
    // One publish per remembered session, INCLUDING the already-stale one.
    expect(changed).toHaveBeenCalledTimes(2)
    for (const call of changed.mock.calls) expect(call[0]).toMatchObject({ stale: true })
    expect(store.get('session')).toMatchObject({ known: true, stale: true, presence: 'active' })

    // Revisions restart with the connection: a daemon that restarted at 1 is heard.
    expect(store.apply('local', second, fact({ epoch: 'daemon-2', revision: 1 }))).toBe(true)
    // Store revisions are one global stream: 2 applies + 2 sweep publishes + this one.
    expect(store.get('session')).toMatchObject({ revision: 5, stale: false })
    // ...and the old connection cannot speak again.
    expect(store.apply('local', first, fact({ revision: 9 }))).toBe(false)
  })

  it('sweeps only the non-stale sessions on disconnect and never sweeps twice', () => {
    const changed = vi.fn()
    const store = createSessionCronMetadataStore(changed)
    const token = {}
    store.connect('local', token, 'daemon-1')
    store.apply('local', token, fact())
    store.apply('local', token, fact({ sessionId: 'already-stale', stale: true }))

    changed.mockClear()
    store.disconnect('local', token)
    expect(changed).toHaveBeenCalledTimes(1)
    expect(changed.mock.calls[0]![0]).toMatchObject({ sessionId: 'session', stale: true })

    // The token is retired by the sweep, so a repeat is a no-op...
    store.disconnect('local', token)
    expect(changed).toHaveBeenCalledTimes(1)
    // ...and so is every later apply on it.
    expect(store.apply('local', token, fact({ revision: 2 }))).toBe(false)
    expect(store.get('session')).toMatchObject({ stale: true })

    // A reconnect leaves nothing for the next disconnect to sweep.
    const second = {}
    store.connect('local', second, 'daemon-2')
    changed.mockClear()
    store.disconnect('local', second)
    expect(changed).not.toHaveBeenCalled()
  })

  it('ignores connect-less hosts entirely', () => {
    const store = createSessionCronMetadataStore(() => {})
    expect(store.apply('ghost-host', {}, fact())).toBe(false)
    store.disconnect('ghost-host', {})
    expect(store.get('session')).toBeNull()
    expect(store.remove('session')).toBe(false)
  })
})

describe('session cron metadata store — deletion tombstones', () => {
  it('refuses every host for a deleted session while the connections live', () => {
    const changed = vi.fn()
    const store = createSessionCronMetadataStore(changed)
    const a = {}; const b = {}
    store.connect('host-a', a, 'daemon-a')
    store.connect('host-b', b, 'daemon-b')
    expect(store.apply('host-a', a, fact({ epoch: 'daemon-a', revision: 3 }))).toBe(true)
    expect(store.apply('host-b', b, fact({ epoch: 'daemon-b', revision: 3 }))).toBe(true)

    expect(store.remove('session')).toBe(true)
    expect(store.get('session')).toBeNull()
    changed.mockClear()
    for (const [hostname, token, epoch] of [['host-a', a, 'daemon-a'], ['host-b', b, 'daemon-b']] as const) {
      expect(store.apply(hostname, token, fact({ epoch, revision: 99 }))).toBe(false)
    }
    expect(changed).not.toHaveBeenCalled()
    expect(store.get('session')).toBeNull()
    // Nothing to delete the second time.
    expect(store.remove('session')).toBe(false)
    expect(store.remove('never-held')).toBe(false)
  })

  it('keeps siblings flowing through a tombstoned host', () => {
    const store = createSessionCronMetadataStore(() => {})
    const token = {}
    store.connect('local', token, 'daemon-1')
    store.apply('local', token, fact())
    store.apply('local', token, fact({ sessionId: 'kept' }))
    store.remove('session')
    expect(store.apply('local', token, fact({ sessionId: 'kept', revision: 2 }))).toBe(true)
    expect(Object.keys(store.list(['session', 'kept']))).toEqual(['kept'])
  })

  // BUG (suspected): a tombstone is CONNECTION-scoped, so a reconnect — the
  // routine outcome of a daemon restart or a tunnel blip — forgets that the
  // session was deleted and re-publishes metadata for a session Walnut no longer
  // has a record for (`remove` is wired to the session:deleted event). The
  // existing suite pins this as intended ("the new connection speaks for
  // itself"), so this is filed rather than fixed; skipped so it documents the
  // hazard without failing the tier.
  it.skip('BUG: a reconnect resurrects a deleted session', () => {
    const store = createSessionCronMetadataStore(() => {})
    const first = {}
    store.connect('local', first, 'daemon-1')
    store.apply('local', first, fact())
    expect(store.remove('session')).toBe(true)

    const second = {}
    store.connect('local', second, 'daemon-2')
    // A fresh `deleted` set ships with the new connection, so the tombstone is gone.
    expect(store.apply('local', second, fact({ epoch: 'daemon-2' }))).toBe(false)
    expect(store.get('session')).toBeNull()
  })

  it('documents the behaviour the BUG skip above would change', () => {
    const store = createSessionCronMetadataStore(() => {})
    const first = {}
    store.connect('local', first, 'daemon-1')
    store.apply('local', first, fact())
    store.remove('session')
    const second = {}
    store.connect('local', second, 'daemon-2')
    expect(store.apply('local', second, fact({ epoch: 'daemon-2' }))).toBe(true)
    expect(store.get('session')).toMatchObject({ presence: 'active', stale: false })
  })
})

describe('session cron metadata store — malformed job details', () => {
  it('keeps presence, drops the details, and restores them on the next good reply', () => {
    const store = createSessionCronMetadataStore(() => {})
    const token = {}
    store.connect('local', token, 'daemon-1')
    let revision = 0
    for (const malformed of MALFORMED_JOBS) {
      expect(store.apply('local', token, fact({ revision: ++revision, presence: 'inactive', jobs: malformed as never })))
        .toBe(true)
      const value = store.get('session')!
      expect(value).toMatchObject({ presence: 'inactive', known: true })
      expect('jobs' in value).toBe(false)

      expect(store.apply('local', token, fact({ revision: ++revision, jobs: [job()] as never }))).toBe(true)
      expect(store.get('session')?.jobs).toEqual([job()])
    }
  })
})
