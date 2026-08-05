/**
 * applySessionPhase integration tests for the two 2026-08-03/04 status-mismatch
 * fixes that need real task + session records:
 *
 *  1. session:turn-start — the CLI's session_state_changed{running} pulls a
 *     task flipped to AGENT_COMPLETE/AWAIT back to IN_PROGRESS (queued-send
 *     race, incidents 46f42871 + 1f11596b).
 *  2. triage-sync running gate — a late triage (debounced summary of the
 *     PREVIOUS turn) must not push AGENT_COMPLETE → AWAIT_HUMAN_ACTION while
 *     the session is actively running the NEXT turn (the reverse race of the
 *     same incidents).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants())

import { applySessionPhase } from '../../src/core/phase.js'
import { addTask, updateTaskRaw, getTask } from '../../src/core/task-manager.js'
import {
  createSessionRecord,
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
  await fsp.mkdir(path.dirname(TASKS_FILE), { recursive: true })
})

afterEach(async () => {
  closeDb()
  _resetSessionTrackerForTesting()
  await fsp.rm(tmpDir, { recursive: true, force: true })
})

async function taskInPhase(phase: string): Promise<string> {
  const { task } = await addTask({ title: 't', category: 'c', project: 'p' })
  await updateTaskRaw(task.id, { phase: phase as never })
  return task.id
}

describe('applySessionPhase: session:turn-start', () => {
  it('INCIDENT SHAPE: AGENT_COMPLETE → IN_PROGRESS when the queued turn actually starts', async () => {
    const taskId = await taskInPhase('AGENT_COMPLETE')
    const res = await applySessionPhase(taskId, 'session:turn-start', 'test', { sessionId: 'sid-1' })
    expect(res.changed).toBe(true)
    expect((await getTask(taskId)).phase).toBe('IN_PROGRESS')
  })

  it('clears needs_attention on the pullback (red row goes away)', async () => {
    const taskId = await taskInPhase('AWAIT_HUMAN_ACTION')
    await updateTaskRaw(taskId, { needs_attention: true })
    await applySessionPhase(taskId, 'session:turn-start', 'test', { sessionId: 'sid-1' })
    const task = await getTask(taskId)
    expect(task.phase).toBe('IN_PROGRESS')
    expect(task.needs_attention).toBeFalsy()
  })

  it('no-op on IN_PROGRESS (every turn re-fires the trigger)', async () => {
    const taskId = await taskInPhase('IN_PROGRESS')
    const res = await applySessionPhase(taskId, 'session:turn-start', 'test', { sessionId: 'sid-1' })
    expect(res.changed).toBe(false)
  })

  it('never overwrites a terminal phase', async () => {
    const taskId = await taskInPhase('COMPLETE')
    const res = await applySessionPhase(taskId, 'session:turn-start', 'test', { sessionId: 'sid-1' })
    expect(res.changed).toBe(false)
    expect((await getTask(taskId)).phase).toBe('COMPLETE')
  })
})

describe('applySessionPhase: triage-sync running gate', () => {
  it('REVERSE RACE: triage does NOT push AWAIT while the session is running the next turn', async () => {
    const taskId = await taskInPhase('AGENT_COMPLETE')
    await createSessionRecord('sid-running', taskId, 'proj')
    await updateSessionRecord('sid-running', { process_status: 'running' })

    const res = await applySessionPhase(taskId, 'triage-sync', 'test', { sessionId: 'sid-running' })
    expect(res.changed).toBe(false)
    expect((await getTask(taskId)).phase).toBe('AGENT_COMPLETE')
  })

  it('triage still pushes AWAIT when the session is settled (idle)', async () => {
    const taskId = await taskInPhase('AGENT_COMPLETE')
    await createSessionRecord('sid-idle', taskId, 'proj')
    await updateSessionRecord('sid-idle', { process_status: 'idle' })

    const res = await applySessionPhase(taskId, 'triage-sync', 'test', { sessionId: 'sid-idle' })
    expect(res.changed).toBe(true)
    expect((await getTask(taskId)).phase).toBe('AWAIT_HUMAN_ACTION')
  })

  it('unknown session record → gate fails open (pre-guard behavior preserved)', async () => {
    const taskId = await taskInPhase('AGENT_COMPLETE')
    const res = await applySessionPhase(taskId, 'triage-sync', 'test', { sessionId: 'sid-ghost' })
    expect(res.changed).toBe(true)
    expect((await getTask(taskId)).phase).toBe('AWAIT_HUMAN_ACTION')
  })
})
