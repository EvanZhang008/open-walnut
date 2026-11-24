/**
 * A card that asks him to decide must hold what he decides (org/thread-summary-content.ts; 2026-11-24,
 * the user on his VP's Done card, "the three new designs are on the 'pick a design' card ... waiting
 * for your pick", whose named card was out of his sight: "where is it ... each thread should be self
 * contain have all necessary context"). Every writer refuses it: thread_update (threads-model.ts
 * updateThread), thread_create (threads-store.ts) and the status line (sessions/status-threads.ts
 * patchForLine). A card asking him to decide that is no decision card (Done or hidden) is named in the
 * node's threads-tidy note (thread-capture.ts). Chinese test data is written with \u escapes.
 */
import { describe, expect, it } from 'vitest'
import { asksHimToDecide, summaryPointsElsewhere } from '../../../src/core/org/thread-summary-content.js'
import { threadsTidyOf } from '../../../src/core/org/thread-capture.js'
import { patchForLine } from '../../../src/core/sessions/status-threads.js'
import { emptyThreads, fileMessage, setAnswers, ThreadError, updateThread } from '../../../src/core/org/threads-model.js'

// His card, the choices on another card (garden-neutral words aside, his own shape).
const HIS_CARD = '\u65b0\u5efa\u4efb\u52a1\u300c\u5728\u54ea\u91cc\u8dd1\u300d\u7684\u4e09\u4e2a\u65b0\u65b9\u6848\uff08A\u3001B\u3001C\uff09\u5df2\u653e\u5230\u201c\u6311\u65b9\u6848\u201d\u5361\u4e0a\uff0c\u63a8\u8350 A\uff0c\u8bc4\u5ba1\u5206\u6570 A 6/8/8\uff1b\u65e7\u7684 10 \u4e2a\u65b9\u6848\u90a3\u5f20\u5361\u5df2\u6458\u4e0b\uff0c\u7b49\u4f60\u6311\u3002'
const ELSEWHERE = /sends him to another card/

describe('a card that asks him to decide and sends him elsewhere for it', () => {
  it.each([
    ['the card he showed', HIS_CARD],
    ['"waiting for your decision in task X"', '\u8282\u70b9\u5361\u6b7b\u6ca1\u5f00\u51fa\u7968\uff0c\u56e0\u4e3a\u603b\u544a\u8b66\u4e00\u76f4\u662f\u7ea2\u7684\u3002\u8981\u4e0d\u8981\u6062\u590d\u4fee\u590d\uff0c\u5728\u6e05\u961f\u5217\u4efb\u52a1\u91cc\u7b49\u4f60\u51b3\u5b9a\u3002'],
    ['"for you to decide over in the memory task"', '\u4ea4\u6362\u533a\u8fd8\u5360 19 GB\u3002\u8981\u4e0d\u8981\u91cd\u542f\u6765\u91ca\u653e\u4ea4\u6362\u533a\uff0c\u5728\u7ba1\u5185\u5b58\u7684\u4efb\u52a1\u90a3\u91cc\u7531\u4f60\u51b3\u5b9a\u3002'],
    ['"on another card, waiting for your pick"', '\u4e09\u4e2a\u65b0\u65b9\u6848\u5df2\u653e\u5230\u53e6\u4e00\u5f20\u5361\u4e0a\uff0c\u7b49\u4f60\u6311\u3002'],
    ['English: your pick is on the design card', 'The three new designs are on the pick card; your pick decides which ships.'],
    ['English: a thread id', 'Your call on th-0a1b2c3d4e: which bed gets the new hose.'],
  ])('is refused: %s', (_name, summary) => {
    expect(summaryPointsElsewhere(summary)).toMatch(ELSEWHERE)
  })

  it.each([
    ['his question about two cards, answered with the cause', '\u201c\u6311\u65b9\u6848\u201d\u5361\u6302\u4e86\u4e24\u5f20\uff1a\u539f\u56e0\u662f\u4f60\u7684\u56de\u7b54\u53d1\u5728\u6211\u7684\u7ebf\u7a0b\u91cc\uff0c\u505a\u65b9\u6848\u7684\u4efb\u52a1\u90a3\u5f20\u5361\u5c31\u4e00\u76f4\u6302\u7740\uff1b\u65e7\u7684\u90a3\u5f20\u6211\u5df2\u6458\u4e0b\uff0c\u65b0\u4e00\u7248\u65b9\u6848\u653e\u5728\u540c\u4e00\u5f20\u5361\u4e0a\uff0c\u4e0d\u4f1a\u518d\u591a\u4e00\u5f20\u3002'],
    ['the choices on the card itself', '\u8bf7\u4f60\u6311\u4e00\u4e2a\uff1aA \u5de6\u680f\u52a0\u4e00\u4e2a\u641c\u7d22\u6846\uff1bB \u4e00\u6253\u5f00\u5c31\u5217\u6700\u8fd1\u7528\u8fc7\u7684\uff1bC \u5206\u680f\u70b9\u9009\u3002\u6211\u63a8\u8350 A\uff0c\u5b83\u6700\u5feb\u3002'],
    ['the choices behind a path he can open', '\u91cd\u505a\u4e86 3 \u4e2a\u80fd\u70b9\u7740\u8bd5\u7684\u65b9\u6848\uff0c\u63a8\u8350 A\uff0c\u7b49\u4f60\u6311\uff1b\u9875\u9762\uff1a/tmp/design/three.html'],
    ['a result on another card, nothing asked of him', 'The fix is on the release card and live since 10:30.'],
    ['English: the choices here', 'Your pick: A, a search box on the left; B, recent places first. I recommend A.'],
  ])('passes: %s', (_name, summary) => {
    expect(summaryPointsElsewhere(summary)).toBeNull()
  })

  it('reads the words that ask him to decide', () => {
    for (const s of [HIS_CARD, '\u4f60\u53ea\u6709\u67e5\u770b\u6743\u9650\uff0c\u8bc4\u5ba1\u610f\u89c1\u6ca1\u5199\u8fdb\u53bb\uff1b\u73b0\u5728\u7b49\u4f60\u9009\u53d1\u8bc4\u8bba\u8fd8\u662f\u5148\u8981\u7f16\u8f91\u6743\u9650\u3002', 'Waiting for your approval of the budget.']) expect(asksHimToDecide(s)).toBe(true)
    for (const s of ['\u201c\u6311\u65b9\u6848\u201d\u5361\u6302\u4e86\u4e24\u5f20\uff1a\u539f\u56e0\u662f\u4f60\u7684\u56de\u7b54\u53d1\u5728\u6211\u7684\u7ebf\u7a0b\u91cc\uff0c\u505a\u65b9\u6848\u7684\u4efb\u52a1\u90a3\u5f20\u5361\u5c31\u4e00\u76f4\u6302\u7740\uff1b\u65e7\u7684\u90a3\u5f20\u6211\u5df2\u6458\u4e0b\uff0c\u65b0\u4e00\u7248\u65b9\u6848\u653e\u5728\u540c\u4e00\u5f20\u5361\u4e0a\uff0c\u4e0d\u4f1a\u518d\u591a\u4e00\u5f20\u3002', 'The fix is live.']) expect(asksHimToDecide(s)).toBe(false)
  })
})

/** His question, answered, its card written as `reply` in `state`. */
function card(reply: string, state: 'answered' | 'pending' | 'working' | 'needs') {
  let f = fileMessage(emptyThreads('vp'), { text: 'which panel layout?', via: 'chat', at: '2026-11-24T05:00:00.000Z' }).file
  f = setAnswers(f, new Map([[f.threads[0].messages[0].id, { text: 'Three layouts are ready.', at: '2026-11-24T05:01:00.000Z' }]])).file
  const patch = state === 'needs' ? { title: 'Panel layout', reply, state, user_kind: 'user_own', user_kind_why: 'his own pick of a layout' } : { title: 'Panel layout', reply: 'Three layouts are ready.', state }
  const out = updateThread(f, f.threads[0].id, patch as never, 'task:vp', '2026-11-24T05:02:00.000Z').file
  // A card that asks him from outside needs is refused at every write now (thread-asks-outside-needs.test.ts);
  // one an older build stored that way is still named to its node.
  return state === 'needs' ? out : { ...out, threads: out.threads.map((t, i) => (i === 0 ? { ...t, reply } : t)) }
}

describe('every writer refuses it', () => {
  it('thread_update', () => {
    const f = card('Three layouts are ready.', 'answered')
    expect(() => updateThread(f, f.threads[0].id, { reply: HIS_CARD }, 'task:vp', '2026-11-24T05:03:00.000Z')).toThrow(ThreadError)
  })

  it('the status line: its words are not written, and the state stays', () => {
    const f = card('Three layouts are ready.', 'working')
    const t = f.threads[0]
    expect(patchForLine(t, { id: t.id, title: t.title, state: 'answered', progress: HIS_CARD })).toBeNull()
  })
})

describe('a card asking him to decide that is no decision card is named to the node', () => {
  const at = Date.parse('2026-11-24T05:30:00.000Z')
  it.each(['answered', 'pending', 'working'] as const)('%s: named to make it a decision card', (state) => {
    const f = card('\u4f60\u53ea\u6709\u67e5\u770b\u6743\u9650\uff0c\u8bc4\u5ba1\u610f\u89c1\u6ca1\u5199\u8fdb\u53bb\uff1b\u73b0\u5728\u7b49\u4f60\u9009\u53d1\u8bc4\u8bba\u8fd8\u662f\u5148\u8981\u7f16\u8f91\u6743\u9650\u3002', state)
    expect(threadsTidyOf(f, at)?.items).toEqual(expect.arrayContaining([expect.objectContaining({ id: f.threads[0].id, why: 'decide' })]))
  })

  it('a decision card (needs) is not', () => {
    const f = card('\u8bf7\u4f60\u6311\u4e00\u4e2a\uff1aA \u5de6\u680f\u52a0\u4e00\u4e2a\u641c\u7d22\u6846\uff1bB \u4e00\u6253\u5f00\u5c31\u5217\u6700\u8fd1\u7528\u8fc7\u7684\uff1bC \u5206\u680f\u70b9\u9009\u3002\u6211\u63a8\u8350 A\uff0c\u5b83\u6700\u5feb\u3002', 'needs')
    expect(threadsTidyOf(f, at)?.items.some((i) => i.why === 'decide') ?? false).toBe(false)
  })
})
