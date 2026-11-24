/**
 * A completed task's session stop survives a restart and an offline host
 * (src/core/sessions/task-complete-stop.ts).
 *
 * 2026-11-18: a session completed its own task mid-turn, so it was to stop when that turn
 * ended, a wait kept only in memory. A deploy restarted the server; 19 s after the boot the
 * completed-task migration wrote the session stopped, cleared its pid and announced it, while
 * its host's daemon was not connected yet ("owner stop: host daemon not connected, nothing
 * signalled"). The CLI kept running, and the task's workspace cleanup removed its node_modules.
 *
 * Real task and session stores, closed and reopened for the restart; owner-stop is stubbed
 * (which hosts are connected, what each stop answered); process.kill must see nothing.
 *
 * Which path: the records here carry no `judge`, so this server judges them (the path every
 * session started before host_runs_sessions, or with it off, takes); the switch only decides how
 * a NEW session starts. The same timeline for a session its host judges (`judge: 'host'`) is
 * task-complete-stop-host-judged.test.ts.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import fsp from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

const { ownerStops, connected, answer } = vi.hoisted(() => ({
  ownerStops: [] as Array<{ sid: string; host?: string; why: string }>,
  connected: new Set<string>(),
  answer: { outcome: 'stopped' as 'stopped' | 'unreachable' | 'unknown' | 'refused' },
}))

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-task-complete-stop-restart'))
vi.mock('../../../src/core/sessions/owner-stop.js', () => ({
  ownerConnection: async (host: string) => ({ connected: connected.has(host) }),
  stopThroughOwner: async (row: { claudeSessionId: string; host?: string }, _reason: string, why: string) => {
    const host = row.host || '__local__'
    if (!connected.has(host)) return 'unreachable'
    ownerStops.push({ sid: row.claudeSessionId, host: row.host, why })
    return answer.outcome
  },
  stopAcpThroughOwner: async () => 'stopped',
}))
vi.mock('../../../src/providers/claude-code-session.js', () => ({
  sessionRunner: { markExpectedTeardown: () => () => {} },
}))
vi.mock('../../../src/utils/session-liveness.js', () => ({
  isSessionProcessAlive: async (s: { process_status?: string }) => s.process_status !== 'stopped' && s.process_status !== 'error',
}))
vi.mock('../../../src/providers/daemon-connection.js', () => ({
  isDaemonConnected: () => true,
  getDaemonDisconnectedSince: () => null,
}))
vi.mock('../../../src/web/terminal/dtach-lifecycle.js', () => ({ conditionalReap: async () => 'kept' }))

import {
  createSessionRecord,
  emitSessionStatusChanged,
  getSessionByClaudeId,
  updateSessionRecord,
  _resetSessionTrackerForTesting,
} from '../../../src/core/session-tracker.js'
import {
  addTask, completeTask, linkSession, migrateCompletedTaskSessions, updateTask, _resetForTesting,
} from '../../../src/core/task-manager.js'
import { closeDb as closeTaskDb } from '../../../src/core/task-db.js'
import { closeDb as closeSessionDb } from '../../../src/core/session-db.js'
import { bus, EventNames } from '../../../src/core/event-bus.js'
import {
  __setSelfCompleteSettleMs, _pendingSelfCompleteStopsForTest, _resetSelfCompleteStopsForTest,
} from '../../../src/core/sessions/self-complete-stop.js'
import { flushTaskCompleteStops, TASK_COMPLETE_STOP_UNDELIVERED_MAX_MS } from '../../../src/core/sessions/task-complete-stop.js'
// Loaded up front: the turn-end wait imports these on its first look, and two first imports of a
// module that reaches a mocked one at once can leave one of them pending under vitest.
import { loadTurnRetriers } from '../../../src/core/sessions/turn-run.js'
import '../../../src/providers/claude-code-session.js'
import '../../../src/core/session-queue-store.js'
import { WALNUT_HOME } from '../../../src/constants.js'

const PID = 2 ** 22 + 7
const HOST = 'devbox'
let signals: Array<[number, unknown]>
/** Every status the bus announced for a session: the workspace cleanup acts on 'stopped'. */
let announced: Array<{ sid: string; status: string }>

async function taskWithSession(sid: string, status: 'running' | 'idle') {
  const { task } = await addTask({ title: 'Ship the fix' })
  await createSessionRecord(sid, task.id, 'proj', undefined, { pid: PID, host: HOST })
  await updateSessionRecord(sid, { process_status: status })
  await linkSession(task.id, sid)
  return task
}

async function turnEnds(sid: string) {
  const rec = await updateSessionRecord(sid, { process_status: 'idle' })
  emitSessionStatusChanged(rec, {}, ['*'], { source: 'session-runner' })
}

/** A deploy: everything in memory is gone, the stores on disk stay. */
function restart() {
  _resetSelfCompleteStopsForTest()
  closeTaskDb()
  closeSessionDb()
  _resetSessionTrackerForTesting()
  _resetForTesting()
}

const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms))

// The retry rows load at the server's start (triage/runs.ts); loaded here too, so a wait's first
// look does not import them inside the timed window (2026-11-24: about a second on a busy host).
beforeAll(async () => { await loadTurnRetriers() })

beforeEach(async () => {
  restart()
  __setSelfCompleteSettleMs(0)
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
  ownerStops.length = 0
  connected.clear()
  connected.add('__local__').add(HOST)
  answer.outcome = 'stopped'
  signals = []
  announced = []
  bus.subscribe('test-announced', (event) => {
    const d = event.data as { sessionId?: string; process_status?: string }
    if (d?.sessionId && d.process_status) announced.push({ sid: d.sessionId, status: d.process_status })
  }, { global: true, interest: [EventNames.SESSION_STATUS_CHANGED] })
  vi.spyOn(process, 'kill').mockImplementation(((pid: number, sig?: string | number) => {
    if (sig === 0) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
    signals.push([pid, sig])
    return true
  }) as typeof process.kill)
})

afterEach(async () => {
  expect(signals, 'no stop path may signal a pid it read from a record').toEqual([])
  bus.unsubscribe('test-announced')
  __setSelfCompleteSettleMs()
  vi.restoreAllMocks()
  restart()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
})

describe('a session that completed its own task, across a deploy restart and an offline host', () => {
  it('the incident timeline: never written stopped while alive, stopped once its host is back and its turn is over', async () => {
    const task = await taskWithSession('self', 'running')
    await completeTask(task.id, { actorSid: 'self' })
    await vi.waitFor(() => expect(_pendingSelfCompleteStopsForTest()).toEqual(['self']))
    // The wait is on the record, not only in memory.
    expect((await getSessionByClaudeId('self'))?.taskCompleteStop).toMatchObject({ state: 'turn_end' })

    // The deploy restart: the in-memory wait is gone, and the host has not reconnected yet.
    restart()
    connected.delete(HOST)
    expect(_pendingSelfCompleteStopsForTest()).toEqual([])

    // The boot's completed-task migration.
    await migrateCompletedTaskSessions()
    await settle()
    expect(_pendingSelfCompleteStopsForTest(), 'the turn-end wait is watched again').toEqual(['self'])
    expect(await getSessionByClaudeId('self')).toMatchObject({ process_status: 'running', pid: PID })
    expect(ownerStops).toEqual([])
    expect(announced.filter((a) => a.status === 'stopped')).toEqual([])

    // Its turn ends while the host is still away: the stop cannot be sent, so it is not written.
    await turnEnds('self')
    await vi.waitFor(async () => expect((await getSessionByClaudeId('self'))?.taskCompleteStop)
      .toMatchObject({ state: 'undelivered', actor: true }), { timeout: 10_000 })
    expect(await getSessionByClaudeId('self')).toMatchObject({ process_status: 'idle', pid: PID })
    expect(ownerStops).toEqual([])

    // A later write to the complete task and another boot pass change nothing.
    await updateTask(task.id, { title: 'Ship the fix, refined' })
    await migrateCompletedTaskSessions()
    await settle()
    expect(await getSessionByClaudeId('self')).toMatchObject({ process_status: 'idle', pid: PID })
    expect(ownerStops).toEqual([])

    // The host connects: its daemon gets the stop, and the record says so.
    connected.add(HOST)
    await flushTaskCompleteStops(HOST)
    await vi.waitFor(() => expect(ownerStops).toEqual([{ sid: 'self', host: HOST, why: 'task_completed' }]))
    const rec = await getSessionByClaudeId('self')
    expect(rec).toMatchObject({ process_status: 'stopped', status_reason: 'expected_teardown' })
    expect(rec?.pid).toBeUndefined()
    expect(rec?.taskCompleteStop).toBeUndefined()
    expect(_pendingSelfCompleteStopsForTest()).toEqual([])
  })

  it('a restart with its host connected resumes the wait and stops it only when the turn ends', async () => {
    const task = await taskWithSession('self', 'running')
    await completeTask(task.id, { actorSid: 'self' })
    await vi.waitFor(() => expect(_pendingSelfCompleteStopsForTest()).toEqual(['self']))
    restart()

    await migrateCompletedTaskSessions()
    await settle()
    expect(ownerStops, 'the migration does not cut the turn').toEqual([])
    expect(await getSessionByClaudeId('self')).toMatchObject({ process_status: 'running', pid: PID })

    await turnEnds('self')
    await vi.waitFor(() => expect(ownerStops.map((s) => s.sid)).toEqual(['self']))
    expect((await getSessionByClaudeId('self'))?.taskCompleteStop).toBeUndefined()
  })

  it('a task reopened before the restart is not stopped after it, and its marker goes', async () => {
    const task = await taskWithSession('self', 'running')
    await completeTask(task.id, { actorSid: 'self' })
    await vi.waitFor(() => expect(_pendingSelfCompleteStopsForTest()).toEqual(['self']))
    restart()
    await updateTask(task.id, { phase: 'IN_PROGRESS' }, { source: 'api' })

    await migrateCompletedTaskSessions()
    await settle()
    expect(_pendingSelfCompleteStopsForTest()).toEqual([])
    expect((await getSessionByClaudeId('self'))?.taskCompleteStop).toBeUndefined()
    expect(ownerStops).toEqual([])
  })
})

describe('any completed task\'s session on a host that is not connected', () => {
  it('the boot migration keeps the record and the host\'s connect sends the stop', async () => {
    const task = await taskWithSession('worker', 'idle')
    await updateTask(task.id, { phase: 'COMPLETE' })
    // Its completion ran with the host connected: a fresh copy of the incident starts from a live record.
    await updateSessionRecord('worker', { process_status: 'idle', pid: PID })
    ownerStops.length = 0
    announced = []
    restart()
    connected.delete(HOST)

    await migrateCompletedTaskSessions()
    await settle()
    expect(await getSessionByClaudeId('worker')).toMatchObject({ process_status: 'idle', pid: PID, taskCompleteStop: { state: 'undelivered' } })
    expect(announced.filter((a) => a.status === 'stopped')).toEqual([])

    connected.add(HOST)
    await flushTaskCompleteStops(HOST)
    expect(ownerStops.map((s) => s.sid)).toEqual(['worker'])
    expect(await getSessionByClaudeId('worker')).toMatchObject({ process_status: 'stopped' })
    expect((await getSessionByClaudeId('worker'))?.taskCompleteStop).toBeUndefined()
    expect(announced.filter((a) => a.sid === 'worker' && a.status === 'stopped').length).toBe(1)
  })

  it('a session that completed its own task: once its host is back, another completion pass still waits for its turn', async () => {
    const task = await taskWithSession('self', 'running')
    connected.delete(HOST)
    await completeTask(task.id, { actorSid: 'self' })
    await vi.waitFor(() => expect(_pendingSelfCompleteStopsForTest()).toEqual(['self']))
    await turnEnds('self')
    await vi.waitFor(async () => expect((await getSessionByClaudeId('self'))?.taskCompleteStop)
      .toMatchObject({ state: 'undelivered', actor: true }), { timeout: 10_000 })
    const at = (await getSessionByClaudeId('self'))!.taskCompleteStop!.at
    // Back, and in a new turn before the connect's flush ran; a write to the task runs a pass.
    connected.add(HOST)
    await updateSessionRecord('self', { process_status: 'running' })
    await updateTask(task.id, { title: 'Ship the fix, refined' })
    await vi.waitFor(() => expect(_pendingSelfCompleteStopsForTest()).toEqual(['self']))
    expect(ownerStops).toEqual([])
    expect((await getSessionByClaudeId('self'))?.taskCompleteStop).toEqual({ at, state: 'turn_end' })

    await turnEnds('self')
    await vi.waitFor(() => expect(ownerStops.map((s) => s.sid)).toEqual(['self']), { timeout: 10_000 })
  })

  it('a task reopened while its host was away keeps its session: the connect drops the marker', async () => {
    const task = await taskWithSession('worker', 'idle')
    connected.delete(HOST)
    await completeTask(task.id)
    await vi.waitFor(async () => expect((await getSessionByClaudeId('worker'))?.taskCompleteStop?.state).toBe('undelivered'))
    await updateTask(task.id, { phase: 'IN_PROGRESS' }, { source: 'api' })

    connected.add(HOST)
    await flushTaskCompleteStops(HOST)
    expect(ownerStops).toEqual([])
    expect(await getSessionByClaudeId('worker')).toMatchObject({ process_status: 'idle', pid: PID })
    expect((await getSessionByClaudeId('worker'))?.taskCompleteStop).toBeUndefined()
  })

  it('a stop that failed on the way (already recorded stopped) is sent again on connect, once', async () => {
    const task = await taskWithSession('worker', 'idle')
    answer.outcome = 'unknown'
    await completeTask(task.id)
    await vi.waitFor(async () => expect((await getSessionByClaudeId('worker'))?.taskCompleteStop?.state).toBe('undelivered'))
    expect(await getSessionByClaudeId('worker')).toMatchObject({ process_status: 'stopped' })

    answer.outcome = 'stopped'
    await flushTaskCompleteStops(HOST)
    expect(ownerStops.map((s) => s.sid)).toEqual(['worker', 'worker'])
    expect((await getSessionByClaudeId('worker'))?.taskCompleteStop).toBeUndefined()
    await flushTaskCompleteStops(HOST)
    expect(ownerStops.length).toBe(2)
  })

  it('a host away past the limit: the next pass records it stopped without the host, and keeps the stop for a later connect', async () => {
    const task = await taskWithSession('worker', 'idle')
    connected.delete(HOST)
    await completeTask(task.id)
    await vi.waitFor(async () => expect((await getSessionByClaudeId('worker'))?.taskCompleteStop?.state).toBe('undelivered'))
    const old = new Date(Date.now() - TASK_COMPLETE_STOP_UNDELIVERED_MAX_MS - 60_000).toISOString()
    await updateSessionRecord('worker', { taskCompleteStop: { at: old, state: 'undelivered' } })

    await migrateCompletedTaskSessions()
    await vi.waitFor(async () => expect((await getSessionByClaudeId('worker'))?.taskCompleteStop?.state).toBe('undelivered'))
    const rec = await getSessionByClaudeId('worker')
    expect(rec).toMatchObject({ process_status: 'stopped' })
    expect(rec?.pid).toBeUndefined()

    connected.add(HOST)
    await flushTaskCompleteStops(HOST)
    expect(ownerStops.map((s) => s.sid)).toEqual(['worker'])
    expect((await getSessionByClaudeId('worker'))?.taskCompleteStop).toBeUndefined()
  })
})

describe('ratchet: no decided stop drops what its owner answered', () => {
  // The class of this bug: a stop sent with its answer thrown away, so "the host is not
  // connected" reached a log line only. Every call of the owner stops in src reads the
  // outcome (await, assignment, return, an arrow's value, or a .then on the next line).
  it('every stopThroughOwner / stopAcpThroughOwner call uses its outcome', async () => {
    const { readdirSync, readFileSync } = await import('node:fs')
    const path = await import('node:path')
    const root = path.resolve(__dirname, '../../..')
    const files: string[] = []
    const walk = (dir: string) => {
      for (const e of readdirSync(path.join(root, dir), { withFileTypes: true })) {
        const rel = path.join(dir, e.name)
        if (e.isDirectory()) walk(rel)
        else if (/\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts')) files.push(rel)
      }
    }
    walk('src')
    const dropped: string[] = []
    let calls = 0
    for (const f of files) {
      const lines = readFileSync(path.join(root, f), 'utf8').split('\n')
      lines.forEach((line, i) => {
        if (!/\bstop(Acp)?ThroughOwner\(/.test(line) || /function stop(Acp)?ThroughOwner\(/.test(line) || /^\s*(\*|\/\/)/.test(line)) return
        calls++
        const before = line.split(/\bstop(?:Acp)?ThroughOwner\(/)[0]!
        const thenNext = /^\s*\.then\(\s*\(?\s*\w+/.test(lines[i + 1] ?? '')
        // A bare `void` call, even inside an arrow, drops the answer unless a .then reads it.
        const used = /\bvoid\s*$/.test(before) ? thenNext
          : /\bawait\b|=\s*[^=>]|\breturn\b|=>\s*$|=>\s*\(?\s*\w*\.?$/.test(before) || thenNext
        if (!used) dropped.push(`${f}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(calls).toBeGreaterThanOrEqual(8)
    expect(dropped, 'a stop whose outcome is dropped loses "host not connected" (task-complete-stop.ts)').toEqual([])
  })
})
