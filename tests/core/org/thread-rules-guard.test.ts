/**
 * Guard: the rule every Org node follows to keep its Threads clean stays a Walnut feature, said
 * in every place a node reads it and enforced where it writes (2026-11-01, the user: "make sure
 * this is a Walnut feature, not just your memory"; then, after a node closed a thread right after
 * answering it: "I had not replied ... so clearly I had not acknowledged it ... you cannot remove
 * it"; and "you can also create a new thread even if it is not from me").
 *
 * Fails when the prompt line, the `threads` hint, the `threads-tidy` reminder or a thread op loses
 * the rule, when the hint again tells the node it may close on its own say, when Walnut lets a
 * node close or fold an answer the user has not reacted to, or when a thread the node opened stops
 * taking his reply.
 */
import { describe, it, expect } from 'vitest'
import { THREADS_KNOWN_RULE, THREADS_OPEN_RULE } from '../../../src/core/org/thread-rules.js'
import { THREADS_LINE } from '../../../src/core/sessions/session-context.js'
import { threadHintText, threadsTidyOf, threadsTidyText, type ThreadHintState } from '../../../src/core/org/thread-capture.js'
import { emptyThreads, fileMessage, openThread, setAnswers, ThreadError, updateThread } from '../../../src/core/org/threads-model.js'
import { findHint } from '../../../src/core/hints/hint-registry.js'
import { getOp } from '../../../src/ops/index.js'

const at = (min: number) => new Date(Date.UTC(2026, 10, 1, 4, min)).toISOString()
const hint: ThreadHintState = {
  threadId: 'th-aaaaaaaaaaaa', title: 'Small model', created: true, followUp: false, duplicate: false,
  open: [{ id: 'th-bbbbbbbbbbbb', title: 'Other', state: 'answered' }], closed: [],
}

describe('the rule says what the user said', () => {
  it('silence after an answer is not knowing; only his reaction folds or closes', () => {
    expect(THREADS_KNOWN_RULE).toContain('Silence after your answer is NOT knowing')
    expect(THREADS_KNOWN_RULE).toContain('never mark it known or close it then')
    expect(THREADS_KNOWN_RULE).toMatch(/reply about it, an ok or thanks, a follow-up that builds on it, his Acknowledge/)
    expect(THREADS_KNOWN_RULE).toContain('on every turn that touches one')
  })

  it('a node opens a thread itself only for what he must act on or asked to follow, never as a feed', () => {
    expect(THREADS_OPEN_RULE).toContain('thread_create')
    expect(THREADS_OPEN_RULE).toContain('Never as a progress feed')
    expect(THREADS_OPEN_RULE).toContain('inbox as a letter')
  })
})

describe('every place a node reads it carries it', () => {
  it('the prompt line of Main and every lead', () => {
    expect(THREADS_LINE).toContain(THREADS_KNOWN_RULE)
    expect(THREADS_LINE).toContain(THREADS_OPEN_RULE)
  })

  it('the threads hint on each of his messages, and never the old "close it yourself when he says so"', () => {
    for (const s of [hint, { ...hint, created: false, followUp: true }, { ...hint, open: [] }]) {
      const text = threadHintText(s)
      expect(text).toContain(THREADS_KNOWN_RULE)
      expect(text).toContain(THREADS_OPEN_RULE)
      expect(text).not.toMatch(/close it yourself only when he says/i)
    }
  })

  it('the cleanup reminder, a built-in hint on a schedule', () => {
    let f = fileMessage(emptyThreads('lead-1'), { text: 'what is the small model?', via: 'chat', at: at(0) }).file
    f = setAnswers(f, new Map([[f.threads[0].messages[0].id, { text: 'The fast one.', at: at(1) }]])).file
    f = fileMessage(f, { text: 'ok, another thing', via: 'chat', at: at(2) }).file
    const tidy = threadsTidyOf(f, Date.parse(at(3)))
    expect(tidy?.items.map((i) => i.why)).toContain('reacted')
    expect(threadsTidyText(tidy!)).toContain(THREADS_KNOWN_RULE)
    const spec = findHint(null, 'threads-tidy')
    expect(spec?.enabled).toBe(true)
    expect(spec?.triggers).toContain('every_n_turns')
  })

  it('the thread ops', () => {
    for (const name of ['thread_list', 'thread_update', 'thread_create', 'thread_split', 'thread_file']) {
      expect(getOp(name)?.description, name).toContain(THREADS_KNOWN_RULE)
    }
    expect(getOp('thread_update')?.description).toMatch(/known/)
  })
})

describe('Walnut enforces it', () => {
  it('the node answers, he says nothing, the node tries to close or fold it: refused, the thread stays open', () => {
    let f = fileMessage(emptyThreads('lead-1'), { text: 'what is the small model?', via: 'chat', at: at(0) }).file
    const t = f.threads[0]
    f = setAnswers(f, new Map([[t.messages[0].id, { text: 'The fast one.', at: at(1) }]])).file
    for (const patch of [{ close: 'acked' as const }, { close: 'dropped' as const }, { known: 'all' }, { known: t.messages[0].id }]) {
      expect(() => updateThread(f, t.id, patch, 'task:lead-1', at(2)), JSON.stringify(patch)).toThrow(/has not written to you since/)
    }
    // Closed in the same turn as the answer, before Walnut read it: nothing he could have reacted to.
    const unread = fileMessage(emptyThreads('lead-1'), { text: 'and the big model?', via: 'chat', at: at(0) }).file
    expect(() => updateThread(unread, unread.threads[0].id, { close: 'acked' }, 'task:lead-1', at(1))).toThrow(/no answer of yours/)
    // After he reacts, the same close goes through, the node's reply to his thanks included.
    f = fileMessage(f, { text: 'got it, thanks', via: 'follow-up', threadId: t.id, at: at(3) }).file
    expect(updateThread(f, t.id, { close: 'acked' }, 'task:lead-1', at(4)).thread.closed?.how).toBe('acked')
    const thanks = f.threads[0].messages[1]
    const replied = setAnswers(f, new Map([[thanks.id, { text: 'Glad it helped.', at: at(4) }]])).file
    expect(updateThread(replied, t.id, { close: 'acked' }, 'task:lead-1', at(5)).thread.closed?.how).toBe('acked')
    // But the reply to his thanks is not known until he writes again: the mark stops before it.
    expect(updateThread(replied, t.id, { known: 'all' }, 'task:lead-1', at(5)).thread.known?.through).toBe(t.messages[0].id)
  })

  it('his follow-up question is not a reaction: answering it and closing in one turn is refused, and after the answer too', () => {
    let f = fileMessage(emptyThreads('lead-1'), { text: 'what is the small model?', via: 'chat', at: at(0) }).file
    const t = f.threads[0]
    f = setAnswers(f, new Map([[t.messages[0].id, { text: 'The fast one.', at: at(1) }]])).file
    f = fileMessage(f, { text: 'why that one and not the big model?', via: 'follow-up', threadId: t.id, at: at(2) }).file
    expect(() => updateThread(f, t.id, { close: 'acked' }, 'task:lead-1', at(3))).toThrow(ThreadError)
    const q = f.threads[0].messages[1]
    f = setAnswers(f, new Map([[q.id, { text: 'It is faster for titles.', at: at(3) }]])).file
    expect(() => updateThread(f, t.id, { close: 'acked' }, 'task:lead-1', at(4))).toThrow(/has not written to you since/)
    // Folding: the first answer, which his question reacted to, may fold; the second may not.
    expect(updateThread(f, t.id, { known: 'all' }, 'task:lead-1', at(4)).thread.known?.through).toBe(t.messages[0].id)
  })

  it('a thread the node opened files his reply under it', () => {
    const o = openThread(emptyThreads('lead-1'), { title: 'Mail needs your answer', text: 'The meetup asks to confirm the talk slot.', from: 'mail' }, 'task:lead-1', at(0))
    const r = fileMessage(o.file, { text: 'confirm it', via: 'follow-up', threadId: o.thread.id, at: at(1) })
    expect(r.created).toBe(false)
    expect(r.file.threads).toHaveLength(1)
    expect(r.thread.messages.map((m) => m.text)).toEqual(['confirm it'])
  })
})
