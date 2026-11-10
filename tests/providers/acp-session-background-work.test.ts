/**
 * A command a direct Codex session's turn left running (the worker's `background-work` records):
 * the session is on the job while it runs (the runner's outliving work, the turn's result keeps
 * the task in progress), and its end wakes the session through the normal queue, once.
 */
import fs from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-acp-session-background-work'))

const sends = vi.hoisted(() => [] as Array<{ sessionId: string; text: string; opts: Record<string, unknown> }>)
vi.mock('../../src/core/session-message-queue.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendMessageToSession: vi.fn(async (sessionId: string, text: string, opts: Record<string, unknown>) => {
    sends.push({ sessionId, text, opts })
    return { id: opts.messageId }
  }),
}))
const phases = vi.hoisted(() => [] as Array<{ taskId: string; event: string; by: string }>)
vi.mock('../../src/core/phase.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  applySessionPhase: vi.fn(async (taskId: string, event: string, by: string) => { phases.push({ taskId, event, by }) }),
}))

import { WALNUT_HOME } from '../../src/constants.js'
import { _resetSessionTrackerForTesting, createSessionRecord } from '../../src/core/session-tracker.js'
import { AcpSession } from '../../src/providers/acp-session.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { bus, EventNames } from '../../src/core/event-bus.js'
import { BACKGROUND_WORK_ENDED_SOURCE, backgroundWorkEndedText } from '../../src/core/sessions/background-work-wake.js'

const SID = 'codex-bg-1'
const RT = 'rt-bg-1'
const build = { processId: '4242', command: 'make build' }

beforeEach(async () => {
  _resetSessionTrackerForTesting()
  sends.length = 0
  phases.length = 0
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
})
afterEach(() => {
  bus.unsubscribe('acp-bg-test')
  ;(sessionRunner as unknown as { acpSessions: Map<string, unknown> }).acpSessions.delete(SID)
})

async function setup() {
  await createSessionRecord(SID, 'task-bg', 'Quick Start', '/tmp', {
    initialProcessStatus: 'running', messageCount: 0, engine: 'codex', acpRuntimeId: RT,
  })
  const session = new AcpSession({
    taskId: 'task-bg', project: 'Quick Start', cwd: '/tmp', mode: 'default', engine: 'codex',
    providerSessionId: SID, runtimeId: RT, consumedOffset: 0,
  })
  ;(session as unknown as { _active: boolean })._active = true
  ;(sessionRunner as unknown as { acpSessions: Map<string, unknown> }).acpSessions.set(SID, session)
  const results: Array<Record<string, unknown>> = []
  bus.subscribe('acp-bg-test', (e) => { if (e.name === EventNames.SESSION_RESULT) results.push(e.data as Record<string, unknown>) },
    { global: true, interest: [EventNames.SESSION_RESULT] })
  const consume = (session as unknown as { consumeJournalLine(line: string, offset: number): void }).consumeJournalLine.bind(session)
  const meta = (v: number, event: Record<string, unknown>) => consume(JSON.stringify({ kind: 'meta', ts: v, event }), v)
  const turn = (v: number, commandId: string) => {
    meta(v, { type: 'prompt-accepted', commandId, walnutMessageId: `m-${commandId}`, text: 'go' })
    meta(v + 1, { type: 'turn-started', commandId })
  }
  const endTurn = (v: number, commandId: string) => meta(v, { type: 'turn-ended', commandId, stopReason: 'end_turn' })
  const bg = (v: number, running: unknown[], finished: unknown[] = []) => meta(v, { type: 'background-work', running, finished })
  return { session, results, meta, turn, endTurn, bg }
}

describe('a command a direct Codex turn left running', () => {
  it('keeps the session on the job, and its end wakes it once with what it printed', async () => {
    const { session, results, turn, endTurn, bg } = await setup()
    turn(10, 'c1')
    // Ahead of the turn's end, as the worker writes it.
    bg(20, [build])
    expect(session.outlivingWork).toEqual([])
    endTurn(21, 'c1')
    // The turn ended, the work did not: the result keeps the task in progress.
    expect(results.at(-1)).toMatchObject({ detachedBgActive: true })
    expect(session.outlivingWork).toEqual(['background'])
    // Every place that asks the runner sees it: user status, idle reap, request settling.
    expect(sessionRunner.outlivingWorkOf(SID)).toEqual(['background'])
    expect(sessionRunner.hasWorkOutlivingTurn(SID)).toBe(true)

    bg(30, [], [{ ...build, exitCode: 0, output: 'compiling\nBUILD OK\n' }])
    expect(session.outlivingWork).toEqual([])
    expect(sessionRunner.hasWorkOutlivingTurn(SID)).toBe(false)
    await vi.waitFor(() => expect(sends).toHaveLength(1))
    expect(sends[0]).toMatchObject({ sessionId: SID, opts: { source: BACKGROUND_WORK_ENDED_SOURCE, taskId: 'task-bg', messageId: `qm-bgend-${RT}-30` } })
    expect(sends[0].text).toContain('make build')
    expect(sends[0].text).toContain('exit code 0')
    expect(sends[0].text).toContain('BUILD OK')
    // Woken, not handed back: the wake's own turn ends the work.
    expect(phases).toEqual([])
  })

  it('an end told during a turn wakes the session once that turn is over', async () => {
    const { turn, endTurn, bg, results } = await setup()
    turn(10, 'c1')
    bg(20, [build])
    endTurn(21, 'c1')
    turn(30, 'c2')
    bg(40, [], [{ ...build, exitCode: 2, output: 'error: x\n' }])
    expect(sends).toHaveLength(0)
    endTurn(41, 'c2')
    // Its wake is on the way: still in progress.
    expect(results.at(-1)).toMatchObject({ detachedBgActive: true })
    await vi.waitFor(() => expect(sends).toHaveLength(1))
    expect(sends[0].text).toContain('exit code 2')
    expect(sends[0].opts.messageId).toBe(`qm-bgend-${RT}-40`)
  })

  it('a deferred wake is queued before the turn\'s end moves the cursor past the record that told it', async () => {
    const { turn, endTurn, bg } = await setup()
    turn(10, 'c1')
    bg(20, [build])
    endTurn(21, 'c1')
    turn(30, 'c2')
    bg(40, [], [{ ...build, exitCode: 0, output: '' }])
    const order: string[] = []
    const { sendMessageToSession } = await import('../../src/core/session-message-queue.js')
    vi.mocked(sendMessageToSession).mockImplementationOnce(async (sessionId: string, text: string, opts?: Record<string, unknown>) => {
      const { getSessionByClaudeId } = await import('../../src/core/session-tracker.js')
      order.push(`send at offset ${(await getSessionByClaudeId(SID))?.consumedOffset}`)
      sends.push({ sessionId, text, opts: opts ?? {} })
      return { id: opts?.messageId } as never
    })
    endTurn(41, 'c2')
    await vi.waitFor(async () => {
      const { getSessionByClaudeId } = await import('../../src/core/session-tracker.js')
      expect((await getSessionByClaudeId(SID))?.consumedOffset).toBe(41)
    })
    // A restart before the send would read the record again (the cursor was still at c1's end).
    expect(order).toEqual(['send at offset 21'])
  })

  it('a stop, a stop of the session or a detach withdraws a wake still on its way', async () => {
    for (const stop of ['detach', 'drop'] as const) {
      sends.length = 0
      const { session, bg } = await setup()
      let release!: () => void
      ;(session as unknown as { _cursorCommit: Promise<void> })._cursorCommit = new Promise<void>((r) => { release = r })
      bg(30, [], [{ ...build, exitCode: 0, output: '' }])
      if (stop === 'detach') session.detach()
      else (session as unknown as { dropBackgroundWork(why: string): void }).dropBackgroundWork('session-stopped')
      release()
      await (session as unknown as { _cursorCommit: Promise<void> })._cursorCommit
      expect(sends, stop).toHaveLength(0)
      _resetSessionTrackerForTesting()
      await fs.rm(WALNUT_HOME, { recursive: true, force: true })
      await fs.mkdir(WALNUT_HOME, { recursive: true })
      bus.unsubscribe('acp-bg-test')
    }
  })

  it('the wake carries the stop fence read when the end was told, and asks again before its row is stored', async () => {
    const { bg } = await setup()
    bg(30, [], [{ ...build, exitCode: 0, output: '' }])
    await vi.waitFor(() => expect(sends).toHaveLength(1))
    expect('stopFence' in sends[0].opts).toBe(true)
    expect((sends[0].opts.stillWanted as () => boolean)()).toBe(true)
  })

  it('an end told during a status question wakes the session once the question is answered', async () => {
    const { session, turn, endTurn, bg, meta } = await setup()
    turn(10, 'c1')
    bg(20, [build])
    endTurn(21, 'c1')
    // Walnut's status question runs as a turn of the provider's own (no Walnut turn).
    ;(session as unknown as { _selfReport: unknown })._selfReport = {
      commandId: 'q1', started: true, chunks: [], toolRefused: false, timer: undefined, resolve: () => {}, reject: () => {},
    }
    bg(30, [], [{ ...build, exitCode: 0, output: 'BUILD OK\n' }])
    expect(sends).toHaveLength(0)
    meta(31, { type: 'control-ended', commandId: 'q1', stopReason: 'end_turn' })
    await vi.waitFor(() => expect(sends).toHaveLength(1))
    expect(sends[0].opts.messageId).toBe(`qm-bgend-${RT}-30`)
  })

  it('a turn that leaves nothing running ends as before', async () => {
    const { session, results, turn, endTurn } = await setup()
    turn(10, 'c1')
    endTurn(11, 'c1')
    expect(results.at(-1)?.detachedBgActive).toBeUndefined()
    expect(session.outlivingWork).toEqual([])
    expect(sessionRunner.outlivingWorkOf(SID)).toEqual([])
  })

  it('a record read again past the last commit wakes nobody a second time', async () => {
    const { session, bg } = await setup()
    ;(session as unknown as { _committedV: number })._committedV = 50
    // Turned away before anything asynchronous starts.
    bg(30, [], [{ ...build, exitCode: 0, output: '' }])
    expect((session as unknown as { _pendingWake: unknown })._pendingWake).toBeNull()
    expect(sends).toHaveLength(0)
  })

  it('the command gone with no news (a stop), or the worker gone, hands the task back', async () => {
    const { session, turn, endTurn, bg } = await setup()
    turn(10, 'c1')
    bg(20, [build])
    endTurn(21, 'c1')
    bg(30, [])
    await vi.waitFor(() => expect(phases).toEqual([{ taskId: 'task-bg', event: 'session:result', by: 'acp-session:background-work-gone' }]))
    expect(sends).toHaveLength(0)

    bg(40, [build])
    ;(session as unknown as { handleDaemonEvent(ev: unknown): void }).handleDaemonEvent({ sid: RT, ev: 'acp_state', state: 'dead' })
    await vi.waitFor(() => expect(phases.at(-1)).toMatchObject({ by: 'acp-session:worker-gone' }))
    expect(session.outlivingWork).toEqual([])
  })
})

describe('the wake message', () => {
  it('names each command, how it ended and the end of its output, in a fence the output cannot close', () => {
    const text = backgroundWorkEndedText([
      { processId: '1', command: 'make build', exitCode: 0, output: 'BUILD OK\n' },
      { processId: '2', command: 'cat notes.md', exitCode: null, output: 'a\n```\nb' },
    ])
    expect(text).toContain('<walnut-message kind="notification"')
    expect(text).toContain('2 commands you left running when your turn ended have ended')
    expect(text).toContain('`make build` (process 1): exit code 0. Its output ends with:\n```\nBUILD OK\n```')
    expect(text).toContain('`cat notes.md` (process 2): it ended (Codex gave no exit code). Its output ends with:\n~~~~\na\n```\nb\n~~~~')
  })
})
