/**
 * The leader's rows a start carried, taken into a host replica's store (replication/kinds/sessions.ts
 * applyLeaderSessionRows; session-channel/start-task-rows.ts): as a copy round's put takes them, this
 * host's own rows taking only their leader fields, and never over what a copy round brought after the
 * leader read them; each taken row's hash noted, so the next manifest brings a row the leader changed
 * since. Real pieces: the host replica's store, the tracker and the sessions follower's own steps.
 * (The sessions kind has no journal-held rows: replica/journal-overlay.ts holds tasks and boards
 * only, and the call that asks is the round's own.)
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fsp from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-apply-leader-rows', { CLOUD_MODE: false }))

import { WALNUT_HOME } from '../../../src/constants.js'
import { _resetServerRoleForTesting } from '../../../src/core/server-role.js'
import * as sessionDb from '../../../src/core/session-db.js'
import * as tracker from '../../../src/core/session-tracker.js'
import {
  _resetSessionsCopyForTesting, applyLeaderSessionRows, projectSession, sessionCopyHash, sessionsFollower,
} from '../../../src/core/replication/kinds/sessions.js'
import type { SessionRecord } from '../../../src/core/types.js'

const KEY = 'devbox'
const OWN = 'bbbbbbbb-0001-4001-8001-000000000001'
const MAC = 'bbbbbbbb-0002-4002-8002-000000000002'

const row = (sid: string, extra: Partial<SessionRecord> = {}): SessionRecord => ({
  claudeSessionId: sid, taskId: 'task-1', project: 'Acme', process_status: 'idle', mode: 'default',
  startedAt: '2026-11-25T00:00:00.000Z', lastActiveAt: '2026-11-25T00:00:00.000Z', messageCount: 2, ...extra,
} as SessionRecord)
const switched = { archived: true, archive_reason: 'engine_switched:antigravity' }

/** A copy round of the sessions kind: its manifest at `asOf` (every row the host holds, by the leader's hash), then its put. */
async function round(asOf: number, rows: SessionRecord[]): Promise<void> {
  const f = sessionsFollower()
  const byId = new Map(sessionDb.sessionIdsInStore().map((id) => [id, null as SessionRecord | null]))
  for (const r of rows) byId.set(r.claudeSessionId, r)
  const entries = [...byId].map(([k, r]) => ({ k, h: r ? sessionCopyHash(projectSession(r)) : '000000000000' }))
  const s = await f.sync({ schemaVersion: 1, entries, keep: [...byId.keys()].filter((k) => !byId.get(k)), leftOut: [], asOf })
  expect(s.ok, JSON.stringify(s)).toBe(true)
  const p = await f.put({ schemaVersion: 1, rows, last: true })
  expect(p.ok, JSON.stringify(p)).toBe(true)
}

/** What the next manifest asks for when the leader's row of `sid` is `leader`. */
async function needs(sid: string, leader: SessionRecord): Promise<boolean> {
  const entries = sessionDb.sessionIdsInStore().map((k) => ({ k, h: k === sid ? sessionCopyHash(projectSession(leader)) : '000000000000' }))
  const s = await sessionsFollower().sync({ schemaVersion: 1, entries, keep: entries.map((e) => e.k).filter((k) => k !== sid), leftOut: [], asOf: Date.now() }) as { need?: string[] }
  return (s.need ?? []).includes(sid)
}

const stored = async (sid: string) => tracker.getSessionByClaudeId(sid)

beforeAll(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
  for (const k of ['WALNUT_ROLE', 'WALNUT_PLACEMENT', 'WALNUT_HOST_SERVER', 'WALNUT_WALNUT_ID']) delete process.env[k]
  _resetServerRoleForTesting()
  sessionDb.applySessionCopy({ rows: [] })
  sessionDb.closeDb()
  tracker._resetSessionTrackerForTesting()
  process.env.WALNUT_ROLE = 'replica'
  process.env.WALNUT_HOST_KEY = KEY
  _resetServerRoleForTesting()
  sessionDb.allowOwnRowWrites(KEY)
})

afterAll(async () => {
  sessionDb.allowOwnRowWrites(null)
  sessionDb.closeDb()
  tracker._resetSessionTrackerForTesting()
  for (const k of ['WALNUT_ROLE', 'WALNUT_HOST_KEY']) delete process.env[k]
  _resetServerRoleForTesting()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

beforeEach(() => { _resetSessionsCopyForTesting() })

describe('applyLeaderSessionRows', () => {
  it('this host\'s own row takes only the leader\'s fields; a row of the Mac\'s is taken whole', async () => {
    sessionDb.claimStartingRow(OWN, row(OWN, { host: KEY, judge: 'host' }))
    await tracker.updateSessionRecord(OWN, { process_status: 'running' })
    sessionDb.applySessionCopy({ ownHost: KEY, rows: [row(MAC)] })
    const n = await applyLeaderSessionRows([
      row(OWN, { host: KEY, judge: 'host', process_status: 'stopped', ...switched }),
      row(MAC, { process_status: 'stopped', ...switched }),
    ], Date.now())
    expect(n).toBe(2)
    expect(await stored(OWN)).toMatchObject({ judge: 'host', process_status: 'running', ...switched })
    expect(await stored(MAC)).toMatchObject({ process_status: 'stopped', ...switched })
  })

  it('a round that brought the row after the leader read it wins; a carried row read after the round is taken', async () => {
    const sid = 'bbbbbbbb-0003-4003-8003-000000000003'
    const t0 = Date.now()
    // The round's manifest at t1 (after the start's read at t0) brought the row archived.
    await round(t0 + 1_000, [row(sid, switched)])
    expect(await applyLeaderSessionRows([row(sid)], t0)).toBe(0)
    expect(await stored(sid)).toMatchObject(switched)
    // A start read after that round: its row is the newer one.
    const later = row(sid, { archived: true, archive_reason: 'engine_switched:codex' })
    expect(await applyLeaderSessionRows([later], t0 + 2_000)).toBe(1)
    expect(await stored(sid)).toMatchObject({ archive_reason: 'engine_switched:codex' })
  })

  it('a taken row\'s hash is noted: the next manifest brings it only when the leader\'s row changed since', async () => {
    const sid = 'bbbbbbbb-0004-4004-8004-000000000004'
    const carried = row(sid, switched)
    expect(await applyLeaderSessionRows([carried], Date.now())).toBe(1)
    expect(await needs(sid, carried)).toBe(false)
    expect(await needs(sid, row(sid))).toBe(true)
  })

  // Round 2 review: a round whose manifest the leader built before the start read its rows put an
  // older copy over the carried row (the archive gone again before the start's claim).
  it.each([
    ['while it runs', false],
    ['across a host restart', true],
  ])('a round built before the carry never writes its older copy over the carried row (%s)', async (_label, restart) => {
    const sid = restart ? 'bbbbbbbb-0006-4006-8006-000000000006' : 'bbbbbbbb-0007-4007-8007-000000000007'
    const t0 = Date.now()
    const f = sessionsFollower()
    const before = row(sid)
    // The round's manifest at t0 asks for the row; its put comes after the start's carry at t0 + 1 s.
    const m = await f.sync({ schemaVersion: 1, entries: [{ k: sid, h: sessionCopyHash(projectSession(before)) }], keep: sessionDb.sessionIdsInStore(), leftOut: [], asOf: t0 }) as { need?: string[] }
    expect(m.need).toContain(sid)
    expect(await applyLeaderSessionRows([row(sid, switched)], t0 + 1_000)).toBe(1)
    if (restart) _resetSessionsCopyForTesting() // memory gone: the state file (hashes, carried) is not
    const p = await sessionsFollower().put({ schemaVersion: 1, rows: [before], last: true }) as { stored?: number; held?: number }
    expect(p).toMatchObject({ stored: 0, held: 1 })
    expect(await stored(sid)).toMatchObject(switched)
    // A carry no newer than it, after the restart too, is not taken over it either.
    expect(await applyLeaderSessionRows([before], t0 + 500)).toBe(0)
    // The next round (built after the carry) brings the leader's row and is taken.
    const now = row(sid, { ...switched, title: 'later' } as Partial<SessionRecord>)
    await round(t0 + 2_000, [now])
    expect(await stored(sid)).toMatchObject({ ...switched, title: 'later' })
  })

  it('a host replica with no host key of its own takes none', async () => {
    const was = process.env.WALNUT_HOST_KEY
    delete process.env.WALNUT_HOST_KEY
    try {
      expect(await applyLeaderSessionRows([row('bbbbbbbb-0005-4005-8005-000000000005')], Date.now())).toBe(0)
    } finally { process.env.WALNUT_HOST_KEY = was }
  })
})
