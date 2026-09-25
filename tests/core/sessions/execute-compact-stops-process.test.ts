import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-execute-compact-stop'))

// Every step records into one log, so the test reads the order the steps ran in.
const steps: string[] = []

vi.mock('../../../src/core/session-tracker.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/core/session-tracker.js')>(),
  getSessionByClaudeId: vi.fn(async () => ({
    claudeSessionId: 'plan-session', taskId: 'task-1', cwd: '/tmp/compact-fixture', process_status: 'idle',
  })),
  updateSessionRecord: vi.fn(async () => ({})),
}))
vi.mock('../../../src/utils/plan-message.js', () => ({
  readPlanFromSession: vi.fn(async () => ({ content: 'Plan body', planFile: '/tmp/compact-fixture/plan.md' })),
  buildPlanExecutionMessage: vi.fn(() => 'Execute the plan'),
}))
vi.mock('../../../src/core/session-file-reader.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/core/session-file-reader.js')>(),
  findLocalJsonlPath: vi.fn(async () => '/tmp/compact-fixture/plan-session.jsonl'),
}))
vi.mock('../../../src/utils/compact-inject.js', () => ({
  buildCompactSummary: vi.fn(() => 'Summary'),
  injectCompactBoundary: vi.fn(async () => { steps.push('inject'); return true }),
}))
vi.mock('../../../src/core/session-message-queue.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/core/session-message-queue.js')>(),
  sendMessageToSession: vi.fn(async () => { steps.push('send'); return { messageId: 'qm-1' } }),
}))

import { executeCompactSession } from '../../../src/core/sessions/session-extras.js'
import { sessionRunner, type ClaudeCodeSession } from '../../../src/providers/claude-code-session.js'

describe('execute-compact on a live session', () => {
  afterEach(() => {
    steps.length = 0
    vi.restoreAllMocks()
  })

  it('stops the CLI process and waits for the stop before rewriting its transcript', async () => {
    // A live CLI keeps its history in memory; interrupting only its turn would let it
    // keep running on the old context, so compact needs the process gone first.
    const live = {
      stopProcess: vi.fn(async () => {
        steps.push('stop requested')
        await new Promise((resolve) => setTimeout(resolve, 20))
        steps.push('stop confirmed')
      }),
      interrupt: vi.fn(async () => { steps.push('turn interrupted') }),
    }
    vi.spyOn(sessionRunner, 'findByClaudeId').mockReturnValue(live as unknown as ClaudeCodeSession)

    await executeCompactSession('plan-session', {})

    expect(steps).toEqual(['stop requested', 'stop confirmed', 'inject', 'send'])
    expect(live.interrupt).not.toHaveBeenCalled()
  })

  it('a failed stop leaves the transcript untouched', async () => {
    const live = { stopProcess: vi.fn(async () => { throw new Error('Daemon did not confirm the stop') }) }
    vi.spyOn(sessionRunner, 'findByClaudeId').mockReturnValue(live as unknown as ClaudeCodeSession)

    await expect(executeCompactSession('plan-session', {})).rejects.toThrow('Daemon did not confirm the stop')
    expect(steps).toEqual([])
  })
})
