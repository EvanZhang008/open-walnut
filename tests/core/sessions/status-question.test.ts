/**
 * The task's status words are asked right at its turn end (src/core/sessions/status-question.ts),
 * with only the CLI faked: one short side question with only the FOR_USER_* lines, its answer stored
 * as the task's status and moving its phase; a new turn within the settle window cancels it; the
 * debounced summary then asks no status and stores none of its own. An ACP session is asked only
 * when its engine takes the question (pi).
 * Races: a turn running when the window ends is not asked mid-turn; a turn end while an ask is in
 * flight is asked again once it settles; an answer that does not read hands the turn back to the
 * summary.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-status-question'))

import { WALNUT_HOME } from '../../../src/constants.js'
import { sessionRunner } from '../../../src/providers/claude-code-session.js'
import { addTask, getTask, updateTaskRaw } from '../../../src/core/task-manager.js'
import { FOR_USER_PROMPT, buildSelfReportPrompt, runTriage, __resetTriageRateLimiter } from '../../../src/core/session-hooks/builtins.js'
import { armStatusQuestion, askStatus, buildStatusPrompt, cancelStatusQuestion, settleStatusQuestion, statusQuestionOwns, STATUS_SETTLE_MS, __resetStatusQuestion } from '../../../src/core/sessions/status-question.js'
import { createSessionRecord, updateSessionRecord } from '../../../src/core/session-tracker.js'
import { isReportPending } from '../../../src/core/sessions/report-pending.js'
import { STATUS_RULE_VERSION } from '../../../src/core/user-status.js'
import type { OnTurnCompletePayload } from '../../../src/core/session-hooks/types.js'
import type { Task } from '../../../src/core/types.js'

const SID = 'status-q-session'
const ANSWER = 'FOR_USER_STATE: waiting\nFOR_USER_WAITING_ON: outside: the CI run on main\nFOR_USER_NOW: The tests run in CI.\nFOR_USER_NEXT: I merge once they pass.'

function fakeSession(answer: string) {
  const fake = { sessionId: SID, askSideQuestion: vi.fn(async () => answer), detach: () => {}, kill: () => {}, get active() { return false } }
  ;(sessionRunner as unknown as { sessions: Map<string, unknown> }).sessions.set(SID, fake)
  return fake
}

let task: Task

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  task = (await addTask({ title: 'Fix the parser', project: 'Garden' })).task
  await updateTaskRaw(task.id, { phase: 'IN_PROGRESS' }, { source: 'test' })
})

afterAll(async () => {
  ;(sessionRunner as unknown as { sessions: Map<string, unknown> }).sessions.delete(SID)
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
})

// A test that returns once its question was asked leaves that question's tail running (its answer
// stored, its in-flight mark cleared). Wait for it to end first, or it clears the next test's mark.
beforeEach(async () => { await settleStatusQuestion(SID, 10_000); __resetStatusQuestion(); __resetTriageRateLimiter() })

describe('the status question', () => {
  it('asks only the status lines, telling the session not to work', () => {
    const prompt = buildStatusPrompt(FOR_USER_PROMPT, 'Fix the parser', 'Chinese')
    expect(prompt).toContain('Do not use any tool and do not continue the work.')
    expect(prompt).toContain('Answer with only these lines on how this task stands FOR THE USER')
    expect(prompt).toContain('FOR_USER_STATE:')
    expect(prompt).toContain('write them in Chinese')
    expect(prompt).not.toContain('EXEC_SUMMARY')
  })

  it('stores the answer as the task\'s status and moves its phase', async () => {
    const fake = fakeSession(ANSWER)
    expect(await askStatus(task.id, SID, Date.now())).toBe(true)
    expect(fake.askSideQuestion).toHaveBeenCalledTimes(1)
    const t = await getTask(task.id)
    expect(t.status_report).toMatchObject({ state: 'waiting', waiting_kind: 'outside', waiting_on: 'the CI run on main' })
    expect(t.phase).toBe('WAITING')
  })

  it('waits for the turn to stay quiet; a new turn cancels it; the report reads pending meanwhile', async () => {
    const fake = fakeSession(ANSWER)
    expect(await armStatusQuestion(task.id, SID)).toBe(true)
    expect(statusQuestionOwns(SID)).toBe(true)
    expect(isReportPending(SID)).toBe(true)
    cancelStatusQuestion(SID)
    expect(isReportPending(SID)).toBe(false)
    await new Promise((r) => setTimeout(r, STATUS_SETTLE_MS + 300))
    expect(fake.askSideQuestion).not.toHaveBeenCalled()
    await armStatusQuestion(task.id, SID)
    await vi.waitFor(() => {
      expect(fake.askSideQuestion).toHaveBeenCalledTimes(1)
      expect(isReportPending(SID)).toBe(false)
    }, { timeout: STATUS_SETTLE_MS + 7_000, interval: 10 })
  }, 20_000)

  it('a turn running when the window ends is not asked mid-turn; its own end asks', async () => {
    const fake = fakeSession(ANSWER)
    const active = (sessionRunner as unknown as { activeProcessing: Set<string> }).activeProcessing
    await armStatusQuestion(task.id, SID)
    active.add(SID)
    try {
      await new Promise((r) => setTimeout(r, STATUS_SETTLE_MS + 300))
      expect(fake.askSideQuestion).not.toHaveBeenCalled()
      expect(isReportPending(SID)).toBe(false)
    } finally { active.delete(SID) }
    await armStatusQuestion(task.id, SID)
    await vi.waitFor(() => expect(fake.askSideQuestion).toHaveBeenCalledTimes(1), { timeout: STATUS_SETTLE_MS + 7_000, interval: 10 })
  }, 20_000)

  it('a turn end while an ask is in flight is asked again once it settles', async () => {
    const fake = fakeSession(ANSWER)
    let release!: () => void
    fake.askSideQuestion.mockImplementationOnce(() => new Promise<string>((r) => { release = () => r(ANSWER) }))
    const first = askStatus(task.id, SID, Date.now() - 60_000, 'reconcile')
    // The first question is out (and `release` is set).
    await vi.waitFor(() => expect(fake.askSideQuestion).toHaveBeenCalledTimes(1), { timeout: 10_000, interval: 10 })
    expect(await askStatus(task.id, SID, Date.now())).toBe(false)
    release()
    await first
    await vi.waitFor(() => {
      expect(fake.askSideQuestion).toHaveBeenCalledTimes(2)
      expect(isReportPending(SID)).toBe(false)
    }, { timeout: 10_000, interval: 10 })
  })

  it('an engine switch stopping the session waits for a question in flight and asks no new one', async () => {
    // 2026-11-05: a switch stopped Pi mid-question; its provider thread kept the question, and the
    // session resumed on a switch back answered it into the chat as FOR_USER lines.
    const fake = fakeSession(ANSWER)
    let release!: () => void
    fake.askSideQuestion.mockImplementationOnce(() => new Promise<string>((r) => { release = () => r(ANSWER) }))
    const first = askStatus(task.id, SID, Date.now() - 60_000, 'reconcile')
    // The first question is out (and `release` is set).
    await vi.waitFor(() => expect(fake.askSideQuestion).toHaveBeenCalledTimes(1), { timeout: 10_000, interval: 10 })
    let settled = false
    const settling = settleStatusQuestion(SID, 5_000).then(() => { settled = true })
    await new Promise((r) => setTimeout(r, 100))
    expect(settled).toBe(false)
    release()
    await first
    await settling
    expect(settled).toBe(true)
    // An armed question does not fire after the settle.
    expect(await armStatusQuestion(task.id, SID)).toBe(true)
    await settleStatusQuestion(SID, 100)
    await new Promise((r) => setTimeout(r, STATUS_SETTLE_MS + 300))
    expect(fake.askSideQuestion).toHaveBeenCalledTimes(1)
  }, 15_000)

  it('a session an engine switch replaced is never asked', async () => {
    const fake = fakeSession(ANSWER)
    await createSessionRecord(SID, task.id, 'Garden', '/tmp')
    await updateSessionRecord(SID, { archived: true, archive_reason: 'engine_switched:pi' } as never)
    try {
      expect(await askStatus(task.id, SID, Date.now())).toBe(false)
      expect(fake.askSideQuestion).not.toHaveBeenCalled()
    } finally {
      await updateSessionRecord(SID, { archived: false, archive_reason: undefined } as never)
    }
  })

  it('an answer it cannot read hands that turn\'s status back to the summary', async () => {
    const fake = fakeSession('I am not sure what you mean.')
    await armStatusQuestion(task.id, SID)
    expect(statusQuestionOwns(SID)).toBe(true)
    await vi.waitFor(() => {
      expect(fake.askSideQuestion).toHaveBeenCalledTimes(1)
      expect(statusQuestionOwns(SID)).toBe(false)
      expect(isReportPending(SID)).toBe(false)
    }, { timeout: STATUS_SETTLE_MS + 10_000, interval: 10 })
    // The next turn is its again.
    fakeSession(ANSWER)
    await armStatusQuestion(task.id, SID)
    expect(statusQuestionOwns(SID)).toBe(true)
    cancelStatusQuestion(SID)
  }, 20_000)

  it('a session Walnut cannot ask natively (an ACP engine) is left to the summary', async () => {
    expect(await armStatusQuestion(task.id, 'no-such-native-session')).toBe(false)
    expect(statusQuestionOwns('no-such-native-session')).toBe(false)
    // A session the runner lost after an earlier native turn is the summary's again.
    fakeSession(ANSWER)
    await armStatusQuestion(task.id, SID)
    cancelStatusQuestion(SID)
    const sessions = (sessionRunner as unknown as { sessions: Map<string, unknown> }).sessions
    const held = sessions.get(SID)
    sessions.delete(SID)
    try {
      expect(await armStatusQuestion(task.id, SID)).toBe(false)
      expect(statusQuestionOwns(SID)).toBe(false)
    } finally { sessions.set(SID, held) }
  })

  // 2026-11-02: a pi task read "its report on the turn that just ended" for 4.5 minutes after
  // every turn. An ACP engine whose registry entry takes the question is asked like a native
  // session, through its hidden control prompt; the others stay with the summary.
  it.each([['pi', true], ['codex', false]] as const)('a live %s session is asked at its turn end: %s', async (engineId, asked) => {
    const ACP_SID = `acp-status-${engineId}`
    const request = vi.fn(async () => ANSWER)
    const fake = { sessionId: ACP_SID, runtimeId: `acp-rt-${engineId}`, engineId, activity: 'idle',
      establish: async () => ACP_SID, send: async () => {}, abortTurn: async () => {}, requestTurnCompleteSelfReport: request }
    const acpSessions = (sessionRunner as unknown as { acpSessions: Map<string, unknown> }).acpSessions
    acpSessions.set(ACP_SID, fake)
    const endedBefore = (await getTask(task.id)).status_report?.turn_ended_at
    try {
      expect(await armStatusQuestion(task.id, ACP_SID)).toBe(asked)
      expect(statusQuestionOwns(ACP_SID)).toBe(asked)
      if (!asked) return
      await expect.poll(() => request.mock.calls.length, { timeout: STATUS_SETTLE_MS + 3000 }).toBe(1)
      expect(String((request.mock.calls[0] as unknown[])[0])).toContain('Do not use any tool and do not continue the work.')
      // This ask's own write, not an earlier test's report with the same words.
      await expect.poll(async () => (await getTask(task.id)).status_report?.turn_ended_at).not.toBe(endedBefore)
      expect((await getTask(task.id)).status_report?.waiting_on).toBe('the CI run on main')
    } finally { acpSessions.delete(ACP_SID) }
  }, 20_000)

  it('the summary then asks no status and stores none of its own', async () => {
    expect(buildSelfReportPrompt('', 'Fix the parser', { status: false })).not.toContain('FOR_USER_STATE')
    expect(buildSelfReportPrompt('', 'Fix the parser')).toContain('FOR_USER_STATE')
    await armStatusQuestion(task.id, SID)
    cancelStatusQuestion(SID)
    const before = (await getTask(task.id)).status_report
    const fake = fakeSession(`EXEC_SUMMARY: The parser work.\nRECAP: Fixed it.\nPHASE_SIGNAL: conversational(user-asked-question)\n${ANSWER.replace('waiting', 'needs-you')}\nFOR_USER_ASK: Approve?`)
    const payload = { sessionId: SID, taskId: task.id, task: await getTask(task.id), session: { provider: 'claude-code', cwd: '/tmp/x' }, result: 'done', totalCost: 0, duration: 1, turnIndex: 1 } as unknown as OnTurnCompletePayload
    await runTriage(payload)
    expect(fake.askSideQuestion.mock.calls[0]![0] as string).not.toContain('FOR_USER_STATE')
    expect((await getTask(task.id)).status_report).toEqual(before)
  })
})

describe('the reconcile loop', () => {
  it('asks again only a live idle native session whose status misses its last turn', async () => {
    const { statusMissed } = await import('../../../src/core/sessions/status-reconcile.js')
    const now = Date.parse('2026-10-31T18:00:00Z')
    const iso = (min: number) => new Date(now - min * 60_000).toISOString()
    const idle = { process_status: 'idle', last_status_change: iso(10), provider: 'cli' } as const
    // Reports asked under the current rules (a wait under the old ones is asked once again:
    // working-means-own-work.test.ts).
    const t = (reportMin: number | null) => ({ phase: 'WAITING', status: 'in_progress', ...(reportMin === null ? {} : { status_report: { at: iso(reportMin), turn_ended_at: iso(reportMin), state: 'waiting', rule: STATUS_RULE_VERSION } }) }) as never
    expect(statusMissed(t(30), idle, now)).toBe(Date.parse(iso(10)))
    expect(statusMissed(t(null), idle, now)).toBe(Date.parse(iso(10)))
    // Its answer covers the last turn.
    expect(statusMissed(t(10), idle, now)).toBeNull()
    // A turn that just ended is the turn-end question's.
    expect(statusMissed(t(30), { ...idle, last_status_change: iso(1) }, now)).toBeNull()
    // A stopped or running session, an embedded subagent, a finished task: never asked.
    expect(statusMissed(t(30), { ...idle, process_status: 'stopped' }, now)).toBeNull()
    expect(statusMissed(t(30), { ...idle, process_status: 'running' }, now)).toBeNull()
    expect(statusMissed(t(30), { ...idle, provider: 'embedded' }, now)).toBeNull()
    // A Personal AI chat lane has no status of its own; an ACP engine answers with a turn.
    expect(statusMissed(t(30), { ...idle, lane: 'chat:main' } as never, now)).toBeNull()
    expect(statusMissed(t(30), { ...idle, engine: 'codex' } as never, now)).toBeNull()
    expect(statusMissed({ ...(t(30) as object), phase: 'COMPLETE' } as never, idle, now)).toBeNull()
  })

  it('its own ask is no turn: an answer after the last request covers the status changes since', async () => {
    const { statusMissed } = await import('../../../src/core/sessions/status-reconcile.js')
    const now = Date.parse('2026-11-09T18:00:00Z')
    const iso = (min: number) => new Date(now - min * 60_000).toISOString()
    // The turn's last request at 120 min ago, its answer at 60, and the side question's own stream
    // lines moved the record's status change to 55 (2026-11-08: asked every 30 to 90 minutes for days).
    const task = { phase: 'WAITING', status: 'in_progress', status_report: { at: iso(60), turn_ended_at: iso(118), state: 'waiting', rule: STATUS_RULE_VERSION } } as never
    const echoed = { process_status: 'idle', last_status_change: iso(55), provider: 'cli', promptCache: { tokens: 300_000, requestAt: iso(120) } } as never
    expect(statusMissed(task, echoed, now)).toBeNull()
    // A real turn after the answer made a request: its missed status is asked.
    const worked = { process_status: 'idle', last_status_change: iso(30), provider: 'cli', promptCache: { tokens: 310_000, requestAt: iso(32) } } as never
    expect(statusMissed(task, worked, now)).toBe(Date.parse(iso(30)))
    // No request recorded: the turn-end rule decides, as before.
    expect(statusMissed(task, { process_status: 'idle', last_status_change: iso(55), provider: 'cli' } as never, now)).toBe(Date.parse(iso(55)))
    // A change long after the answer is no echo (a turn whose request the record missed, say a
    // replay after a restart): asked.
    expect(statusMissed(task, { ...(echoed as object), last_status_change: iso(20) } as never, now)).toBe(Date.parse(iso(20)))
    // An answer given mid-turn (a watch) keeps the turn end before it: the turn's end is still missed.
    const midTurn = { phase: 'WAITING', status: 'in_progress', status_report: { at: iso(60), turn_ended_at: iso(200), state: 'working', rule: STATUS_RULE_VERSION } } as never
    expect(statusMissed(midTurn, echoed, now)).toBe(Date.parse(iso(55)))
  })

  it('a pass asks a missed status, at most twice for one turn end, one pass at a time', async () => {
    const { runStatusReconcile, stopStatusReconcile } = await import('../../../src/core/sessions/status-reconcile.js')
    const { createSessionRecord, updateSessionRecord } = await import('../../../src/core/session-tracker.js')
    const own = (await addTask({ title: 'Tune the cache', project: 'Garden' })).task
    await updateTaskRaw(own.id, { phase: 'IN_PROGRESS' }, { source: 'test' })
    const sid = 'status-q-reconcile'
    const fake = { sessionId: sid, askSideQuestion: vi.fn(async () => 'nothing to read'), detach: () => {}, kill: () => {}, get active() { return false } }
    const sessions = (sessionRunner as unknown as { sessions: Map<string, unknown> }).sessions
    sessions.set(sid, fake)
    try {
      await createSessionRecord(sid, own.id, 'Garden')
      const now = Date.now()
      await updateSessionRecord(sid, { process_status: 'idle', last_status_change: new Date(now - 10 * 60_000).toISOString() })
      stopStatusReconcile()
      const [a, b] = await Promise.all([runStatusReconcile(now), runStatusReconcile(now)])
      expect([...a, ...b]).toEqual([own.id])
      // Within the retry gap: not again.
      expect(await runStatusReconcile(now + 10 * 60_000)).toEqual([])
      expect(await runStatusReconcile(now + 31 * 60_000)).toEqual([own.id])
      // An answer that never reads is not asked all day for the same turn end.
      expect(await runStatusReconcile(now + 62 * 60_000)).toEqual([])
      expect(fake.askSideQuestion).toHaveBeenCalledTimes(2)
    } finally {
      sessions.delete(sid)
      stopStatusReconcile()
    }
  })

  it('asks that never read are capped per request, though each ask moves the status change', async () => {
    const { runStatusReconcile, stopStatusReconcile } = await import('../../../src/core/sessions/status-reconcile.js')
    const { createSessionRecord, updateSessionRecord } = await import('../../../src/core/session-tracker.js')
    const own = (await addTask({ title: 'Prune the hedge', project: 'Garden' })).task
    await updateTaskRaw(own.id, { phase: 'IN_PROGRESS' }, { source: 'test' })
    const sid = 'status-q-reconcile-echo'
    const fake = { sessionId: sid, askSideQuestion: vi.fn(async () => 'nothing to read'), detach: () => {}, kill: () => {}, get active() { return false } }
    const sessions = (sessionRunner as unknown as { sessions: Map<string, unknown> }).sessions
    sessions.set(sid, fake)
    try {
      await createSessionRecord(sid, own.id, 'Garden')
      const now = Date.now()
      const requestAt = new Date(now - 15 * 60_000).toISOString()
      await updateSessionRecord(sid, { process_status: 'idle', last_status_change: new Date(now - 10 * 60_000).toISOString(), promptCache: { tokens: 250_000, requestAt } })
      stopStatusReconcile()
      const asked: string[][] = []
      for (let i = 0; i < 6; i++) {
        const at = now + i * 31 * 60_000
        asked.push(await runStatusReconcile(at))
        // The ask's own stream lines reach the record a few minutes later as a status change.
        await updateSessionRecord(sid, { last_status_change: new Date(at + 3 * 60_000).toISOString() })
      }
      expect(asked.flat()).toEqual([own.id, own.id])
      expect(fake.askSideQuestion).toHaveBeenCalledTimes(2)
    } finally {
      sessions.delete(sid)
      stopStatusReconcile()
    }
  })
})
