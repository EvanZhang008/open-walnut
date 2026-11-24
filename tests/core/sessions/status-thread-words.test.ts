/**
 * Every door that writes a node's words on his card checks them (2026-11-24, the threads
 * inspection, item 7: a done line closing his acknowledged request, its fallback, a new subject's
 * first post and a node's close wrote words that only point elsewhere; Main's card "this card was
 * replaced by the new card, pick there" sat in his Done). status-threads.ts lineWords,
 * threads-model.ts updateThread, thread-summary-content.ts.
 */
import { describe, expect, it } from 'vitest'
import { lineWords, planThreadWrites } from '../../../src/core/sessions/status-threads.js'
import { emptyThreads, fileMessage, setAnswers, updateThread, ThreadError, type ThreadsFile } from '../../../src/core/org/threads-model.js'
import { asksHimNow, summaryPointsElsewhere } from '../../../src/core/org/thread-summary-content.js'

const at = (min: number) => new Date(Date.UTC(2026, 10, 24, 12, min)).toISOString()
/** "This card was replaced by the new card <title>; please pick on the new card." (Main, 11-24) */
const REPLACED = '\u8fd9\u5f20\u5361\u5df2\u7ecf\u88ab\u65b0\u5361\u300c\u4f11\u5047\u9009\u54ea\u6bb5\u300d\u53d6\u4ee3\uff0c\u8bf7\u5728\u65b0\u5361\u4e0a\u9009\u3002'
/** "This card was replaced by the new card." */
const REPLACED_ONLY = '\u8fd9\u5f20\u5361\u5df2\u88ab\u65b0\u5361\u53d6\u4ee3\u3002'
/** "After the old service was swapped for the new one, latency fell from 900 ms to 120 ms." */
const SWAPPED = '\u65e7\u670d\u52a1\u88ab\u65b0\u670d\u52a1\u66ff\u6362\u540e\uff0c\u5ef6\u8fdf\u4ece 900 ms \u964d\u5230 120 ms\u3002'
/** "No need for you to pick on the card any more: shipped with A." */
const NO_NEED = '\u4e0d\u7528\u8bf7\u4f60\u5728\u5361\u4e0a\u9009\u4e86\uff0c\u5df2\u6309 A \u4e0a\u7ebf\u3002'
const POINTER = 'Already told you in the chat.'
const RESULT = 'Two metres keeps the deer out; the posts are ordered.'

/** His request, answered at 1, and his "ok" at 2: he reacted to the answer. */
function reacted(): ThreadsFile {
  let f = fileMessage(emptyThreads('lead-1'), { text: 'how tall should the orchard fence be?', via: 'chat', at: at(0) }).file
  const id = f.threads[0].id
  f = setAnswers(f, new Map([[f.threads[0].messages[0].id, { text: 'Two metres keeps the deer out.', at: at(1) }]])).file
  f = updateThread(f, id, { title: 'Orchard fence', state: 'answered', reply: 'Two metres keeps the deer out.' }, 'task:lead-1', at(1)).file
  return f
}

/** The same, and his "ok, thanks" at 2 on it. */
function thanked(): ThreadsFile {
  return fileMessage(reacted(), { text: 'ok, thanks', via: 'chat', at: at(2) }).file
}

describe('the words', () => {
  it('a card replaced by another that sends him there to pick points elsewhere and asks him', () => {
    expect(asksHimNow(REPLACED)).toBe(true)
    expect(summaryPointsElsewhere(REPLACED)).toBeTruthy()
    expect(summaryPointsElsewhere(REPLACED_ONLY)).toBeTruthy()
    expect(asksHimNow('This card was replaced by the newer one; please pick there.')).toBe(true)
    // A swap with its result after it says something; a "no need" before the ask is no ask.
    expect(summaryPointsElsewhere(SWAPPED)).toBeNull()
    expect(asksHimNow(SWAPPED)).toBe(false)
    expect(asksHimNow(NO_NEED)).toBe(false)
  })
})

describe('every door of a line\'s words', () => {
  it('lineWords keeps words that say something, never a pointer or his own words back', () => {
    const f = reacted()
    expect(lineWords(f.threads[0], RESULT)).toBe(RESULT)
    expect(lineWords(f.threads[0], POINTER)).toBeUndefined()
    expect(lineWords(f.threads[0], REPLACED_ONLY)).toBeUndefined()
    expect(lineWords(undefined, undefined)).toBeUndefined()
  })

  it('a done line closing his request he reacted to keeps only words that say something, in the close and its fallback', () => {
    const f = reacted()
    const id = f.threads[0].id
    const close = (progress: string) => planThreadWrites(f, [{ id, title: 'x', state: 'done', progress }], [], { seen: [{ id }] }).writes.find((w) => w.patch.close)
    expect(close(POINTER)?.patch).toEqual({ close: 'acked' })
    expect(close(POINTER)?.fallback?.reply).toBeUndefined()
    expect(close(RESULT)?.patch).toEqual({ close: 'acked', reply: RESULT })
  })

  it('a new subject whose words point elsewhere opens with its title', () => {
    const plan = planThreadWrites(emptyThreads('lead-1'), [], [{ title: 'Spring seed order', state: 'working', progress: POINTER }])
    expect(plan.opens).toEqual([{ title: 'Spring seed order', text: 'Spring seed order', state: 'working' }])
    const ok = planThreadWrites(emptyThreads('lead-1'), [], [{ title: 'Spring seed order', state: 'working', progress: RESULT }])
    expect(ok.opens[0].text).toBe(RESULT)
  })

  it('a card a newer ask replaced is never turned into a pointer in his Done by a line (Main, 11-24; the inspection, item 9)', () => {
    // Stepped aside by the newer card (thread-supersede.ts): pending, out of his sight.
    const f = reacted()
    const id = f.threads[0].id
    const aside = updateThread(f, id, { state: 'pending', reply: 'Asked now in "Vacation dates" (th-0000bb).' }, 'task:lead-1', at(3)).file
    for (const state of ['answered', 'done'] as const) {
      const plan = planThreadWrites(aside, [{ id, title: 'x', state, progress: REPLACED }], [])
      expect(plan.writes, state).toEqual([])
      const only = planThreadWrites(aside, [{ id, title: 'x', state, progress: REPLACED_ONLY }], [])
      expect(only.writes, state).toEqual([])
    }
  })

  it('a node\'s close carrying words is held to them too; a close with none, and his own, are not', () => {
    const f = thanked()
    const id = f.threads[0].id
    expect(() => updateThread(f, id, { close: 'acked', reply: REPLACED_ONLY }, 'task:lead-1', at(3))).toThrow(ThreadError)
    expect(updateThread(f, id, { close: 'acked' }, 'task:lead-1', at(3)).thread.closed).toBeTruthy()
    expect(updateThread(f, id, { close: 'acked', reply: RESULT }, 'task:lead-1', at(3)).thread.reply).toBe(RESULT)
  })
})
