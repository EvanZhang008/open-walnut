/**
 * A copied session row can never reach a process on a host replica
 * (docs/plan/walnut-replica-servers-impl.md, WP4 acceptance). The replica's
 * sessions.sqlite is a copy of the Mac's: every pid in it names a process the
 * Mac's daemon owns. The copy strips process fields (kinds/sessions.ts), and
 * every process action refuses on a host replica (sessions/replica-process-guard.ts):
 * no signal, no probe, no stop asked of a daemon, no reap, no capacity eviction.
 *
 * The rows here name the pid of a REAL child this test spawned (`sleep`), so a
 * regression would hit a live process; the test checks it is still alive.
 * The "daemon" is a fake connection that accepts everything and records sends.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import fsp from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-replica-guard', { CLOUD_MODE: false }))
// The real stop funnel, watched: capacity eviction reaches it through a dynamic import.
vi.mock('../../../src/core/sessions/owner-stop.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/core/sessions/owner-stop.js')>()
  return { ...real, stopThroughOwner: vi.fn(real.stopThroughOwner) }
})

import { WALNUT_HOME } from '../../../src/constants.js'
import { log } from '../../../src/logging/index.js'
import { _resetServerRoleForTesting, isHostReplica } from '../../../src/core/server-role.js'
import { ORPHAN_STOP_CAPABILITY, stopAcpThroughOwner, stopThroughOwner, sweepOrphansThroughOwner, type OwnerConnection } from '../../../src/core/sessions/owner-stop.js'
import { OWNER_HOME_CAPABILITY } from '../../../src/core/sessions/stop-provenance.js'
import type { SessionRecord } from '../../../src/core/types.js'

const ENV_KEYS = ['WALNUT_ROLE', 'WALNUT_PLACEMENT', 'WALNUT_HOST_SERVER'] as const
const saved: Record<string, string | undefined> = {}
let child: ChildProcess | null = null
let pid = 0
const HOUR_AGO = new Date(Date.now() - 60 * 60_000).toISOString()

function copiedRow(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    claudeSessionId: 'sid-marina-copied-1', taskId: 'task-marina-1', project: 'Marina', process_status: 'stopped', mode: 'default',
    startedAt: HOUR_AGO, lastActiveAt: HOUR_AGO, last_status_change: HOUR_AGO, messageCount: 3,
    status_reason: 'idle_timeout', status_changed_by: 'health-monitor', provider: 'cli', pid, outputFile: '/tmp/never-read.jsonl', ...over,
  } as SessionRecord
}

function acceptingConn(): OwnerConnection & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    connected: true,
    hasCapability: (cap) => cap === ORPHAN_STOP_CAPABILITY || cap === OWNER_HOME_CAPABILITY,
    send: async (command) => { calls.push(command); return { ok: true, stopped: true } },
  }
}

function alive(p: number): boolean {
  try { process.kill(p, 0); return true } catch { return false }
}

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k]
  Object.assign(process.env, { WALNUT_ROLE: 'replica', WALNUT_PLACEMENT: 'host', WALNUT_HOST_SERVER: '1' })
  _resetServerRoleForTesting()
  child = spawn('sleep', ['120'], { stdio: 'ignore' })
  pid = child.pid ?? 0
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
})

afterAll(async () => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  _resetServerRoleForTesting()
  // The child this test spawned, and only it.
  if (child && child.exitCode === null) child.kill('SIGTERM')
  const sessionDb = await import('../../../src/core/session-db.js')
  sessionDb.closeDb()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('a host replica never acts on a process named by a copied row', () => {
  it('runs as a host replica with a live child to aim at', () => {
    expect(isHostReplica()).toBe(true)
    expect(pid).toBeGreaterThan(1)
    expect(alive(pid)).toBe(true)
  })

  it('asks no daemon to stop a copied session (stopThroughOwner)', async () => {
    const conn = acceptingConn()
    const outcome = await stopThroughOwner(copiedRow(), 'user', 'test', { connection: async () => conn }, 'human')
    expect(outcome).toBe('refused')
    expect(conn.calls).toEqual([])
  })

  it('asks no daemon to stop a copied ACP worker (stopAcpThroughOwner)', async () => {
    const conn = acceptingConn()
    const outcome = await stopAcpThroughOwner(copiedRow({ acpRuntimeId: 'acp-marina-1', host: 'devbox' }), 'test', { connection: async () => conn }, { ephemeral: false })
    expect(outcome).toBe('refused')
    expect(conn.calls).toEqual([])
  })

  it('sweeps no copied row as an orphan (sweepOrphansThroughOwner)', async () => {
    const conn = acceptingConn()
    const outcomes = await sweepOrphansThroughOwner([copiedRow()], 'test', {
      connection: async () => conn,
      reread: async () => copiedRow(),
      markExpectedTeardown: async () => undefined,
      now: () => Date.now(),
    })
    expect(outcomes).toEqual([])
    expect(conn.calls).toEqual([])
  })

  it('reads a copied row\'s liveness from its label and never probes its pid', async () => {
    const { isSessionProcessAlive } = await import('../../../src/utils/session-liveness.js')
    const kill = vi.spyOn(process, 'kill')
    try {
      expect(await isSessionProcessAlive(copiedRow({ process_status: 'running' }))).toBe(true)
      expect(await isSessionProcessAlive(copiedRow({ process_status: 'idle' }))).toBe(true)
      expect(await isSessionProcessAlive(copiedRow({ process_status: 'stopped' }))).toBe(false)
      expect(kill.mock.calls.filter(([p]) => p === pid)).toEqual([])
    } finally { kill.mockRestore() }
    expect(alive(pid)).toBe(true)
  })

  it('evicts no copied idle session for capacity: no victim marked, no stop asked, not even one the funnel would refuse', async () => {
    const sessionDb = await import('../../../src/core/session-db.js')
    const tracker = await import('../../../src/core/session-tracker.js')
    sessionDb.getDb()
    // The copy's own write path (kinds/sessions.ts), rows as the Mac had them.
    const ids = ['sid-marina-idle-1', 'sid-marina-idle-2', 'sid-marina-idle-3']
    sessionDb.applySessionCopy({ rows: ids.map((id) => copiedRow({ claudeSessionId: id, process_status: 'idle', status_reason: undefined })) })
    const stop = vi.mocked(stopThroughOwner)
    stop.mockClear()
    const warns = vi.spyOn(log.session, 'warn')
    const kill = vi.spyOn(process, 'kill')
    try {
      const result = await tracker.checkSessionLimit(null, undefined, { max_idle: 1 })
      // Over the idle limit (3 >= 1), so the Mac would evict here; the replica must not.
      expect(result.idleCount).toBe(3)
      expect(result.evicted ?? []).toEqual([])
      // The guard in checkSessionLimit is what stops it, before the loop: stopThroughOwner's own
      // guard would refuse each victim too, so only the funnel never being reached proves this one.
      expect(stop).not.toHaveBeenCalled()
      const said = warns.mock.calls.map(([msg, data]) => [msg, (data as { action?: string } | undefined)?.action])
      expect(said.filter(([msg]) => msg === 'evicting idle session for capacity')).toEqual([])
      expect(said).toContainEqual(['replica: refused a process action, sessions here are copies of the Mac\'s', 'capacity_eviction'])
      expect(kill.mock.calls.filter(([p]) => p === pid)).toEqual([])
      for (const id of ids) expect((await tracker.getSessionByClaudeId(id))).toMatchObject({ process_status: 'idle' })
    } finally {
      kill.mockRestore()
      warns.mockRestore()
      sessionDb.applySessionCopy({ removeIds: ids })
    }
    expect(alive(pid)).toBe(true)
  })

  it('repairs no copied row its label cannot vouch for, through every caller of the repair', async () => {
    const sessionDb = await import('../../../src/core/session-db.js')
    const tracker = await import('../../../src/core/session-tracker.js')
    sessionDb.getDb()
    // Rows whose label this server does not read as alive: one with none, one a newer Mac wrote.
    // On the Mac a dead pid would mark such a row stopped; on a replica the row is the Mac's.
    const rows = [
      copiedRow({ claudeSessionId: 'sid-marina-nolabel', process_status: undefined, status_reason: undefined }),
      copiedRow({ claudeSessionId: 'sid-marina-newlabel', process_status: 'suspended' as SessionRecord['process_status'], status_reason: undefined }),
    ]
    sessionDb.applySessionCopy({ rows })
    const warns = vi.spyOn(log.session, 'warn')
    try {
      const before = await Promise.all(rows.map((r) => tracker.getSessionByClaudeId(r.claudeSessionId)))
      const limit = await tracker.checkSessionLimit(null, undefined, { max_idle: 30 })
      expect(limit.running).toBe(0)
      const alive = await tracker.getAllAliveSessionsByHost()
      expect(Object.values(alive).flat().map((s) => s.claudeSessionId)).toEqual([])
      // fixStaleRecords writes fire and forget: give a write that should not exist time to land.
      await new Promise((r) => setTimeout(r, 50))
      const said = warns.mock.calls.map(([msg, data]) => [msg, (data as { action?: string } | undefined)?.action])
      expect(said.filter(([msg]) => msg === 'fixing stale records' || msg === 'failed to fix stale record')).toEqual([])
      expect(said.filter(([, action]) => action === 'stale_repair')).toHaveLength(2)
      const after = await Promise.all(rows.map((r) => tracker.getSessionByClaudeId(r.claudeSessionId)))
      expect(after).toEqual(before)
      expect(after.map((s) => s?.status_reason)).toEqual([undefined, undefined])
    } finally {
      warns.mockRestore()
      sessionDb.applySessionCopy({ removeIds: rows.map((r) => r.claudeSessionId) })
    }
  })
})
