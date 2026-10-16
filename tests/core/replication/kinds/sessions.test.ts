/**
 * The `sessions` copy kind (docs/plan/walnut-replica-servers-impl.md, section 4
 * and WP4): the projection strips every process field, the hash ignores the
 * volatile ones, a digest ends an unchanged round, a changed row goes as one
 * put without a manifest, removals take the manifest and its half rule. The
 * follower is the real route and the real store: this process runs as a host
 * replica, its sessions.sqlite is the replica's own, read only but for the
 * apply connection. The leader side is the real round over a fixture of rows.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../../helpers/mock-constants.js'
import { startCopyHarness, stepsSince, type CopyHarness } from '../../../helpers/copy-kind-harness.js'

vi.mock('../../../../src/constants.js', () => createMockConstants('walnut-copy-sessions', { CLOUD_MODE: false }))

import { WALNUT_HOME } from '../../../../src/constants.js'
import { _resetServerRoleForTesting, isHostReplica } from '../../../../src/core/server-role.js'
import * as sessionDb from '../../../../src/core/session-db.js'
import * as tracker from '../../../../src/core/session-tracker.js'
import { runCopyRound, syncCopyKinds, type CopyKind } from '../../../../src/core/replication/kinds/copy-kind.js'
import {
  PROCESS_FIELDS, SESSIONS_KIND, VOLATILE_SESSION_FIELDS, projectSession, sessionCopyHash, _resetSessionsCopyForTesting,
} from '../../../../src/core/replication/kinds/sessions.js'
import { buildKindManifest } from '../../../../src/core/replication/kind-leader.js'
import { _resetReplicaStatusForTesting, forgetKindManifests, peekKindState } from '../../../../src/core/replication/replica-status.js'
import type { SessionRecord } from '../../../../src/core/types.js'

const T0 = '2026-10-15T08:00:00.000Z'
const ENV = ['WALNUT_ROLE', 'WALNUT_PLACEMENT', 'WALNUT_HOST_SERVER'] as const
const saved: Record<string, string | undefined> = {}
let h: CopyHarness
let leaderRows: SessionRecord[] = []

function session(i: number, over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    claudeSessionId: `sid-marina-${String(i).padStart(5, '0')}`, taskId: `task-${i % 40}`, project: 'Marina', process_status: i % 7 === 0 ? 'running' : 'stopped',
    mode: 'default', provider: 'cli', startedAt: T0, lastActiveAt: T0, messageCount: i % 13, cwd: '/home/acme/marina', host: i % 3 === 0 ? 'devbox' : undefined,
    title: `Session ${i}`, model: 'opus', status_history: [{ from: 'running', to: 'stopped', at: T0 }],
    pid: 40_000 + i, outputFile: `/tmp/streams/s-${i}.jsonl`, consumedOffset: 1234, streamEpoch: 'e1', costWatermarkPid: 40_000 + i,
    ...over,
  } as unknown as SessionRecord
}

const kind: CopyKind<SessionRecord> = { ...SESSIONS_KIND, rows: async () => leaderRows.map(projectSession), watch: () => () => {} }

async function round(): Promise<ReturnType<typeof runCopyRound>> {
  const manifest = await buildKindManifest(kind, [...await kind.rows()])
  return runCopyRound(kind, manifest, h.target, { asOf: Date.now() })
}

function rawRow(id: string): Record<string, unknown> | undefined {
  const db = new Database(sessionDb.SESSION_DB_PATH, { readonly: true })
  try { return db.prepare('SELECT * FROM sessions WHERE claude_session_id = ?').get(id) as Record<string, unknown> | undefined } finally { db.close() }
}

async function resetFollower(): Promise<void> {
  sessionDb.closeDb()
  tracker._resetSessionTrackerForTesting()
  _resetSessionsCopyForTesting()
  _resetReplicaStatusForTesting()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
  // The follower's store exists before a step (the replica opens it at boot).
  sessionDb.getDb()
}

beforeAll(async () => {
  for (const k of ENV) saved[k] = process.env[k]
  Object.assign(process.env, { WALNUT_ROLE: 'replica', WALNUT_PLACEMENT: 'host', WALNUT_HOST_SERVER: '1' })
  _resetServerRoleForTesting()
  h = await startCopyHarness()
})

afterAll(async () => {
  await h.close()
  sessionDb.closeDb()
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
  _resetServerRoleForTesting()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

beforeEach(async () => {
  await resetFollower()
  h.calls.length = 0
  leaderRows = Array.from({ length: 12 }, (_, i) => session(i))
})

describe('projection and hash', () => {
  it('strips every process field and keeps the rest, process_status as a label', () => {
    const full = session(1, { process_status: 'running', pendingPermission: { requestId: 'r1', receivedAt: T0 } } as Partial<SessionRecord>)
    const extra = {
      ...full, workerPid: 7, helper_pid: 8, pgid: 9, sessionPgid: 10, sideOutputFile: '/x', acpRuntimeId: 'acp-1', stopRequest: { id: 's', requestedAt: T0, state: 'pending' },
      profile: { systemPrompt: 'persona', mcpServers: { walnut: { command: 'node', env: { API_TOKEN: 'never-copied' } } } },
    }
    for (const f of PROCESS_FIELDS) if (!(f in extra)) (extra as Record<string, unknown>)[f] = 1
    const p = projectSession(extra as unknown as SessionRecord) as unknown as Record<string, unknown>
    for (const f of [...PROCESS_FIELDS, 'workerPid', 'helper_pid', 'pgid', 'sessionPgid', 'sideOutputFile', 'profile']) expect(p, f).not.toHaveProperty(f)
    expect(JSON.stringify(p)).not.toContain('never-copied')
    expect(p.process_status).toBe('running')
    expect(p.title).toBe('Session 1')
    expect(p.pendingPermission).toEqual({ requestId: 'r1', receivedAt: T0 })
    expect(p.status_history).toEqual([{ from: 'running', to: 'stopped', at: T0 }])
    // Idempotent: projecting a projection changes nothing.
    expect(projectSession(p as unknown as SessionRecord)).toEqual(p)
  })

  it('leaves the volatile fields out of the hash, and nothing else', () => {
    const base = projectSession(session(2))
    for (const f of VOLATILE_SESSION_FIELDS) {
      expect(sessionCopyHash({ ...base, [f]: f === 'contextTokens' ? 99_000 : '2026-10-15T09:59:00.000Z' } as SessionRecord), f).toBe(sessionCopyHash(base))
    }
    expect(sessionCopyHash({ ...base, title: 'Renamed' })).not.toBe(sessionCopyHash(base))
    expect(sessionCopyHash({ ...base, process_status: 'idle' })).not.toBe(sessionCopyHash(base))
    // The follower hashes what it received (JSON) and gets the leader's hash.
    expect(sessionCopyHash(JSON.parse(JSON.stringify(base)))).toBe(sessionCopyHash(base))
    // A process field never moves the hash (the follower projects again before it stores).
    expect(sessionCopyHash({ ...base, pid: 1 } as SessionRecord)).toBe(sessionCopyHash(base))
  })
})

describe('a host replica keeps the sessions copy', () => {
  it('stores the first round in its own sessions.sqlite, with no pid or output file', async () => {
    expect(isHostReplica()).toBe(true)
    const r = await round()
    expect(r).toMatchObject({ kind: 'sessions', action: 'synced', entries: 12, sent: 12, held: 0 })
    expect(stepsSince(h.calls)).toEqual(['status:sessions', 'sync:sessions', 'put:sessions:12'])
    const raw = rawRow('sid-marina-00001')!
    expect(raw.pid).toBeNull()
    expect(raw.output_file).toBeNull()
    expect(String(raw.payload ?? '')).not.toMatch(/consumedOffset|streamEpoch|costWatermarkPid/)
    const listed = await tracker.listSessions()
    expect(listed.map((s) => s.claudeSessionId).sort()).toEqual(leaderRows.map((s) => s.claudeSessionId).sort())
    expect(listed.every((s) => s.pid === undefined && s.outputFile === undefined)).toBe(true)
    expect((await tracker.getSessionByClaudeId('sid-marina-00007'))?.process_status).toBe('running')
    // The shared handle reads only; the copy's one writer is the apply connection.
    expect(sessionDb.getDb()!.pragma('query_only', { simple: true })).toBe(1)
    expect(() => sessionDb.getDb()!.prepare("UPDATE sessions SET title = 'x'").run()).toThrow(/readonly/)
  })

  it('a digest ends an unchanged round: the sweep sends one status step, no manifest', async () => {
    await round()
    const from = h.calls.length
    expect((await round()).action).toBe('unchanged')
    expect(h.calls.length).toBe(from) // same manifest hash: no step at all
    forgetKindManifests(['sessions'])
    expect((await round()).action).toBe('unchanged')
    expect(stepsSince(h.calls, from)).toEqual(['status:sessions'])
  })

  it('a volatile change sends nothing; a turn ending sends one row, without a manifest', async () => {
    await round()
    leaderRows[3] = { ...leaderRows[3], lastActiveAt: '2026-10-15T08:30:00.000Z', activity: 'Running tests' } as SessionRecord
    let from = h.calls.length
    expect((await round()).action).toBe('unchanged')
    expect(h.calls.length).toBe(from)
    leaderRows[4] = { ...leaderRows[4], process_status: 'idle', messageCount: 99 } as SessionRecord
    from = h.calls.length
    expect(await round()).toMatchObject({ action: 'synced', sent: 1 })
    expect(stepsSince(h.calls, from)).toEqual(['put:sessions:1+digest'])
    expect((await tracker.getSessionByClaudeId('sid-marina-00004'))).toMatchObject({ process_status: 'idle', messageCount: 99 })
  })

  it('a removal takes the manifest, and the half rule refuses removing most rows past 200', async () => {
    await round()
    leaderRows = leaderRows.slice(1)
    let from = h.calls.length
    expect(await round()).toMatchObject({ action: 'synced', removed: 1 })
    expect(stepsSince(h.calls, from)).toEqual(['sync:sessions'])
    expect(await tracker.getSessionByClaudeId('sid-marina-00000')).toBeNull()
    leaderRows = Array.from({ length: 240 }, (_, i) => session(i))
    await round()
    leaderRows = leaderRows.slice(0, 100)
    from = h.calls.length
    await expect(round()).rejects.toThrow(/manifest_removes_most_rows/)
    expect((await tracker.listSessions()).length).toBe(240)
    expect(peekKindState('host:devbox', 'sessions')?.lastRefusal).toMatchObject({ local: 240, removing: 140, entries: 100 })
  })

  it('a leader that restarted asks nothing again: one status step', async () => {
    await round()
    _resetReplicaStatusForTesting() // the leader's per-target state is gone, the follower's copy is not
    const from = h.calls.length
    expect((await round()).action).toBe('unchanged')
    expect(stepsSince(h.calls, from)).toEqual(['status:sessions'])
  })

  it('a lost delta put falls back to the manifest round, which brings the row', async () => {
    await round()
    leaderRows[5] = { ...leaderRows[5], title: 'Release notes' } as SessionRecord
    h.failNext(1)
    const from = h.calls.length
    expect(await round()).toMatchObject({ action: 'synced', sent: 1 })
    expect(stepsSince(h.calls, from)).toEqual(['put:sessions:1+digest', 'sync:sessions', 'put:sessions:1'])
    expect((await tracker.getSessionByClaudeId('sid-marina-00005'))?.title).toBe('Release notes')
  })

  it('keeps its state at 0600 in a 0700 dir, and the per-host choice turns the kind off', async () => {
    await round()
    const file = path.join(WALNUT_HOME, 'cache', 'replica', 'sessions.json')
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700)
    const off = await startCopyHarness({ id: 'host:quiet', copies: async () => ({ sessions: false }) })
    try {
      // Off for this host: no manifest, no row; one purge step (what it holds of the kind goes), then nothing.
      const results = await syncCopyKinds([kind], { targets: () => [off.target] })
      expect(results).toMatchObject([{ target: 'host:quiet', kind: 'sessions', action: 'unsupported', error: 'kind_not_copied' }])
      expect(stepsSince(off.calls)).toEqual(['purge:sessions'])
      await syncCopyKinds([kind], { targets: () => [off.target] })
      expect(stepsSince(off.calls)).toEqual(['purge:sessions'])
    } finally { await off.close() }
  })
})

describe('off a host replica', () => {
  it('the leader answers 404 unknown_kind, as it did before this kind', async () => {
    const { followerStep } = await import('../../../../src/core/replication/kind-follower.js')
    const { registerCopyFollowerKinds } = await import('../../../../src/core/replication/kinds/index.js')
    registerCopyFollowerKinds()
    for (const k of ENV) delete process.env[k]
    _resetServerRoleForTesting()
    try {
      expect(isHostReplica()).toBe(false)
      expect(await followerStep({ op: 'sync', kind: 'sessions', entries: [], asOf: 1 })).toEqual({ ok: false, status: 404, error: 'unknown_kind' })
      expect(await followerStep({ op: 'status', kind: 'sessions', digest: '0.0' })).toEqual({ ok: false, status: 404, error: 'unknown_kind' })
      expect(await followerStep({ op: 'put', kind: 'sessions', rows: [] })).toEqual({ ok: false, status: 404, error: 'unknown_kind' })
      // Every copy kind, any op, any schema version: the answer of a kind nobody registered.
      for (const kind of ['sessions', 'requests', 'boards', 'inbox', 'inbox-bodies']) {
        for (const body of [{ op: 'status', digest: '0.0' }, { op: 'sync', entries: [], asOf: 1, schemaVersion: 99 }, { op: 'put', rows: [], schemaVersion: 2 }, { op: 'purge' }]) {
          expect([kind, body.op, await followerStep({ ...body, kind })]).toEqual([kind, body.op, { ok: false, status: 404, error: 'unknown_kind' }])
        }
      }
    } finally {
      Object.assign(process.env, { WALNUT_ROLE: 'replica', WALNUT_PLACEMENT: 'host', WALNUT_HOST_SERVER: '1' })
      _resetServerRoleForTesting()
    }
  })

  it('the plain host server (WALNUT_HOST_SERVER=1 alone, the default program and the fallback) keeps no copy either', async () => {
    const { followerStep } = await import('../../../../src/core/replication/kind-follower.js')
    const { registerCopyFollowerKinds } = await import('../../../../src/core/replication/kinds/index.js')
    const { isHostReplicaProgram } = await import('../../../../src/core/server-role.js')
    registerCopyFollowerKinds()
    // Exactly the env core/host-server/manager.ts gives the host-server program.
    delete process.env.WALNUT_ROLE
    delete process.env.WALNUT_PLACEMENT
    process.env.WALNUT_HOST_SERVER = '1'
    _resetServerRoleForTesting()
    try {
      expect([isHostReplica(), isHostReplicaProgram()]).toEqual([true, false])
      const letter = { id: 'lt-abc-1234', title: 'x', createdAt: '2026-10-01T00:00:00.000Z' }
      const puts: Record<string, unknown[]> = {
        sessions: [], requests: [], boards: [], inbox: [letter], 'inbox-bodies': [{ name: 'lt-abc-1234.md', body: 'private' }],
      }
      for (const kind of ['sessions', 'requests', 'boards', 'inbox', 'inbox-bodies']) {
        for (const body of [{ op: 'status', digest: '0.0' }, { op: 'sync', entries: [{ k: 'lt-abc-1234', h: 'aaaaaaaaaaaa' }], asOf: 1 }, { op: 'put', rows: puts[kind], last: true }, { op: 'purge' }]) {
          expect([kind, body.op, await followerStep({ ...body, kind, schemaVersion: 1 })]).toEqual([kind, body.op, { ok: false, status: 404, error: 'unknown_kind' }])
        }
      }
      expect(fs.existsSync(path.join(WALNUT_HOME, 'human-inbox', 'index.json'))).toBe(false)
      expect(fs.existsSync(path.join(WALNUT_HOME, 'human-inbox', 'bodies', 'lt-abc-1234.md'))).toBe(false)
    } finally {
      Object.assign(process.env, { WALNUT_ROLE: 'replica', WALNUT_PLACEMENT: 'host', WALNUT_HOST_SERVER: '1' })
      _resetServerRoleForTesting()
    }
  })
})

describe('a replica boot leaves the copy as the Mac sent it', () => {
  const allRows = (): string => {
    const db = new Database(sessionDb.SESSION_DB_PATH, { readonly: true })
    try { return JSON.stringify(db.prepare('SELECT * FROM sessions ORDER BY claude_session_id').all()) } finally { db.close() }
  }
  const stateBytes = (): string => fs.readFileSync(path.join(WALNUT_HOME, 'cache', 'replica', 'sessions.json'), 'utf8')
  const reopen = (): void => {
    sessionDb.closeDb()
    tracker._resetSessionTrackerForTesting()
    sessionDb.getDb()
  }

  it('reopening on a host replica runs no data fix (the leader placement would change the rows)', async () => {
    // A Mac row the open path's backfill would rewrite (no status revision, an empty stamp).
    leaderRows[1] = session(1, { statusRevision: 0, statusUpdatedAt: '' } as Partial<SessionRecord>)
    await round()
    const rows = allRows()
    const state = stateBytes()
    expect([rawRow('sid-marina-00001')?.status_revision, rawRow('sid-marina-00001')?.status_updated_at]).toEqual([0, ''])
    reopen()
    expect(allRows()).toBe(rows)
    expect(stateBytes()).toBe(state)
    expect([rawRow('sid-marina-00001')?.status_revision, rawRow('sid-marina-00001')?.status_updated_at]).toEqual([0, ''])
    // The same file opened by a server that is not a host replica: the backfill runs, so the branch is the reason.
    for (const k of ENV) delete process.env[k]
    _resetServerRoleForTesting()
    try {
      reopen()
      expect(isHostReplica()).toBe(false)
      expect([rawRow('sid-marina-00001')?.status_revision, rawRow('sid-marina-00001')?.status_updated_at]).toEqual([1, T0])
      expect(allRows()).not.toBe(rows)
    } finally {
      Object.assign(process.env, { WALNUT_ROLE: 'replica', WALNUT_PLACEMENT: 'host', WALNUT_HOST_SERVER: '1' })
      _resetServerRoleForTesting()
      reopen()
    }
  })
})

describe('the leader clock of what the copy holds', () => {
  const asOfHeld = (): number => Number((JSON.parse(fs.readFileSync(path.join(WALNUT_HOME, 'cache', 'replica', 'sessions.json'), 'utf8')) as { asOf?: unknown }).asOf)
  const at = async (asOf: number) => runCopyRound(kind, await buildKindManifest(kind, [...await kind.rows()]), h.target, { asOf })

  it('moves with a delta whose digest matched and with an equal status, never back', async () => {
    const t0 = Date.parse('2026-10-15T09:00:00.000Z')
    await at(t0)
    expect(asOfHeld()).toBe(t0)
    leaderRows[2] = { ...leaderRows[2], title: 'Turn ended' } as SessionRecord
    let from = h.calls.length
    expect(await at(t0 + 60_000)).toMatchObject({ action: 'synced', sent: 1 })
    expect(stepsSince(h.calls, from)).toEqual(['put:sessions:1+digest'])
    expect(asOfHeld()).toBe(t0 + 60_000)
    forgetKindManifests(['sessions'])
    from = h.calls.length
    expect((await at(t0 + 120_000)).action).toBe('unchanged')
    expect(stepsSince(h.calls, from)).toEqual(['status:sessions'])
    expect(asOfHeld()).toBe(t0 + 120_000)
    forgetKindManifests(['sessions'])
    await at(t0 + 30_000) // an older clock moves nothing
    expect(asOfHeld()).toBe(t0 + 120_000)
  })
})

describe('the host turned the sessions copy off', () => {
  it('drops every copied row and keeps an off marker; on again, a full manifest brings them back', async () => {
    let choice: Record<string, boolean> = {}
    const host = await startCopyHarness({ id: 'host:sessions-off', copies: async () => choice })
    const marker = () => JSON.parse(fs.readFileSync(path.join(WALNUT_HOME, 'cache', 'replica', 'sessions.json'), 'utf8')) as Record<string, unknown>
    try {
      await syncCopyKinds([kind], { targets: () => [host.target] })
      expect((await tracker.listSessions()).length).toBe(12)
      choice = { sessions: false }
      let from = host.calls.length
      const off = await syncCopyKinds([kind], { targets: () => [host.target] })
      expect(stepsSince(host.calls, from)).toEqual(['purge:sessions'])
      expect(off[0]).toMatchObject({ kind: 'sessions', action: 'unsupported', error: 'kind_not_copied', removed: 12 })
      expect(sessionDb.sessionIdsInStore()).toEqual([])
      expect(marker()).toMatchObject({ v: 1, off: true })
      choice = {}
      from = host.calls.length
      await syncCopyKinds([kind], { targets: () => [host.target] })
      expect(stepsSince(host.calls, from)).toEqual(['sync:sessions', 'put:sessions:12'])
      expect(sessionDb.sessionIdsInStore().length).toBe(12)
      expect(marker().off).toBeUndefined()
    } finally { await host.close() }
  })
})
