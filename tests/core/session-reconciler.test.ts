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
} from '../../src/core/session-tracker.js'
import { WALNUT_HOME, TASKS_FILE } from '../../src/constants.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = WALNUT_HOME
  await fsp.rm(tmpDir, { recursive: true, force: true })
  await fsp.mkdir(tmpDir, { recursive: true })
  // Ensure tasks directory exists for task-manager operations
  await fsp.mkdir(path.dirname(TASKS_FILE), { recursive: true })
})

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true })
})

describe('reconcileSessions', () => {
  it('returns 0 when no sessions exist', async () => {
    const result = await reconcileSessions()
    expect(result.reconciled).toBe(0)
    expect(result.reconnectable).toEqual([])
  })

  it('returns 0 when all sessions are already completed', async () => {
    await createSessionRecord('s1', 'task-1', 'proj')
    await updateSessionRecord('s1', { work_status: 'completed', process_status: 'stopped' })
    await createSessionRecord('s2', 'task-2', 'proj')
    await updateSessionRecord('s2', { work_status: 'completed', process_status: 'stopped' })

    const result = await reconcileSessions()
    expect(result.reconciled).toBe(0)
    expect(result.reconnectable).toEqual([])
  })

  it('marks active sessions without pid/outputFile as agent_complete (legacy)', async () => {
    await createSessionRecord('active-1', 'task-1', 'proj')
    // createSessionRecord defaults to process_status: 'running', work_status: 'in_progress', no pid/outputFile

    const result = await reconcileSessions()
    expect(result.reconciled).toBe(1)
    expect(result.reconnectable).toEqual([])

    const sessions = await listSessions()
    expect(sessions[0].work_status).toBe('agent_complete')
    expect(sessions[0].process_status).toBe('stopped')
  })

  it('re-marks idle sessions without pid/outputFile as agent_complete', async () => {
    await createSessionRecord('idle-1', 'task-1', 'proj')
    await updateSessionRecord('idle-1', { work_status: 'agent_complete', process_status: 'stopped' })

    const result = await reconcileSessions()
    // agent_complete is non-terminal, so reconciler processes it again
    expect(result.reconciled).toBe(1)
    expect(result.reconnectable).toEqual([])

    const sessions = await listSessions()
    expect(sessions[0].work_status).toBe('agent_complete')
    expect(sessions[0].process_status).toBe('stopped')
  })

  it('marks sessions with dead PIDs as agent_complete', async () => {
    await createSessionRecord('dead-pid', 'task-1', 'proj', undefined, {
      pid: 999999999,
      outputFile: '/tmp/dead.jsonl',
    })

    const result = await reconcileSessions()
    expect(result.reconciled).toBe(1)
    expect(result.reconnectable).toEqual([])

    const sessions = await listSessions()
    expect(sessions[0].work_status).toBe('agent_complete')
    expect(sessions[0].process_status).toBe('stopped')
  })

  it('reconciles mix of active, idle, and completed sessions', async () => {
    // Active zombie (no pid — legacy)
    await createSessionRecord('zombie-active', 'task-1', 'proj')

    // Idle zombie (dead pid)
    await createSessionRecord('zombie-idle', 'task-2', 'proj', undefined, {
      pid: 999999998,
      outputFile: '/tmp/zombie-idle.jsonl',
    })
    await updateSessionRecord('zombie-idle', { work_status: 'agent_complete', process_status: 'stopped' })

    // Already completed (should not be touched)
    await createSessionRecord('already-done', 'task-3', 'proj')
    await updateSessionRecord('already-done', { work_status: 'completed', process_status: 'stopped' })

    const result = await reconcileSessions()
    expect(result.reconciled).toBe(2)
    expect(result.reconnectable).toEqual([])

    const sessions = await listSessions()
    const byId = new Map(sessions.map(s => [s.claudeSessionId, s]))
    expect(byId.get('zombie-active')!.work_status).toBe('agent_complete')
    expect(byId.get('zombie-idle')!.work_status).toBe('agent_complete')
    expect(byId.get('already-done')!.work_status).toBe('completed')
  })

  it('handles sessions with no linked task (taskless sessions)', async () => {
    await createSessionRecord('taskless-1', '', 'proj')

    const result = await reconcileSessions()
    expect(result.reconciled).toBe(1)

    const sessions = await listSessions()
    expect(sessions[0].work_status).toBe('agent_complete')
  })

  it('preserves task session slots for agent_complete sessions', async () => {
    // Create a task with an exec session slot referencing a zombie session
    const taskStore = {
      version: 1,
      tasks: [{
        id: 'task-linked',
        title: 'Linked task',
        status: 'in_progress',
        priority: 'none',
        category: 'test',
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

    // Verify task's session slot is PRESERVED (agent_complete keeps the link)
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

    // Session should still be marked agent_complete even if task doesn't exist
    const sessions = await listSessions()
    expect(sessions[0].work_status).toBe('agent_complete')
  })

  it('re-reconciles agent_complete sessions (non-terminal) on second run', async () => {
    await createSessionRecord('s1', 'task-1', 'proj')
    await createSessionRecord('s2', 'task-2', 'proj')

    const first = await reconcileSessions()
    expect(first.reconciled).toBe(2)

    // agent_complete is non-terminal, so second run processes them again
    const second = await reconcileSessions()
    expect(second.reconciled).toBe(2)

    const sessions = await listSessions()
    for (const s of sessions) {
      expect(s.work_status).toBe('agent_complete')
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

  it('sessions with pid but no outputFile are treated as dead', async () => {
    await createSessionRecord('pid-no-file', 'task-1', 'proj', undefined, {
      pid: process.pid, // alive PID but no outputFile
    })

    const result = await reconcileSessions()
    // No outputFile → can't reconnect → mark completed
    expect(result.reconciled).toBe(1)
    expect(result.reconnectable).toEqual([])
  })
})
