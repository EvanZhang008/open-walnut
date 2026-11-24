/**
 * Guard: a decision of his is never asked from a thread out of his Needs you (2026-11-24, the
 * threads inspection: four live cards in Done asked him to decide, written by status lines and
 * summaries, with no buttons and nothing in his Needs you; one asked him to answer once more after
 * he had answered five times).
 *
 * The class is every door that writes a card's summary for him: a node's thread_update
 * (threads-model.ts updateThread), a node's thread_create (threads-store.ts openThread's checks),
 * and a status line (status-threads.ts planThreadWrites). Each refuses, or writes nothing for, words
 * that say a decision of his waits (asksHimNow) unless the thread is handed to him (needs). A new
 * door that writes a node's summary joins this list. Chinese test data is escaped.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { ASKS_OUTSIDE_NEEDS, asksHimNow, asksHimToDecide, summaryPointsElsewhere } from '../../../src/core/org/thread-summary-content.js'
import { listsChoices } from '../../../src/core/org/thread-options.js'
import { emptyThreads, fileMessage, setAnswers, updateThread, ThreadError, type ThreadsFile } from '../../../src/core/org/threads-model.js'
import { listForQuestion, planThreadWrites, readThreadLines, threadQuestionBlock } from '../../../src/core/sessions/status-threads.js'
import { ASKED_MARK, linesThatAsked, noteLineAsks, resetLineAsks } from '../../../src/core/sessions/status-thread-asked.js'
import { setThreadsKept } from '../../../src/core/org/threads-kept.js'

const at = (min: number) => new Date(Date.UTC(2026, 10, 24, 9, min)).toISOString()
afterEach(() => { setThreadsKept(false); resetLineAsks() })

// "The ten new designs are on the page, waiting for your nod to ship"; "all three are live; please answer once
// more whether to post"; "the No. 9 you picked is live"; "Recommend A. A: round cards B: square cards";
// "the three new designs are on the pick card, waiting for your pick".
const NOD = '\u65b0\u7684 10 \u4e2a\u65b9\u6848\u5728\u9875\u4e0a\uff0c\u7b49\u4f60\u70b9\u5934\u518d\u4e0a\u7ebf'
const AGAIN = '\u4e09\u4e2a\u90fd\u5df2\u4e0a\u7ebf\uff1b\u8bf7\u518d\u56de\u7b54\u4e00\u6b21\u8981\u4e0d\u8981\u53d1\u5e16'
const PICKED = '\u4f60\u9009\u7684 9 \u53f7\u5df2\u4e0a\u7ebf'
const CHOICES = '\u63a8\u8350 A\u3002\nA\uff1a\u5706\u89d2\u5361\u7247\nB\uff1a\u76f4\u89d2\u5361\u7247'
// "I need you to answer once on the corrected plan" asks; "nothing for you to decide", "cards that want you to pick
// carry options" and "no need to wait for your nod" do not (his VP's cards, 2026-11-24).
const ONE_LINE = '\u8981\u4f60\u5bf9\u66f4\u6b63\u540e\u7684\u505a\u6cd5\u56de\u4e00\u53e5\uff1a\u4f60\u56de\u4e4b\u524d\u4e0d\u5207'
const NOTHING = ['\u5185\u5b58\u7626\u8eab\u5728\u522b\u7684\u4efb\u52a1\u624b\u4e0a\uff0c\u6ca1\u6709\u8981\u4f60\u5b9a\u7684\u4e8b', '\u6ca1\u6709\u8981\u4f60\u51b3\u5b9a\u7684\u4e8b\u3002', '\u5361\u4e0a\u76f4\u63a5\u6709\u8f93\u5165\u6846\uff1b\u8981\u4f60\u9009\u7684\u5361\u5e26\u80fd\u70b9\u7684\u9009\u9879', '\u4e0d\u7528\u7b49\u4f60\u70b9\u5934\uff0c\u5df2\u4e0a\u7ebf', '\u4fee\u6cd5\uff1a\u5168\u90e8\u8ba1\u6570\u53ea\u7528\u4e00\u4e2a\u300c\u8981\u4f60\u5904\u7406\u300d\u7684\u5b9a\u4e49', '\u5df2\u4e0a\u7ebf\uff0c\u4ee5\u540e\u4e0d\u7528\u518d\u8ba9\u4f60\u786e\u8ba4', '\u4e0d\u9700\u8981\u4f60\u786e\u8ba4\uff0c\u5df2\u81ea\u52a8\u4e0a\u7ebf', '\u65e0\u9700\u7b49\u4f60\u786e\u8ba4', '\u4e0d\u5fc5\u7b49\u4f60\u70b9\u5934', '\u6ca1\u7b49\u4f60\u786e\u8ba4\u5c31\u4e0a\u7ebf\u4e86', '\u4e4b\u524d\u7b49\u4f60\u786e\u8ba4\u7684\u90a3\u7248\u5df2\u4e0a\u7ebf', '\u8ba9\u4f60\u9009\u7684\u90a3\u5f20\u5361\u5df2\u64a4\u4e0b', '\u7531\u4f60\u5b9a\u7684\u9ed8\u8ba4\u503c\u5df2\u751f\u6548']
const ELSEWHERE = '\u4e09\u4e2a\u65b0\u8bbe\u8ba1\u5df2\u653e\u5230\u300c\u6311\u8bbe\u8ba1\u300d\u5361\u4e0a\uff0c\u7b49\u4f60\u6311'

/** His request, answered by the node. */
function answered(): ThreadsFile {
  let f = fileMessage(emptyThreads('lead-1'), { text: 'make ten panel designs', via: 'chat', at: at(0) }).file
  f = setAnswers(f, new Map([[f.threads[0].messages[0].id, { text: 'Ten designs are on one page.', at: at(1) }]])).file
  return updateThread(f, f.threads[0].id, { title: 'Panel designs', state: 'answered', reply: 'Ten designs are on one page.' }, 'task:lead-1', at(1)).file
}

describe('the words', () => {
  it('a decision that waits now, in Chinese and English; never a past pick', () => {
    for (const t of [NOD, AGAIN, 'The real switch waits for your consent.', 'Needs your go-ahead before the release.', 'Ready for you to pick one.']) expect(asksHimNow(t), t).toBe(true)
    expect(asksHimNow(ONE_LINE)).toBe(true)
    // Review round 2: a colon form, a "no problem" before the ask, a question after a sentence with "no"; and never a
    // question answered in place, quoted words, or "should I have".
    for (const t of ['Your call: A or B.', '\u6d4b\u8bd5\u90fd\u8fc7\u4e86\uff0c\u6ca1\u95ee\u9898\u5c31\u7b49\u4f60\u70b9\u5934', 'No errors. Should I ship it?', '\u4f60\u51b3\u5b9a\u4e00\u4e0b\u7528\u54ea\u7248', 'Do you want A or B?']) expect(asksHimNow(t), t).toBe(true)
    for (const t of ['\u8981\u4e0d\u8981\u56de\u6eda\uff1f\u4e0d\u7528\uff0c\u5df2\u7ecf\u4fee\u597d\u5e76\u4e0a\u7ebf', 'The bot posts "waiting for your approval" for public releases; this one shipped.', 'Should I have caught this earlier? Yes, the test now does.']) expect(asksHimNow(t), t).toBe(false)
    // Review 2026-11-24 round 1, the forms that were missed: pending your confirm, post it or not?, you settle it, tell me once,
    // please decide, only your word is left, and a conditional ask from his VP's card.
    for (const t of ['\u8349\u7a3f\u5df2\u5907\u597d\uff0c\u5f85\u4f60\u786e\u8ba4\u540e\u53d1\u5e03', '\u8981\u4e0d\u8981\u53d1\uff1f', '\u4f60\u5b9a\u4e00\u4e0b\u7528\u54ea\u4e2a', '\u56de\u6211\u4e00\u53e5\u5c31\u53d1', '\u8bf7\u62cd\u677f', '\u53ea\u5dee\u4f60\u4e00\u53e5\u8bdd', '\u8981\u6211\u5f00\u5de5\u8fd9\u4e00\u6b65\uff0c\u56de\u6211\u4e00\u53e5', 'Should I post it?', 'Can you confirm the plan?', 'Waiting on you to pick.', 'Ready to ship; let me know if I should post it.']) expect(asksHimNow(t), t).toBe(true)
    // "the drafts are ready, waiting for your nod in the promotion task's thread"; "the real switch waits for your consent"
    for (const t of ['\u8349\u7a3f\u90fd\u597d\u4e86\uff0c\u7b49\u4f60\u5728\u63a8\u5e7f\u4efb\u52a1\u7684\u7ebf\u7a0b\u91cc\u70b9\u5934\uff0c\u73b0\u5728\u4ec0\u4e48\u90fd\u6ca1\u53d1', '\u771f\u673a\u5207\u6362\u8981\u7b49\u4f60\u540c\u610f']) expect(asksHimNow(t), t).toBe(true)
    for (const t of NOTHING) expect(asksHimNow(t), t).toBe(false)
    for (const t of [PICKED, 'Your pick (A) is live.', 'Shipped; nothing waits on anyone.', 'He approved it at 09:10.',
      // Review 2026-11-24: results that only mention him.
      'Shipped; nothing waits on you.', 'Nothing is waiting for you here.', 'The deploy is waiting for your Mac to wake up.',
      'waiting for your phone to come online', 'It no longer needs your approval', 'No longer waiting on your answer']) expect(asksHimNow(t), t).toBe(false)
    // A past pick still names a decision for the pointer rule (asksHimToDecide), never as one that waits.
    expect(asksHimToDecide('Your pick (A) is live.')).toBe(true)
  })

  it('choices listed in Chinese are choices', () => {
    expect(listsChoices(CHOICES)).toBe(true)
    expect(listsChoices('1. Built\n2. Tested')).toBe(false)
    // Status lists with a word that holds a character of choosing are no choice (review 2026-11-24).
    for (const t of ['\u4fee\u590d\u65b9\u6848\uff1a\n1. \u6539\u4e86 X\n2. \u52a0\u4e86\u6d4b\u8bd5', '1. \u6784\u5efa\u901a\u8fc7\n2. \u6d4b\u8bd5\u8fd8\u662f\u5931\u8d25', '\u7b5b\u9009\u5df2\u4fee\u597d\uff1a\n1. \u5217\u8868\n2. \u8be6\u60c5']) expect(listsChoices(t), t).toBe(false)
  })

  it('a proof beside it does not hold the choices another card has', () => {
    expect(summaryPointsElsewhere(`${ELSEWHERE} /tmp/panel/three.html`)).toMatch(/sends him to another card/)
    expect(summaryPointsElsewhere('Ten designs are live: /tmp/panel/ten.html')).toBeNull()
    expect(summaryPointsElsewhere('\u8349\u7a3f\u90fd\u597d\u4e86\uff0c\u7b49\u4f60\u5728\u63a8\u5e7f\u4efb\u52a1\u7684\u7ebf\u7a0b\u91cc\u70b9\u5934\u3002\u4e00\u9875\u5c31\u80fd\u770b\u5168\uff1a/tmp/promo/review.html')).toMatch(/sends him to another card/)
  })
})

describe('every door that writes a node\'s summary', () => {
  it('a new subject from a status line opens with its title, never with words that ask him', () => {
    const f = answered()
    const plan = planThreadWrites(f, [], [{ title: 'Spring post', state: 'working', progress: NOD }, { title: 'Seed order', state: 'working', progress: 'Comparing two suppliers.' }])
    expect(plan.opens.map((o) => o.text)).toEqual(['Spring post', 'Comparing two suppliers.'])
  })

  it('thread_update: refused out of needs, written in needs', () => {
    const f = answered()
    const id = f.threads[0].id
    for (const state of [undefined, 'answered', 'working', 'pending'] as const) {
      const err = (() => { try { updateThread(f, id, { reply: NOD, ...(state ? { state } : {}) }, 'task:lead-1', at(2)); return null } catch (e) { return e } })()
      expect(err, String(state)).toBeInstanceOf(ThreadError)
      expect((err as ThreadError).message).toBe(ASKS_OUTSIDE_NEEDS)
    }
    expect(updateThread(f, id, { reply: PICKED }, 'task:lead-1', at(2)).thread.reply).toBe(PICKED)
    // His own words are his.
    expect(updateThread(f, id, { reply: NOD }, 'human', at(2)).thread.reply).toBe(NOD)
  })

  it('a status line: an asking line writes nothing, and the next question names the thread first', () => {
    setThreadsKept(true)
    const f = answered()
    const t = f.threads[0]
    const { listed } = listForQuestion(f, f.threads)
    const { refs } = threadQuestionBlock(listed, undefined, { org: true })
    const ref = [...refs].find(([, r]) => r.id === t.id)![0]
    for (const state of ['answered', 'done', 'working', 'waiting'] as const) {
      const lines = readThreadLines(`FOR_USER_STATE: working\nFOR_USER_THREAD: ${ref} | ${state} | ${AGAIN}`, refs)
      const plan = planThreadWrites(f, lines.threads ?? [], [])
      expect(plan.writes, state).toEqual([])
      expect(plan.asked, state).toEqual([t.id])
    }
    noteLineAsks('lead-1', [t.id], [])
    expect(linesThatAsked('lead-1')).toEqual(new Set([t.id]))
    const again = threadQuestionBlock([{ ...listed[0], asked: true }], undefined, { org: true })
    expect(again.block).toContain(ASKED_MARK)
    expect(again.block).toContain('a thread_update into needs')
    const task = threadQuestionBlock([{ ...listed[0], asked: true }], undefined, { org: false })
    expect(task.block).toContain('FOR_USER_ASK, with FOR_USER_ASK_OPTIONS')
    // A line with its result only is written, and the thread is no longer named.
    const plain = readThreadLines(`FOR_USER_STATE: working\nFOR_USER_THREAD: ${ref} | answered | ${PICKED}`, refs)
    const ok = planThreadWrites(f, plain.threads ?? [], [])
    expect(ok.writes.map((w) => w.id)).toEqual([t.id])
    noteLineAsks('lead-1', ok.asked, ok.writes.map((w) => w.id))
    expect(linesThatAsked('lead-1').size).toBe(0)
  })
})
