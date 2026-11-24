/**
 * A card he acknowledged comes back only with news (2026-11-24, the threads inspection, item 10: the
 * status line was braked after his Acknowledge, but a node's own thread_update could write the same
 * result again and reopen a card Walnut had closed for it, and nothing compared it with what he
 * acknowledged). thread-ack-repeat.ts repeatsAcknowledged, threads-model.ts updateThread and setAnswers.
 *
 * Every door that writes a node's words on a card he acknowledged is listed here: a line (lineMay),
 * a node's thread_update (still pending, or closed by Walnut's placement), and a chat answer Walnut
 * attaches late. Each either refuses words that repeat it or leaves his card as he left it.
 */
import { describe, expect, it } from 'vitest'
import { ackKnown, ackPlace } from '../../../src/core/org/thread-ack.js'
import { emptyThreads, fileMessage, setAnswers, updateThread, ThreadError, type ThreadsFile } from '../../../src/core/org/threads-model.js'
import { shownToHim } from '../../../src/core/org/thread-view.js'

const at = (min: number) => new Date(Date.UTC(2026, 10, 24, 12, min)).toISOString()
const NOW = Date.parse(at(90))
const RESULT = 'The orchard fence is two metres high and the posts are ordered; delivery is on Friday.'

/** His ask, the node's result on it, and his Acknowledge at 10 (ack_means_known: pending, acknowledged). */
function acknowledged(): { file: ThreadsFile; id: string } {
  let f = fileMessage(emptyThreads('lead-1'), { text: 'how tall should the orchard fence be?', via: 'chat', at: at(0) }).file
  const id = f.threads[0].id
  f = updateThread(f, id, { title: 'Orchard fence', state: 'answered', reply: RESULT }, 'task:lead-1', at(5)).file
  return { file: ackKnown(f, id, at(10)).file, id }
}

/** The same, then closed by Walnut's placement as his Acknowledge covered it. */
function placedClosed(): { file: ThreadsFile; id: string } {
  const { file, id } = acknowledged()
  const t = ackPlace(file.threads[0], 'closed', 'walnut', undefined, at(20))
  return { file: { ...file, threads: [t] }, id }
}

const write = (f: ThreadsFile, id: string, reply: string, extra: Record<string, unknown> = {}) =>
  updateThread(f, id, { reply, state: 'answered', ...extra } as never, 'task:lead-1', at(30))

describe('a node\'s words on a card he acknowledged', () => {
  for (const [name, make] of [['still pending', acknowledged], ['closed by Walnut for his Acknowledge', placedClosed]] as const) {
    it(`${name}: the same result again is refused, and his card stays out of his sight`, () => {
      const { file, id } = make()
      expect(shownToHim(file.threads[0], undefined, NOW)).toBe(false)
      for (const again of [RESULT, `${RESULT} `, 'Orchard fence: two metres high, the posts are ordered, delivery Friday.']) {
        expect(() => write(file, id, again), again).toThrow(ThreadError)
      }
      try { write(file, id, RESULT) } catch (e) { expect((e as ThreadError).code).toBe('he_has_it') }
    })

    it(`${name}: real news (a new number, a new step) shows him the card again`, () => {
      const { file, id } = make()
      const news = write(file, id, 'The fence went up today, 140 metres in all; the gate comes on Monday.')
      expect(news.thread.closed).toBeUndefined()
      expect(shownToHim(news.thread, undefined, NOW)).toBe(true)
    })
  }

  it('a new decision for him (needs) and a close are never judged as a repeat', () => {
    const { file, id } = acknowledged()
    expect(() => updateThread(file, id, { close: 'acked', reply: RESULT }, 'task:lead-1', at(30))).not.toThrow()
  })

  it('a line keeps its own brake (lineMay): only a close goes on', () => {
    const { file, id } = acknowledged()
    expect(() => updateThread(file, id, { state: 'answered', reply: 'Something else entirely, 42.' }, 'task:lead-1', at(30), undefined, { line: true })).toThrow(ThreadError)
  })

  it('a chat answer Walnut attaches late to his acknowledged message leaves the closed card closed', () => {
    let { file, id } = placedClosed()
    // His message got no answer on the thread; the node's chat reply to it is read in later.
    const m = file.threads[0].messages[0]
    file = { ...file, threads: [{ ...file.threads[0], messages: [{ ...m, answer: undefined }] }] }
    const got = setAnswers(file, new Map([[m.id, { text: 'Two metres keeps the deer out.', at: at(4) }]]))
    expect(got.changed).toEqual([id])
    expect(got.file.threads[0].closed).toBeTruthy()
    // An answer the node gave after his Acknowledge is news: the card comes back with it.
    const later = setAnswers(file, new Map([[m.id, { text: 'The gate is on order too, 1.2 m wide.', at: at(40) }]]))
    expect(later.file.threads[0].closed).toBeUndefined()
  })
})
