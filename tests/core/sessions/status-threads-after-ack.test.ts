/**
 * A status line never shows him again what he already has (src/core/org/thread-known.ts lineHeHas
 * and lineMay; 2026-11-23, the user, of cards that came back "New since you acknowledged" after each
 * Acknowledge: "what I acknowledged all stays there", "this thread system has a big problem").
 *
 * The bug: his Acknowledge put the thread pending, and the node's next turn-end line (answered or
 * done, in new words) wrote it answered with a fresh summary, so it was news on his card again; he
 * acknowledged three times in one day and it came back each time, on two different nodes.
 *
 * The class: every write a status line makes (patchForLine's plan, its fallback, and any other
 * updateThread call with `line`), every line state, every thread whose result he acknowledged (with
 * the record, an older ack without it, his request or one the node opened). A done line closes it;
 * nothing else writes it. What still reaches him: a result after an ack while its work ran, a result
 * after the node placed it in Working or Waiting, the node's own thread_update, his own new words.
 */
import { describe, it, expect } from 'vitest'
import { emptyThreads, fileMessage, normalizeThreads, setAnswers, ThreadError, THREAD_STATES, updateThread, type OrgThread, type ThreadsFile } from '../../../src/core/org/threads-model.js'
import { ackKnown, ackPlace } from '../../../src/core/org/thread-ack.js'
import { ackHoldsResult, backFromKnown, isKnown, KNOWN_CLOSE_MS, knownStep } from '../../../src/core/org/thread-known.js'
import { hasThreadNews, shownToHim } from '../../../src/core/org/thread-view.js'
import { listForQuestion, patchForLine, planThreadWrites, threadQuestionBlock, THREAD_LINE_STATES, type StatusThreadLine } from '../../../src/core/sessions/status-threads.js'

const at = (min: number) => new Date(Date.UTC(2026, 10, 23, 18, min)).toISOString()
const NODE = 'task:lead-1'

/** Run the planned writes the way threads-store.ts writeOwnThreads does: each in turn, a refused one left out. */
function apply(file: ThreadsFile, plan: ReturnType<typeof planThreadWrites>, when: string): ThreadsFile {
  for (const w of plan.writes) {
    for (const p of [w.patch, w.fallback]) {
      if (!p) continue
      try { file = updateThread(file, w.id, p, NODE, when, undefined, { line: true }).file; break } catch (err) { if (!(err instanceof ThreadError)) throw err }
    }
  }
  return file
}

const line = (t: OrgThread, state: StatusThreadLine['state'], progress?: string): StatusThreadLine =>
  ({ id: t.id, title: t.title, state, ...(progress ? { progress } : {}), upTo: t.messages[t.messages.length - 1]?.id ?? '' })

/** His request "watch the review until the second approval", answered: approved and merged. */
function answered(): { f: ThreadsFile; id: string } {
  let f = fileMessage(emptyThreads('lead-1'), { text: 'watch the oven review until Dana approves it', via: 'chat', at: at(0) }).file
  const id = f.threads[0].id
  f = setAnswers(f, new Map([[f.threads[0].messages[0].id, { text: 'Watching it every 5 minutes; I will tell you when Dana approves.', at: at(1) }]])).file
  f = updateThread(f, id, { title: 'Dana approved, the oven timer change is merged', state: 'answered', reply: 'Dana approved the oven timer change and it is merged; the rollout goes on in the oven task.', tasks: ['t-oven'] }, NODE, at(2)).file
  return { f, id }
}

/** A subject the node opened itself and he read (his reply), still answered. */
function nodeOpened(): { f: ThreadsFile; id: string } {
  const o = emptyThreads('lead-1')
  const f: ThreadsFile = { ...o, threads: [{ id: 'th-bbbbbbbbbbbb', title: 'Bakery mail answered', state: 'answered', messages: [], createdAt: at(0), updatedAt: at(0), reply: 'The bakery confirmed Friday.', replyAt: at(0), opener: { text: 'The bakery asks for a date.', at: at(0), from: 'node', by: NODE } }] }
  return { f, id: 'th-bbbbbbbbbbbb' }
}

/** Every thread whose result he acknowledged, as it may stand when a line comes. */
function acknowledged(): Array<{ name: string; f: ThreadsFile; id: string }> {
  const a = answered()
  const acked = ackKnown(a.f, a.id, at(20)).file
  // What 11-23's lines left behind: an ack with no record of what he acknowledged, a line flipped it back to answered with new words.
  const raw = JSON.parse(JSON.stringify(acked)) as ThreadsFile
  delete (raw.threads[0] as Partial<OrgThread>).ackedResult
  delete (raw.threads[0] as Partial<OrgThread>).lineReplyAt
  const legacy = normalizeThreads({ threads: [{ ...raw.threads[0], state: 'answered', reply: 'Reworded: the oven change was approved by Dana and merged.', replyAt: at(24), lineState: at(24) }] }, 'lead-1')
  const n = nodeOpened()
  const nodeAcked = ackKnown(n.f, n.id, at(20)).file
  return [
    { name: 'acknowledged with its result', f: acked, id: a.id },
    { name: 'an older ack, flipped back by a line', f: legacy, id: a.id },
    { name: 'a subject the node opened, acknowledged', f: nodeAcked, id: n.id },
  ]
}

const WORDS = [undefined, 'Dana approved and it is merged; nothing new since you acknowledged.', 'The oven timer change is merged and the oven task rolls it out.']

describe('a status line on a thread whose result he acknowledged', () => {
  it('each is read as such', () => {
    expect(acknowledged().map((c) => ackHoldsResult(c.f.threads.find((t) => t.id === c.id)!))).toEqual([true, true, true])
  })

  for (const c of acknowledged()) {
    for (const state of THREAD_LINE_STATES) {
      for (const words of WORDS) {
        it(`${c.name}: a ${state} line${words ? ' with words' : ''} closes it (done) or changes nothing`, () => {
          const before = c.f.threads.find((t) => t.id === c.id)!
          const after = apply(c.f, planThreadWrites(c.f, [line(before, state, words)], []), at(30)).threads.find((t) => t.id === c.id)!
          if (state === 'done') {
            // His Acknowledge covers the close, his request or the node's own subject alike; the line's words go on the closed card.
            expect(after.closed).toMatchObject({ how: 'acked', by: NODE })
            expect(after.reply).toBe(words ?? before.reply)
            return
          }
          // Nothing else is written: no state, no words, no news, nothing back in his sight.
          const { updatedAt: _u, by: _b, ...was } = before
          const { updatedAt: _u2, by: _b2, ...is } = after
          expect(is).toEqual(was)
        })
      }
    }
  }

  it('any other line write (every state, new words) is refused; a title or a known mark goes on', () => {
    const c = acknowledged()[0]
    for (const state of THREAD_STATES) {
      expect(() => updateThread(c.f, c.id, { state, reply: 'Something in other words.' }, NODE, at(30), undefined, { line: true })).toThrow(/he acknowledged its result/)
      expect(() => updateThread(c.f, c.id, { state }, NODE, at(30), undefined, { line: true })).toThrow(ThreadError)
    }
    expect(() => updateThread(c.f, c.id, { reply: 'Something in other words.' }, NODE, at(30), undefined, { line: true })).toThrow(ThreadError)
    expect(updateThread(c.f, c.id, { title: 'Oven timer change merged' }, NODE, at(30), undefined, { line: true }).thread.title).toBe('Oven timer change merged')
  })

  it('the real case: acknowledged at 18:20, lines at 18:24 and 18:43 leave it in Acknowledged with nothing new; done closes it', () => {
    const a = answered()
    let f = ackKnown(a.f, a.id, at(20)).file
    f = apply(f, planThreadWrites(f, [line(f.threads[0], 'answered', 'Dana approved and it is merged; the oven task follows the rollout.')], []), at(24))
    f = apply(f, planThreadWrites(f, [line(f.threads[0], 'answered', 'The oven change was approved by Dana and merged; the rollout is the oven task\'s.')], []), at(43))
    const t = f.threads[0]
    expect(isKnown(t)).toBe(true)
    expect(backFromKnown(t)).toBe(false)
    expect(hasThreadNews(t)).toBe(false)
    expect(shownToHim(t, undefined, Date.parse(at(44)))).toBe(false)
    // Nothing new from the lines, so Walnut's own placement runs on its clock and finds no news to show.
    expect(knownStep(t, false, Date.parse(at(20)) + KNOWN_CLOSE_MS + 1)).toBe('place')
    const closed = apply(f, planThreadWrites(f, [line(t, 'done', 'Nothing left for you on this.')], []), at(45)).threads[0]
    expect(closed.closed).toMatchObject({ how: 'acked', by: NODE })
  })
})

describe('what still reaches him on a thread he acknowledged', () => {
  /** His request, acknowledged while its work still ran (`state`), the node's words then. */
  function early(state: 'working' | 'pending' = 'working'): { f: ThreadsFile; id: string } {
    let f = fileMessage(emptyThreads('lead-1'), { text: 'tell me when the oven timer is fixed', via: 'chat', at: at(0) }).file
    const id = f.threads[0].id
    f = updateThread(f, id, { state, reply: 'The oven task is fixing the timer.' }, NODE, at(1)).file
    return { f: ackKnown(f, id, at(5)).file, id }
  }

  it('acknowledged while its work ran: its result shows him, by an answered line or a done line', () => {
    for (const state of ['working', 'pending'] as const) {
      const e = early(state)
      expect(ackHoldsResult(e.f.threads[0])).toBe(false)
      for (const kind of ['answered', 'done'] as const) {
        const after = apply(e.f, planThreadWrites(e.f, [line(e.f.threads[0], kind, 'Fixed and merged: https://example.com/oven/pull/7')], []), at(10)).threads[0]
        expect(after.closed).toBeUndefined()
        expect(after.state).toBe('answered')
        expect(after.reply).toBe('Fixed and merged: https://example.com/oven/pull/7')
        expect(shownToHim(after, undefined, Date.parse(at(11)))).toBe(true)
      }
    }
  })

  it('once he acknowledged that result, no line brings it back', () => {
    const e = early()
    let f = apply(e.f, planThreadWrites(e.f, [line(e.f.threads[0], 'answered', 'The oven timer is fixed and tested.')], []), at(10))
    f = ackKnown(f, e.id, at(12)).file
    expect(ackHoldsResult(f.threads[0])).toBe(true)
    const again = apply(f, planThreadWrites(f, [line(f.threads[0], 'answered', 'The timer fix is done and tested.')], []), at(14)).threads[0]
    expect(again.reply).toBe('The oven timer is fixed and tested.')
    expect(shownToHim(again, undefined, Date.parse(at(15)))).toBe(false)
  })

  it('the node placed it in Working or Waiting itself: its result is news again', () => {
    const a = answered()
    const f = ackKnown(a.f, a.id, at(20)).file
    for (const to of ['working', 'waiting'] as const) {
      const placed = { ...f, threads: [ackPlace(f.threads[0], to, 'node', 'the rollout still runs', at(22))] }
      expect(ackHoldsResult(placed.threads[0])).toBe(false)
      const after = apply(placed, planThreadWrites(placed, [line(placed.threads[0], 'answered', 'Rolled out to every oven.')], []), at(30)).threads[0]
      expect(shownToHim(after, undefined, Date.parse(at(31)))).toBe(true)
    }
    // Walnut's own placement is its rule, not news: lines still change nothing.
    const byWalnut = { ...f, threads: [ackPlace(f.threads[0], 'waiting', 'walnut', 'the oven task still works', at(31))] }
    expect(ackHoldsResult(byWalnut.threads[0])).toBe(true)
  })

  it('the node\'s own thread_update with something new still shows it, and then a line is no longer held back', () => {
    const a = answered()
    let f = ackKnown(a.f, a.id, at(20)).file
    f = updateThread(f, a.id, { reply: 'The rollout failed in one oven; the oven task rolled it back.' }, NODE, at(25)).file
    expect(shownToHim(f.threads[0], undefined, Date.parse(at(26)))).toBe(true)
    expect(backFromKnown(f.threads[0])).toBe(true)
    expect(ackHoldsResult(f.threads[0])).toBe(false)
  })

  it('his own new message on it makes it his again: lines write as before', () => {
    const a = answered()
    let f = ackKnown(a.f, a.id, at(20)).file
    f = fileMessage(f, { text: 'and the grill timer too?', via: 'follow-up', threadId: a.id, at: at(22) }).file
    expect(ackHoldsResult(f.threads[0])).toBe(false)
    expect(patchForLine(f.threads[0], line(f.threads[0], 'answered', 'The grill timer is fixed too.'))).toEqual({ state: 'answered', reply: 'The grill timer is fixed too.' })
  })

  it('an answer he only read, never acknowledged, takes lines as before (not this change)', () => {
    const a = answered()
    const f = updateThread(a.f, a.id, { known: 'all' }, 'human', at(10)).file
    expect(ackHoldsResult(f.threads[0])).toBe(false)
    expect(patchForLine(f.threads[0], line(f.threads[0], 'answered', 'Rolled out to every oven.'))).toEqual({ state: 'answered', reply: 'Rolled out to every oven.' })
  })

  it('the ack record survives a read from disk; a bad one is dropped', () => {
    const a = answered()
    const f = ackKnown(a.f, a.id, at(20)).file
    expect(f.threads[0].ackedResult).toBe(true)
    expect(normalizeThreads(JSON.parse(JSON.stringify(f)), 'lead-1').threads[0].ackedResult).toBe(true)
    expect(normalizeThreads({ threads: [{ ...f.threads[0], ackedResult: 'yes' }] }, 'lead-1').threads[0].ackedResult).toBeUndefined()
  })
})

describe('the status question says which threads he acknowledged', () => {
  it('names one whose result he acknowledged, and what a line still does there', () => {
    const [acked] = acknowledged()
    const a = answered()
    const listed = [...listForQuestion(acked.f, acked.f.threads).listed, ...listForQuestion(a.f, a.f.threads).listed]
    expect(listed.map((t) => !!t.acked)).toEqual([true, false])
    const { block } = threadQuestionBlock(listed)
    expect(block).toContain('(pending, he acknowledged its result: a line only closes it (done); news for him is your thread_update)')
    expect(block).toContain(' (answered)')
  })
})

describe('whose words a summary is (review round 2)', () => {
  it('an older card a line flipped, then the node\'s own words: news, so a done line no longer closes it unseen', () => {
    const [, legacy] = acknowledged()
    expect(ackHoldsResult(legacy.f.threads[0])).toBe(true)
    const told = updateThread(legacy.f, legacy.id, { reply: 'The rollout failed in one oven; the oven task rolled it back.' }, NODE, at(30)).file
    expect(ackHoldsResult(told.threads[0])).toBe(false)
    const after = apply(told, planThreadWrites(told, [line(told.threads[0], 'done')], []), at(31)).threads[0]
    expect(after.closed).toBeUndefined()
    expect(shownToHim(after, undefined, Date.parse(at(32)))).toBe(true)
  })

  it('a line\'s own words are marked as a line\'s; anyone else\'s clear the mark', () => {
    const a = answered()
    const byLine = updateThread(a.f, a.id, { state: 'answered', reply: 'Merged.' }, NODE, at(5), undefined, { line: true }).thread
    expect(byLine.lineReplyAt).toBe(byLine.replyAt)
    const byNode = updateThread(a.f, a.id, { reply: 'Merged and rolled out.' }, NODE, at(6)).thread
    expect(byNode.lineReplyAt).not.toBe(byNode.replyAt)
    expect(normalizeThreads(JSON.parse(JSON.stringify({ threads: [byLine] })), 'lead-1').threads[0].lineReplyAt).toBe(byLine.replyAt)
  })

  it('the plan names the lines it left out, for the log', () => {
    const [acked] = acknowledged()
    expect(planThreadWrites(acked.f, [line(acked.f.threads[0], 'answered', 'Merged again.')], []).held).toEqual([acked.id])
  })
})
