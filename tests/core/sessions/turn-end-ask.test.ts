/**
 * A turn end's report asks only what that turn asked (src/core/sessions/turn-end-ask.ts).
 *
 * The incident, replayed (2026-11-13): a lead's task had asked the user to approve a cloud cleanup
 * (decision ask-orrkkv), the user said yes, the cleanup ran, and its reports read working. A Walnut
 * compaction later ended a turn that asked nothing (the turn before it was an agent-ack); the status
 * question named ask-orrkkv as "your ask to the user", and the compacted session answered needs with
 * that id. The task read Needs you for a three-day-old, finished ask.
 *
 * Pinned here through the real writer (applyStatusAnswer, which every turn-end path uses: the side
 * question, an ACP engine's summary, the restart, reconcile and watch re-asks), with only the
 * transcript read faked: a quiet turn (an agent-ack, nothing, a compaction) never brings back an older
 * ask, an ask that still stands stays, a new ask in a turn with words is stored, and the status
 * question never names a decision the task no longer asks.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-turn-end-ask'))

const buildSessionTranscript = vi.fn()
vi.mock('../../../src/core/session-projection.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  buildSessionTranscript: (...a: unknown[]) => buildSessionTranscript(...a),
}))

import { WALNUT_HOME } from '../../../src/constants.js'
import { addTask, getTask, updateTaskRaw } from '../../../src/core/task-manager.js'
import { applyStatusAnswer } from '../../../src/core/sessions/status-question.js'
import { readStatusReport } from '../../../src/core/session-hooks/builtins.js'
import { askDecisionQuestion } from '../../../src/core/ask-decision.js'
import { judgeTurnEndAsk } from '../../../src/core/sessions/turn-end-ask.js'
import { lastTurnWroteWords } from '../../../src/core/sessions/session-request-notify.js'
import { beginQuietTurn, endQuietTurn } from '../../../src/core/sessions/quiet-turn.js'
import { createSessionRecord, updateSessionRecord } from '../../../src/core/session-tracker.js'
import { handBackTaskOnSessionEnd } from '../../../src/core/phase.js'
import type { StatusReport } from '../../../src/core/user-status.js'

const SID = 'turn-end-ask-session'
const ACK = '<walnut-turn status="agent-ack"/>'
// The old ask in the user's language (CJK test data, escaped): "Old log groups of the beta account: agree to try deleting 200 first with admin rights, then all of about 651,000?"
const OLD_ASK = 'beta \u8d26\u53f7\u7684\u65e7\u65e5\u5fd7\u7ec4\uff1a\u540c\u610f\u7528 Admin \u6743\u9650\u5148\u8bd5\u5220 200 \u4e2a\uff0c\u786e\u8ba4\u6ca1\u5220\u9519\u518d\u5168\u90e8\u5220\u6389\u7ea6 65.1 \u4e07\u4e2a\u5417\uff1f'
const DAY = 24 * 3_600_000
const NOW = Date.now()
const iso = (ms: number) => new Date(ms).toISOString()

function needsAnswer(ask: string, id?: string): string {
  return [
    'FOR_USER_STATE: needs-you', `FOR_USER_ASK: ${ask}`, 'FOR_USER_ASK_OWN: cloud_delete: it deletes data in a cloud account',
    'FOR_USER_ASK_KIND: yes-no', `FOR_USER_ASK_ID: ${id ?? 'none'}`, 'FOR_USER_NOW: The cleanup waits for a yes.', 'FOR_USER_NEXT: You decide, then I delete.',
  ].join('\n')
}
function parsed(answer: string): StatusReport {
  const r = readStatusReport(answer)
  if (!r) throw new Error('answer did not parse')
  return r
}

/** The task as it stood: its last report working, the decision it asked three days ago remembered. */
const WORKING_AFTER_ASK: StatusReport = {
  state: 'working', now: 'The cleanup finished.', next: 'I watch the next run.', at: iso(NOW - 5 * 3_600_000),
  turn_ended_at: iso(NOW - 5 * 3_600_000), session_id: SID,
  last_ask: { id: 'ask-orrkkv', ask: OLD_ASK, at: iso(NOW - 3 * DAY), kind: 'yes-no' },
} as StatusReport
const STILL_ASKING: StatusReport = {
  state: 'needs', ask: OLD_ASK, ask_id: 'ask-orrkkv', ask_kind: 'yes-no', user_kind: 'cloud_delete', user_kind_why: 'it deletes data',
  at: iso(NOW - 3_600_000), turn_ended_at: iso(NOW - 3_600_000), session_id: SID,
} as StatusReport

let taskId: string
async function withReport(r: StatusReport | null): Promise<void> {
  await updateTaskRaw(taskId, { status_report: r ?? undefined, phase: 'IN_PROGRESS' }, { source: 'test' })
}
function transcript(rows: Array<{ role: string; text: string; kind?: string }>): void {
  buildSessionTranscript.mockResolvedValue({ messages: rows })
}
const AGENT_ACK_TURN = [
  { role: 'assistant', text: 'Asked the user to approve the cleanup.' },
  { role: 'user', text: '<walnut-message kind="notification">Team update</walnut-message>' },
  { role: 'assistant', text: ACK },
]
const WORDY_TURN = [
  { role: 'user', text: 'what next?' },
  { role: 'assistant', text: 'Bash', kind: 'tool' },
  { role: 'assistant', text: 'One more account needs the same cleanup. Approve it?' },
]

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  taskId = (await addTask({ title: 'Lead of the platform team', project: 'Garden' })).task.id
  await createSessionRecord(SID, taskId, 'Garden', '/tmp')
})
afterAll(async () => { await fs.rm(WALNUT_HOME, { recursive: true, force: true }) })
beforeEach(async () => {
  buildSessionTranscript.mockReset()
  endQuietTurn(SID, 'test')
  await updateSessionRecord(SID, { lastCompactAt: undefined } as never)
})

describe('the incident: a quiet turn end brings back a finished ask', () => {
  it('an agent-ack turn: the old decision named by id stays off the status', async () => {
    await withReport(WORKING_AFTER_ASK)
    transcript(AGENT_ACK_TURN)
    expect(await applyStatusAnswer(taskId, SID, parsed(needsAnswer(OLD_ASK, 'ask-orrkkv')), NOW)).toBe(true)
    const r = (await getTask(taskId)).status_report!
    expect(r.state).toBe('working')
    expect(r.ask).toBeUndefined()
    expect(r.ask_id).toBeUndefined()
    // As of this turn end, so the reconcile loop does not ask it again.
    expect(r.turn_ended_at).toBe(iso(NOW))
    expect(r.last_ask?.id).toBe('ask-orrkkv')
  })

  it('a compaction after a turn with words (its summary folded onto that turn): the same, also in other words with no id', async () => {
    await withReport(WORKING_AFTER_ASK)
    // The transcript shows the turn before the compaction; the record saw the compaction after it.
    transcript(WORDY_TURN.map((m) => ({ ...m, timestamp: iso(NOW - 20 * 60_000) })))
    await updateSessionRecord(SID, { lastCompactAt: iso(NOW - 3 * 60_000) } as never)
    await applyStatusAnswer(taskId, SID, parsed(needsAnswer(`${OLD_ASK} (about 50 minutes)`)), NOW)
    expect((await getTask(taskId)).status_report!.state).toBe('working')
  })

  it('a turn with words after the last compaction still asks', async () => {
    await withReport(WORKING_AFTER_ASK)
    transcript(WORDY_TURN.map((m) => ({ ...m, timestamp: iso(NOW - 60_000) })))
    await updateSessionRecord(SID, { lastCompactAt: iso(NOW - 3 * 60_000) } as never)
    await applyStatusAnswer(taskId, SID, parsed(needsAnswer('Approve the same cleanup on the second account?', 'new')), NOW)
    expect((await getTask(taskId)).status_report!.state).toBe('needs')
  })

  it('a quiet turn Walnut runs is quiet without reading the transcript', async () => {
    await withReport(WORKING_AFTER_ASK)
    beginQuietTurn(SID, 'idle-compact', 'idle-compact')
    await applyStatusAnswer(taskId, SID, parsed(needsAnswer(OLD_ASK, 'ask-orrkkv')), NOW)
    expect((await getTask(taskId)).status_report!.state).toBe('working')
    expect(buildSessionTranscript).not.toHaveBeenCalled()
  })

  it('a quiet turn asks nothing new either: the ask that stands stays', async () => {
    await withReport(STILL_ASKING)
    transcript(AGENT_ACK_TURN)
    await applyStatusAnswer(taskId, SID, parsed(needsAnswer('Approve deleting the staging bucket too?', 'new')), NOW)
    const r = (await getTask(taskId)).status_report!
    expect(r).toMatchObject({ state: 'needs', ask: OLD_ASK, ask_id: 'ask-orrkkv' })
  })

  it('the status question never names a decision the task no longer asks', () => {
    expect(askDecisionQuestion(WORKING_AFTER_ASK)).toBe('')
    for (const state of ['working', 'waiting', 'done', 'read'] as const) {
      expect(askDecisionQuestion({ ...WORKING_AFTER_ASK, state } as StatusReport)).toBe('')
    }
    expect(askDecisionQuestion(STILL_ASKING)).toContain('ask-orrkkv')
  })
})

describe('what a turn end still asks', () => {
  it('a re-check turn that answers only the agent-ack keeps the ask that stands', async () => {
    await withReport(STILL_ASKING)
    transcript(AGENT_ACK_TURN)
    await applyStatusAnswer(taskId, SID, parsed(needsAnswer(OLD_ASK, 'ask-orrkkv')), NOW)
    expect((await getTask(taskId)).status_report).toMatchObject({ state: 'needs', ask_id: 'ask-orrkkv', turn_ended_at: iso(NOW) })
  })

  it('a turn with words asks a new decision', async () => {
    await withReport(WORKING_AFTER_ASK)
    transcript(WORDY_TURN)
    await applyStatusAnswer(taskId, SID, parsed(needsAnswer('Approve the same cleanup on the second account?', 'new')), NOW)
    const r = (await getTask(taskId)).status_report!
    expect(r.state).toBe('needs')
    expect(r.ask_id).toMatch(/^ask-/)
    expect(r.ask_id).not.toBe('ask-orrkkv')
  })

  it('a turn with words asks a decision again after a wait the user did not answer', async () => {
    await withReport(WORKING_AFTER_ASK)
    transcript(WORDY_TURN)
    await applyStatusAnswer(taskId, SID, parsed(needsAnswer(OLD_ASK, 'ask-orrkkv')), NOW)
    expect((await getTask(taskId)).status_report).toMatchObject({ state: 'needs', ask_id: 'ask-orrkkv' })
  })

  it('a turn of tool calls with no text hides no ask', async () => {
    await withReport(WORKING_AFTER_ASK)
    transcript([{ role: 'user', text: 'x' }, { role: 'assistant', text: 'human_inbox_send', kind: 'tool' }])
    await applyStatusAnswer(taskId, SID, parsed(needsAnswer('Approve the same cleanup on the second account?', 'new')), NOW)
    expect((await getTask(taskId)).status_report!.state).toBe('needs')
  })

  it('a transcript it cannot read hides no ask', async () => {
    await withReport(WORKING_AFTER_ASK)
    buildSessionTranscript.mockRejectedValue(new Error('host gone'))
    await applyStatusAnswer(taskId, SID, parsed(needsAnswer('Approve the same cleanup on the second account?', 'new')), NOW)
    expect((await getTask(taskId)).status_report!.state).toBe('needs')
  })

  it('a quiet turn with no report before it stores none', async () => {
    const fresh = (await addTask({ title: 'A task with no report yet', project: 'Garden' })).task.id
    transcript(AGENT_ACK_TURN)
    expect(await applyStatusAnswer(fresh, SID, parsed(needsAnswer(OLD_ASK)), NOW)).toBe(false)
    expect((await getTask(fresh)).status_report).toBeUndefined()
  })
})

describe('the parts', () => {
  it('reads whether the last turn wrote words, never an earlier turn\'s', () => {
    expect(lastTurnWroteWords(undefined)).toBeUndefined()
    expect(lastTurnWroteWords([])).toBeUndefined()
    expect(lastTurnWroteWords(AGENT_ACK_TURN)).toBe(false)
    expect(lastTurnWroteWords([...AGENT_ACK_TURN.slice(0, 2), { role: 'assistant', text: `<walnut-about tasks="t1"/>\n${ACK}` }])).toBe(false)
    expect(lastTurnWroteWords([{ role: 'assistant', text: 'Old words.' }, { role: 'user', text: 'x' }, { role: 'assistant', text: 'Bash', kind: 'tool' }])).toBeUndefined()
    expect(lastTurnWroteWords([{ role: 'assistant', text: 'Old words.' }, { role: 'user', text: 'x' }])).toBe(false)
    const at = (t: string) => WORDY_TURN.map((m) => ({ ...m, timestamp: t }))
    expect(lastTurnWroteWords(at(iso(NOW - 60_000)), { compactedAt: iso(NOW - 30_000) })).toBe(false)
    expect(lastTurnWroteWords(at(iso(NOW - 10_000)), { compactedAt: iso(NOW - 30_000) })).toBe(true)
    expect(lastTurnWroteWords(WORDY_TURN)).toBe(true)
    expect(lastTurnWroteWords([{ role: 'user', text: 'x' }, { role: 'assistant', text: 'Done.' }, { role: 'user', text: '[Request interrupted by user]' }])).toBe(true)
  })

  it('judges only an ask: other states pass', () => {
    for (const state of ['working', 'waiting', 'done'] as const) {
      expect(judgeTurnEndAsk({ state, at: iso(NOW) } as StatusReport, WORKING_AFTER_ASK, { turn: 'quiet' })).toEqual({ ok: true })
    }
  })

  it('the clean end of a quiet turn hands no task back', async () => {
    await withReport(WORKING_AFTER_ASK)
    beginQuietTurn(SID, 'idle-compact', 'idle-compact')
    expect(await handBackTaskOnSessionEnd(taskId, SID, 'snapshot-apply:test', { turnEnd: true })).toBe(false)
    expect((await getTask(taskId)).phase).toBe('IN_PROGRESS')
  })
})
