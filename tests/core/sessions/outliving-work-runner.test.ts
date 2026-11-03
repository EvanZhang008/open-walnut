/**
 * The live runner's list of its own work that runs on after the turn (ClaudeCodeSession.outlivingWork,
 * sessions/outliving-work.ts), fed Claude Code's stream lines one at a time: a background Agent
 * subagent, a recurring /loop, a one-shot cron (which ends at its fire with no CronDelete, so it
 * must not keep the task reading Working), a CronDelete, and the CLI's 7-day end of a recurring one.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-outliving-runner'))

const sendMessageToSession = vi.hoisted(() => vi.fn(async () => ({ id: 'qm-1' })))
vi.mock('../../../src/core/session-message-queue.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/core/session-message-queue.js')>()),
  sendMessageToSession,
}))
const getSessionByClaudeId = vi.hoisted(() => vi.fn(async () => null))
vi.mock('../../../src/core/session-tracker.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/core/session-tracker.js')>()),
  getSessionByClaudeId,
}))

import { bus } from '../../../src/core/event-bus.js'
import { ClaudeCodeSession } from '../../../src/providers/claude-code-session.js'

const SID = 'cccccccc-1111-2222-3333-444444444444'

function runner(): { session: ClaudeCodeSession; feed: (obj: unknown) => void } {
  const session = new ClaudeCodeSession('task-outliving', 'proj', 'true')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(session as any).claudeSessionId = SID
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { session, feed: (obj) => (session as any).handleStreamLine(JSON.stringify(obj)) }
}

const toolUse = (id: string, name: string, input: Record<string, unknown>) => ({
  type: 'assistant', session_id: SID,
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
})
const toolResult = (id: string, result: Record<string, unknown>, isError = false) => ({
  type: 'user', session_id: SID,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok', ...(isError ? { is_error: true } : {}) }] },
  tool_use_result: result,
})

beforeEach(() => { bus.clear() })
afterEach(() => { vi.useRealTimers() })

describe('ClaudeCodeSession.outlivingWork', () => {
  it('a background Agent subagent is background work until its notification', () => {
    const { session, feed } = runner()
    expect(session.outlivingWork).toEqual([])
    feed({ type: 'system', subtype: 'task_started', task_id: 'a1', tool_use_id: 'tu-a1', description: 'review', subagent_type: 'general-purpose', is_backgrounded: true, task_type: 'local_agent', session_id: SID })
    expect(session.outlivingWork).toEqual(['background'])
    expect(session.workOutlivesTurn).toBe(true)
    feed({ type: 'system', subtype: 'task_updated', task_id: 'a1', patch: { status: 'completed', end_time: Date.now() }, session_id: SID })
    feed({ type: 'system', subtype: 'task_notification', task_id: 'a1', tool_use_id: 'tu-a1', status: 'completed', session_id: SID })
    expect(session.outlivingWork).toEqual([])
  })

  it('a recurring /loop counts until its CronDelete', () => {
    const { session, feed } = runner()
    feed(toolUse('tu-c1', 'CronCreate', { cron: '*/10 * * * *', prompt: 'check the build', recurring: true }))
    feed(toolResult('tu-c1', { id: 'job-1' }))
    expect(session.outlivingWork).toEqual(['loop'])
    feed(toolUse('tu-d1', 'CronDelete', { id: 'job-1' }))
    expect(session.outlivingWork).toEqual([])
    expect(session.cronArmed).toBe(false)
  })

  it('a one-shot cron keeps the reap away but is no /loop for the status', () => {
    const { session, feed } = runner()
    feed(toolUse('tu-c2', 'CronCreate', { cron: '0 15 * * *', prompt: 'remind me', recurring: false }))
    feed(toolResult('tu-c2', { id: 'job-2' }))
    expect(session.cronArmed).toBe(true)
    expect(session.outlivingWork).toEqual([])
  })

  it('a rejected create arms nothing', () => {
    const { session, feed } = runner()
    feed(toolUse('tu-c3', 'CronCreate', { cron: 'bad', prompt: 'x' }))
    feed(toolResult('tu-c3', {}, true))
    expect(session.outlivingWork).toEqual([])
  })

  it('the CLI ends a recurring /loop after 7 days', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-03T00:00:00Z'))
    const { session, feed } = runner()
    feed(toolUse('tu-c4', 'CronCreate', { cron: '0 * * * *', prompt: 'digest' }))
    feed(toolResult('tu-c4', { id: 'job-4' }))
    expect(session.outlivingWork).toEqual(['loop'])
    vi.setSystemTime(new Date('2026-11-10T00:00:01Z'))
    expect(session.outlivingWork).toEqual([])
  })
})
