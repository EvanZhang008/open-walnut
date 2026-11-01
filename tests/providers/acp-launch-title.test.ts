/**
 * An ACP launch kicks the task's AI title, as a native launch does (quick-start fires
 * autoTitleFromLaunch only for a native launch, whose session id it knows before the
 * spawn). 2026-11-01: no OpenCode session on a local model ever got an AI title; the
 * server log of both Mac runs had no session-auto-title line at all.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-acp-launch-title'))

const titleKick = vi.fn(async () => true)
vi.mock('../../src/core/session-hooks/builtins.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/session-hooks/builtins.js')>()),
  autoTitleFromObservedMessage: (...args: unknown[]) => titleKick(...(args as [])),
}))

let nextSid = 0
vi.mock('../../src/providers/acp-session.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/providers/acp-session.js')>()
  class FakeAcpSession {
    runtimeId = `rt-launch-${++nextSid}`
    sessionId: string | undefined
    activity = 'idle'
    sessionControls: unknown[] = []
    constructor(readonly cfg: Record<string, unknown>) {}
    async establish() { this.sessionId = `acp-launch-sid-${nextSid}`; return this.sessionId }
    async send() {}
    async abortTurn() {}
    async requestTurnCompleteSelfReport() { return '' }
  }
  return { ...actual, AcpSession: FakeAcpSession }
})

import { WALNUT_HOME } from '../../src/constants.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { addTask } from '../../src/core/task-manager.js'
import { createSessionRecord } from '../../src/core/session-tracker.js'

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
})

describe('ACP launch title', () => {
  it('asks for the task title with the launch words once the session has its id', async () => {
    const { task } = await addTask({ title: 'Session: demo' })
    const start = (sessionRunner as unknown as {
      handleAcpStart(data: Record<string, unknown>): Promise<{ claudeSessionId: string }>
    }).handleAcpStart.bind(sessionRunner)
    // The record the runner updates after establish (in production the start path made it).
    await createSessionRecord(`acp-launch-sid-${nextSid + 1}`, task.id, '', '/tmp/demo', { engine: 'opencode' } as never)
    const { claudeSessionId } = await start({
      taskId: task.id, message: 'count.py counts words wrong, fix it', engine: 'opencode', cwd: '/tmp/demo',
    })
    await vi.waitFor(() => expect(titleKick).toHaveBeenCalledTimes(1))
    expect(titleKick).toHaveBeenCalledWith(claudeSessionId, task.id, 'count.py counts words wrong, fix it')
  })
})
