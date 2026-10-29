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
import { MAX_REQUESTS, prunedByLeader, requestsWindowOf } from '../../../../src/core/session-request-retention.js'

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

describe('a request store the Mac fails to read', () => {
  it('is not an empty store: the round skips the kind and sends nothing', async () => {
    const real: CopyKind<SessionRequest> = { ...REQUESTS_KIND, watch: () => () => {} }
    // No file yet: no requests.
    expect(await real.rows()).toEqual([])
    // A file that does not open (a link to itself: ELOOP, as root too), standing in for EACCES or EMFILE.
    await fsp.symlink('session-requests.json', storeFile())
    await expect(real.rows()).rejects.toThrow(/ELOOP/)
    expect(await syncCopyKinds([real], { targets: () => [h.target] })).toEqual([])
    expect(h.calls).toEqual([])
  })
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

// 2026-10-26 to 10-28: clouddev's server was down for a day and a half while the Mac kept
// writing requests at its cap. Back up, its copy held 413 settled rows from 10-17..10-24, the
// Mac's manifest named 501 rows from the last 2.5 days and none of those, and every round (about
// 340 a day) was refused: 413 of 413 removed. The Mac's window moved every few minutes, so the
// Settings confirm (3 refusals of the same key set) never came up either.
describe('a copy that missed rounds while the Mac pruned past it', () => {
  const DAY = 86_400_000
  const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString()
  /** `n` rows from `fromAgo` back to `toAgo`, settled (replied) unless `pending`. */
  function span(prefix: string, n: number, fromAgo: number, toAgo: number, pending = 0): SessionRequest[] {
    return Array.from({ length: n }, (_, i) => {
      const at = iso(fromAgo - ((fromAgo - toAgo) * i) / Math.max(1, n - 1))
      const open = i >= n - pending
      return rq(i, { id: `rq-${prefix}-${String(i).padStart(6, '0')}`, createdAt: at, ...(open ? {} : { status: 'replied' as const, settledAt: at }) })
    })
  }

  it('catches up: every row it removes is one the Mac pruned by its cap', async () => {
    // The copy took the Mac's 413 rows (4 to 11 days old, 4 still pending) when it last ran.
    leader = span('old', 413, 11 * DAY, 4 * DAY, 4)
    expect(await round()).toMatchObject({ action: 'synced', sent: 413 })
    // The Mac now holds 501 rows from the last 2.5 days (10 pending): the cap pushed the rest out.
    leader = span('new', 501, 2.5 * DAY, 0, 10)
    expect(requestsWindowOf(leader)).toEqual({ from: Date.parse(leader[0].createdAt) })
    expect(await round()).toMatchObject({ action: 'synced', entries: 501, sent: 501, removed: 413 })
    const ids = new Set((await copy()).map((r) => r.id))
    expect(ids.size).toBe(501)
    expect([...ids].every((id) => id.startsWith('rq-new-'))).toBe(true)
    forgetKindManifests(['requests'])
    const from = h.calls.length
    await round()
    expect(stepsSince(h.calls, from)).toEqual(['sync:requests']) // converged
  })

  it('still refuses a leader that lost its store: recent rows it no longer names count', async () => {
    leader = span('old', 120, 3 * DAY, 0)
    await round()
    // A store that opened nearly empty: 10 rows, under the cap, so no window.
    leader = span('fresh', 10, 60_000, 0)
    await expect(round()).rejects.toThrow(/manifest_removes_most_rows/)
    expect((await copy()).length).toBe(120)
  })

  it('still refuses a store lost after a quiet week: rows explained by age never lift the brake', async () => {
    // The Mac wrote no request for a week (prune runs on write), so both sides hold 100 settled
    // rows 8 to 12 days old, plus 20 recent ones, 5 of them pending.
    leader = [...span('quiet', 100, 12 * DAY, 8 * DAY), ...span('recent', 20, DAY, 0, 5)]
    await round()
    // The Mac's store is lost: an empty manifest, no window. The 100 are past the retention,
    // but the 20 recent rows (pending ones included) must not go with them.
    leader = []
    await expect(round()).rejects.toThrow(/manifest_removes_most_rows/)
    expect((await copy()).length).toBe(120)
  })

  it('still refuses a full leader missing rows newer than its window', async () => {
    // The copy holds 120 settled rows from the last 2 days.
    leader = span('mid', 120, 2 * DAY, 1 * DAY)
    await round()
    // A leader at its cap whose oldest settled row is 3 days old, yet names none of them:
    // those rows are inside its window, so their loss is not its cap's doing.
    leader = span('full', 500, 3 * DAY, 0)
    await expect(round()).rejects.toThrow(/manifest_removes_most_rows/)
    expect((await copy()).length).toBe(120)
  })
})

describe('prunedByLeader', () => {
  const now = Date.parse('2026-10-29T06:00:00.000Z')
  const at = (iso: string) => ({ status: 'replied', createdAt: iso, settledAt: iso })
  const window = { from: Date.parse('2026-10-26T19:35:00.000Z') }

  it('explains a settled row past the 7-day retention, on this side\'s clock', () => {
    expect(prunedByLeader(at('2026-10-21T00:00:00.000Z'), { now, window: null, entries: 3 })).toBe(true)
    expect(prunedByLeader(at('2026-10-23T00:00:00.000Z'), { now, window: null, entries: 3 })).toBe(false)
    // A leader clock a week ahead does not age rows here.
    expect(prunedByLeader(at('2026-10-23T00:00:00.000Z'), { now, asOf: now + 7 * 86_400_000, window: null, entries: 3 })).toBe(false)
  })

  it('explains a settled row older than a full window only', () => {
    const row = at('2026-10-24T10:00:00.000Z')
    expect(prunedByLeader(row, { now, window, entries: MAX_REQUESTS + 1 })).toBe(true)
    expect(prunedByLeader(row, { now, window, entries: MAX_REQUESTS - 1 })).toBe(false)
    expect(prunedByLeader(at('2026-10-27T00:00:00.000Z'), { now, window, entries: MAX_REQUESTS })).toBe(false)
  })

  it('explains a pending row only by a full window, never by age', () => {
    const pending = { status: 'pending', createdAt: '2026-10-01T00:00:00.000Z' }
    expect(prunedByLeader(pending, { now, window: null, entries: 3 })).toBe(false)
    expect(prunedByLeader(pending, { now, window, entries: MAX_REQUESTS - 1 })).toBe(false)
    // Gone from a full store older than its window: settled there (a settle this copy missed) and evicted.
    expect(prunedByLeader(pending, { now, window, entries: MAX_REQUESTS })).toBe(true)
    expect(prunedByLeader({ status: 'pending', createdAt: '2026-10-27T00:00:00.000Z' }, { now, window, entries: MAX_REQUESTS })).toBe(false)
  })

  it('takes the window from where the cap stopped evicting, in store order', () => {
    const rows = Array.from({ length: MAX_REQUESTS }, (_, i) => at(new Date(Date.parse('2026-10-26T19:35:00.000Z') + i * 60_000).toISOString()))
    // A row a host's journal appended late, with an early createdAt, does not pull the window back.
    rows.push(at('2026-10-20T00:00:00.000Z'))
    expect(requestsWindowOf(rows)).toEqual({ from: Date.parse('2026-10-26T19:35:00.000Z') })
    expect(requestsWindowOf(rows.slice(0, MAX_REQUESTS - 1))).toBeUndefined()
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
