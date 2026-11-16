/**
 * What a task still waits on the user for, read from its own conclusion and its lead's threads
 * (src/core/sessions/owed-waits.ts; 2026-11-16: a worker sent to look at a new document found an
 * invoice to pay, wrote "whether to pay is the user's decision" in its not_done and result, and completed;
 * its lead's thread asking the user "pay it?" named that worker, so nobody was left to pay).
 *
 * Chinese test data is written as \u escapes (the repo keeps code ASCII); each line says what it means.
 */
import { describe, expect, it } from 'vitest'
import { decisionItems, threadItemText, threadNamesTask, waitsOnUser } from '../../src/core/sessions/owed-waits.js'
import { threadAskText } from '../../src/core/org/thread-task-ask.js'

// "Pay $45 or not is open (Robin's decision, spending); the order history page not read."
const ND_ZH = '\u662f\u5426\u4ed8 $45 \u672a\u5b9a\uff08Robin \u7684\u51b3\u5b9a\uff0c\u82b1\u94b1\uff09\uff1b\u8ba2\u5355\u5386\u53f2\u9875\u6ca1\u8bfb\u3002'
// "The new file is Maple Print's invoice: $45.00, no due date; whether to pay is left to Robin (reported to the lead)."
const RESULT_ZH = '\u65b0\u6587\u4ef6\u662f Maple Print \u7684\u53d1\u7968\uff1a$45.00\uff0c\u65e0\u622a\u6b62\u65e5\u671f\uff1b\u662f\u5426\u4ed8\u6b3e\u4ea4 Robin \u5b9a\uff08\u5df2\u56de\u62a5 lead\uff09\u3002'
// "Changed the password per Robin's decision" (past: not waiting).
const PAST_ZH = '\u6309 Robin \u7684\u51b3\u5b9a\u6539\u4e86\u5bc6\u7801'
// "Waiting for Robin's reply"
const WAIT_ZH = '\u7b49 Robin \u56de\u590d'
// "You decide"
const YOU_DECIDE_ZH = '\u7531\u4f60\u51b3\u5b9a'
// "No need to wait for Robin, it is already paid"
const NO_WAIT_ZH = '\u4e0d\u7528\u7b49 Robin\uff0c\u5df2\u7ecf\u4ed8\u4e86'
// "The order history page not read" (the task's own leftover, not the user's)
const OWN_ZH = '\u8ba2\u5355\u5386\u53f2\u9875\u6ca1\u8bfb'
// The lead's thread: "You decide: pay Maple Print's $45 or not?"
const THREAD_ASK_ZH = '\u8981\u4f60\u5b9a\uff1a\u4ed8\u4e0d\u4ed8 Maple Print \u7684 $45\uff1f'

describe('a line that says the user still has to decide or answer', () => {
  it('the case that showed it: its not_done, its result and its summary each say so', () => {
    expect(waitsOnUser(ND_ZH, 'Robin')).toBe(true)
    expect(waitsOnUser(RESULT_ZH, 'Robin')).toBe(true)
    expect(waitsOnUser('Whether to pay the $45 is Robin\'s decision, and it was passed to the lead task.', 'Robin')).toBe(true)
  })

  it('reads the user\'s name, "the user" and "you", in English and Chinese', () => {
    for (const t of [
      WAIT_ZH, YOU_DECIDE_ZH,
      'Waiting for Robin to sign in', 'awaiting Robin', 'Robin to decide whether to pay',
      'left for the user to approve', 'waiting for the user\'s answer on the host', 'Needs your decision on the name',
      'You: pick the host', 'until Robin replies', 'The CR stays a draft until Robin reviews it.',
      'the user\'s approval is still needed', 'Whether to merge is Robin\'s call', 'blocked until Robin accepts the agreement',
    ]) expect(waitsOnUser(t, 'Robin'), t).toBe(true)
  })

  it('a decision already made, one that only mentions the user, or a negated wait is not', () => {
    for (const t of [
      PAST_ZH, NO_WAIT_ZH, OWN_ZH,
      'Paid per Robin\'s decision.', 'Changed it after Robin\'s approval', 'Robin\'s decision was to skip it',
      'Robin approved the password change', 'Tell Robin the result', 'Waiting on the user-service deploy',
      'Robinson report import', 'no longer waiting on Robin', 'Order history page not read',
      // Real conclusions of the week before the fix that a first cut misread (names neutral).
      'Robin\'s reply is in the chat, and the task is complete.', 'Stopped at Robin\'s call (relayed by the lead): left as a draft',
      'The check confirmed Robin\'s approval satisfies the reviewer requirement', 'design 7, the user\'s pick of 10 designs, puts arrows at the end',
      'Walnut corrects agents whose lines drift away from the user\'s reply language.',
      // "There is nothing only Robin can decide, so no letter was written."
      '\u6ca1\u6709\u53ea\u80fd\u7531 Robin \u5b9a\u7684\u4e8b\uff0c\u6240\u4ee5\u6ca1\u5199\u4fe1\u3002',
    ]) expect(waitsOnUser(t, 'Robin'), t).toBe(false)
  })

  it('a result describes work: only a decision put on the user counts there (strict)', () => {
    // The 2026-11-16 review's misreads, as a result would say them.
    for (const t of [
      'Landed the gate: a task still waiting on the user cannot be completed.',
      'Fixed the bug where tasks waiting for Robin were closed early.',
      'Robin, the deploy is live and verified.', 'The user will pay nothing extra', 'Done: nothing waits on Robin.',
      // "Fixed the user's confirmation dialog"; "Implemented staying open while waiting for the user's reply"
      '\u4fee\u597d\u4e86\u7528\u6237\u7684\u786e\u8ba4\u5f39\u7a97', '\u5b9e\u73b0\u4e86\u7b49\u7528\u6237\u56de\u590d\u65f6\u4fdd\u6301\u6253\u5f00',
    ]) expect(waitsOnUser(t, 'Robin', true), t).toBe(false)
    expect(waitsOnUser(RESULT_ZH, 'Robin', true)).toBe(true)
    expect(waitsOnUser('Whether to pay is Robin\'s decision.', 'Robin', true)).toBe(true)
    expect(waitsOnUser('Done: nothing waits on Robin.', 'Robin')).toBe(false)
  })

  it('without a recorded name only the plain words count', () => {
    expect(waitsOnUser('Robin\'s decision', undefined)).toBe(false)
    expect(waitsOnUser('It is the user\'s decision', undefined)).toBe(true)
  })
})

describe('the task\'s conclusion', () => {
  it('not_done items come first and are kept as written; its own leftovers are not the user\'s', () => {
    expect(decisionItems({ notDone: [ND_ZH, OWN_ZH], result: RESULT_ZH }, 'Robin')).toEqual([ND_ZH])
  })

  it('with nothing in not_done, its result says it, one sentence per item', () => {
    expect(decisionItems({ notDone: [OWN_ZH], result: RESULT_ZH }, 'Robin')).toHaveLength(1)
    expect(decisionItems({ result: 'Read the invoice. Whether to pay is Robin\'s decision.' }, 'Robin'))
      .toEqual(['Whether to pay is Robin\'s decision.'])
  })

  it('a conclusion with nothing for the user holds nothing', () => {
    expect(decisionItems({ notDone: [OWN_ZH], result: 'Paid $45 per Robin\'s decision, receipt saved.' }, 'Robin')).toEqual([])
  })
})

describe('a lead\'s thread waiting on the user for this task', () => {
  const base = { id: 'th-1', title: 'Print shop invoice', state: 'needs' as const, messages: [], createdAt: '', updatedAt: '', by: 'task:lead' }
  it('is about it by its ask owner or its opener\'s ref; by its tasks only from a lead above it, only while open and waiting on him', () => {
    const on = (saysWaits: boolean, node = 'lead') => ({ node, chain: new Set(['lead']), saysWaits })
    // A lead's thread above it that went to it alone, or whose decision its own conclusion names.
    expect(threadNamesTask({ ...base, tasks: ['t1'] }, 't1', on(false))).toBe(true)
    expect(threadNamesTask({ ...base, tasks: ['t1', 't2'] }, 't1', on(false))).toBe(false)
    expect(threadNamesTask({ ...base, tasks: ['t1', 't2'] }, 't1', on(true))).toBe(true)
    // Not a node above it, nor a list alone.
    expect(threadNamesTask({ ...base, tasks: ['t1'] }, 't1', on(true, 'main'))).toBe(false)
    expect(threadNamesTask({ ...base, tasks: ['t1'] }, 't1')).toBe(false)
    expect(threadNamesTask({ ...base, askOwner: { task: 't1', at: '' } }, 't1')).toBe(true)
    expect(threadNamesTask({ ...base, opener: { text: 'x', at: '', from: 'task', by: 'task:lead', ref: 't1' } } as never, 't1')).toBe(true)
    expect(threadNamesTask({ ...base, tasks: ['t2'] }, 't1')).toBe(false)
    expect(threadNamesTask({ ...base, state: 'answered', askOwner: { task: 't1', at: '' } } as never, 't1')).toBe(false)
    expect(threadNamesTask({ ...base, askOwner: { task: 't1', at: '' }, closed: { at: '', by: 'human', how: 'acked' } } as never, 't1')).toBe(false)
  })

  it('its item is what it asks him, in its own words (so the thread folds into the task\'s ask), else its title', () => {
    expect(threadItemText({ ...base, reply: `${THREAD_ASK_ZH} More detail.` }, threadAskText)).toBe(threadAskText({ reply: `${THREAD_ASK_ZH} More detail.` }))
    expect(threadItemText({ ...base, ask: 'Pay the print shop invoice?' }, threadAskText)).toBe('Pay the print shop invoice?')
    expect(threadItemText(base, threadAskText)).toBe('Answer the thread "Print shop invoice"')
  })
})
