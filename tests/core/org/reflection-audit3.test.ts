/**
 * The third audit of the reflection (2026-11-24, Reflection VP), one test per finding fixed:
 * - a correction told a session to take a step that was not an agent's (prod promotions in the
 *   user's own browser): the judge is told such a step is asked for, never done;
 * - a third of the "not done" findings were done by the time they were judged (6 to 18 hours late),
 *   one sent 9 seconds after the session answered: the judge reads the session's later turns, and a
 *   first answer written while it judged holds the correction;
 * - 33 of 90 real corrections were held (one a pass per task, a lead chat's two a day) and never
 *   reached anyone: held ones go with the task's next send, in one message; a lead chat gets one an hour;
 * - a day whose judge budget was spent said nothing when an older build had spent the day's flag;
 * - near-identical lessons of several tasks, and the backfill, wrote near-identical lines; the tidy
 *   note counted the same lesson many times;
 * - a status-line ask was called "no buttons" when its thread card had them; a card rewritten five
 *   times after one complaint was judged five times.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-reflection-audit3'))

const sessionsByTask = new Map<string, Array<{ claudeSessionId: string; startedAt: string; lastActiveAt?: string; archived?: boolean }>>()
vi.mock('../../../src/core/session-tracker.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getSessionsForTask: async (id: string) => sessionsByTask.get(id) ?? [],
}))

import { WALNUT_HOME } from '../../../src/constants.js'
import type { Task } from '../../../src/core/types.js'
import { confirmSendCheck, judgeInputOf, reflectForNode, type ReflectDeps } from '../../../src/core/org/reflection/pipeline.js'
import { JUDGE_SYSTEM, judgePrompt } from '../../../src/core/org/reflection/judge.js'
import { addGuidance, guidanceFileOf, readDayEntries, readGuidance, reflectionDayFileOf, renderGuidance } from '../../../src/core/org/reflection/records.js'
import { CHAT_SEND_GAP_MS, localDate, readReflectionState, takeChatSend, updateReflectionState } from '../../../src/core/org/reflection/state.js'
import { distinctWaiting, twinLines } from '../../../src/core/org/reflection/guidance-tidy.js'
import { collectCandidates, type Candidate } from '../../../src/core/org/reflection/candidates.js'
import { currentSessionOfTask, sessionOfTaskAt } from '../../../src/core/sessions/session-send-core.js'

const NOW = Date.parse('2026-11-24T20:00:00Z')
const iso = (minAgo: number, now = NOW) => new Date(now - minAgo * 60_000).toISOString()
const vp = { id: 'vp-marina', title: 'Marina VP', project: 'Marina', org_role: 'lead', phase: 'IN_PROGRESS', org_duties: { reflection: { on: true, at: iso(9999) } } } as Task
const worker = { id: 'w-1', title: 'Upgrade the dock page', project: 'Marina', phase: 'IN_PROGRESS', parent_task_id: vp.id } as Task
const DONE = 'Shipped the new card layout and checked it on the phone.'

const finding = (correction = 'Bring the reply back under the card.', guidance = '') => JSON.stringify({ verdict: 'bad_decision', why: 'x', finding: {
  kind: 'regression', session_quote: DONE, user_quote: 'used to show', rule_quote: '', what_went_wrong: 'The card lost its reply.',
  correct_action: 'Bring the reply back.', already_fixed: false, correction, guidance, same_as: 0, skill: null,
} })

type Row = { role: string; text: string; timestamp: string; sentBy?: string }
function deps(over: Partial<ReflectDeps> & { messages?: Array<{ id: string; at: string; text: string }>; rows?: () => Row[] } = {}) {
  const sent: Array<{ task: string; text: string }> = []
  const look = {
    getTask: async (id: string) => [vp, worker].find((t) => t.id === id) ?? null, orgTasks: async () => [vp, worker],
    orgEnabled: async () => true, dutyOn: (t: Task) => t.org_duties?.reflection?.on === true, currentSession: currentSessionOfTask,
  }
  const rows = over.rows ?? (() => [
    { role: 'assistant', text: DONE, timestamp: iso(200) },
    ...(over.messages ?? []).map((m) => ({ role: 'user', text: m.text, timestamp: m.at, sentBy: 'person' })),
  ])
  const d: ReflectDeps = {
    readTranscript: async (sid: string) => (sid === 'sess-live' ? rows() as never : []),
    readMessages: async (id) => (id === worker.id ? over.messages ?? [] : []),
    readThreads: async () => [],
    callModel: async () => finding(),
    send: async (task, text) => { sent.push({ task: task.id, text }); return true },
    confirmSend: (node, task, sid) => confirmSendCheck(node, task, sid, look),
    currentSession: currentSessionOfTask,
    sessionAt: (t, at) => sessionOfTaskAt(t.id, at),
    rulesText: async () => '',
    replyLanguage: async () => null,
    nowMs: () => NOW,
    ...over,
  }
  return { d, sent }
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  sessionsByTask.clear()
  sessionsByTask.set(worker.id, [{ claudeSessionId: 'sess-live', startedAt: iso(5000), lastActiveAt: iso(5) }])
  sessionsByTask.set(vp.id, [{ claudeSessionId: 'sess-vp', startedAt: iso(5000), lastActiveAt: iso(1) }])
  await updateReflectionState(vp.id, (s) => { s.since = iso(3 * 24 * 60) }, NOW)
})

describe('what the judge is told', () => {
  it('a step that is not an agent\'s is asked for, never done; a status line has no buttons of its own', () => {
    expect(JUDGE_SYSTEM).toContain('never tell the session to take a step that is not an agent\'s to take')
    expect(JUDGE_SYSTEM).toContain('using the user\'s own browser, accounts or sign-ins')
    expect(JUDGE_SYSTEM).toContain('A Needs-you line on a task is only a status line')
  })

  it('reads what the session did after its window, up to now, when it is judged late', async () => {
    const c = {
      key: 'k', signal: 'frustration', task: worker, sessionId: 'sess-live', messages: [{ id: 'm', at: iso(600), text: 'the reply is gone again' }],
      from: iso(600), to: iso(600), why: 'x',
    } as unknown as Candidate
    const rows = [
      { role: 'assistant', text: DONE, timestamp: iso(700) },
      { role: 'user', text: 'the reply is gone again', timestamp: iso(600), sentBy: 'person' },
      { role: 'assistant', text: 'Looking at the card now.', timestamp: iso(598) },
      { role: 'assistant', text: 'Put the reply back under the card and shipped it.', timestamp: iso(60) },
    ]
    // As the real reader: `before` ends the window.
    const read = async (_sid: string, o: { before?: string }) => rows.filter((r) => !o.before || r.timestamp < o.before) as never
    const input = await judgeInputOf(vp, c, { readTranscript: read, rulesText: async () => '', replyLanguage: async () => null }, [])
    expect(input.laterText).toContain('Put the reply back under the card and shipped it.')
    expect(judgePrompt(input)).toContain('LATER (the session\'s latest turns')
    // Read for already_fixed only: never quotable as the decision judged.
    expect(input.sessionText).not.toContain('Put the reply back under the card and shipped it.')
  })
})

describe('a correction the session may have taken up while it was judged', () => {
  it('is judged again on the next pass when its first answer to him came while the judge read', async () => {
    const messages = [{ id: 'm1', at: iso(30), text: 'the reply used to show under the card' }]
    let answered = false
    const rows = () => [
      { role: 'assistant', text: DONE, timestamp: iso(200) },
      { role: 'user', text: messages[0].text, timestamp: messages[0].at, sentBy: 'person' },
      ...(answered ? [{ role: 'assistant', text: 'Bringing the reply back now.', timestamp: iso(1) }] : []),
    ]
    const { d, sent } = deps({ messages, rows, callModel: async () => { answered = true; return finding() } })
    await reflectForNode(vp, 'Marina VP', [vp, worker], d)
    expect(sent).toHaveLength(0)
    expect((await readDayEntries(vp.id, localDate(NOW))) ?? []).toHaveLength(0)
    // The next pass judges it with the answer: here the judge finds it taken up.
    const taken = JSON.parse(finding()); taken.finding.already_fixed = true
    const next = deps({ messages, rows, nowMs: () => NOW + 5 * 60_000, callModel: async () => JSON.stringify(taken) })
    await reflectForNode(vp, 'Marina VP', [vp, worker], next.d)
    expect(next.sent).toHaveLength(0)
    expect((await readDayEntries(vp.id, localDate(NOW)))![0]).toMatchObject({ corrected: 'already_fixed' })
  })
})

describe('held corrections go with the task\'s next send', () => {
  it('a second correction for one task in a pass is held, then sent in one message the next pass, and its entry says when', async () => {
    const messages = [
      { id: 'm1', at: iso(40), text: 'the reply used to show under the card' },
      { id: 'm2', at: iso(30), text: 'and the dates are wrong again, why' },
    ]
    const said = [finding('Bring the reply back under the card.'), finding('Show the dates in his time zone again.')]
    const { d, sent } = deps({ messages, callModel: async () => said.shift()! })
    await reflectForNode(vp, 'Marina VP', [vp, worker], d)
    expect(sent).toHaveLength(1)
    const day = localDate(NOW)
    expect((await readDayEntries(vp.id, day))!.map((e) => e.corrected).sort()).toEqual(['held', 'sent'])
    expect((await readReflectionState(vp.id, NOW)).held).toHaveLength(1)
    // The next pass: nothing new to judge, the held one goes alone in one message.
    const later = deps({ messages, nowMs: () => NOW + 5 * 60_000 })
    await reflectForNode(vp, 'Marina VP', [vp, worker], later.d)
    expect(later.sent).toHaveLength(1)
    expect(later.sent[0].text).toContain('held 1 correction for this task')
    const held = (await readDayEntries(vp.id, day))!.find((e) => e.corrected === 'held')!
    expect(held.sentLater).toBe(new Date(NOW + 5 * 60_000).toISOString())
    expect(await fs.readFile(reflectionDayFileOf(vp.id, day), 'utf-8')).toContain('> Note: Sent later: 1 held correction to Upgrade the dock page (w-1)')
    expect((await readReflectionState(vp.id, NOW + 5 * 60_000)).held ?? []).toHaveLength(0)
  })

  it('one held longer than a day is dropped and the day says so', async () => {
    await updateReflectionState(vp.id, (s) => { s.held = [{ taskId: worker.id, at: iso(25 * 60), date: localDate(NOW), entryAt: iso(25 * 60), text: 'old point' }] }, NOW)
    const { d, sent } = deps()
    await reflectForNode(vp, 'Marina VP', [vp, worker], d)
    expect(sent).toHaveLength(0)
    expect(await fs.readFile(reflectionDayFileOf(vp.id, localDate(NOW)), 'utf-8')).toContain('Held corrections dropped: 1 for Upgrade the dock page (w-1) waited over 24 hours')
  })

  it('a send that does not go puts them back and gives the chat its hour back; the same point held twice is one, both entries marked', async () => {
    const { holdCorrection, sendHeld } = await import('../../../src/core/org/reflection/held-corrections.js')
    const day = localDate(NOW)
    const { appendDayEntry } = await import('../../../src/core/org/reflection/records.js')
    const entry = (at: string) => ({ at, signal: 'frustration' as const, task: { id: vp.id, title: vp.title }, finding: JSON.parse(finding()).finding, corrected: 'held' as const, held: 'own_cap' as const, rule: { kind: 'none' as const, text: 'no new rule' } })
    for (const at of [iso(20), iso(10)]) {
      await appendDayEntry(vp.id, 'Marina VP', day, entry(at))
      await holdCorrection(vp, 'Marina VP', vp.title, { taskId: vp.id, at, date: day, entryAt: at, text: 'Answer the thread he wrote in.' }, NOW)
    }
    expect((await readReflectionState(vp.id, NOW)).held).toHaveLength(1)
    const { d } = deps()
    expect(await sendHeld(vp, 'Marina VP', [vp, worker], new Set(), { ...d, send: async () => false }, NOW)).toBe(0)
    expect((await readReflectionState(vp.id, NOW)).held).toHaveLength(1)
    expect((await readReflectionState(vp.id, NOW)).lastChatSendAt).toBeUndefined()
    const sent: string[] = []
    expect(await sendHeld(vp, 'Marina VP', [vp, worker], new Set(), { ...d, send: async (_t, text) => { sent.push(text); return true } }, NOW)).toBe(1)
    expect(sent[0]).toContain('held 1 correction')
    expect((await readDayEntries(vp.id, day))!.map((e) => e.sentLater)).toEqual([new Date(NOW).toISOString(), new Date(NOW).toISOString()])
  })

  it('past the few a task may wait with, the oldest go and the day says so', async () => {
    const { holdCorrection, HELD_PER_TASK_MAX } = await import('../../../src/core/org/reflection/held-corrections.js')
    const points = ['Show the dates in his zone.', 'Bring the reply back under the card.', 'Name the thread in the card.', 'Put the recommended button first.', 'Link the design page by its path.', 'Say what each button does.', 'Close the card he acknowledged.']
    for (const [i, text] of points.entries()) await holdCorrection(vp, 'Marina VP', worker.title, { taskId: worker.id, at: iso(60 - i), date: localDate(NOW), entryAt: iso(60 - i), text }, NOW)
    expect((await readReflectionState(vp.id, NOW)).held).toHaveLength(HELD_PER_TASK_MAX)
    expect(await fs.readFile(reflectionDayFileOf(vp.id, localDate(NOW)), 'utf-8')).toContain('Held corrections dropped: 1 for Upgrade the dock page (w-1)')
  })

  it('a lead chat gets one an hour, not two a day', async () => {
    expect(await takeChatSend(vp.id, NOW)).toBe(true)
    expect(await takeChatSend(vp.id, NOW + CHAT_SEND_GAP_MS - 1)).toBe(false)
    expect(await takeChatSend(vp.id, NOW + CHAT_SEND_GAP_MS)).toBe(true)
    expect(await takeChatSend(vp.id, NOW + 2 * CHAT_SEND_GAP_MS)).toBe(true)
  })
})

describe('the day says its spent budget', () => {
  it('even when the state\'s flag was spent by an older build and the record has no note', async () => {
    const messages = [{ id: 'm1', at: iso(30), text: 'the reply used to show under the card' }]
    await updateReflectionState(vp.id, (s) => { s.day.calls = 1000; s.day.budgetLeftCount = 3 }, NOW)
    const { d } = deps({ messages })
    await reflectForNode(vp, 'Marina VP', [vp, worker], d)
    expect(await fs.readFile(reflectionDayFileOf(vp.id, localDate(NOW)), 'utf-8')).toContain('> Note: Judge budget')
  })
})

describe('the same lesson in other words is one line', () => {
  const line = 'When the user agrees to a group of objects at once, the agent completes each item the tool asks to confirm by quoting his words.'
  it('a lesson a line nearly says is known, from any task or the backfill', async () => {
    await fs.mkdir(path.dirname(guidanceFileOf(vp.id)), { recursive: true })
    await fs.writeFile(guidanceFileOf(vp.id), renderGuidance('Marina VP', [{ text: line, from: 'a task', date: '2026-11-20' }]))
    const twin = 'When the user agrees to a group of objects at once, the agent completes every item the tool asks to confirm, quoting his words.'
    expect(await addGuidance(vp.id, 'Marina VP', { text: twin, from: 'another task', date: '2026-11-24' }, { removed: [], addedToday: 0 })).toBe('known')
    expect(await readGuidance(vp.id)).toHaveLength(1)
    expect(await addGuidance(vp.id, 'Marina VP', { text: 'Name the thread a card asks him to answer in.', from: 'x', date: '2026-11-24' }, { removed: [], addedToday: 0 })).toBe('added')
  })

  it('a short lesson is never read as said by a long line that shares its words', async () => {
    const { nearlySame } = await import('../../../src/core/org/reflection/records.js')
    const longLine = 'Before you land, run the tests your change reaches, never restart the production server by hand, and ask the user only for his own decisions: spending, credentials, outward sends, deleting his data and public releases; decide the rest yourself and say what you chose.'
    for (const short of ['Run the tests before you land.', 'Never restart the production server by hand.', 'Ask the user only for his own decisions.']) expect([short, nearlySame(longLine, short)]).toEqual([short, false])
  })

  it('the tidy note counts each waiting lesson once and names the lines to merge first', () => {
    const lines = [line, line.replace('each item', 'every item'), 'Name the thread a card asks him to answer in.']
    expect(twinLines(lines)).toEqual([[1, 2]])
    const waiting = [line.replace('at once', 'in one go'), 'Show his dates in his own time zone.', 'Show the dates in his own time zone.']
    expect(distinctWaiting(waiting, lines)).toEqual(['Show the dates in his own time zone.'])
  })
})

describe('an ask is judged where he reads it', () => {
  const thread = (over: Record<string, unknown> = {}) => ({
    id: 'th-1', title: 'Pick the dock layout', state: 'needs', closed: false, tasks: [worker.id], updatedAt: iso(30), replyAt: iso(30),
    reply: 'Pick A (recommended): one column.', options: [{ label: 'A', recommended: true }, { label: 'B' }],
    messages: [{ id: 'tm-1', at: iso(60), text: 'why is the layout this wide' }], ...over,
  })
  const asking = { ...worker, user_status: { state: 'needs', source: 'session', ask: 'Pick the dock layout', at: iso(30), askSessionId: 'sess-live' } } as unknown as Task
  const collect = async (threads: unknown[], seen: string[] = []) => (await collectCandidates(vp, [vp, asking], iso(3000), new Set(seen), {
    readTranscript: async () => [], readMessages: async () => [], readThreads: async (id: string) => (id === vp.id ? threads as never : []),
    currentSession: currentSessionOfTask, sessionAt: (t, at) => sessionOfTaskAt(t.id, at), nowMs: () => NOW, replyLanguage: async () => null,
  } as never)).candidates.filter((c) => c.key.startsWith('card:') || c.key.startsWith('ask:'))

  it('an ask with a card of its own is judged once, as the card; a card that shows the ask, or one judged already, lends it its buttons', async () => {
    expect((await collect([thread()])).map((c) => c.key)).toEqual(['card:th-1:after:tm-1'])
    for (const [th, seen] of [[thread({ cardOfOther: true }), []], [thread(), ['card:th-1:after:tm-1']]] as const) {
      const cs = await collect([th], [...seen])
      expect(cs.map((c) => c.key.split(':')[0])).toEqual(['ask'])
      expect(cs[0].ask!.text).toContain('Thread card: Pick the dock layout')
      expect(cs[0].ask!.text).not.toContain('Buttons: none')
    }
  })

  it('a card about several tasks lends no task its buttons: each ask is still judged', async () => {
    const ask = (await collect([thread({ tasks: [worker.id, 'w-2'] })])).find((c) => c.key.startsWith('ask:'))!
    expect(ask.ask!.text).not.toContain('Thread card:')
  })

  it('a card rewritten after one message of his is judged once', async () => {
    const first = await collect([thread()])
    const again = await collect([thread({ reply: 'Pick A (recommended): one column, as on the phone.' })], first.map((c) => c.key))
    expect(again.filter((c) => c.key.startsWith('card:'))).toHaveLength(0)
  })
})
