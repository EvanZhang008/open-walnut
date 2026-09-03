/**
 * The cache-to-the-limit invariant, tested against the REAL handleStart:
 * a side-thread fork's `--append-system-prompt` must be BYTE-IDENTICAL to the
 * parent's stored spawn-time prompt (`appliedAppendSystemPrompt`) — the system
 * prompt is the first block of the API prefix, so any divergence collapses the
 * fork's prompt-cache reuse (measured live: 232K → 15K cache_read).
 *
 * SAFETY: `ClaudeCodeSession.prototype.send` is stubbed before any test body —
 * no `claude` process is ever spawned; only the ARGUMENTS reaching send() are
 * asserted.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fsp from 'node:fs/promises'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-side-prompt'))

import { WALNUT_HOME } from '../../src/constants.js'
import {
  createSessionRecord, getSessionByClaudeId, updateSessionRecord,
} from '../../src/core/session-tracker.js'
import { ClaudeCodeSession, sessionRunner } from '../../src/providers/claude-code-session.js'

const PARENT = '33333333-3333-4333-8333-333333333333'
const THREAD = '44444444-4444-4444-8444-444444444444'
const PARENT_PROMPT = '## Walnut Session Context\nTask: Fix the FIFO stall\nExact bytes matter here — 你好.\n'

/** send() is arg-position plumbing; capture what handleStart passes. */
let sendCalls: unknown[][] = []

const runnerInternals = sessionRunner as unknown as {
  handleStart(data: Record<string, unknown>): Promise<void>
}

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

async function startSideThread(): Promise<void> {
  // The record is seeded before the spawn, exactly as forkSideThreadSession does.
  await createSessionRecord(THREAD, '', 'proj', '/repo/walnut', {
    lane: `side:${PARENT}:sth-1`,
    forkedFromSessionId: PARENT,
    initialProcessStatus: 'idle',
    initialStatusReason: 'awaiting_spawn',
  })
  await runnerInternals.handleStart({
    preassignedSessionId: THREAD,
    taskId: '',
    message: '',
    cwd: '/repo/walnut',
    project: 'proj',
    lane: `side:${PARENT}:sth-1`,
    forkedFromSessionId: PARENT,
  })
}

/** Let handleStart's fire-and-forget persist land. */
async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve()
  await new Promise((r) => setTimeout(r, 25))
}

describe('side-thread system-prompt inheritance (real handleStart)', () => {
  it('re-sends the parent stored prompt VERBATIM as --append-system-prompt', async () => {
    await createSessionRecord(PARENT, 'task-1', 'proj', '/repo/walnut', {})
    // The field lands via updateSessionRecord in production (the persist hunk).
    await updateSessionRecord(PARENT, { appliedAppendSystemPrompt: PARENT_PROMPT })
    await startSideThread()

    expect(sendCalls).toHaveLength(1)
    // Byte-for-byte: NOT a freshly built context, the parent's exact string.
    expect(sendCalls[0]![5]).toBe(PARENT_PROMPT)
  })

  it('persists the inherited prompt on the THREAD record too (thread-of-thread stays consistent)', async () => {
    await createSessionRecord(PARENT, 'task-1', 'proj', '/repo/walnut', {})
    await updateSessionRecord(PARENT, { appliedAppendSystemPrompt: PARENT_PROMPT })
    await startSideThread()
    await settle()

    expect((await getSessionByClaudeId(THREAD))?.appliedAppendSystemPrompt).toBe(PARENT_PROMPT)
  })

  it('spawns with NO append prompt when the parent has no stored prompt (never a fresh build)', async () => {
    await createSessionRecord(PARENT, 'task-1', 'proj', '/repo/walnut', {})
    await startSideThread()

    expect(sendCalls).toHaveLength(1)
    // A fresh build could never match the parent's prefix; absence at least
    // matches a parent that was cold-resumed without one.
    expect(sendCalls[0]![5]).toBeUndefined()
  })

  it("an explicit '' (parent launched without a prompt) also spawns with none", async () => {
    await createSessionRecord(PARENT, 'task-1', 'proj', '/repo/walnut', {})
    await updateSessionRecord(PARENT, { appliedAppendSystemPrompt: '' })
    await startSideThread()

    expect(sendCalls[0]![5]).toBeUndefined()
  })

  it('the exact prompt carried on the start event wins over the record', async () => {
    await createSessionRecord(PARENT, 'task-1', 'proj', '/repo/walnut', {})
    await updateSessionRecord(PARENT, { appliedAppendSystemPrompt: 'record copy' })
    await createSessionRecord(THREAD, '', 'proj', '/repo/walnut', {
      lane: `side:${PARENT}:sth-1`, forkedFromSessionId: PARENT,
      initialProcessStatus: 'idle', initialStatusReason: 'awaiting_spawn',
    })
    await runnerInternals.handleStart({
      preassignedSessionId: THREAD, taskId: '', message: '', cwd: '/repo/walnut', project: 'proj',
      lane: `side:${PARENT}:sth-1`, forkedFromSessionId: PARENT,
      appendSystemPromptExact: 'live copy',
    })
    expect(sendCalls[0]![5]).toBe('live copy')
  })

  it('refuses an oversized stored prompt (spawn-argv safety cap) and spawns with none', async () => {
    await createSessionRecord(PARENT, 'task-1', 'proj', '/repo/walnut', {})
    await updateSessionRecord(PARENT, { appliedAppendSystemPrompt: 'x'.repeat(70_000) })
    await startSideThread()

    expect(sendCalls).toHaveLength(1)
    expect(sendCalls[0]![5]).toBeUndefined()
  })
})
