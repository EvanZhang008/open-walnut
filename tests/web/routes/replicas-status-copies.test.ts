/**
 * The user's confirm of a removal the half rule refused, for the WP4 copy
 * kinds (docs/plan/walnut-replica-servers-impl.md, section 4 and WP4):
 * POST /api/replicas/confirm-removal's copy-kind branch
 * (src/web/routes/replicas-status.ts), confirmCopyKindRemoval
 * (core/replication/kinds/copy-kind.ts) and the words of the Settings row
 * (web/src/components/settings/sections/replica-removal-status.ts rowNoun).
 *
 * The sessions kind runs for real: the leader round over a host target, the
 * follower route, and this process's sessions.sqlite as the host replica's
 * copy. The status and confirm routes are the leader's, so they are called
 * with the leader's env; the rounds run with the host replica's (the two
 * sides are one process here).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fsp from 'node:fs/promises'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createMockConstants } from '../../helpers/mock-constants.js'
import { startCopyHarness, type CopyHarness } from '../../helpers/copy-kind-harness.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-replicas-status-copies', { CLOUD_MODE: false }))

import { WALNUT_HOME } from '../../../src/constants.js'
import { replicasStatusRouter } from '../../../src/web/routes/replicas-status.js'
import { _resetServerRoleForTesting, isFollower, isHostReplica } from '../../../src/core/server-role.js'
import * as sessionDb from '../../../src/core/session-db.js'
import * as tracker from '../../../src/core/session-tracker.js'
import { COPY_FIRST_ROUND_MS, startCopyKindsSync, syncCopyKinds, type CopyKind } from '../../../src/core/replication/kinds/copy-kind.js'
import { SESSIONS_KIND, projectSession, _resetSessionsCopyForTesting } from '../../../src/core/replication/kinds/sessions.js'
import { _resetReplicaStatusForTesting, peekKindState } from '../../../src/core/replication/replica-status.js'
import { registerReplicaTarget, _resetReplicaTargetsForTesting, type ReplicaTarget } from '../../../src/core/replication/replica-targets.js'
import { replicaRemovalRows, type ReplicasStatusResponse } from '../../../web/src/components/settings/sections/replica-removal-status.js'
import type { SessionRecord } from '../../../src/core/types.js'

const T0 = '2026-10-15T08:00:00.000Z'
const HOST_ENV = { WALNUT_ROLE: 'replica', WALNUT_PLACEMENT: 'host', WALNUT_HOST_SERVER: '1' } as const
const ENV = Object.keys(HOST_ENV) as Array<keyof typeof HOST_ENV>
const TARGET = 'host:devbox'
const saved: Record<string, string | undefined> = {}
let h: CopyHarness
let server: Server | null = null
let port = 0
let leaderRows: SessionRecord[] = []
/** Every sync step the leader sent, as sent. */
let syncs: Array<Record<string, unknown>> = []
let hold: Promise<void> | null = null
let heldRounds = 0

function session(i: number): SessionRecord {
  return {
    claudeSessionId: `sid-marina-${String(i).padStart(5, '0')}`, taskId: `task-${i % 40}`, project: 'Marina', process_status: 'stopped',
    mode: 'default', provider: 'cli', startedAt: T0, lastActiveAt: T0, messageCount: i % 13, cwd: '/home/acme/marina', title: `Session ${i}`,
  } as unknown as SessionRecord
}

const kind: CopyKind<SessionRecord> = { ...SESSIONS_KIND, rows: async () => leaderRows.map(projectSession), watch: () => () => {} }

const sync = () => syncCopyKinds([kind], { targets: () => [h.target] })
const copied = () => sessionDb.sessionIdsInStore().length

/** The leader's routes run with the leader's env (this process is the host replica in between). */
async function asLeader<T>(fn: () => Promise<T>): Promise<T> {
  for (const k of ENV) delete process.env[k]
  _resetServerRoleForTesting()
  try {
    expect(isFollower()).toBe(false)
    return await fn()
  } finally {
    Object.assign(process.env, HOST_ENV)
    _resetServerRoleForTesting()
  }
}

async function api(method: string, p: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  return asLeader(async () => {
    const r = await fetch(`http://127.0.0.1:${port}/api${p}`, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
    return { status: r.status, body: await r.json() as Record<string, unknown> }
  })
}

const status = async (): Promise<ReplicasStatusResponse> => (await api('GET', '/replicas/status')).body as unknown as ReplicasStatusResponse
const sessionsRow = async () => (await status()).targets.find((t) => t.id === TARGET)?.kinds.find((k) => k.kind === 'sessions')
const confirm = (body: Record<string, unknown>) => api('POST', '/replicas/confirm-removal', body)

beforeAll(async () => {
  for (const k of ENV) saved[k] = process.env[k]
  Object.assign(process.env, HOST_ENV)
  _resetServerRoleForTesting()
  h = await startCopyHarness({ id: TARGET })
  // Record each sync as the leader sent it (the harness keeps only its size).
  const post = h.target.post
  h.target.post = async (payload, o) => {
    if (payload.op === 'sync') syncs.push(JSON.parse(JSON.stringify(payload)) as Record<string, unknown>)
    return post(payload, o)
  }
  // A round asks every target whether it is up first: while `hold` is set, it waits there.
  const available = h.target.available
  h.target.available = async () => {
    if (hold) { heldRounds++; await hold }
    return available()
  }
  const { default: express } = await import('express')
  const app = express()
  app.use(express.json())
  app.use('/api', replicasStatusRouter)
  server = await new Promise<Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()))
  await h.close()
  sessionDb.closeDb()
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
  _resetServerRoleForTesting()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

beforeEach(async () => {
  sessionDb.closeDb()
  tracker._resetSessionTrackerForTesting()
  _resetSessionsCopyForTesting()
  _resetReplicaStatusForTesting()
  _resetReplicaTargetsForTesting()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
  sessionDb.getDb()
  // confirmCopyKindRemoval looks the target up where the host server registers it.
  registerReplicaTarget(h.target as ReplicaTarget)
  syncs = []
  hold = null
  heldRounds = 0
  leaderRows = Array.from({ length: 240 }, (_, i) => session(i))
  expect(isHostReplica()).toBe(true)
  expect(await sync()).toMatchObject([{ target: TARGET, kind: 'sessions', action: 'synced', entries: 240 }])
  expect(copied()).toBe(240)
})

/** Three rounds the half rule refuses, the copy kept whole each time. */
async function refuseThreeTimes(): Promise<void> {
  for (let i = 1; i <= 3; i++) {
    expect(await sync()).toMatchObject([{ target: TARGET, kind: 'sessions', action: 'failed', error: 'manifest_removes_most_rows' }])
    expect(copied()).toBe(240)
  }
}

describe('a removal of most sessions, confirmed by the user', () => {
  it('240 cut to 100 is held every round; the confirm goes once, bound to the manifest, and the copy drops to 100', async () => {
    leaderRows = leaderRows.slice(0, 100)
    for (let i = 1; i <= 3; i++) {
      expect(await sync()).toMatchObject([{ kind: 'sessions', action: 'failed', error: 'manifest_removes_most_rows' }])
      expect(copied()).toBe(240)
      expect(await sessionsRow()).toMatchObject({ refusals: i, needsConfirm: i === 3, lastRefusal: { entries: 100, local: 240, removing: 140 } })
      // Nothing to confirm before the third refusal.
      if (i < 3) expect((await confirm({ target: TARGET, kind: 'sessions' })).status).toBe(409)
    }
    expect(syncs.length).toBe(4)
    expect(syncs.every((s) => s.confirm === undefined)).toBe(true)

    // The Settings row names the kind's rows in a sentence and offers the confirm it read.
    const [row] = replicaRemovalRows(await status(), 'host')
    expect(row).toMatchObject({
      id: `${TARGET}/sessions`, state: 'refused', confirm: { target: TARGET, kind: 'sessions', entries: 100, keys: expect.stringMatching(/^[0-9a-f]{12}$/) },
    })
    expect(row.text).toBe('This Mac has 100 sessions now, and the copy there would drop 140 of its 240. Walnut held off in case this Mac lost them. If you removed them on purpose, remove them there too.')

    // The copy scheduler runs as on the Mac; its rounds are held at their first step until released.
    let release = (): void => {}
    hold = new Promise<void>((r) => { release = r })
    const scheduler = await asLeader(async () => startCopyKindsSync([kind], { targets: () => [h.target] }))
    try {
      expect(await confirm(row.confirm!)).toEqual({ status: 200, body: { ok: true } })
      // The confirm itself asks the copy scheduler for a round within its debounce (3 s), well
      // before the scheduler's own first round (15 s): the task path would wake the task scheduler.
      await expect.poll(() => heldRounds, { timeout: COPY_FIRST_ROUND_MS - 5_000, interval: 100 }).toBe(1)
      expect(await sessionsRow()).toMatchObject({ needsConfirm: false, confirmArmed: { entries: 100, keys: row.confirm!.keys } })
      const [armed] = replicaRemovalRows(await status(), 'host')
      expect(armed.state).toBe('armed')
      expect(armed.text).toMatch(/^Confirmed: the next copy keeps only this Mac's 100 sessions there\./)

      const from = syncs.length
      hold = null
      release()
      await expect.poll(() => peekKindState(TARGET, 'sessions')?.action === 'synced' && copied() === 100, { timeout: 15_000, interval: 100 }).toBe(true)
      expect(syncs.slice(from).map((s) => [s.confirm, s.confirmFor])).toEqual([[true, { entries: 100, keys: row.confirm!.keys }]])
      expect(peekKindState(TARGET, 'sessions')).toMatchObject({ entries: 100, removed: 140 })
    } finally {
      hold = null
      release()
      scheduler.stop()
    }
    expect((await tracker.listSessions()).map((s) => s.claudeSessionId).sort()).toEqual(leaderRows.map((s) => s.claudeSessionId).sort())
    expect(await sessionsRow()).toMatchObject({ refusals: 0, needsConfirm: false })
    expect(await sessionsRow()).not.toHaveProperty('confirmArmed')
    expect(replicaRemovalRows(await status(), 'host')).toEqual([])

    // The confirm went once: the next round carries none.
    const next = syncs.length
    expect((await sync())[0].action).toBe('unchanged')
    expect(syncs.slice(next).some((s) => s.confirm !== undefined)).toBe(false)
  })

  it('a confirm for a manifest that changed is refused 409, and an armed one never rides a changed manifest', async () => {
    leaderRows = leaderRows.slice(0, 100)
    await refuseThreeTimes()
    const seen = (await sessionsRow())!.lastRefusal as { entries: number; keys: string }

    // The Mac's rows moved after the user read the row: a new streak, and what they read confirms nothing.
    leaderRows = leaderRows.slice(0, 99)
    await sync()
    expect(await sessionsRow()).toMatchObject({ refusals: 1, needsConfirm: false, lastRefusal: { entries: 99 } })
    expect(await confirm({ target: TARGET, kind: 'sessions', entries: seen.entries, keys: seen.keys })).toEqual({ status: 409, body: { ok: false, error: 'not_refused' } })

    // The same count again with another key set: three refusals of it, and the old keys still confirm nothing.
    leaderRows = [...leaderRows, session(500)]
    await refuseThreeTimes()
    const now = (await sessionsRow())!.lastRefusal as { entries: number; keys: string }
    expect(now.entries).toBe(100)
    expect(now.keys).not.toBe(seen.keys)
    expect((await confirm({ target: TARGET, kind: 'sessions', entries: 100, keys: seen.keys })).status).toBe(409)

    // Confirmed for the rows the user read now, then the Mac's rows change before the round:
    // the round drops the confirm, the half rule refuses again, and the copy keeps all 240.
    expect((await confirm({ target: TARGET, kind: 'sessions', entries: now.entries, keys: now.keys })).status).toBe(200)
    leaderRows = leaderRows.slice(0, 98)
    const from = syncs.length
    expect(await sync()).toMatchObject([{ kind: 'sessions', action: 'failed', error: 'manifest_removes_most_rows' }])
    expect(syncs.slice(from).map((s) => s.confirm ?? false)).toEqual([false])
    expect(copied()).toBe(240)
    expect(await sessionsRow()).not.toHaveProperty('confirmArmed')
  })

  it('a confirm for a host target nobody registered, or a kind it never ran, is 409', async () => {
    expect((await confirm({ target: 'host:nowhere', kind: 'sessions' })).status).toBe(409)
    expect((await confirm({ target: TARGET, kind: 'inbox-bodies' })).status).toBe(409)
    // A copy kind on the companion: the copy kinds go to host targets only.
    expect((await confirm({ target: 'companion', kind: 'sessions' })).status).toBe(409)
  })
})
