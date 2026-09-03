/**
 * retrySession conversation pre-flight (2026-08-13 incident).
 *
 * A CLI killed within ~2s of its FIRST spawn never persists a conversation
 * JSONL under ~/.claude/projects. Every `claude --resume <sid>` then exits 1
 * with "No conversation found" — the UI's Retry button was an unfixable loop.
 *
 * retrySession must now probe for the conversation file before choosing the
 * --resume path:
 *   - file exists  → resume (unchanged behavior)
 *   - file missing → archive (conversation_never_persisted) + fresh session
 *     reusing the pending queue text as the new first message.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-retry-preflight'))

// Local JSONL probe — the unit under control. Default: conversation missing.
const findLocalJsonlPath = vi.fn(async () => null as string | null)
vi.mock('../../src/core/session-file-reader.js', () => ({
  findLocalJsonlPath,
}))

// Liveness: always dead (we're testing the dead-process branch).
vi.mock('../../src/utils/session-liveness.js', () => ({
  isSessionProcessAlive: vi.fn(async () => false),
}))

// Task lookup: minimal live task so the fresh-start path can proceed.
vi.mock('../../src/core/task-manager.js', () => ({
  getTask: vi.fn(async (id: string) => ({ id, project: 'proj' })),
  clearSession: vi.fn(async () => {}),
  clearSessionSlot: vi.fn(async () => {}),
}))

import { WALNUT_HOME } from '../../src/constants.js'
import { bus, EventNames } from '../../src/core/event-bus.js'
import { createSessionRecord, getSessionByClaudeId, updateSessionRecord } from '../../src/core/session-tracker.js'
import { sendMessageToSession, getQueue } from '../../src/core/session-message-queue.js'
import { retrySession } from '../../src/core/sessions/session-lifecycle.js'

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  findLocalJsonlPath.mockReset()
  findLocalJsonlPath.mockResolvedValue(null)
})

afterEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('retrySession conversation pre-flight', () => {
  it('conversation missing → archives the record and starts a FRESH session (no --resume loop)', async () => {
    const sid = 'retry-pf-missing'
    await createSessionRecord(sid, 'task-pf1', 'proj', '/tmp', { initialProcessStatus: 'error' })
    // The message the user tried to send (what Retry should carry over).
    await sendMessageToSession(sid, 'original user prompt', { taskId: 'task-pf1' })

    const started: unknown[] = []
    bus.subscribe('session-runner', (event) => {
      if (event.name === EventNames.SESSION_START) started.push(event.data)
    })
    try {
      const res = await retrySession(sid)
      expect(res.status).toBe('pending')

      // Old record archived with the dedicated reason (not generic 'retry').
      const rec = await getSessionByClaudeId(sid)
      expect(rec?.archived).toBe(true)
      expect(rec?.archive_reason).toBe('conversation_never_persisted')

      // A fresh session was requested with the original message text.
      expect(started).toHaveLength(1)
      expect((started[0] as { message: string }).message).toBe('original user prompt')
    } finally {
      bus.unsubscribe('session-runner')
    }
  })

  it('conversation present → keeps the session resumable and enqueues NOTHING', async () => {
    const sid = 'retry-pf-present'
    findLocalJsonlPath.mockResolvedValue(`/fake/projects/x/${sid}.jsonl`)
    await createSessionRecord(sid, 'task-pf2', 'proj', '/tmp', { initialProcessStatus: 'error' })

    const res = await retrySession(sid)
    expect(res.status).toBe('resumable')

    // Record NOT archived, and no synthesized message: Retry reconnects, the
    // user's next message is what triggers --resume (see retrySession path 3).
    const rec = await getSessionByClaudeId(sid)
    expect(rec?.archived).not.toBe(true)
    expect(await getQueue(sid)).toHaveLength(0)
  })

  it('probe failure → fails open to the resumable path (daemon down must not force a fresh session)', async () => {
    const sid = 'retry-pf-error'
    findLocalJsonlPath.mockRejectedValue(new Error('daemon unreachable'))
    await createSessionRecord(sid, 'task-pf3', 'proj', '/tmp', { initialProcessStatus: 'error' })

    const res = await retrySession(sid)
    expect(res.status).toBe('resumable')
    const rec = await getSessionByClaudeId(sid)
    expect(rec?.archived).not.toBe(true)
  })

  it('non-claude engines skip the probe entirely', async () => {
    const sid = 'retry-pf-acp'
    await createSessionRecord(sid, 'task-pf4', 'proj', '/tmp', { initialProcessStatus: 'error' })
    await updateSessionRecord(sid, { engine: 'codex' } as Record<string, unknown>)

    const res = await retrySession(sid)
    expect(res.status).toBe('resumable')
    expect(findLocalJsonlPath).not.toHaveBeenCalled()
  })
})
