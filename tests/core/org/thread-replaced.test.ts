/**
 * One decision shows once: a card replaced by another stays neither in Needs you nor in Done (2026-11-24,
 * the threads inspection, item 9: on Main a request of his the node had put in needs, and a card of
 * the node's own asking the same task's pick, both showed; the old one later said only "replaced by
 * the new card, pick there", in Done). src/core/org/thread-supersede.ts ownNeedsThreads, closeReplaced;
 * src/core/org/thread-ended.ts replacedBy, closeWhy.
 *
 * Every door a second card for one decision opens is here: the node's own card beside its own (the
 * old rule), beside his request it put in needs for the same task (new), a replaced card left behind
 * (closed when named; the sweep for one left from before). The last test classifies every state.
 */
import { describe, expect, it } from 'vitest'
import { closeReplaced, otherAsksRefusal, ownNeedsThreads } from '../../../src/core/org/thread-supersede.js'
import { answerUnread, closeWhy, holdsHim, replacedBy, replacedLine } from '../../../src/core/org/thread-ended.js'
import { THREAD_STATES, type OrgThread, type ThreadsFile } from '../../../src/core/org/threads-model.js'

const NOW = Date.parse('2026-11-24T12:00:00Z')
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString()
const LEAD = 'lead-1'
const BY = `task:${LEAD}` as const
const FENCE = 't-fence'

/** His request, which the node put in needs for the fence task's pick. */
const his = (over: Partial<OrgThread> = {}): OrgThread => ({
  id: 'th-his00001', title: 'Fence posts', titled: true, state: 'needs', tasks: [FENCE], needsAt: ago(60),
  messages: [{ id: 'tm-his0001', at: ago(70), text: 'which posts should we order?', via: 'chat', answer: { text: 'Larch or oak: I will ask you.', at: ago(69) }, readAt: ago(65) }],
  reply: 'Order larch or oak posts? I recommend larch.', replyAt: ago(60), createdAt: ago(70), updatedAt: ago(60), by: BY,
  options: [{ label: 'Larch (recommended)', recommended: true }, { label: 'Oak' }], ...over,
}) as OrgThread
/** The node's own card asking the same pick. */
const own = (over: Partial<OrgThread> = {}): OrgThread => ({
  id: 'th-own00001', title: 'Orchard fence: larch or oak posts?', titled: true, state: 'needs', tasks: [FENCE], needsAt: ago(50),
  messages: [], opener: { by: BY, from: 'task', at: ago(50), text: 'Order larch posts?' },
  reply: 'Order larch posts for the orchard fence? I recommend it: a third cheaper than oak.', replyAt: ago(50), createdAt: ago(50), updatedAt: ago(50), by: BY, ...over,
}) as OrgThread
const file = (...threads: OrgThread[]): ThreadsFile => ({ version: 1, taskId: LEAD, threads } as ThreadsFile)
/** "This card was replaced by the new card, please pick on the new card." (Chinese, escaped) */
const POINTER = '\u8fd9\u5f20\u5361\u5df2\u88ab\u65b0\u5361\u300c\u56f4\u680f\u7528\u54ea\u79cd\u6728\u6869\u300d\u53d6\u4ee3\uff0c\u8bf7\u5728\u65b0\u5361\u4e0a\u9009\u3002'

describe('a second card for one task\'s decision', () => {
  it('his request the node put in needs for that task counts as its open ask', () => {
    const others = ownNeedsThreads(file(his()), LEAD, undefined, undefined, undefined, [FENCE])
    expect(others.map((o) => o.id)).toEqual(['th-his00001'])
    expect(otherAsksRefusal(others, {})).toMatch(/th-his00001/)
    expect(otherAsksRefusal(others, { supersedes: ['th-his00001'] })).toBeNull()
  })

  it('not for another task, a closed or moved card, a card not in needs, a writer from below, or a card a task below opened', () => {
    expect(ownNeedsThreads(file(his()), LEAD, undefined, undefined, undefined, ['t-gate'])).toEqual([])
    expect(ownNeedsThreads(file(his({ closed: { how: 'acked', at: ago(5), by: 'human' } })), LEAD, undefined, undefined, undefined, [FENCE])).toEqual([])
    expect(ownNeedsThreads(file(his({ movedTo: { taskId: 't-x', threadId: 'th-x', at: ago(5) } } as never)), LEAD, undefined, undefined, undefined, [FENCE])).toEqual([])
    expect(ownNeedsThreads(file(his({ state: 'answered' })), LEAD, undefined, undefined, undefined, [FENCE])).toEqual([])
    expect(ownNeedsThreads(file(his()), 't-below', undefined, undefined, undefined, [FENCE])).toEqual([])
    // A task below asked it on the node's Threads: its own ask, never the node's to replace (review 2026-11-24).
    expect(ownNeedsThreads(file(his({ opener: { by: 'task:t-below', from: 'task', at: ago(60), text: 'x' } } as never)), LEAD, undefined, undefined, undefined, [FENCE])).toEqual([])
    // The node itself as the shared task is no task of the decision.
    expect(ownNeedsThreads(file(his({ tasks: [LEAD] })), LEAD, undefined, undefined, undefined, [LEAD])).toEqual([])
  })

  it('named as replaced, it closes with where it is asked now: no buttons, nothing asked of him, the line its own', () => {
    const line = replacedLine({ id: 'th-own00001', title: 'Orchard fence: larch or oak posts?' })
    const r = closeReplaced(file(his({ reply_sid: 'old-sid', reply_host: 'old-host' } as never), own()), 'th-his00001', line, BY, ago(0))
    expect(r.out).toBe('closed')
    const t = r.file.threads[0]
    expect(t.closed).toMatchObject({ how: 'dropped', by: BY, told: true })
    expect(t.reply).toBe('Asked now in "Orchard fence: larch or oak posts?" (th-own00001).')
    expect(t.options).toBeUndefined()
    expect(t).not.toHaveProperty('reply_sid')
    expect(t).not.toHaveProperty('reply_host')
    expect(r.changed).toEqual({ kind: 'updated', threadId: 'th-his00001' })
    expect(closeReplaced(r.file, 'th-his00001', 'again', BY, ago(0))).toMatchObject({ out: 'gone' })
    // He answered it meanwhile (it waits on him no more): left as it is, never stepped aside to pending.
    expect(closeReplaced(file(his({ state: 'working' }), own()), 'th-his00001', 'x', BY, ago(0)).out).toBe('gone')
  })

  it('judged on the file inside the lock: something of his on it keeps it, to step aside only', () => {
    const word = his({ messages: [...his().messages, { id: 'tm-his0002', at: ago(10), text: 'and the gate?', via: 'chat' }] as never })
    const coming = his({ messages: [...his().messages, { id: 'tm-his0003', at: ago(1), text: 'oak after all', via: 'chat', delivery: { state: 'pending', at: ago(1) } }] as never })
    const unread = his({ messages: [{ ...his().messages[0], readAt: undefined }] as never })
    for (const [name, t] of [['his word unanswered', word], ['his reply on its way', coming], ['an answer he has not read', unread]] as const) {
      expect(holdsHim(t, NOW) || answerUnread(t), name).toBe(true)
      const r = closeReplaced(file(t, own()), 'th-his00001', 'x', BY, ago(0))
      expect(r.out, name).toBe('held')
      expect(r.file.threads[0].closed, name).toBeUndefined()
    }
    expect(holdsHim(his(), NOW) || answerUnread(his())).toBe(false)
    // Its own letter, settled just before, holds it no more.
    const lettered = his({ letter: { id: 'lt-1', task: LEAD } } as never)
    expect(closeReplaced(file(lettered, own()), 'th-his00001', 'x', BY, ago(0)).out).toBe('held')
    expect(closeReplaced(file(lettered, own()), 'th-his00001', 'x', BY, ago(0), true).out).toBe('closed')
  })
})

describe('a replaced card left behind (the sweep)', () => {
  const left = (over: Partial<OrgThread> = {}) => his({ state: 'answered', reply: POINTER, options: undefined, ...over })

  it('a card in Done saying only that the new card asks it closes, beside that open card', () => {
    expect(replacedBy(left(), file(left(), own()), NOW)).toBe('th-own00001')
    expect(closeWhy(left(), file(left(), own()), new Map(), NOW)).toBe('replaced')
  })

  it('a card stepped aside with the replaced line closes once nothing of his holds it', () => {
    const t = left({ state: 'pending', reply: replacedLine({ id: 'th-own00001', title: 'Orchard fence: larch or oak posts?' }) })
    expect(replacedBy(t, file(t, own({ tasks: [] })), NOW)).toBe('th-own00001')
    const zh = left({ state: 'pending', reply: replacedLine({ id: 'th-own00001', title: '\u56f4\u680f\u6728\u6869' }) })
    expect(replacedBy(zh, file(zh, own({ tasks: [] })), NOW)).toBe('th-own00001')
  })

  it('never a result card beside an unrelated decision on the same task (review 2026-11-24)', () => {
    // Never a decision card itself, its result in the answer under his message, not read yet.
    const result = left({ needsAt: undefined, reply: 'Answered in the chat.', messages: [{ ...his().messages[0], answer: { text: 'Shipped: https://example.com/fence', at: ago(30) }, readAt: undefined }] as never })
    expect(replacedBy(result, file(result, own({ title: 'Fence colour?' })), NOW)).toBeNull()
    // Read, still never a decision card and not naming the other: it stays too.
    const read = left({ needsAt: undefined, reply: 'Answered in the chat.' })
    expect(replacedBy(read, file(read, own({ title: 'Fence colour?' })), NOW)).toBeNull()
  })

  it('stays when it says something itself, the other card is no decision or names another task, or something of his is on it', () => {
    expect(replacedBy(left({ reply: 'Larch posts are ordered; delivery is on Friday, 140 of them.' }), file(left(), own()), NOW)).toBeNull()
    expect(replacedBy(left(), file(left(), own({ state: 'answered' })), NOW)).toBeNull()
    expect(replacedBy(left(), file(left(), own({ tasks: ['t-gate'] })), NOW)).toBeNull()
    expect(replacedBy(left(), file(left(), own({ closed: { how: 'acked', at: ago(5), by: 'human' } })), NOW)).toBeNull()
    expect(replacedBy(left({ watched: { at: ago(5), by: 'human' } } as never), file(left(), own()), NOW)).toBeNull()
  })

  it('a pointer naming the open card by id needs no shared task', () => {
    const t = left({ tasks: [], reply: 'Please pick on the new card (th-own00001).' })
    expect(replacedBy(t, file(t, own({ tasks: [] })), NOW)).toBe('th-own00001')
  })

  it('every state is classified: only answered and pending close as replaced', () => {
    const closes = THREAD_STATES.filter((state) => replacedBy(left({ state }), file(left({ state }), own()), NOW))
    expect(closes.sort()).toEqual(['answered', 'pending'])
  })
})
