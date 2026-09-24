import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-handback'))

import { reconcileSessions } from '../../src/core/session-reconciler.js'
import { handBackTaskOnSessionEnd, sessionResultPhase } from '../../src/core/phase.js'
import {
  createSessionRecord,
  updateSessionRecord,
  _resetSessionTrackerForTesting,
} from '../../src/core/session-tracker.js'
import { addTask, getTask, updateTask } from '../../src/core/task-manager.js'
import * as taskManager from '../../src/core/task-manager.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { startSessionAutoRecover } from '../../src/core/session-auto-recover.js'
import { closeDb } from '../../src/core/session-db.js'
import { WALNUT_HOME, TASKS_FILE } from '../../src/constants.js'

const HANDBACK_PHASE = sessionResultPhase('IN_PROGRESS')!

beforeEach(async () => {
  closeDb()
  _resetSessionTrackerForTesting()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
  await fsp.mkdir(path.dirname(TASKS_FILE), { recursive: true })
})

afterEach(async () => {
  vi.restoreAllMocks()
  closeDb()
  _resetSessionTrackerForTesting()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {})
})

async function seedTask(title: string): Promise<string> {
  const { task } = await addTask({ title })
  return task.id
}

describe('handBackTaskOnSessionEnd', () => {
  it('flips a TODO task to NEED_ACTION (the incident shape: session Stopped, row grey)', async () => {
    const taskId = await seedTask('dead session, grey row')
    await createSessionRecord('sid-todo', taskId, 'proj')
    await updateSessionRecord('sid-todo', { process_status: 'stopped' })

    expect((await getTask(taskId)).phase).toBe('TODO')
    const changed = await handBackTaskOnSessionEnd(taskId, 'sid-todo', 'test')
    expect(changed).toBe(true)
    expect((await getTask(taskId)).phase).toBe(HANDBACK_PHASE)
  })

  it('flips an IN_PROGRESS task too (the pre-existing phase-debt shape)', async () => {
    const taskId = await seedTask('left behind at in-progress')
    await updateTask(taskId, { phase: 'IN_PROGRESS' })
    await createSessionRecord('sid-inp', taskId, 'proj')
    await updateSessionRecord('sid-inp', { process_status: 'idle' })

    expect(await handBackTaskOnSessionEnd(taskId, 'sid-inp', 'test')).toBe(true)
    expect((await getTask(taskId)).phase).toBe(HANDBACK_PHASE)
  })

  it('never regresses a COMPLETE task', async () => {
    const taskId = await seedTask('already finished')
    await updateTask(taskId, { phase: 'COMPLETE' })

    expect(await handBackTaskOnSessionEnd(taskId, 'sid-done', 'test')).toBe(false)
    expect((await getTask(taskId)).phase).toBe('COMPLETE')
  })

  it('is a no-op when the task is already NEED_ACTION (no repeat notification)', async () => {
    const taskId = await seedTask('already red')
    await updateTask(taskId, { phase: HANDBACK_PHASE })

    expect(await handBackTaskOnSessionEnd(taskId, 'sid-red', 'test')).toBe(false)
  })

  it('leaves the task alone while a SIBLING session is still running', async () => {
    const taskId = await seedTask('two sessions, one still working')
    await createSessionRecord('sid-dead', taskId, 'proj')
    await updateSessionRecord('sid-dead', { process_status: 'stopped' })
    await createSessionRecord('sid-live', taskId, 'proj')
    await updateSessionRecord('sid-live', { process_status: 'running' })

    expect(await handBackTaskOnSessionEnd(taskId, 'sid-dead', 'test')).toBe(false)
    expect((await getTask(taskId)).phase).toBe('TODO')
  })

  it('an IDLE sibling does not count as working (idle IS the handed-back state)', async () => {
    const taskId = await seedTask('sibling is idle between turns')
    await createSessionRecord('sid-dead2', taskId, 'proj')
    await updateSessionRecord('sid-dead2', { process_status: 'stopped' })
    await createSessionRecord('sid-idle', taskId, 'proj')
    await updateSessionRecord('sid-idle', { process_status: 'idle' })

    expect(await handBackTaskOnSessionEnd(taskId, 'sid-dead2', 'test')).toBe(true)
    expect((await getTask(taskId)).phase).toBe(HANDBACK_PHASE)
  })

  it('ignores an archived sibling that is recorded as running', async () => {
    const taskId = await seedTask('archived sibling must not block')
    await createSessionRecord('sid-dead3', taskId, 'proj')
    await updateSessionRecord('sid-dead3', { process_status: 'stopped' })
    await createSessionRecord('sid-arch', taskId, 'proj')
    await updateSessionRecord('sid-arch', { process_status: 'running', archived: true } as never)

    expect(await handBackTaskOnSessionEnd(taskId, 'sid-dead3', 'test')).toBe(true)
  })

  it.each(['source-record', 'sibling-record', 'source-live', 'sibling-live'])('rejects a resume before the task write: %s', async (kind) => {
    const taskId = await seedTask('resume while handing back')
    await updateTask(taskId, { phase: 'IN_PROGRESS' })
    await createSessionRecord('sid-resume', taskId, 'proj')
    await updateSessionRecord('sid-resume', { process_status: 'stopped' })
    await createSessionRecord('sid-peer', taskId, 'proj')
    await updateSessionRecord('sid-peer', { process_status: 'idle' })
    const lookup = vi.spyOn(sessionRunner, 'findSessionByClaudeId').mockReturnValue(undefined)
    const write = taskManager.updateTaskRaw
    const spy = vi.spyOn(taskManager, 'updateTaskRaw').mockImplementationOnce(async (...args) => {
      const sid = kind.startsWith('source') ? 'sid-resume' : 'sid-peer'
      if (kind.endsWith('record')) await updateSessionRecord(sid, { process_status: 'running' })
      else lookup.mockImplementation((id) => id === sid ? { processStatus: 'running' } as never : undefined)
      return write(...args)
    })
    expect(await handBackTaskOnSessionEnd(taskId, 'sid-resume', 'test')).toBe(false)
    expect(spy).toHaveBeenCalledOnce()
    expect((await getTask(taskId)).phase).toBe('IN_PROGRESS')
  })

  it.each(['eligible', 'pending', 'disabled', 'exhausted'] as const)('respects automatic recovery: %s', async (mode) => {
    const taskId = await seedTask('interrupted work')
    await updateTask(taskId, { phase: 'IN_PROGRESS' })
    await createSessionRecord('sid-recovery', taskId, 'proj')
    const rec = await updateSessionRecord('sid-recovery', {
      process_status: 'stopped', status_reason: 'server_restart', type: 'interactive',
      ...(mode === 'exhausted' ? { autoRecover: { attempts: 3, lastAt: new Date().toISOString(), cause: 'server_restart' } } : {}),
    })
    const recovery = startSessionAutoRecover({
      enabled: mode !== 'disabled', delayMs: 20000, staggerMs: 0,
      maxAttempts: 3, maxPerHost: 10, windowMs: 3600000,
    }, { setTimer: () => 1 as never, clearTimer: () => {}, send: vi.fn() })
    try {
      if (mode === 'pending') expect(recovery.instance.schedule(rec, 'server_restart')).toBe(true)
      const shouldHandBack = mode === 'disabled' || mode === 'exhausted'
      expect(await handBackTaskOnSessionEnd(taskId, 'sid-recovery', 'test')).toBe(shouldHandBack)
      expect((await getTask(taskId)).phase).toBe(shouldHandBack ? HANDBACK_PHASE : 'IN_PROGRESS')
    } finally {
      recovery.stop()
    }
  })

  it('is a no-op for a session with no task', async () => {
    expect(await handBackTaskOnSessionEnd(null, 'sid-orphan', 'test')).toBe(false)
    expect(await handBackTaskOnSessionEnd(undefined, 'sid-orphan', 'test')).toBe(false)
  })
})

describe('ACP reconnect hands the task back', () => {
  async function seedAcp(phase: 'IN_PROGRESS' | 'COMPLETE' = 'IN_PROGRESS') {
    const taskId = await seedTask('ACP reconnect')
    await updateTask(taskId, { phase })
    await createSessionRecord('sid-acp', taskId, 'proj')
    await updateSessionRecord('sid-acp', {
      engine: 'opencode', acpRuntimeId: 'runtime-acp', process_status: 'running',
      lastAcceptedAcpCommandId: 'command-before',
    })
    return taskId
  }

  async function reconnect(probe: () => Promise<Record<string, unknown>>) {
    const { DaemonConnection } = await import('../../src/providers/daemon-connection.js')
    const conn = new DaemonConnection('__local__', null)
    const send = vi.spyOn(conn, 'send').mockImplementation(async (command, payload) => {
      expect(command).toBe('acpState')
      expect(payload).toEqual({ sid: 'runtime-acp' })
      return await probe() as never
    })
    try {
      await (conn as unknown as { recoverDisconnectedSessions(): Promise<void> }).recoverDisconnectedSessions()
    } finally {
      send.mockRestore()
    }
  }

  it('hands back a missing worker without losing the lazy-resume identity or repeating the edge', async () => {
    const taskId = await seedAcp()
    await updateSessionRecord('sid-acp', { pendingPermission: { toolName: 'Bash' } as never })
    await reconnect(async () => ({ ok: false, errorKind: 'no_worker' }))
    const { getSessionByClaudeId } = await import('../../src/core/session-tracker.js')
    const settled = await getSessionByClaudeId('sid-acp')
    expect(settled).toMatchObject({ process_status: 'idle', acpRuntimeId: 'runtime-acp' })
    expect(settled?.pendingPermission).toBeUndefined()
    expect((await getTask(taskId)).phase).toBe(HANDBACK_PHASE)
    await updateTask(taskId, { phase: 'IN_PROGRESS' })
    await reconnect(async () => ({ ok: false, errorKind: 'no_worker' }))
    expect((await getTask(taskId)).phase).toBe('IN_PROGRESS')
  })

  it.each(['revision', 'runtime', 'command'] as const)('rejects a stale missing-worker probe after a newer %s', async (change) => {
    const taskId = await seedAcp()
    const { getSessionByClaudeId } = await import('../../src/core/session-tracker.js')
    let newer: Awaited<ReturnType<typeof getSessionByClaudeId>>
    await reconnect(async () => {
      await updateSessionRecord('sid-acp', change === 'revision'
        ? { activity: 'New work' }
        : change === 'runtime' ? { acpRuntimeId: 'runtime-new' }
          : { lastAcceptedAcpCommandId: 'command-new' })
      newer = await getSessionByClaudeId('sid-acp')
      return { ok: false, errorKind: 'no_worker' }
    })
    expect(await getSessionByClaudeId('sid-acp')).toEqual(newer!)
    expect((await getTask(taskId)).phase).toBe('IN_PROGRESS')
  })

  const workerState = (turnActive: boolean, controlActive = false) => ({
    ok: true, result: { turnActive, controlActive, pendingPermissions: [] },
  })

  it('hands back an ended turn even when its worker remains alive', async () => {
    const taskId = await seedAcp()
    await reconnect(async () => workerState(false))
    const { getSessionByClaudeId } = await import('../../src/core/session-tracker.js')
    expect((await getSessionByClaudeId('sid-acp'))?.process_status).toBe('idle')
    expect((await getTask(taskId)).phase).toBe(HANDBACK_PHASE)
    await updateTask(taskId, { phase: 'IN_PROGRESS' })
    await reconnect(async () => workerState(false))
    expect((await getTask(taskId)).phase).toBe('IN_PROGRESS')
  })

  it('keeps an idle session idle during a self-report control request', async () => {
    const taskId = await seedAcp()
    await updateSessionRecord('sid-acp', { process_status: 'idle', status_reason: 'turn_completed' })
    await updateTask(taskId, { phase: HANDBACK_PHASE })
    const { getSessionByClaudeId } = await import('../../src/core/session-tracker.js')
    const before = await getSessionByClaudeId('sid-acp')
    const reattach = vi.fn(async () => true)
    vi.spyOn(sessionRunner, 'findAcpSession').mockReturnValue({ reattachWatcher: reattach } as never)
    await reconnect(async () => workerState(false, true))
    expect(reattach).toHaveBeenCalledOnce()
    expect(await getSessionByClaudeId('sid-acp')).toEqual(before)
    expect((await getTask(taskId)).phase).toBe(HANDBACK_PHASE)
  })

  it.each(['unchanged', 'incomplete', 'superseded'] as const)('restores subscriptions without a status write: %s', async (kind) => {
    await seedAcp()
    await updateSessionRecord('sid-acp', { process_status: 'idle', status_reason: 'turn_completed' })
    const { getSessionByClaudeId } = await import('../../src/core/session-tracker.js')
    let before = await getSessionByClaudeId('sid-acp')
    const reattach = vi.fn(async () => {
      if (kind === 'superseded') {
        await updateSessionRecord('sid-acp', { process_status: 'running', lastAcceptedAcpCommandId: 'command-new' })
        before = await getSessionByClaudeId('sid-acp')
      }
      return true
    })
    vi.spyOn(sessionRunner, 'findAcpSession').mockReturnValue({ reattachWatcher: reattach } as never)
    await reconnect(async () => kind === 'incomplete' ? { ok: true } : workerState(false))
    expect(reattach).toHaveBeenCalledOnce()
    expect(await getSessionByClaudeId('sid-acp')).toEqual(before)
  })

  it.each(['turn', 'control', 'permission', 'missing-state'] as const)('does not settle a live worker with %s', async (kind) => {
    const taskId = await seedAcp()
    await reconnect(async () => kind === 'missing-state' ? { ok: true }
      : kind === 'permission' ? { ok: true, result: { turnActive: false, controlActive: false, pendingPermissions: [{ providerRequestId: 'pending-1' }] } }
        : workerState(kind === 'turn', kind === 'control'))
    const { getSessionByClaudeId } = await import('../../src/core/session-tracker.js')
    expect((await getSessionByClaudeId('sid-acp'))?.process_status).toBe('running')
    expect((await getTask(taskId)).phase).toBe('IN_PROGRESS')
  })

  it('does not let a slow live-worker response erase a newer waiting state', async () => {
    const taskId = await seedAcp()
    await reconnect(async () => {
      await updateSessionRecord('sid-acp', { pendingPermission: { toolName: 'AskUserQuestion' } as never, activity: 'Waiting' })
      return workerState(false)
    })
    const { getSessionByClaudeId } = await import('../../src/core/session-tracker.js')
    expect(await getSessionByClaudeId('sid-acp')).toMatchObject({ activity: 'Waiting', pendingPermission: { toolName: 'AskUserQuestion' } })
    expect((await getTask(taskId)).phase).toBe('IN_PROGRESS')
  })

  it('rejects a new turn between session settlement and the task write', async () => {
    const taskId = await seedAcp()
    const write = taskManager.updateTaskRaw
    const spy = vi.spyOn(taskManager, 'updateTaskRaw').mockImplementationOnce(async (...args) => {
      await updateSessionRecord('sid-acp', { process_status: 'running', lastAcceptedAcpCommandId: 'command-new' })
      return write(...args)
    })
    await reconnect(async () => ({ ok: false, errorKind: 'no_worker' }))
    expect(spy).toHaveBeenCalledOnce()
    expect((await getTask(taskId)).phase).toBe('IN_PROGRESS')
  })

  it.each(['timeout', 'rpc-error', 'live', 'complete'] as const)('does not hand back on %s', async (kind) => {
    const taskId = await seedAcp(kind === 'complete' ? 'COMPLETE' : 'IN_PROGRESS')
    await reconnect(async () => {
      if (kind === 'timeout') throw new Error('Probe timed out')
      return kind === 'live' ? workerState(true)
        : { ok: false, errorKind: kind === 'complete' ? 'no_worker' : 'rpc_error' }
    })
    expect((await getTask(taskId)).phase).toBe(kind === 'complete' ? 'COMPLETE' : 'IN_PROGRESS')
    if (kind === 'rpc-error' || kind === 'timeout') {
      const { getSessionByClaudeId } = await import('../../src/core/session-tracker.js')
      expect((await getSessionByClaudeId('sid-acp'))?.process_status).toBe('running')
    }
  })
})

describe('startup reconciler hands the task back', () => {
  it('a zombie session killed by the server restart turns its TODO task red', async () => {
    const taskId = await seedTask('was mid-turn when the server died')
    // 'interactive' + non-terminal + no pid → the reconciler's dead-zombie path.
    await createSessionRecord('zombie-1', taskId, 'proj')
    await updateSessionRecord('zombie-1', { process_status: 'running', type: 'interactive' } as never)

    const result = await reconcileSessions()
    expect(result.reconciled).toBeGreaterThan(0)

    // Both halves of the fix: the record AND the phase.
    const task = await getTask(taskId)
    expect(task.phase).toBe(HANDBACK_PHASE)
  })

  it('keeps interrupted work recoverable until the scheduler sends the resume', async () => {
    const taskId = await seedTask('resume after restart')
    await updateTask(taskId, { phase: 'IN_PROGRESS' })
    await createSessionRecord('zombie-recover', taskId, 'proj')
    await updateSessionRecord('zombie-recover', { process_status: 'running', type: 'interactive' })
    let fire!: () => void
    const send = vi.fn(async () => ({}))
    const recovery = startSessionAutoRecover({
      enabled: true, delayMs: 20000, staggerMs: 0,
      maxAttempts: 3, maxPerHost: 10, windowMs: 3600000,
    }, { setTimer: (fn) => { fire = fn; return 1 as never }, clearTimer: () => {}, send, recoveryOwner: async () => 'server' })
    try {
      const result = await reconcileSessions()
      expect((await getTask(taskId)).phase).toBe('IN_PROGRESS')
      const rec = result.dead.find((s) => s.claudeSessionId === 'zombie-recover')!
      expect(recovery.instance.schedule(rec, 'server_restart')).toBe(true)
      fire()
      await vi.waitFor(() => expect(send).toHaveBeenCalledOnce())
      expect(send).toHaveBeenCalledWith('zombie-recover', expect.stringContaining('[Walnut auto-recover]'), {
        source: 'auto-recover', taskId,
      })
    } finally {
      recovery.stop()
    }
  })

  it('does not touch a task the human already completed', async () => {
    const taskId = await seedTask('finished, session never cleaned up')
    await updateTask(taskId, { phase: 'COMPLETE' })
    await createSessionRecord('zombie-2', taskId, 'proj')
    await updateSessionRecord('zombie-2', { process_status: 'running', type: 'interactive' } as never)

    await reconcileSessions()
    expect((await getTask(taskId)).phase).toBe('COMPLETE')
  })
})
