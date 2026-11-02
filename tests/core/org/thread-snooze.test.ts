/**
 * Snoozing a thread (src/core/org/threads-model.ts `snooze`, src/core/org/thread-view.ts snoozedNow;
 * 2026-11-02, the user: "low priority, will follow up later, actually in thread has a snoozed
 * section, also a snoozed button"): it leaves his view (and the tab's dot) until its date, comes back
 * then, or earlier on real news, and the node's tidy reminder leaves it alone meanwhile.
 */
import { describe, it, expect } from 'vitest'
import { emptyThreads, fileMessage, normalizeThreads, setAnswers, ThreadError, updateThread, type ThreadsFile } from '../../../src/core/org/threads-model.js'
import { newsAt, shownToHim, snoozedNow } from '../../../src/core/org/thread-view.js'
import { threadsTidyOf } from '../../../src/core/org/thread-capture.js'

const T0 = Date.UTC(2026, 10, 2, 20, 0)
const at = (min: number) => new Date(T0 + min * 60_000).toISOString()
const ms = (min: number) => T0 + min * 60_000

/** One thread the node answered (state answered), so his view shows it. */
function answered(): { f: ThreadsFile; id: string; msg: string } {
  const r = fileMessage(emptyThreads('lead-1'), { text: 'pick a routing design', via: 'chat', at: at(0) })
  let f = setAnswers(r.file, new Map([[r.message.id, { text: 'Option 2 fits best.', at: at(1) }]])).file
  f = updateThread(f, r.thread.id, { title: 'Routing', state: 'answered', reply: 'Option 2 fits best.' }, 'task:lead-1', at(2)).file
  return { f, id: r.thread.id, msg: r.message.id }
}

const snooze = (f: ThreadsFile, id: string, until: string, by: 'human' | `task:${string}` = 'human', when = at(5)) =>
  updateThread(f, id, { snooze: until }, by, when).file

describe('a snoozed thread', () => {
  it('leaves his view and the tab dot until its date, then comes back with news at its date', () => {
    const { f, id } = answered()
    expect(shownToHim(f.threads[0], undefined, ms(5))).toBe(true)
    const s = snooze(f, id, at(65))
    const t = s.threads[0]
    expect(t.snoozed).toEqual({ until: at(65), at: at(5), by: 'human' })
    expect(snoozedNow(t, ms(30))).toBe(true)
    expect(shownToHim(t, undefined, ms(30))).toBe(false)
    expect(newsAt(s.threads, undefined, ms(30))).toBeNull()
    // Its date: back, and the dot says there is news then (after he last looked).
    expect(snoozedNow(t, ms(65))).toBe(false)
    expect(shownToHim(t, undefined, ms(65))).toBe(true)
    expect(newsAt(s.threads, undefined, ms(66))).toBe(at(65))
  })

  it('takes a duration ("4h", "3d", "90m") as well as an ISO time, and "" takes it off', () => {
    const { f, id } = answered()
    expect(snooze(f, id, '4h').threads[0].snoozed!.until).toBe(new Date(ms(5) + 4 * 3_600_000).toISOString())
    expect(snooze(f, id, '3d').threads[0].snoozed!.until).toBe(new Date(ms(5) + 3 * 86_400_000).toISOString())
    expect(snooze(f, id, '90m').threads[0].snoozed!.until).toBe(at(95))
    const off = updateThread(snooze(f, id, '4h'), id, { snooze: '' }, 'human', at(6)).file
    expect(off.threads[0].snoozed).toBeUndefined()
    expect(shownToHim(off.threads[0], undefined, ms(7))).toBe(true)
  })

  it('refuses a time already begun, a word that is no time, a closed thread, and snooze with close', () => {
    const { f, id } = answered()
    for (const bad of [at(4), 'later', 'tomorrow-ish']) {
      expect(() => snooze(f, id, bad)).toThrow(ThreadError)
    }
    const closed = updateThread(f, id, { close: 'acked' }, 'human', at(3)).file
    expect(() => snooze(closed, id, at(65))).toThrow(/closed/)
    expect(() => updateThread(f, id, { close: 'acked', snooze: at(65) }, 'human', at(5))).toThrow(/cannot go together/)
  })

  it('comes back early on real news: his own message, a new answer, a move to needs or answered', () => {
    const { f, id } = answered()
    const s = snooze(f, id, at(600))
    // His message in it.
    const mine = fileMessage(s, { text: 'actually, go on', via: 'follow-up', threadId: id, at: at(10) })
    expect(mine.thread.snoozed).toBeUndefined()
    // A new answer of the node's after the snooze (to a message Walnut had not read the reply of yet).
    const asked = fileMessage(f, { text: 'and the cost?', via: 'follow-up', threadId: id, at: at(3) })
    const s2 = snooze(asked.file, id, at(600))
    expect(snoozedNow(s2.threads[0], ms(10))).toBe(true)
    const withAnswer = setAnswers(s2, new Map([[asked.message.id, { text: 'About the same.', at: at(9) }]])).file
    expect(snoozedNow(withAnswer.threads[0], ms(10))).toBe(false)
    // The node moves it to needs (its question to him), or to answered from working.
    const needs = updateThread(s, id, { state: 'needs', user_kind: 'user_own', user_kind_why: 'He asked to pick the design himself.' }, 'task:lead-1', at(10)).file
    expect(needs.threads[0].snoozed).toBeUndefined()
    const working = updateThread(f, id, { state: 'working' }, 'task:lead-1', at(3)).file
    const s3 = snooze(working, id, at(600))
    expect(updateThread(s3, id, { state: 'answered', reply: 'Done: option 2.' }, 'task:lead-1', at(10)).file.threads[0].snoozed).toBeUndefined()
  })

  it('tidying the summary or the title while snoozed keeps it snoozed', () => {
    const { f, id } = answered()
    const s = snooze(f, id, at(600))
    const tidied = updateThread(s, id, { title: 'Routing design', reply: 'Option 2 fits best; costs the same.' }, 'task:lead-1', at(10)).file
    expect(snoozedNow(tidied.threads[0], ms(11))).toBe(true)
  })

  it('a close takes the snooze off; the node may snooze too (an agent action), recorded as its own', () => {
    const { f, id } = answered()
    const byNode = snooze(f, id, at(600), 'task:lead-1')
    expect(byNode.threads[0].snoozed!.by).toBe('task:lead-1')
    const closed = updateThread(byNode, id, { close: 'acked' }, 'human', at(10)).file
    expect(closed.threads[0].snoozed).toBeUndefined()
  })

  it('the tidy reminder skips a snoozed thread until it is back', () => {
    const { f, id, msg } = answered()
    // He wrote elsewhere after its answer: the reminder would ask whether he reacted to it.
    const elsewhere = fileMessage(f, { text: 'another subject', via: 'chat', at: at(3) }).file
    const tidyIds = (x: ThreadsFile, now: number) => threadsTidyOf(x, now)?.items.map((i) => i.id) ?? []
    expect(tidyIds(elsewhere, ms(4))).toContain(id)
    const s = snooze(elsewhere, id, at(60))
    expect(tidyIds(s, ms(30))).not.toContain(id)
    expect(tidyIds(s, ms(61))).toContain(id)
    expect(msg).toMatch(/^tm-/)
  })

  it('back early on news: no second dot at the date it was snoozed until', () => {
    const { f, id, msg } = answered()
    const asked = fileMessage(f, { text: 'and the cost?', via: 'follow-up', threadId: id, at: at(3) })
    const s = snooze(asked.file, id, at(600))
    const early = setAnswers(s, new Map([[asked.message.id, { text: 'About the same.', at: at(9) }]])).file
    expect(newsAt(early.threads, undefined, ms(10))).toBe(at(9))
    expect(newsAt(early.threads, undefined, ms(601))).toBe(at(9))
    expect(msg).toMatch(/^tm-/)
  })

  it('a date alone is that day\'s local midnight; more than a year away is refused', () => {
    const { f, id } = answered()
    const until = snooze(f, id, '2026-11-09').threads[0].snoozed!.until
    expect(Date.parse(until)).toBe(new Date(2026, 10, 9).getTime())
    expect(() => snooze(f, id, '99999999999d')).toThrow(/more than a year/)
    expect(() => snooze(f, id, '400d')).toThrow(/more than a year/)
  })

  it('a bad snooze read from disk is dropped, a good one kept', () => {
    const { f } = answered()
    const raw = JSON.parse(JSON.stringify(f))
    raw.threads[0].snoozed = { until: 'soon', at: at(5), by: 'human' }
    expect(normalizeThreads(raw, 'lead-1').threads[0].snoozed).toBeUndefined()
    raw.threads[0].snoozed = { until: at(60), at: at(5), by: 'human' }
    expect(normalizeThreads(raw, 'lead-1').threads[0].snoozed).toEqual({ until: at(60), at: at(5), by: 'human' })
  })
})
