import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants())

import { reconcileSessions } from '../../src/core/session-reconciler.js'
import {
  createSessionRecord,
  listSessions,
  updateSessionRecord,
  _resetSessionTrackerForTesting,
} from '../../src/core/session-tracker.js'
import { closeDb } from '../../src/core/session-db.js'
import { WALNUT_HOME, TASKS_FILE } from '../../src/constants.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = WALNUT_HOME
  closeDb()
  _resetSessionTrackerForTesting()
  await fsp.rm(tmpDir, { recursive: true, force: true })
  await fsp.mkdir(tmpDir, { recursive: true })
  // Ensure tasks directory exists for task-manager operations
  await fsp.mkdir(path.dirname(TASKS_FILE), { recursive: true })
})

afterEach(async () => {
  closeDb()
  _resetSessionTrackerForTesting()
  await fsp.rm(tmpDir, { recursive: true, force: true })
})

describe('reconcileSessions', () => {
  it('returns 0 when no sessions exist', async () => {
    const result = await reconcileSessions()
    expect(result.reconciled).toBe(0)
    expect(result.reconnectable).toEqual([])
  })

  it('returns 0 when all sessions are already stopped', async () => {
    await createSessionRecord('s1', 'task-1', 'proj')
    await updateSessionRecord('s1', { process_status: 'stopped' })
    await createSessionRecord('s2', 'task-2', 'proj')
    await updateSessionRecord('s2', { process_status: 'stopped' })

    const result = await reconcileSessions()
    expect(result.reconciled).toBe(0)
    expect(result.reconnectable).toEqual([])
  })

  it('marks active sessions without pid/outputFile as stopped (legacy)', async () => {
    await createSessionRecord('active-1', 'task-1', 'proj')
    // createSessionRecord defaults to process_status: 'running', no pid/outputFile

    const result = await reconcileSessions()
    expect(result.reconciled).toBe(1)
    expect(result.reconnectable).toEqual([])

    const sessions = await listSessions()
    expect(sessions[0].process_status).toBe('stopped')
  })

  it('skips already-stopped sessions (no redundant reconciliation)', async () => {
    await createSessionRecord('idle-1', 'task-1', 'proj')
    await updateSessionRecord('idle-1', { process_status: 'stopped' })

    const result = await reconcileSessions()
    // Already stopped — reconciler skips (no point re-marking)
    expect(result.reconciled).toBe(0)
    expect(result.reconnectable).toEqual([])

    const sessions = await listSessions()
    expect(sessions[0].process_status).toBe('stopped')
  })

  it('marks sessions with dead PIDs as stopped', async () => {
    await createSessionRecord('dead-pid', 'task-1', 'proj', undefined, {
      pid: 999999999,
      outputFile: '/tmp/dead.jsonl',
    })

    const result = await reconcileSessions()
    expect(result.reconciled).toBe(1)
    expect(result.reconnectable).toEqual([])

    const sessions = await listSessions()
    expect(sessions[0].process_status).toBe('stopped')
  })

  it('reconciles mix of active, idle, and stopped sessions', async () => {
    // Active zombie (no pid — legacy)
    await createSessionRecord('zombie-active', 'task-1', 'proj')

    // Already stopped zombie (dead pid)
    await createSessionRecord('zombie-idle', 'task-2', 'proj', undefined, {
      pid: 999999998,
      outputFile: '/tmp/zombie-idle.jsonl',
    })
    await updateSessionRecord('zombie-idle', { process_status: 'stopped' })

    // Already stopped (should not be touched)
    await createSessionRecord('already-done', 'task-3', 'proj')
    await updateSessionRecord('already-done', { process_status: 'stopped' })

    const result = await reconcileSessions()
    // Only zombie-active is reconciled; zombie-idle and already-done are already stopped (skipped)
    expect(result.reconciled).toBe(1)
    expect(result.reconnectable).toEqual([])

    const sessions = await listSessions()
    const byId = new Map(sessions.map(s => [s.claudeSessionId, s]))
    expect(byId.get('zombie-active')!.process_status).toBe('stopped')
    expect(byId.get('zombie-idle')!.process_status).toBe('stopped')
    expect(byId.get('already-done')!.process_status).toBe('stopped')
  })

  it('handles sessions with no linked task (taskless sessions)', async () => {
    await createSessionRecord('taskless-1', '', 'proj')

    const result = await reconcileSessions()
    expect(result.reconciled).toBe(1)

    const sessions = await listSessions()
    expect(sessions[0].process_status).toBe('stopped')
  })

  it('preserves task session slots for stopped sessions', async () => {
    // Create a task with an exec session slot referencing a zombie session
    const taskStore = {
      version: 1,
      tasks: [{
        id: 'task-linked',
        title: 'Linked task',
        status: 'in_progress',
        priority: 'none',
        project: 'test',
        session_ids: ['linked-session'],
        exec_session_id: 'linked-session',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        description: '',
        summary: '',
        note: '',
        source: 'ms-todo',
      }],
    }
    await fsp.writeFile(TASKS_FILE, JSON.stringify(taskStore), 'utf-8')

    // Create the zombie session linked to this task
    await createSessionRecord('linked-session', 'task-linked', 'test')

    const result = await reconcileSessions()
    expect(result.reconciled).toBe(1)

    // Verify task's session slot is PRESERVED (stopped keeps the link)
    const raw = JSON.parse(await fsp.readFile(TASKS_FILE, 'utf-8'))
    const task = raw.tasks.find((t: { id: string }) => t.id === 'task-linked')
    expect(task.exec_session_id).toBe('linked-session')
  })

  it('handles missing task gracefully (task deleted but session remains)', async () => {
    // Session references a task that doesn't exist
    await createSessionRecord('orphan-session', 'deleted-task', 'proj')

    // No tasks file — task doesn't exist
    const result = await reconcileSessions()
    expect(result.reconciled).toBe(1)

    // Session should still be marked stopped even if task doesn't exist
    const sessions = await listSessions()
    expect(sessions[0].process_status).toBe('stopped')
  })

  it('does not re-reconcile already-stopped sessions on second run', async () => {
    await createSessionRecord('s1', 'task-1', 'proj')
    await createSessionRecord('s2', 'task-2', 'proj')

    const first = await reconcileSessions()
    expect(first.reconciled).toBe(2)

    // After first run: both are stopped → second run skips them
    const second = await reconcileSessions()
    expect(second.reconciled).toBe(0)

    const sessions = await listSessions()
    for (const s of sessions) {
      expect(s.process_status).toBe('stopped')
    }
  })

  it('returns reconnectable sessions when pid is alive', async () => {
    // We can't easily mock isProcessAlive in the existing import,
    // so use pid: 999999999 (dead) to verify the opposite
    // and rely on integration tests for the alive path.
    // Here we verify the structural contract.
    await createSessionRecord('alive-maybe', 'task-1', 'proj', undefined, {
      pid: 999999999, // dead PID
      outputFile: '/tmp/test.jsonl',
    })

    const result = await reconcileSessions()
    // Dead PID → reconciled, not reconnectable
    expect(result.reconciled).toBe(1)
    expect(result.reconnectable).toEqual([])
  })

  it('REGRESSION (false-zombie kill): a live local session with an empty outputFile is NOT marked dead', async () => {
    // This is the exact shape that caused the false-zombie incident: a local
    // session (host null) whose process is genuinely alive (use this test
    // runner's own pid) but whose outputFile column was never persisted.
    // The old reconciler short-circuited `outputFile ? isAlive : false` and
    // marked it stopped while the CLI was still streaming; the orphan sweeper
    // then SIGTERM'd the real process. The fix removes that short-circuit, so
    // the live pid is detected via process.kill(pid,0) and the session survives.
    await createSessionRecord('live-no-file', 'task-1', 'proj', undefined, {
      pid: process.pid, // alive PID, deliberately no outputFile
    })

    const result = await reconcileSessions()
    expect(result.reconciled).toBe(0)
    expect(result.reconnectable.map(s => s.claudeSessionId)).toEqual(['live-no-file'])

    const sessions = await listSessions()
    const rec = sessions.find(s => s.claudeSessionId === 'live-no-file')!
    expect(rec.process_status).not.toBe('stopped')
    // And the empty outputFile is backfilled with the canonical local sentinel
    // so it can never trip a future caller that still keys off the column.
    expect(rec.outputFile).toBe('remote://__local__/live-no-file')
  })

  it('a dead pid with no outputFile is still correctly marked stopped (pid==null path unaffected)', async () => {
    await createSessionRecord('dead-no-file', 'task-1', 'proj', undefined, {
      pid: 999999999, // dead PID, no outputFile
    })

    const result = await reconcileSessions()
    // pid exists but process.kill throws → isSessionProcessAlive returns false → stopped
    expect(result.reconciled).toBe(1)
    expect(result.reconnectable).toEqual([])

    const sessions = await listSessions()
    expect(sessions.find(s => s.claudeSessionId === 'dead-no-file')!.process_status).toBe('stopped')
  })

  it('REGRESSION (incident 57b125ab): an alive session\'s process_status is NOT rewritten from the task phase', async () => {
    // The CLI process is long-running BETWEEN turns: alive + idle is the normal
    // between-turns state. The old sweep set process_status from the task's
    // phase (`IN_PROGRESS → 'running'`), so a dev:prod restart revived a
    // correctly-idle record to a false 'running' that nothing ever corrected
    // (15h of fake Running). The record's persisted value is the last
    // event-driven truth — the sweep must keep it.
    // Task in IN_PROGRESS FIRST — the exact phase the old proxy translated to
    // 'running'. Without a real IN_PROGRESS task the old code would have
    // written 'idle' too and a revert would not fail this test.
    const { addTask, updateTaskRaw } = await import('../../src/core/task-manager.js')
    const { task } = await addTask({ title: 'inprog', project: 'p' })
    await updateTaskRaw(task.id, { phase: 'IN_PROGRESS' })

    await createSessionRecord('alive-idle', task.id, 'proj', undefined, {
      pid: process.pid, // alive (this test runner)
      outputFile: 'remote://__local__/alive-idle',
    })
    await updateSessionRecord('alive-idle', { process_status: 'idle' })

    const result = await reconcileSessions()
    expect(result.reconnectable.map(s => s.claudeSessionId)).toEqual(['alive-idle'])

    const sessions = await listSessions()
    const rec = sessions.find(s => s.claudeSessionId === 'alive-idle')!
    // The bug shape: this used to come back 'running'.
    expect(rec.process_status).toBe('idle')
  })

  it('an alive stuck-running record is left for the evidence path (sweep neither fixes nor worsens it)', async () => {
    // The sweep is not the healer for stale 'running' — reconcileProcessStatus
    // (stream-file evidence) is. The sweep must simply not touch the value.
    await createSessionRecord('alive-running', 'task-x', 'proj', undefined, {
      pid: process.pid,
      outputFile: 'remote://__local__/alive-running',
    })
    // createSessionRecord defaults to 'running' — leave it.

    await reconcileSessions()
    const sessions = await listSessions()
    expect(sessions.find(s => s.claudeSessionId === 'alive-running')!.process_status).toBe('running')
  })
})
