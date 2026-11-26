/**
 * An ask a session wrote itself with task_report_set stays its ask when its turn ends still asking
 * (src/core/sessions/own-ask-write.ts). 2026-11-23 and 11-24: a task put the full English message
 * the user was to approve into ask_more and read it back; the turn's status answer was stored over
 * it, a Chinese summary, and the card asked him to approve words that were not the message.
 *
 * The class: every report a turn end stores (the status question, the summary with status lines)
 * goes through saveStatusAnswer, which keeps the own write; the ratchet below fails when another
 * file stores a status_report without it.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import fss from 'node:fs'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-own-ask'))

import { WALNUT_HOME } from '../../src/constants.js'
import { applyStatusAnswer } from '../../src/core/sessions/status-question.js'
import { setTaskReport } from '../../src/core/sessions/report-set.js'
import { keepOwnAskWrite } from '../../src/core/sessions/own-ask-write.js'
import { addTask, getTask, updateTaskRaw } from '../../src/core/task-manager.js'
import { createSessionRecord, updateSessionRecord } from '../../src/core/session-tracker.js'
import type { StatusReport } from '../../src/core/user-status.js'
import { askDecisionQuestion } from '../../src/core/ask-decision.js'

const ROOT = path.resolve(__dirname, '../..')
const iso = (ms: number) => new Date(ms).toISOString()
const MESSAGE = 'Hello, please print 200 copies of the attached garden club flyer on A5 matte paper by Friday. Thank you.'
const OWN = {
  state: 'needs', ask: 'Send this order to the print shop in your name through its web form?',
  ask_kind: 'single', ask_options: [{ label: 'Send it as written', recommended: true }, { label: 'Keep it unsent' }], ask_more: MESSAGE, user_kind: 'user_own', user_kind_why: 'It speaks to the print shop in his name',
}

describe('an ask the session wrote itself survives its turn end', () => {
  const SID = '2a3b4c5d-6e7f-4801-92a3-b4c5d6e7f809'
  let id = ''
  beforeAll(async () => {
    await fs.rm(WALNUT_HOME, { recursive: true, force: true })
    await fs.mkdir(WALNUT_HOME, { recursive: true })
    id = (await addTask({ title: 'Order the club flyers', project: 'Garden' })).task.id
    await createSessionRecord(SID, id, 'Garden', WALNUT_HOME)
  })
  afterAll(async () => { await fs.rm(WALNUT_HOME, { recursive: true, force: true }) })

  const ownWriteInTurn = async (turnEnd: number) => {
    await updateTaskRaw(id, { phase: 'IN_PROGRESS', status_report: undefined }, { source: 'test' })
    await updateSessionRecord(SID, { process_status: 'running' })
    await setTaskReport(id, OWN, { taskId: id, sessionId: SID, title: 'Order the club flyers' } as never, turnEnd - 20_000)
    await updateSessionRecord(SID, { process_status: 'idle' })
    expect((await getTask(id)).status_report?.ask_more).toBe(MESSAGE)
  }

  const summary = (end: number, extra: Partial<StatusReport> = {}): StatusReport => ({
    state: 'needs', ask: 'Approve the order to the print shop?', ask_more: '\u628a\u8ba2\u5355\u53d1\u7ed9\u5370\u5237\u5e97',
    ask_own: { kind: 'user_own', why: 'his name' }, now: 'Drafted the message', at: iso(end + 5_000), ...extra,
  })
  const asked = async () => (await getTask(id)).status_report!

  it('the turn-end answer that still asks keeps the ask, its options, its detail and its kind as written', async () => {
    const end = Date.now() - 90_000
    await ownWriteInTurn(end)
    expect(await applyStatusAnswer(id, SID, summary(end), end)).toBe(true)
    const r = await asked()
    expect(r).toMatchObject({ state: 'needs', ask: OWN.ask, ask_kind: 'single', ask_more: MESSAGE, ask_by_self: true, ask_own: { kind: 'user_own', why: OWN.user_kind_why } })
    expect(r.ask_options?.map((o) => o.label)).toEqual(['Send it as written', 'Keep it unsent'])
    // The rest of the turn's report is its own: where it stands, and the turn-end stamp.
    expect(r.now).toBe('Drafted the message')
    expect(r.rule).toBeDefined()
  })

  it('the next turn on the same decision keeps it too (the user only asked a follow-up)', async () => {
    const end = Date.now() - 80_000
    await ownWriteInTurn(end)
    await applyStatusAnswer(id, SID, summary(end), end)
    const later = end + 20_000
    expect(await applyStatusAnswer(id, SID, summary(later, { now: 'Answered his question about the paper' }), later)).toBe(true)
    expect(await asked()).toMatchObject({ ask: OWN.ask, ask_more: MESSAGE, now: 'Answered his question about the paper' })
  })

  it('a watch asked mid-turn, then the turn end: both keep it', async () => {
    const end = Date.now() - 60_000
    await ownWriteInTurn(end)
    expect(await applyStatusAnswer(id, SID, summary(end - 10_000), end, { midTurn: true, askedAtMs: end - 10_000 })).toBe(true)
    expect(await applyStatusAnswer(id, SID, summary(end), end)).toBe(true)
    expect(await asked()).toMatchObject({ ask: OWN.ask, ask_more: MESSAGE })
  })

  it('an answer that says its ask is another decision replaces it, and the mark goes', async () => {
    const end = Date.now() - 40_000
    await ownWriteInTurn(end)
    const other = summary(end, { ask: 'Which pickup day suits the club?', ask_more: undefined, ask_id: 'new' })
    expect(await applyStatusAnswer(id, SID, other, end)).toBe(true)
    const r = await asked()
    expect(r.ask).toBe('Which pickup day suits the club?')
    expect(r.ask_more).toBeUndefined()
    expect(r.ask_by_self).toBeUndefined()
  })

  // 2026-11-26: he answered the ask; the session replied and ended "needs you" for him to read the
  // reply, asking nothing. The answered question came back on his card with its options.
  it('he answered it, and the turn that replies asks nothing: the ask is over, its options and mark gone', async () => {
    const end = Date.now() - 30_000
    await ownWriteInTurn(end)
    await applyStatusAnswer(id, SID, summary(end), end)
    const shown = Date.parse((await asked()).at)
    const later = Math.max(end, shown) + 20_000
    await updateSessionRecord(SID, { humanInputAt: iso(later - 10_000) })
    const read: StatusReport = { state: 'needs', now: 'Noted his answer; nothing for him to do', at: iso(later + 1_000) }
    expect(await applyStatusAnswer(id, SID, read, later)).toBe(true)
    const r = await asked()
    expect(r.ask).toBeUndefined()
    expect(r.ask_options).toBeUndefined()
    expect(r.ask_more).toBeUndefined()
    expect(r.ask_by_self).toBeUndefined()
    expect(r.answered_person).toBe(true)
    await updateSessionRecord(SID, { humanInputAt: undefined })
  })

  it('he wrote since (a follow-up), and the turn end still asks in its own words: still its ask, as written', async () => {
    const end = Date.now() - 25_000
    await ownWriteInTurn(end)
    await applyStatusAnswer(id, SID, summary(end), end)
    const later = Math.max(end, Date.parse((await asked()).at)) + 20_000
    await updateSessionRecord(SID, { humanInputAt: iso(later - 10_000) })
    expect(await applyStatusAnswer(id, SID, summary(later, { now: 'Answered his question about the paper' }), later)).toBe(true)
    expect(await asked()).toMatchObject({ ask: OWN.ask, ask_more: MESSAGE, ask_by_self: true })
    await updateSessionRecord(SID, { humanInputAt: undefined })
  })

  // Review 2026-11-26: the stored report's time moves to each answer, so these two read his answer as older than the ask.
  it('he answered before the writing turn\'s status answer was stored: the reply turn that asks nothing ends the ask', async () => {
    const end = Date.now() - 200_000
    await ownWriteInTurn(end)
    await updateSessionRecord(SID, { humanInputAt: iso(end + 3_000) })
    expect(await applyStatusAnswer(id, SID, summary(end + 15_000), end)).toBe(true)
    expect((await asked()).ask).toBe(OWN.ask)
    const later = end + 60_000
    expect(await applyStatusAnswer(id, SID, { state: 'needs', now: 'Noted his answer', at: iso(later + 1_000) }, later)).toBe(true)
    const r = await asked()
    expect(r.ask).toBeUndefined()
    expect(r.ask_by_self).toBeUndefined()
    await updateSessionRecord(SID, { humanInputAt: undefined })
  })

  it('a watch\'s mid-turn answer stored after his answer does not hide it: the reply turn that asks nothing ends the ask', async () => {
    const end = Date.now() - 150_000
    await ownWriteInTurn(end)
    await applyStatusAnswer(id, SID, summary(end), end)
    const said = Math.max(end, Date.parse((await asked()).at)) + 5_000
    await updateSessionRecord(SID, { humanInputAt: iso(said) })
    expect(await applyStatusAnswer(id, SID, summary(said + 10_000), end, { midTurn: true, askedAtMs: said + 9_000 })).toBe(true)
    expect((await asked()).ask).toBe(OWN.ask)
    const later = said + 30_000
    expect(await applyStatusAnswer(id, SID, { state: 'needs', now: 'Noted his answer', at: iso(later + 1_000) }, later)).toBe(true)
    const r = await asked()
    expect(r.ask).toBeUndefined()
    // The decision it asked is over: the next turn's question does not name it as its ask.
    expect(askDecisionQuestion(r)).toBe('')
    await updateSessionRecord(SID, { humanInputAt: undefined })
  })

  it('a turn that ends no longer asking says so: its answer wins', async () => {
    const end = Date.now() - 20_000
    await ownWriteInTurn(end)
    expect(await applyStatusAnswer(id, SID, { state: 'working', now: 'Sending it after his yes in chat', at: iso(end + 5_000) }, end)).toBe(true)
    const r = await asked()
    expect(r.state).toBe('working')
    expect(r.ask_more).toBeUndefined()
    expect(r.ask_by_self).toBeUndefined()
  })
})

describe('keepOwnAskWrite', () => {
  const SID = 'sid-own'
  const prev: StatusReport = { state: 'needs', ask: 'Send it?', ask_more: MESSAGE, ask_own: { kind: 'user_own', why: 'his name' }, ask_id: 'ask-1a2b', ask_by_self: true, at: iso(1), session_id: SID }
  it('a kindless answer (turned into a report to the lead) still asks the own ask', () => {
    const kindless: StatusReport = { state: 'waiting', waiting_kind: 'lead', waiting_on: 'Send it?', kindless_ask: true, at: iso(2) }
    const kept = keepOwnAskWrite(kindless, prev, SID)
    expect(kept).toMatchObject({ state: 'needs', ask: 'Send it?', ask_more: MESSAGE })
    expect(kept.waiting_on).toBeUndefined()
    expect(kept.kindless_ask).toBeUndefined()
  })
  it('only its own session\'s marked write, and not over an answer naming another decision', () => {
    const answer: StatusReport = { state: 'needs', ask: 'Approve?', at: iso(2) }
    expect(keepOwnAskWrite(answer, { ...prev, session_id: 'another' }, SID)).toBe(answer)
    const { ask_by_self: _m, ...unmarked } = prev
    expect(keepOwnAskWrite(answer, unmarked, SID)).toBe(answer)
    const other = { ...answer, ask_id: 'ask-3c4d' }
    expect(keepOwnAskWrite(other, prev, SID)).toBe(other)
    expect(keepOwnAskWrite({ ...answer, ask_id: 'ask-1a2b' }, prev, SID).ask_more).toBe(MESSAGE)
  })
  it('after he wrote since the ask was shown, only an answer that asks, or names the decision, keeps it', () => {
    const wrote = iso(5)
    const nothing: StatusReport = { state: 'needs', now: 'Replied to him', at: iso(9) }
    // The bug: needs with no ask after his answer copied the answered question back.
    expect(keepOwnAskWrite(nothing, prev, SID, wrote)).toBe(nothing)
    // Still its ask: words of an ask, or a kindless line.
    expect(keepOwnAskWrite({ ...nothing, ask: 'Approve?' }, prev, SID, wrote).ask_more).toBe(MESSAGE)
    expect(keepOwnAskWrite({ state: 'waiting', waiting_kind: 'lead', waiting_on: 'Send it?', kindless_ask: true, at: iso(9) }, prev, SID, wrote).ask_more).toBe(MESSAGE)
    // He wrote before the ask was written (the turn that wrote it), or never: the write stands, as before.
    expect(keepOwnAskWrite(nothing, prev, SID, iso(0)).ask_more).toBe(MESSAGE)
    expect(keepOwnAskWrite(nothing, prev, SID).ask_more).toBe(MESSAGE)
    expect(keepOwnAskWrite(nothing, prev, SID, 'not a time').ask_more).toBe(MESSAGE)
    // The anchor is when the decision began being asked, not the stored report's own (later) time.
    const later = { ...prev, ask_since: iso(1), at: iso(8) }
    expect(keepOwnAskWrite(nothing, later, SID, wrote)).toBe(nothing)
    expect(keepOwnAskWrite(nothing, { ...later, ask_since: iso(6) }, SID, wrote).ask_more).toBe(MESSAGE)
  })
})

describe('every stored status_report goes through the turn-end gate or is the explicit write', () => {
  it('no other file stores a status_report', () => {
    const files: string[] = []
    const walk = (dir: string) => {
      for (const e of fss.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.ts$/.test(e.name) && /\{\s*status_report:\s*[A-Za-z_$]/.test(fss.readFileSync(p, 'utf-8'))) files.push(path.relative(ROOT, p))
      }
    }
    walk(path.join(ROOT, 'src'))
    // report-set.ts is the explicit write; status-question.ts stores every turn-end report through keepOwnAskWrite.
    // thread-report-ask.ts stores no report of a turn: it only takes an ask off the stored one once the
    // task's own needs thread asks that decision (the ask lives on as the thread), through withoutOwnAsk.
    expect(files.sort()).toEqual(['src/core/org/thread-report-ask.ts', 'src/core/sessions/report-set.ts', 'src/core/sessions/status-question.ts'])
    expect(fss.readFileSync(path.join(ROOT, 'src/core/org/thread-report-ask.ts'), 'utf-8')).toMatch(/status_report:\s*stampSaidDecision\(withoutOwnAsk\(/)
    expect(fss.readFileSync(path.join(ROOT, 'src/core/sessions/status-question.ts'), 'utf-8')).toMatch(/keepOwnAskWrite\(report, prev, sessionId, rec\?\.humanInputAt\)/)
  })
})
