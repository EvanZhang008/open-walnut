/**
 * A reminder of the open threads now and then, in place of a line for every thread after every turn
 * (experiment threads_reminder; src/core/sessions/status-thread-remind.ts, status-thread-question.ts
 * threadQuestionOf; 2026-11-25, the user, translated: "like that To Do").
 *
 * The pure rules: when a question is the reminder, which threads need a line now, what the block
 * says between reminders and at one, and that the reminder is left out entirely with the switch off.
 * Guard: every need status-thread-pick.ts names is placed in ASKED_BETWEEN, so a new kind of need
 * fails here until it is placed.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-status-thread-remind'))

import { ASKED_BETWEEN, lastChangeMs, lastReminder, lineNeed, noteQuestion, pickForReminder, REMIND_EVERY, REMIND_SOON_MS, reminderDue, resetReminders, type Reminded } from '../../../src/core/sessions/status-thread-remind.js'
import { NEED_RANK, needName, needRank } from '../../../src/core/sessions/status-thread-pick.js'
import { threadQuestionOf, type QuestionMemory } from '../../../src/core/sessions/status-threads.js'
import { quietWorking } from '../../../src/core/org/thread-recheck.js'
import { threadOverdue } from '../../../src/core/org/thread-view.js'
import { setThreadsKept } from '../../../src/core/org/threads-kept.js'
import type { OrgThread, ThreadsFile } from '../../../src/core/org/threads-model.js'

const NOW = Date.parse('2026-11-25T10:00:00.000Z')
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString()
afterEach(() => { setThreadsKept(false); resetReminders() })

/** A thread the node keeps pending, its summary written `min` minutes ago, nothing of his on it. */
const quiet = (n: number, min: number, more: Partial<OrgThread> = {}): OrgThread => ({
  id: `th-${String(n).padStart(6, '0')}`, title: `Garden bed ${n}`, titled: true, state: 'pending', reply: `Handed to the potting team, step ${n}.`,
  replyAt: ago(min), messages: [], createdAt: ago(min + 5), updatedAt: ago(min), by: 'task:lead-1', ...more,
}) as OrgThread

/** His message on it `min` minutes ago, after its summary. */
const heWrote = (t: OrgThread, min: number): OrgThread => ({ ...t, updatedAt: ago(min), messages: [...t.messages, { id: `tm-${t.id.slice(3)}`, at: ago(min), text: 'and the north bed too', via: 'chat' }] }) as OrgThread
const fileOf = (threads: OrgThread[]): ThreadsFile => ({ version: 1, taskId: 'lead-1', threads })
const LEAD = { org_role: 'lead' as const }
const memory = (more: Partial<QuestionMemory> = {}): QuestionMemory => ({ carded: new Set(), dropped: new Set(), last: new Map(), ...more })
const between = (asks = 1): Reminded => ({ sids: ['sess-a'], at: NOW - 60_000, asks })
const ids = (refs: Map<string, { id: string }>) => [...refs.values()].map((r) => r.id)

describe('when a question is the reminder', () => {
  const rec = between(0)

  it('the first since the server started, a session not seen before, or a compaction since', () => {
    expect(reminderDue(undefined, { sid: 'sess-a', now: NOW, overdueAt: [] })).toBe('first')
    expect(reminderDue(rec, { sid: 'sess-b', now: NOW, overdueAt: [] })).toBe('session')
    expect(reminderDue(rec, { sid: 'sess-a', now: NOW, compactedAt: ago(0.5), overdueAt: [] })).toBe('compacted')
    expect(reminderDue(rec, { sid: 'sess-a', now: NOW, compactedAt: ago(5), overdueAt: [] })).toBeNull()
  })

  it('two sessions of one task in turn are each new once, not at every question', () => {
    const seen: Array<string | null> = []
    for (let i = 0; i < 4; i++) {
      const sid = i % 2 ? 'sess-b' : 'sess-a'
      const why = reminderDue(lastReminder('lead-1'), { sid, now: NOW + i, overdueAt: [] })
      seen.push(why)
      noteQuestion('lead-1', sid, !!why, NOW + i)
    }
    expect(seen).toEqual(['first', 'session', null, null])
  })

  it(`one question in ${REMIND_EVERY}`, () => {
    const seen: Array<string | null> = []
    for (let i = 0; i < REMIND_EVERY * 2 + 1; i++) {
      const why = reminderDue(lastReminder('lead-1'), { sid: 'sess-a', now: NOW + i, overdueAt: [] })
      seen.push(why)
      noteQuestion('lead-1', 'sess-a', !!why, NOW + i)
    }
    expect(seen.filter(Boolean)).toEqual(['first', 'turns', 'turns'])
    expect(seen.indexOf('turns')).toBe(REMIND_EVERY)
  })

  it('sooner when a thread went overdue since the last reminder, at most once per overdue clock', () => {
    const old = { ...rec, at: NOW - REMIND_SOON_MS }
    expect(reminderDue(old, { sid: 'sess-a', now: NOW, overdueAt: [NOW - 60_000] })).toBe('overdue')
    expect(reminderDue(old, { sid: 'sess-a', now: NOW, overdueAt: [old.at - 1] })).toBeNull()
    expect(reminderDue(rec, { sid: 'sess-a', now: NOW, overdueAt: [NOW - 30_000] })).toBeNull()
  })
})

describe('which threads need a line now', () => {
  it('his word after the summary, until a question listed it after that', () => {
    const t = heWrote(quiet(1, 60), 10)
    expect(lineNeed(t, NOW, undefined)).toBe('now')
    expect(lineNeed(t, NOW, NOW - 20 * 60_000)).toBe('now')
    expect(lineNeed(t, NOW, NOW - 60_000)).toBe('again')
    expect(lastChangeMs(t)).toBe(NOW - 10 * 60_000)
  })

  it('a thread in the node\'s hands, at every turn end: a turn that answered no message of his may have finished it', () => {
    // Written after the last reminder, listed a minute ago, nothing of his since: still asked.
    for (const state of ['working', 'new'] as const) {
      const t = quiet(2, 3, { state })
      expect(needRank(t, NOW)).toBeGreaterThanOrEqual(NEED_RANK.wrote)
      expect(lineNeed(t, NOW, NOW - 60_000)).toBe('now')
    }
  })

  it('a quiet working thread the overdue note leaves to the next status line is in that line\'s question (thread-recheck.ts nodeCarriesOn)', () => {
    const t = quiet(3, 120, { state: 'working' })
    const overdue = threadOverdue(t, NOW)!
    expect(quietWorking({ thread: t, overdue }, new Set())).toBe(true)
    expect(lineNeed(t, NOW, NOW - 1)).toBe('now')
    // Its overdue mark rides the full item.
    expect(pickForReminder([t], false, NOW, new Map([[t.id, NOW - 1]])).picked[0]).toMatchObject({ id: t.id, overdue: true })
  })

  it('an untitled one, a line dropped for asking him (every turn), a held title, a joined message', () => {
    expect(lineNeed({ ...quiet(4, 5), untitled: true }, NOW, undefined)).toBe('now')
    expect(lineNeed({ ...quiet(5, 5), asked: true }, NOW, NOW)).toBe('now')
    expect(lineNeed({ ...quiet(6, 5), held: { like: 'th-000001' } }, NOW, undefined)).toBe('now')
    expect(lineNeed({ ...quiet(7, 5), joined: {} }, NOW, undefined)).toBe('now')
  })

  it('a reaction to check on an answer in his sight: once after each new message of his, anywhere', () => {
    const t = { ...quiet(8, 30, { state: 'answered' }), wrote: true, hisAt: ago(5) }
    expect(lineNeed(t, NOW, NOW - 10 * 60_000)).toBe('now')
    expect(lineNeed(t, NOW, NOW - 60_000)).toBe('again')
    // Pending (out of his sight): a short item at the reminder.
    expect(lineNeed({ ...t, state: 'pending' }, NOW, undefined)).toBeNull()
  })

  // With threads_reply_tag on the question is the only place his reaction is asked: a thread whose
  // first need was asked already (it still has no title) is asked again after his new message.
  it('a reaction on an answered thread whose first need was asked already: asked again after each new message of his', () => {
    const t = { ...quiet(9, 30, { state: 'answered' }), untitled: true, wrote: true, hisAt: ago(5) }
    expect(needRank(t, NOW)).toBeLessThan(NEED_RANK.wrote)
    expect(lineNeed(t, NOW, NOW - 10 * 60_000)).toBe('now')
    expect(lineNeed(t, NOW, NOW - 60_000)).toBe('again')
    // With no reaction to ask, the need asked once stays asked.
    expect(lineNeed({ ...t, wrote: false }, NOW, NOW - 10 * 60_000)).toBe('again')
  })

  it('a thread Walnut\'s overdue note named since the question last listed it', () => {
    const t = quiet(9, 120, { state: 'answered', recheck: { since: ago(120), at: ago(30), why: 'reply' } })
    expect(lineNeed(t, NOW, NOW - 40 * 60_000)).toBe('now')
    expect(lineNeed(t, NOW, NOW - 20 * 60_000)).toBeNull()
    expect(lineNeed({ ...t, recheck: { ...t.recheck!, pending: true } }, NOW, NOW - 40 * 60_000)).toBeNull()
  })

  it('a plain one waits for the reminder', () => {
    expect(lineNeed(quiet(10, 30), NOW, undefined)).toBeNull()
  })

  it('guard: every need status-thread-pick.ts names is placed, so a new kind fails until it is', () => {
    expect(Object.keys(ASKED_BETWEEN).sort()).toEqual(Object.keys(NEED_RANK).sort())
    const src = fs.readFileSync(path.join(__dirname, '../../../src/core/sessions/status-thread-pick.ts'), 'utf8')
    const body = src.slice(src.indexOf('export function needName'), src.indexOf('/** When the question last listed'))
    const returned = new Set([...body.matchAll(/return '(\w+)';/g)].map((m) => m[1]))
    expect([...returned].sort()).toEqual(Object.keys(NEED_RANK).sort())
    // needRank is the table's rank of needName, nothing of its own.
    expect(needRank(heWrote(quiet(11, 60), 10), NOW)).toBe(NEED_RANK[needName(heWrote(quiet(11, 60), 10), NOW)])
  })
})

describe('the question with the switch on', () => {
  const threads = () => [heWrote(quiet(1, 60), 10), quiet(2, 30), quiet(3, 120, { state: 'working' }), quiet(4, 3000, { state: 'answered', reply: 'The north bed is dug.' })]

  it('between reminders: the needs and the threads in hand, in the format of today', () => {
    setThreadsKept(true)
    const out = threadQuestionOf(fileOf(threads()), LEAD, memory({ remind: { rec: between(), sid: 'sess-a' } }), undefined, NOW)
    expect(out.reminded).toBeNull()
    expect(ids(out.refs).sort()).toEqual(['th-000001', 'th-000003'])
    expect(out.block).toContain('"Garden bed 1" (pending)')
    expect(out.block).toContain('"Garden bed 3" (working, overdue: nothing new on it past its reminder clock')
    expect(out.block).toContain('FOR_USER_THREAD: <ref>')
    expect(out.block).not.toContain('Reminder of')
  })

  it('between reminders with nothing that needs a line: no block for a node, the new-subject line for a task', () => {
    setThreadsKept(true)
    const t = threads().filter((x) => x.state !== 'working')
    const listed = new Map(t.map((x) => [x.id, NOW - 30_000]))
    expect(threadQuestionOf(fileOf(t), LEAD, memory({ last: listed, remind: { rec: between(), sid: 'sess-a' } }), undefined, NOW)).toEqual({ block: '', refs: new Map(), reminded: null })
    for (const kept of [true, false]) {
      setThreadsKept(kept)
      const task = threadQuestionOf(fileOf(t), {}, memory({ last: listed, remind: { rec: between(), sid: 'sess-a' } }), undefined, NOW)
      expect(task.refs.size).toBe(0)
      expect(task.block).toContain('FOR_USER_THREAD_NEW')
    }
  })

  it('the reminder: needs in full, the rest short and grouped by state, with one rule', () => {
    setThreadsKept(true)
    const out = threadQuestionOf(fileOf(threads()), LEAD, memory({ remind: { rec: undefined, sid: 'sess-a' } }), undefined, NOW)
    expect(out.reminded).toBe('first')
    expect(out.refs.size).toBe(4)
    expect(out.block).toMatch(/Reminder of your other open threads, with the time since each was written \(give one a line only when it moved since then; leave the rest out\): answered: t\d+ "Garden bed 4" 2d; pending: t\d+ "Garden bed 2" 30m\./)
    expect(out.block).toContain('One line per thread')
  })

  it('a reminder by count leaves out what the node wrote since the last one, a compaction does not', () => {
    setThreadsKept(true)
    const rec = { ...between(REMIND_EVERY - 1), at: NOW - 60 * 60_000 }
    const byCount = threadQuestionOf(fileOf(threads()), LEAD, memory({ remind: { rec, sid: 'sess-a' } }), undefined, NOW)
    expect(byCount.reminded).toBe('turns')
    expect(byCount.block).not.toContain('Garden bed 2"')
    expect(byCount.block).toContain('"Garden bed 4" 2d')
    expect(byCount.block).toContain('Not shown: 1 you wrote since the last reminder.')
    const compacted = threadQuestionOf(fileOf(threads()), LEAD, memory({ remind: { rec: { ...rec, asks: 0 }, sid: 'sess-a', compactedAt: ago(1) } }), undefined, NOW)
    expect(compacted.reminded).toBe('compacted')
    expect(compacted.block).toContain('"Garden bed 2" 30m')
  })

  it('a need asked once and unchanged is in the reminder in full, not between', () => {
    setThreadsKept(true)
    const t = threads().filter((x) => x.state !== 'working')
    const listed = new Map([['th-000001', NOW - 5 * 60_000]])
    expect(threadQuestionOf(fileOf(t), LEAD, memory({ last: listed, remind: { rec: between(), sid: 'sess-a' } }), undefined, NOW).refs.size).toBe(0)
    const at = threadQuestionOf(fileOf(t), LEAD, memory({ last: listed, remind: { rec: between(REMIND_EVERY - 1), sid: 'sess-a' } }), undefined, NOW)
    expect(at.reminded).toBe('turns')
    expect(at.block).toContain('t1 "Garden bed 1" (pending)')
  })

  it('more needs than places: the reminder lists the one listed longest ago first, so none is dropped each time', () => {
    setThreadsKept(true)
    const many = Array.from({ length: 14 }, (_, i) => heWrote(quiet(30 + i, 600), 100 - i))
    // Every one asked before; the two newest (his words newest, so first by need) asked last.
    const last = new Map(many.map((t, i) => [t.id, NOW - (i >= 12 ? 1 : 50) * 60_000]))
    const out = threadQuestionOf(fileOf(many), LEAD, memory({ last, remind: { rec: undefined, sid: 'sess-a' } }), undefined, NOW)
    const full = ids(out.refs).slice(0, 12)
    expect(full).toContain(many[0].id)
    expect(full).not.toContain(many[13].id)
  })

  it('what a reply\'s card line spoke for is left out of both (threads_reply_tag)', () => {
    setThreadsKept(true)
    const carded = new Set(['th-000001', 'th-000003'])
    expect(threadQuestionOf(fileOf(threads()), LEAD, memory({ carded, remind: { rec: between(), sid: 'sess-a' } }), undefined, NOW).block).toBe('')
    const at = threadQuestionOf(fileOf(threads()), LEAD, memory({ carded, remind: { rec: undefined, sid: 'sess-a' } }), undefined, NOW)
    expect(ids(at.refs).sort()).toEqual(['th-000002', 'th-000004'])
    expect(at.block).toContain('Reminder of your other open threads')
  })

  it('every open thread spoken for: no question about threads, and it is not counted (the first after a restart stays a reminder)', () => {
    setThreadsKept(true)
    const one = [quiet(1, 30)]
    const out = threadQuestionOf(fileOf(one), LEAD, memory({ carded: new Set([one[0].id]), remind: { rec: undefined, sid: 'sess-a' } }), undefined, NOW)
    expect(out).toEqual({ block: '', refs: new Map() })
    expect(out).not.toHaveProperty('reminded')
  })

  it('the reminder works with the plain question too (threads_kept_by_walnut off)', () => {
    const out = threadQuestionOf(fileOf(threads()), {}, memory({ remind: { rec: undefined, sid: 'sess-a' } }), undefined, NOW)
    expect(out.block).toContain('One line per thread: FOR_USER_THREAD:')
    expect(out.block).toContain('Reminder of your other open threads')
    expect(out.block).toContain('FOR_USER_THREAD_NEW')
  })

  it('pickForReminder keeps what is asked beside a need: a held title\'s thread', () => {
    const like = quiet(20, 30)
    const held = { ...quiet(21, 5), held: { like: like.id } }
    expect(pickForReminder([held, like, quiet(22, 30)], false, NOW, new Map()).picked.map((t) => t.id)).toEqual([held.id, like.id])
  })
})

describe('the switch off', () => {
  it('the question is today\'s: every open thread, no reminder, on every turn', () => {
    setThreadsKept(true)
    const t = [heWrote(quiet(1, 60), 10), quiet(2, 30), quiet(3, 120, { state: 'working' })]
    const listed = new Map(t.map((x) => [x.id, NOW - 30_000]))
    for (const last of [new Map<string, number>(), listed]) {
      const out = threadQuestionOf(fileOf(t), LEAD, memory({ last }), undefined, NOW)
      expect(out.refs.size).toBe(3)
      expect(out).not.toHaveProperty('reminded')
      expect(out.block).not.toContain('Reminder of')
      expect(out.block).not.toContain('overdue: nothing new')
    }
  })
})
