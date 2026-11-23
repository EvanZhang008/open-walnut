/**
 * The second audit of the reflection (2026-11-23, Reflection VP): an org node's task has no slot
 * session fields (session_id, exec_session_id are empty while its session runs), and the reflection
 * read only those. So every correction to a node's own chat read "no known session", the daily ask
 * to tidy a full guidance was never sent, and a message with no session of its own was judged with
 * no turns (the judge then said "not done" of work the session had done).
 *
 * Pinned here with tasks shaped as production's (no slot fields): the task's session comes from the
 * send's own pick (session-send-core.ts currentSessionOfTask) everywhere the reflection needs it; one
 * lesson a pass per task and kind; the day's JSON keeps its notes and counts its passes; and a ratchet
 * that no reflection source reads the slot fields but the one helper.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-reflection-node-session'))

const sessionsByTask = new Map<string, Array<{ claudeSessionId: string; startedAt: string; lastActiveAt?: string; archived?: boolean }>>()
vi.mock('../../../src/core/session-tracker.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getSessionsForTask: async (id: string) => sessionsByTask.get(id) ?? [],
}))

import { WALNUT_HOME } from '../../../src/constants.js'
import type { Task } from '../../../src/core/types.js'
import { confirmSendCheck, reflectForNode, type ReflectDeps } from '../../../src/core/org/reflection/pipeline.js'
import { appendDayEntry, appendDayNote, guidanceFileOf, readDayEntries, reflectionDayJsonOf, renderGuidance } from '../../../src/core/org/reflection/records.js'
import { localDate, readReflectionState, updateReflectionState } from '../../../src/core/org/reflection/state.js'
import { askTidy } from '../../../src/core/org/reflection/guidance-tidy.js'
import { guidanceRoomLeft } from '../../../src/core/org/reflection/team-guidance-hint.js'
import { normalizeForQuote as normalizeKey } from '../../../src/core/org/reflection/judge.js'
import { currentSessionOfTask, sessionOfTaskAt } from '../../../src/core/sessions/session-send-core.js'

const NOW = Date.parse('2026-11-23T20:00:00Z')
const iso = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString()
// As production's org nodes and their tasks: no slot fields, a session that runs.
const vp = { id: 'vp-marina', title: 'Marina VP', project: 'Marina', org_role: 'lead', phase: 'IN_PROGRESS', org_duties: { reflection: { on: true, at: iso(9999) } } } as Task
const worker = { id: 'w-1', title: 'Upgrade the dock page', project: 'Marina', phase: 'IN_PROGRESS' } as Task
const DONE = 'Shipped the new card layout and checked it on the phone.'

const finding = (guidance = '') => JSON.stringify({ verdict: 'bad_decision', why: 'x', finding: {
  kind: 'regression', session_quote: DONE, user_quote: 'used to show', rule_quote: '', what_went_wrong: 'The card lost its reply.',
  correct_action: 'Bring the reply back.', already_fixed: false, correction: 'Bring the reply back under the card.',
  guidance, same_as: 0, skill: null,
} })

function deps(over: Partial<ReflectDeps> & { messages?: Array<{ id: string; at: string; text: string }> } = {}) {
  const sent: Array<{ task: string; text: string }> = []
  const transcriptsRead: string[] = []
  const look = {
    getTask: async (id: string) => [vp, worker].find((t) => t.id === id) ?? null, orgTasks: async () => [vp, worker],
    orgEnabled: async () => true, dutyOn: (t: Task) => t.org_duties?.reflection?.on === true, currentSession: currentSessionOfTask,
  }
  const d: ReflectDeps = {
    readTranscript: async (sid: string) => {
      transcriptsRead.push(sid)
      return sid === 'sess-live' ? [
        { role: 'assistant', text: DONE, timestamp: iso(200) },
        ...(over.messages ?? []).map((m) => ({ role: 'user', text: m.text, timestamp: m.at, sentBy: 'person' })),
      ] as never : []
    },
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
  return { d, sent, transcriptsRead }
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  sessionsByTask.clear()
  sessionsByTask.set(worker.id, [
    { claudeSessionId: 'sess-old', startedAt: iso(2000), lastActiveAt: iso(900), archived: true },
    { claudeSessionId: 'sess-live', startedAt: iso(800), lastActiveAt: iso(5) },
  ])
  sessionsByTask.set(vp.id, [{ claudeSessionId: 'sess-vp', startedAt: iso(5000), lastActiveAt: iso(1) }])
  await updateReflectionState(vp.id, (s) => { s.since = iso(3 * 24 * 60) }, NOW)
})

describe('a task with no slot fields', () => {
  it('has the session a send reaches: its slot when live, else the newest live one, else none', async () => {
    expect(await currentSessionOfTask(worker)).toBe('sess-live')
    expect(await currentSessionOfTask({ ...worker, session_id: 'sess-old' })).toBe('sess-live')
    // The session running when a message was written: archived ones too, never one started after it.
    expect(await sessionOfTaskAt(worker.id, iso(1000))).toBe('sess-old')
    expect(await sessionOfTaskAt(worker.id, iso(30))).toBe('sess-live')
    expect(await sessionOfTaskAt(worker.id, iso(3000))).toBe('')
    sessionsByTask.set(worker.id, [{ claudeSessionId: 'a', startedAt: iso(90), lastActiveAt: iso(50) }, { claudeSessionId: 'b', startedAt: iso(60), lastActiveAt: iso(10) }])
    expect(await currentSessionOfTask({ ...worker, session_id: 'a' })).toBe('a')
    // No live session: none, never the archived slot it names.
    sessionsByTask.set(worker.id, [{ claudeSessionId: 'gone', startedAt: iso(90), archived: true }])
    expect(await currentSessionOfTask({ ...worker, session_id: 'gone' })).toBe('')
  })

  it('a message from before the session changed is judged on its own session\'s turns and sent to the current one, told so', async () => {
    const { d, sent, transcriptsRead } = deps({
      messages: [{ id: 'm0', at: iso(1000), text: 'the reply used to show under the card' }],
      readTranscript: async (sid: string) => { transcriptsRead.push(sid); return sid === 'sess-old' ? [{ role: 'assistant', text: DONE, timestamp: iso(1100) }, { role: 'user', text: 'the reply used to show under the card', timestamp: iso(1000), sentBy: 'person' }] as never : [] },
    })
    await reflectForNode(vp, 'Marina VP', [vp, worker], d)
    expect(transcriptsRead).toContain('sess-old')
    expect(sent).toHaveLength(1)
    expect(sent[0].text).toContain('a turn of an earlier session of this task')
  })

  it('is judged on its session\'s turns, and its correction is sent (never "no known session")', async () => {
    const { d, sent, transcriptsRead } = deps({ messages: [{ id: 'm1', at: iso(30), text: 'the reply used to show under the card' }] })
    await reflectForNode(vp, 'Marina VP', [vp, worker], d)
    expect(transcriptsRead).toContain('sess-live')
    expect(sent).toHaveLength(1)
    const [e] = (await readDayEntries(vp.id, localDate(NOW)))!
    expect(e).toMatchObject({ corrected: 'sent' })
    expect(e.notSent).toBeUndefined()
  })

  it('a node\'s own chat gets the daily ask to tidy a full guidance', async () => {
    const long = (i: number) => `Rule number ${i}: ${'keep every point of the old line and its condition '.repeat(4)}`.slice(0, 240)
    await fs.mkdir(path.dirname(guidanceFileOf(vp.id)), { recursive: true })
    await fs.writeFile(guidanceFileOf(vp.id), renderGuidance('Marina VP', Array.from({ length: 16 }, (_, i) => ({ text: long(i), from: 'a task', date: '2026-11-20' }))))
    const waiting = 'Name the thread a card asks him to answer in.'
    await appendDayEntry(vp.id, 'Marina VP', localDate(NOW), {
      at: iso(10), signal: 'frustration', task: { id: worker.id, title: worker.title },
      finding: { kind: 'unclear_ask', session_quote: 'q', user_quote: 'u', rule_quote: '', what_went_wrong: 'w', correct_action: 'c', already_fixed: false, correction: '', guidance: waiting, same_as: 0, skill: null },
      corrected: 'already_fixed', rule: { kind: 'none', text: `not added (day_full; not merged: x): ${waiting}` },
    })
    const { d, sent } = deps()
    expect(await askTidy(vp, 'Marina VP', d, NOW)).toBe(true)
    expect(sent.map((s) => s.task)).toEqual([vp.id])
    expect((await readReflectionState(vp.id, NOW)).tidyAsked).toBe(localDate(NOW))
  })
})

describe('the ask to tidy a full guidance', () => {
  const long = (i: number, n = 240) => `Rule number ${i}: ${'keep every point of the old line and its condition '.repeat(8)}`.slice(0, n)
  const waitingEntry = (text: string) => ({
    at: iso(10), signal: 'frustration' as const, task: { id: worker.id, title: worker.title },
    finding: { kind: 'unclear_ask' as const, session_quote: 'q', user_quote: 'u', rule_quote: '', what_went_wrong: 'w', correct_action: 'c', already_fixed: false, correction: '', guidance: text, same_as: 0, skill: null },
    corrected: 'already_fixed' as const, rule: { kind: 'none' as const, text: `not added (day_full; not merged: x): ${text}` },
  })
  const write = async (lines: string[]) => {
    await fs.mkdir(path.dirname(guidanceFileOf(vp.id)), { recursive: true })
    await fs.writeFile(guidanceFileOf(vp.id), renderGuidance('Marina VP', lines.map((text) => ({ text, from: 'a task', date: '2026-11-20' }))))
  }

  it('names a lesson the backfill gave up on: it was never placed', async () => {
    await write(Array.from({ length: 16 }, (_, i) => long(i)))
    const lesson = 'Name the thread a card asks him to answer in.'
    await appendDayEntry(vp.id, 'Marina VP', localDate(NOW), waitingEntry(lesson))
    await updateReflectionState(vp.id, (s) => { s.backfilled = [normalizeKey(lesson)]; s.backfillGaveUp = [normalizeKey(lesson)] }, NOW)
    const { d, sent } = deps()
    expect(await askTidy(vp, 'Marina VP', d, NOW)).toBe(true)
    expect(sent[0].text).toContain(lesson)
  })

  it('asks when there is room left but no waiting lesson fits in it', async () => {
    // Lines of 240 filling the hint to just past the cut-off, and a waiting lesson longer than what is left.
    const lines: string[] = []
    while (guidanceRoomLeft('Marina VP', [...lines, long(lines.length)]) >= 220) lines.push(long(lines.length))
    await write(lines)
    const room = guidanceRoomLeft('Marina VP', lines)
    expect(room).toBeGreaterThanOrEqual(200)
    const lesson = long(99, Math.min(300, room + 40))
    await appendDayEntry(vp.id, 'Marina VP', localDate(NOW), waitingEntry(lesson))
    const { d, sent } = deps()
    expect(guidanceRoomLeft('Marina VP', [...lines, lesson])).toBeLessThan(0)
    expect(await askTidy(vp, 'Marina VP', d, NOW)).toBe(true)
    expect(sent).toHaveLength(1)
  })
})

describe('one pass', () => {
  it('keeps one lesson per task and kind: his several messages about one thing are one lesson', async () => {
    const lesson = 'Keep the reply under the card when the layout changes.'
    const messages = [
      { id: 'm1', at: iso(40), text: 'the reply used to show under the card' },
      { id: 'm2', at: iso(30), text: 'it used to show the reply, it broke again' },
    ]
    const said = [lesson, 'Keep the reply under the card whenever the layout changes.']
    const { d } = deps({ messages, callModel: async () => finding(said.shift()!) })
    await reflectForNode(vp, 'Marina VP', [vp, worker], d)
    const entries = (await readDayEntries(vp.id, localDate(NOW)))!
    expect(entries).toHaveLength(2)
    expect(entries.filter((e) => e.rule.kind === 'guidance')).toHaveLength(1)
    expect(entries.some((e) => e.rule.text.startsWith('not added (same lesson as an earlier finding on this task this pass)'))).toBe(true)
  })

  it('a different lesson of the same kind on the same task is still kept', async () => {
    const said = ['Keep the reply under the card when the layout changes.', 'Run the phone layout check before a card ships.']
    const messages = [
      { id: 'm1', at: iso(40), text: 'the reply used to show under the card' },
      { id: 'm2', at: iso(30), text: 'the phone layout used to show the tab, it broke' },
    ]
    const { d } = deps({ messages, callModel: async () => finding(said.shift()!) })
    await reflectForNode(vp, 'Marina VP', [vp, worker], d)
    expect((await readDayEntries(vp.id, localDate(NOW)))!.filter((e) => e.rule.kind === 'guidance')).toHaveLength(2)
  })

  it('is counted in the day\'s JSON with nothing to judge, and a note stays there when entries come after it', async () => {
    const { d } = deps()
    await reflectForNode(vp, 'Marina VP', [vp, worker], d)
    await appendDayNote(vp.id, 'Marina VP', localDate(NOW), 'Judge budget: spent at 19:00 UTC.', NOW)
    await reflectForNode(vp, 'Marina VP', [vp, worker], { ...d, nowMs: () => NOW + 60_000 })
    const day = JSON.parse(await fs.readFile(reflectionDayJsonOf(vp.id, localDate(NOW)), 'utf-8'))
    expect(day.passes).toMatchObject({ count: 2, last: { candidates: 0, judged: 0, skipped: 0 } })
    expect(day.notes).toEqual([{ at: new Date(NOW).toISOString(), text: 'Judge budget: spent at 19:00 UTC.' }])
  })

  it('never starts a JSON over a day only the Markdown holds', async () => {
    const md = reflectionDayJsonOf(vp.id, localDate(NOW)).replace(/\.json$/, '.md')
    await fs.mkdir(path.dirname(md), { recursive: true })
    await fs.writeFile(md, '# Session reflection: Marina VP\n\n- an entry from before the JSON\n')
    const { d } = deps()
    await reflectForNode(vp, 'Marina VP', [vp, worker], d)
    await appendDayNote(vp.id, 'Marina VP', localDate(NOW), 'Judge budget: spent.', NOW)
    await expect(fs.access(reflectionDayJsonOf(vp.id, localDate(NOW)))).rejects.toThrow()
    expect(await fs.readFile(md, 'utf-8')).toContain('> Note: Judge budget: spent.')
  })
})

describe('ratchet', () => {
  it('no reflection source reads a task\'s slot session fields but sessionNowOf', async () => {
    const dir = 'src/core/org/reflection'
    const offenders: string[] = []
    for (const f of await fs.readdir(dir)) {
      if (!f.endsWith('.ts')) continue
      const text = await fs.readFile(path.join(dir, f), 'utf-8')
      text.split('\n').forEach((line, i) => {
        if (/\b(exec_)?session_id\b/.test(line) && !line.includes('task.session_id || task.exec_session_id')) offenders.push(`${f}:${i + 1}`)
      })
    }
    expect(offenders, 'read the session a send reaches with sessionNowOf (candidates.ts)').toEqual([])
  })
})
