/**
 * The `requests` copy kind (docs/plan/walnut-replica-servers-impl.md, WP4): the
 * Mac's session-requests.json on a host replica, same file, and a request's
 * status only moves forward on apply. Real route, real follower, real round.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../../helpers/mock-constants.js'
import { startCopyHarness, stepsSince, type CopyHarness } from '../../../helpers/copy-kind-harness.js'

vi.mock('../../../../src/constants.js', () => createMockConstants('walnut-copy-requests', { CLOUD_MODE: false }))

import { WALNUT_HOME } from '../../../../src/constants.js'
import { _resetServerRoleForTesting } from '../../../../src/core/server-role.js'
import { runCopyRound, syncCopyKinds, type CopyKind } from '../../../../src/core/replication/kinds/copy-kind.js'
import { REQUESTS_KIND, forwardRequest, _resetRequestsCopyForTesting } from '../../../../src/core/replication/kinds/requests.js'
import { buildKindManifest } from '../../../../src/core/replication/kind-leader.js'
import { _resetReplicaStatusForTesting, forgetKindManifests } from '../../../../src/core/replication/replica-status.js'
import type { SessionRequest } from '../../../../src/core/session-requests.js'

const T0 = '2026-10-15T08:00:00.000Z'
const ENV = ['WALNUT_ROLE', 'WALNUT_PLACEMENT', 'WALNUT_HOST_SERVER'] as const
const saved: Record<string, string | undefined> = {}
let h: CopyHarness
let leader: SessionRequest[] = []
const kind: CopyKind<SessionRequest> = { ...REQUESTS_KIND, rows: async () => leader.map((r) => ({ ...r })), watch: () => () => {} }
const storeFile = () => path.join(WALNUT_HOME, 'session-requests.json')

function rq(i: number, over: Partial<SessionRequest> = {}): SessionRequest {
  return { id: `rq-${String(i).padStart(12, '0')}`, fromSessionId: `sid-lead-${i % 3}`, toTaskId: `task-${i}`, preview: `Review step ${i}`, status: 'pending', createdAt: T0, deadlineAt: Date.parse(T0) + 3_600_000, ...over }
}

async function round() {
  return runCopyRound(kind, await buildKindManifest(kind, [...await kind.rows()]), h.target, { asOf: Date.now() })
}

async function copy(): Promise<SessionRequest[]> {
  return (JSON.parse(await fsp.readFile(storeFile(), 'utf8')) as { requests: SessionRequest[] }).requests
}

beforeAll(async () => {
  for (const k of ENV) saved[k] = process.env[k]
  Object.assign(process.env, { WALNUT_ROLE: 'replica', WALNUT_PLACEMENT: 'host', WALNUT_HOST_SERVER: '1' })
  _resetServerRoleForTesting()
  h = await startCopyHarness()
})

afterAll(async () => {
  await h.close()
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
  _resetServerRoleForTesting()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

beforeEach(async () => {
  _resetRequestsCopyForTesting()
  _resetReplicaStatusForTesting()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
  h.calls.length = 0
  leader = [rq(1), rq(2, { status: 'replied', settledAt: T0 }), rq(3)]
})

describe('forwardRequest', () => {
  it('takes the leader\'s row unless that moves a final status anywhere else', () => {
    expect(forwardRequest(undefined, rq(1)).status).toBe('pending')
    expect(forwardRequest(rq(1), rq(1, { status: 'replied' })).status).toBe('replied')
    expect(forwardRequest(rq(1, { status: 'replied' }), rq(1)).status).toBe('replied')
    // Two final statuses: the Mac's is the one that holds (its hash is the one recorded).
    expect(forwardRequest(rq(1, { status: 'expired' }), rq(1, { status: 'notified' })).status).toBe('notified')
    expect(forwardRequest(rq(1, { status: 'notified' }), rq(1, { status: 'replied' })).status).toBe('replied')
    expect(forwardRequest(rq(1, { status: 'replied' }), rq(1, { status: 'withdrawn' })).status).toBe('replied')
    // withdrawn is not final: the Mac restores it to pending when the asker's task reopens.
    expect(forwardRequest(rq(1, { status: 'withdrawn' }), rq(1)).status).toBe('pending')
    expect(forwardRequest(rq(1, { status: 'replied', preview: 'old' }), rq(1, { status: 'replied', preview: 'new' })).preview).toBe('new')
  })
})

describe('a host replica keeps the requests copy', () => {
  it('writes the same file the Mac keeps, at 0600, rows as sent', async () => {
    expect(await round()).toMatchObject({ action: 'synced', entries: 3, sent: 3 })
    expect(stepsSince(h.calls)).toEqual(['sync:requests', 'put:requests:3'])
    expect((await copy()).sort((a, b) => a.id.localeCompare(b.id))).toEqual(leader)
    expect(fs.statSync(storeFile()).mode & 0o777).toBe(0o600)
    forgetKindManifests(['requests'])
    const from = h.calls.length
    expect(await round()).toMatchObject({ action: 'synced', sent: 0 })
    expect(stepsSince(h.calls, from)).toEqual(['sync:requests'])
  })

  it('a status only moves forward: a copy that holds a settle keeps it, and the round still ends', async () => {
    await round()
    // The copy settled rq-1 (a reply while the Mac was away reaches the Mac through the journal).
    const rows = await copy()
    await fsp.writeFile(storeFile(), JSON.stringify({ requests: rows.map((r) => (r.id === rq(1).id ? { ...r, status: 'replied', settledAt: T0 } : r)) }))
    // The leader's row for it changes while still pending: the copy takes the change, not the step back.
    leader[0] = { ...leader[0], preview: 'Review step 1 again' }
    expect(await round()).toMatchObject({ action: 'synced', sent: 1, held: 0 })
    expect((await copy()).find((r) => r.id === rq(1).id)?.status).toBe('replied')
    forgetKindManifests(['requests'])
    const from = h.calls.length
    await round()
    expect(stepsSince(h.calls, from)).toEqual(['sync:requests']) // converged: nothing asked for again
    // Once the Mac settles it too, the copy takes the Mac's row.
    leader[0] = { ...leader[0], status: 'replied', settledAt: '2026-10-15T08:05:00.000Z' }
    await round()
    expect((await copy()).find((r) => r.id === rq(1).id)?.settledAt).toBe('2026-10-15T08:05:00.000Z')
  })

  it('removing most of 60 rows is refused; a few go', async () => {
    leader = Array.from({ length: 60 }, (_, i) => rq(i))
    await round()
    leader = leader.slice(0, 50)
    expect(await round()).toMatchObject({ action: 'synced', removed: 10 })
    leader = leader.slice(0, 10)
    await expect(round()).rejects.toThrow(/manifest_removes_most_rows/)
    expect((await copy()).length).toBe(50)
  })
})

describe('the host turned the requests copy off', () => {
  it('drops what it kept and keeps an off marker; on again, a full manifest', async () => {
    let choice: Record<string, boolean> = {}
    const host = await startCopyHarness({ id: 'host:requests-off', copies: async () => choice })
    const marker = () => JSON.parse(fs.readFileSync(path.join(WALNUT_HOME, 'cache', 'replica', 'requests.json'), 'utf8')) as Record<string, unknown>
    try {
      await syncCopyKinds([kind], { targets: () => [host.target] })
      expect((await copy()).length).toBe(3)
      choice = { requests: false }
      let from = host.calls.length
      await syncCopyKinds([kind], { targets: () => [host.target] })
      expect(stepsSince(host.calls, from)).toEqual(['purge:requests'])
      expect(fs.existsSync(storeFile())).toBe(false)
      expect(marker()).toMatchObject({ v: 1, off: true })
      choice = {}
      from = host.calls.length
      await syncCopyKinds([kind], { targets: () => [host.target] })
      expect(stepsSince(host.calls, from)[0]).toBe('sync:requests')
      expect((await copy()).length).toBe(3)
      expect(marker().off).toBeUndefined()
    } finally { await host.close() }
  })
})
