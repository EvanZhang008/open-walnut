/**
 * A session started with a client's own send id (task-start.ts `firstLineUuid`) writes its first
 * user line under that uuid, tested against the REAL handleStart (send() stubbed, nothing spawns).
 *
 * 2026-11-22: a quick bar send that started a task's session, then Walnut restarted before it
 * answered, then the bar sent it again by itself: the first line carried the CLI's own uuid, so the
 * resend found neither a queued row nor a ran line under its uuid (send-once.ts sameSendSettled)
 * and went in a second time. Now the line goes out under the send's uuid; a fork's first line is
 * never that send, so it carries none.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fsp from 'node:fs/promises'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-first-line-uuid'))

import { WALNUT_HOME } from '../../src/constants.js'
import { createSessionRecord } from '../../src/core/session-tracker.js'
import { ClaudeCodeSession, sessionRunner } from '../../src/providers/claude-code-session.js'

const SID = '55555555-5555-4555-8555-555555555555'
const PARENT = '66666666-6666-4666-8666-666666666666'
const LINE = '3e1f0a9b-4c5d-4e6f-8a0b-1c2d3e4f5a6b'

let sendCalls: unknown[][] = []
const runner = sessionRunner as unknown as { handleStart(data: Record<string, unknown>): Promise<void> }

beforeEach(async () => {
  sendCalls = []
  vi.spyOn(ClaudeCodeSession.prototype, 'send').mockImplementation(function (...args: unknown[]) {
    sendCalls.push(args)
  } as never)
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
  const [sessionDb, sessionTracker] = await Promise.all([
    import('../../src/core/session-db.js'),
    import('../../src/core/session-tracker.js'),
  ])
  sessionDb.closeDb()
  sessionTracker._resetSessionTrackerForTesting()
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
})

/** send()'s last argument: the spawn options (preassigned id, lane, the first line's uuid, ...). */
const spawnOpts = () => sendCalls[0]!.at(-1) as Record<string, unknown> | undefined

describe("a new session's first line goes out under the send's own uuid", () => {
  it('a start that names one hands it to the spawn; one that names none hands none', async () => {
    await createSessionRecord(SID, '', 'proj', '/repo/walnut', { lane: 'test-first-line', initialProcessStatus: 'idle', initialStatusReason: 'awaiting_spawn' })
    await runner.handleStart({ preassignedSessionId: SID, taskId: '', message: 'Take the 9am one', cwd: '/repo/walnut', project: 'proj', lane: 'test-first-line', firstLineUuid: LINE })
    expect(sendCalls).toHaveLength(1)
    expect(spawnOpts()).toMatchObject({ preassignedSessionId: SID, uuid: LINE })

    sendCalls = []
    await runner.handleStart({ preassignedSessionId: SID, taskId: '', message: 'Take the 9am one', cwd: '/repo/walnut', project: 'proj', lane: 'test-first-line' })
    expect(spawnOpts()?.uuid).toBeUndefined()
  })

  it('never on a fork: its first line is not that send', async () => {
    await createSessionRecord(PARENT, 'task-1', 'proj', '/repo/walnut', {})
    await createSessionRecord(SID, '', 'proj', '/repo/walnut', {
      lane: `side:${PARENT}:sth-1`, forkedFromSessionId: PARENT, initialProcessStatus: 'idle', initialStatusReason: 'awaiting_spawn',
    })
    await runner.handleStart({
      preassignedSessionId: SID, taskId: '', message: '', cwd: '/repo/walnut', project: 'proj',
      lane: `side:${PARENT}:sth-1`, forkedFromSessionId: PARENT, firstLineUuid: LINE,
    })
    expect(sendCalls).toHaveLength(1)
    expect(spawnOpts()?.uuid).toBeUndefined()
  })
})
