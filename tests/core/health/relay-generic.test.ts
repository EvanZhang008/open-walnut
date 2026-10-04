/**
 * The primary's answer to a RELAYED health call depends on whether the replica
 * can carry generic types (q. / c. / x.) intact. A replica that predates them
 * narrows a generic batch to an empty one and relays that, so storing it would
 * acknowledge samples that never arrived and the phone would move its anchor past
 * them. Real (temp) store; the batches below are the exact shapes each replica
 * forwards. Invented data only.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-health-relay-generic'))

import { closeHealthDb, destroyHealthDbFiles } from '../../../src/core/health/db.js'
import { resetMaterializeQueue } from '../../../src/core/health/materialize.js'
import { RELAY_GENERIC_FLAG, runHealthAction } from '../../../src/core/health/relay.js'
import { samplesQuery } from '../../../src/core/health/samples.js'
import { APP, TZ, rawBatch, uuid, watchNight } from './fixtures.js'

const headache = (id = uuid('H')) => ({ uuid: id, start: '2026-09-20T15:00:00-04:00', end: '2026-09-20T16:00:00-04:00', code: 2, source: APP })
const weight = () => ({ uuid: uuid('W'), start: '2026-09-20T08:00:00-04:00', end: '2026-09-20T08:00:00-04:00', value: 72.4, source: APP })
/** What a replica from before generic types relays for any generic call: its sanitize kept nothing. */
const oldReplicaBody = (type: string, deleted: string[] = []) => ({ tz: TZ, kind: 'raw', type, samples: [], deleted, buckets: [] })
const stamped = (body: unknown) => ({ body, [RELAY_GENERIC_FLAG]: true })

beforeEach(() => {
  resetMaterializeQueue()
  destroyHealthDbFiles()
})

afterAll(() => closeHealthDb())

describe('a relayed health call from a replica that predates generic types', () => {
  it('a generic sync is answered unsupported, so the phone keeps its anchor', async () => {
    for (const type of ['c.Headache', 'x.BloodType', 'q.BodyMass']) {
      const out = await runHealthAction('sync', { body: oldReplicaBody(type), rejected: 1 })
      expect(out.status, type).toBe(200)
      expect(out.body, type).toMatchObject({ accepted: 0, inserted: 0, unsupported: true })
    }
    // Even a full batch (the shape a newer replica would send) is declined without the stamp.
    const full = await runHealthAction('sync', { body: rawBatch('c.Headache', [headache()]) })
    expect(full.body).toMatchObject({ accepted: 0, unsupported: true })
    expect((await samplesQuery({ type: 'c.Headache', from: '2026-09-20', to: '2026-09-20' })).rows).toEqual([])
  })

  it('its status hides supported.generic, so the phone sends catalog types only', async () => {
    const old = await runHealthAction('status', { body: undefined })
    expect(old.status).toBe(200)
    expect(old.body.supported).toBeDefined()
    expect(old.body.supported).not.toHaveProperty('generic')
    expect((old.body.supported as any).raw).toContain('sleep')
    const fresh = await runHealthAction('status', stamped(undefined))
    expect((fresh.body.supported as any).generic).toMatchObject({ prefixes: ['q', 'c', 'x'] })
    const direct = await runHealthAction('status', { body: undefined }, { direct: true })
    expect((direct.body.supported as any).generic).toBeDefined()
  })

  it('a catalog sync through it is stored as before', async () => {
    const out = await runHealthAction('sync', { body: rawBatch('sleep', watchNight('2026-09-20', '2026-09-21')) })
    expect(out.status).toBe(200)
    expect(out.body).not.toHaveProperty('unsupported')
    expect(out.body.accepted).toBeGreaterThan(0)
  })

  it('deletions in a declined generic call still apply', async () => {
    const id = uuid('H')
    await runHealthAction('sync', { body: rawBatch('c.Headache', [headache(id)]) }, { direct: true })
    expect((await samplesQuery({ type: 'c.Headache', from: '2026-09-20', to: '2026-09-20' })).rows).toHaveLength(1)
    const out = await runHealthAction('sync', { body: oldReplicaBody('c.Headache', [id]) })
    expect(out.body).toMatchObject({ unsupported: true, deleted: 1 })
    expect((await samplesQuery({ type: 'c.Headache', from: '2026-09-20', to: '2026-09-20' })).rows).toEqual([])
  })
})

describe('the primary own route and a generic-aware replica', () => {
  it('store generic samples with their unit', async () => {
    const direct = await runHealthAction('sync', { body: rawBatch('q.BodyMass', [weight()], { unit: 'kg' }) }, { direct: true })
    expect(direct.body).toMatchObject({ accepted: 1, inserted: 1 })
    expect(direct.body).not.toHaveProperty('unsupported')
    const relayed = await runHealthAction('sync', stamped(rawBatch('c.Headache', [headache()])))
    expect(relayed.body).toMatchObject({ accepted: 1, inserted: 1 })
    expect((await samplesQuery({ type: 'q.BodyMass', from: '2026-09-20', to: '2026-09-20' })).rows).toMatchObject([{ value: 72.4, unit: 'kg' }])
  })
})
