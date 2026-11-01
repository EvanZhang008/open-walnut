/**
 * The session store's own stop paths (task completion, capacity eviction) hand
 * every stop to the owning daemon and never signal a pid themselves.
 *
 * Both used to process.kill(record.pid, 'SIGINT') from this machine: remote
 * hosts' pids included, and completeTaskSessions runs over completed tasks at
 * startup, so a server holding a copy of another server's store signalled that
 * server's live CLIs (the 2026-09-26 family). owner-stop is stubbed and records
 * its calls; process.kill is spied on, records any real signal without
 * delivering it, and must see none. Pids are fabricated above any real pid limit.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fsp from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

const { ownerStops, acpStops, liveAcp, marks, outcomes, undos } = vi.hoisted(() => ({
  ownerStops: [] as Array<{ sid: string; host?: string; reason: string; why: string }>,
  acpStops: [] as Array<{ sid: string; runtimeId?: string; how: 'live' | 'owner' }>,
  /** ACP sessions this server holds in memory, by session id. */
  liveAcp: new Set<string>(),
  marks: [] as Array<{ sid: string; reason: string }>,
  /** What the owning daemon answers per sid; 'stopped' when unset. */
  outcomes: new Map<string, string>(),
  undos: [] as string[],
}))

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-owner-stop-callers'))
vi.mock('../../../src/core/sessions/owner-stop.js', () => ({
  stopThroughOwner: async (row: { claudeSessionId: string; host?: string }, reason: string, why: string) => {
    ownerStops.push({ sid: row.claudeSessionId, host: row.host, reason, why })
    return outcomes.get(row.claudeSessionId) ?? 'stopped'
  },
  stopAcpThroughOwner: async (row: { claudeSessionId: string; acpRuntimeId?: string }) => {
    acpStops.push({ sid: row.claudeSessionId, runtimeId: row.acpRuntimeId, how: 'owner' })
    return 'stopped'
  },
}))
vi.mock('../../../src/providers/claude-code-session.js', () => ({
  sessionRunner: {
    markExpectedTeardown: (sid: string, reason: string) => { marks.push({ sid, reason }); return () => { undos.push(sid) } },
    findAcpSession: (sid: string) => liveAcp.has(sid)
      ? { gracefulStop: async () => { acpStops.push({ sid, how: 'live' }) } }
      : undefined,
  },
}))
vi.mock('../../../src/utils/session-liveness.js', () => ({
  isSessionProcessAlive: async (s: { process_status?: string }) => s.process_status !== 'stopped' && s.process_status !== 'error',
}))
vi.mock('../../../src/providers/daemon-connection.js', () => ({
  isDaemonConnected: () => true,
  getDaemonDisconnectedSince: () => null,
}))
// Terminal reaping runs a shell on the session's host; nothing here may reach one.
vi.mock('../../../src/web/terminal/dtach-lifecycle.js', () => ({
  conditionalReap: async () => 'kept',
}))

import {
  checkSessionLimit,
  completeTaskSessions,
  createSessionRecord,
  getSessionByClaudeId,
  updateSessionRecord,
  _resetSessionTrackerForTesting,
} from '../../../src/core/session-tracker.js'
import { closeDb } from '../../../src/core/session-db.js'
import { ENGINE_REGISTRY, isAcpEngine } from '../../../src/core/agents/engine-registry.js'
import { WALNUT_HOME } from '../../../src/constants.js'

const BASE = 2 ** 22
let signals: Array<[number, unknown]>

beforeEach(async () => {
  // A fresh store per test: the cases reuse session ids.
  closeDb()
  _resetSessionTrackerForTesting()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
  ownerStops.length = 0
  acpStops.length = 0
  liveAcp.clear()
  marks.length = 0
  outcomes.clear()
  undos.length = 0
  signals = []
  vi.spyOn(process, 'kill').mockImplementation(((pid: number, sig?: string | number) => {
    if (sig === 0) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
    signals.push([pid, sig])   // record, never deliver
    return true
  }) as typeof process.kill)
})

afterEach(async () => {
  expect(signals, 'no stop path may signal a pid it read from a record').toEqual([])
  vi.restoreAllMocks()
  closeDb()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
})

describe('completeTaskSessions', () => {
  it('asks each CLI\'s own daemon (by host) to stop it, marks the teardown first, and signals nothing', async () => {
    // One session per task: each session belongs to its own completed task.
    await createSessionRecord('done-local', 'task-1', 'proj', undefined, { pid: BASE + 1 })
    await createSessionRecord('done-remote', 'task-2', 'proj', undefined, { pid: BASE + 2, host: 'devbox' })
    await createSessionRecord('done-embedded', 'task-3', 'proj', undefined, { pid: BASE + 3, provider: 'embedded' })
    await createSessionRecord('already-clean', 'task-4', 'proj')
    await updateSessionRecord('already-clean', { process_status: 'stopped' })

    const updated = await completeTaskSessions(['done-local', 'done-remote', 'done-embedded', 'already-clean'])

    expect(updated).toBe(3)
    expect(ownerStops).toEqual([
      { sid: 'done-local', host: undefined, reason: 'maintenance', why: 'task_completed' },
      { sid: 'done-remote', host: 'devbox', reason: 'maintenance', why: 'task_completed' },
    ])
    expect(marks).toEqual([
      { sid: 'done-local', reason: 'task_completed' },
      { sid: 'done-remote', reason: 'task_completed' },
    ])
    for (const sid of ['done-local', 'done-remote', 'done-embedded']) {
      const rec = await getSessionByClaudeId(sid)
      expect(rec).toMatchObject({ process_status: 'stopped', status_reason: 'expected_teardown' })
      expect(rec?.pid).toBeUndefined()
    }
  })
})

describe('completeTaskSessions: ACP engines', () => {
  // 2026-11-01: an OpenCode session of a completed task kept generating on the
  // only Ollama slot, so the next session waited minutes behind it. An ACP
  // record has no pid; its worker is stopped by runtime id.
  const acpEngines = [...ENGINE_REGISTRY.keys()].filter((id) => isAcpEngine(id))

  it('stops every ACP engine\'s worker: the live session here, else through its daemon', async () => {
    expect(acpEngines.length).toBeGreaterThan(3)
    const ids: string[] = []
    for (const [i, engine] of acpEngines.entries()) {
      const sid = `acp-${engine}`
      ids.push(sid)
      await createSessionRecord(sid, `acp-task-${i}`, 'proj', undefined, { engine, acpRuntimeId: `rt-${engine}` } as never)
      await updateSessionRecord(sid, { process_status: i % 2 ? 'idle' : 'running' })
      if (i % 2) liveAcp.add(sid)
    }

    expect(await completeTaskSessions(ids)).toBe(acpEngines.length)

    await vi.waitFor(() => expect(acpStops).toHaveLength(acpEngines.length))
    expect(acpStops).toEqual(acpEngines.map((engine, i) => (i % 2
      ? { sid: `acp-${engine}`, how: 'live' }
      : { sid: `acp-${engine}`, runtimeId: `rt-${engine}`, how: 'owner' })))
    expect(ownerStops).toEqual([])
    for (const sid of ids) expect(await getSessionByClaudeId(sid)).toMatchObject({ process_status: 'stopped', status_reason: 'expected_teardown' })
  })

  it('a stopped ACP session and one with no runtime are left alone', async () => {
    await createSessionRecord('acp-stopped', 'acp-t1', 'proj', undefined, { engine: 'opencode', acpRuntimeId: 'rt-1' } as never)
    await updateSessionRecord('acp-stopped', { process_status: 'stopped' })
    await createSessionRecord('acp-no-runtime', 'acp-t2', 'proj', undefined, { engine: 'goose' } as never)
    await completeTaskSessions(['acp-stopped', 'acp-no-runtime'])
    await new Promise((r) => setTimeout(r, 20))
    expect(acpStops).toEqual([])
  })

  it('the ACP session that completed its own task mid-turn stops when that turn ends, not now', async () => {
    await createSessionRecord('acp-actor', 'acp-t3', 'proj', undefined, { engine: 'opencode', acpRuntimeId: 'rt-a' } as never)
    await updateSessionRecord('acp-actor', { process_status: 'running' })
    // It calls the API under its worker's runtime id (x-walnut-caller-sid), not the record's id.
    expect(await completeTaskSessions(['acp-actor'], { actorSid: 'rt-a' })).toBe(0)
    await new Promise((r) => setTimeout(r, 20))
    expect(acpStops).toEqual([])
    expect((await getSessionByClaudeId('acp-actor'))?.process_status).toBe('running')
  })
})

describe('checkSessionLimit: idle capacity eviction', () => {
  it('stops the oldest idle CLIs through their own daemon, local and remote alike', async () => {
    for (let i = 1; i <= 3; i++) {
      await createSessionRecord(`idle-${i}`, `t${i}`, 'p', undefined, { pid: BASE + 10 + i })
      await updateSessionRecord(`idle-${i}`, { process_status: 'idle', lastActiveAt: new Date(Date.now() - (10 - i) * 60_000).toISOString() })
    }
    for (let i = 1; i <= 2; i++) {
      await createSessionRecord(`remote-idle-${i}`, `rt${i}`, 'p', undefined, { pid: BASE + 20 + i, host: 'devbox' })
      await updateSessionRecord(`remote-idle-${i}`, { process_status: 'idle', lastActiveAt: new Date(Date.now() - (10 - i) * 60_000).toISOString() })
    }

    const local = await checkSessionLimit(undefined, { local: 7 }, { max_idle: 2 })
    const remote = await checkSessionLimit('devbox', { devbox: 7 }, { max_idle: 2 })

    expect(local.evicted?.map((s) => s.claudeSessionId)).toEqual(['idle-1', 'idle-2'])
    expect(remote.evicted?.map((s) => s.claudeSessionId)).toEqual(['remote-idle-1'])
    expect(ownerStops).toEqual([
      { sid: 'idle-1', host: undefined, reason: 'idle', why: 'capacity_eviction' },
      { sid: 'idle-2', host: undefined, reason: 'idle', why: 'capacity_eviction' },
      { sid: 'remote-idle-1', host: 'devbox', reason: 'idle', why: 'capacity_eviction' },
    ])
    expect(marks.map((m) => m.sid)).toEqual(['idle-1', 'idle-2', 'remote-idle-1'])
    expect((await getSessionByClaudeId('idle-1'))?.status_reason).toBe('idle_eviction')
  })

  async function seedIdle(n: number): Promise<void> {
    for (let i = 1; i <= n; i++) {
      await createSessionRecord(`idle-${i}`, `t${i}`, 'p', undefined, { pid: BASE + 30 + i })
      await updateSessionRecord(`idle-${i}`, { process_status: 'idle', lastActiveAt: new Date(Date.now() - (10 - i) * 60_000).toISOString() })
    }
  }

  it('a session the daemon keeps (cron supervision, another Walnut\'s) stays idle, its teardown mark is undone, and the next one is tried', async () => {
    await seedIdle(4)
    outcomes.set('idle-1', 'refused')

    const result = await checkSessionLimit(undefined, { local: 7 }, { max_idle: 3 })

    // Two must go (4 idle, room for one more under 3): idle-1 is kept, so idle-2 and idle-3 go.
    expect(ownerStops.map((s) => s.sid)).toEqual(['idle-1', 'idle-2', 'idle-3'])
    expect(result.evicted?.map((s) => s.claudeSessionId)).toEqual(['idle-2', 'idle-3'])
    expect(undos).toEqual(['idle-1'])
    const kept = await getSessionByClaudeId('idle-1')
    expect(kept).toMatchObject({ process_status: 'idle' })
    expect(kept?.status_reason).not.toBe('idle_eviction')
    expect(kept?.pid).toBe(BASE + 31)
    expect((await getSessionByClaudeId('idle-2'))?.status_reason).toBe('idle_eviction')
  })

  it('every daemon refusing evicts nothing and marks nothing stopped', async () => {
    await seedIdle(3)
    for (let i = 1; i <= 3; i++) outcomes.set(`idle-${i}`, 'refused')

    const result = await checkSessionLimit(undefined, { local: 7 }, { max_idle: 2 })

    expect(result.evicted).toBeUndefined()
    expect(undos.sort()).toEqual(['idle-1', 'idle-2', 'idle-3'])
    for (let i = 1; i <= 3; i++) expect((await getSessionByClaudeId(`idle-${i}`))?.process_status).toBe('idle')
  })

  it('an unreachable daemon: the row is marked evicted and keeps its pid, so the owner-checked orphan sweep can finish the job', async () => {
    await seedIdle(2)
    outcomes.set('idle-1', 'unreachable')

    const result = await checkSessionLimit(undefined, { local: 7 }, { max_idle: 2 })

    expect(result.evicted?.map((s) => s.claudeSessionId)).toEqual(['idle-1'])
    expect(undos).toEqual([])
    expect(await getSessionByClaudeId('idle-1')).toMatchObject({ process_status: 'stopped', status_reason: 'idle_eviction', pid: BASE + 31 })
  })
})
