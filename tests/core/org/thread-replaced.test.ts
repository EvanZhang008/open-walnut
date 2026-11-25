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
 *
 * And a card named as replaced that is no ask of the writer's own (2026-11-25: a task's card named
 * its lead's card, the id was dropped without a word, and both asked him): namedVerdict classifies
 * every state and every place, so a named card either steps aside, asks nothing already, or the
 * write is refused by name; never a fourth outcome.
 */
import { describe, expect, it } from 'vitest'
import { closeReplaced, namedRefusal, namedVerdict, otherAsksRefusal, ownNeedsThreads, setAsideNamed } from '../../../src/core/org/thread-supersede.js'
import { answerUnread, closeWhy, heldWhy, holdsHim, HOLDS, replacedBy, replacedLine } from '../../../src/core/org/thread-ended.js'
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

describe('a card named as replaced that is no ask of the writer\'s own', () => {
  const TASK = 't-task'
  const WRITER = `task:${TASK}` as const
  /** The lead's card for the subject it handed to the task. */
  const leads = (over: Partial<OrgThread> = {}): OrgThread => his({ id: 'th-lead0001', tasks: [TASK], ...over })
  const at = (own: boolean, below: boolean) => ({ own, below, node: LEAD })
  const PLACES = [
    { name: 'the writer\'s own Threads', where: at(true, false), over: { tasks: [] }, mine: true },
    { name: 'a node below the writer', where: at(false, true), over: { tasks: [] }, mine: true },
    { name: 'a card that names the writer and no other task', where: at(false, false), over: { tasks: [TASK, LEAD] }, mine: true },
    { name: 'a card pointed at the writer', where: at(false, false), over: { tasks: [], askOwner: { task: TASK, at: ago(9), by: BY } }, mine: true },
    { name: 'a card the writer opened there', where: at(false, false), over: { tasks: [], opener: { by: WRITER, from: 'task', at: ago(9), text: 'x' } }, mine: true },
    { name: 'a card that names another task too', where: at(false, false), over: { tasks: [TASK, 't-other'] }, mine: false, why: 'shared' },
    { name: 'another task\'s card', where: at(false, false), over: { tasks: ['t-other'] }, mine: false, why: 'not_yours' },
  ] as const
  /** Everything that can still be his on a card (thread-ended.ts heldWhy), one fixture per reason. */
  const WATCHED = { watched: { at: ago(5), by: 'human' } } as never as Partial<OrgThread>
  const HELD: Record<Exclude<NonNullable<ReturnType<typeof heldWhy>>, 'acknowledged' | 'watch'>, Partial<OrgThread>> = {
    letter: { letter: { id: 'lt-other001', task: 't-other' } } as never,
    ask: { reportAsk: { id: 'ask-1', at: ago(5) } } as never,
    choice: { choice: { id: 'c-1' } } as never,
    delivery: { messages: [{ id: 'tm-way00001', at: ago(2), text: 'go with larch', via: 'chat', delivery: { state: 'pending', at: ago(2) } }] } as never,
    word: { messages: [{ id: 'tm-word0001', at: ago(2), text: 'wait, which wood did the neighbours use?', via: 'chat' }] } as never,
  }

  it('every state in every place has one of three outcomes, and only a card that waits on him is touched', () => {
    const seen = new Set<string>()
    for (const p of PLACES) {
      for (const state of THREAD_STATES) {
        const v = namedVerdict(leads({ state, ...(p.over as Partial<OrgThread>) }), TASK, p.where, NOW)
        seen.add(v.verdict)
        if (state !== 'needs') expect(v, `${p.name}, ${state}`).toEqual({ verdict: 'nothing' })
        else if (p.mine) expect(v, `${p.name}, ${state}`).toEqual({ verdict: 'replace' })
        else expect(v, `${p.name}, ${state}`).toEqual({ verdict: 'refuse', why: p.why })
      }
      // Closed or moved, whatever its state: it asks him nothing.
      expect(namedVerdict(leads({ closed: { how: 'acked', at: ago(5), by: 'human' }, ...(p.over as Partial<OrgThread>) }), TASK, p.where, NOW).verdict).toBe('nothing')
      expect(namedVerdict(leads({ movedTo: { taskId: 't-x', threadId: 'th-x', at: ago(5) }, ...(p.over as Partial<OrgThread>) } as never), TASK, p.where, NOW).verdict).toBe('nothing')
    }
    expect([...seen].sort()).toEqual(['nothing', 'refuse', 'replace'])
  })

  it('a card with something of his on it is never taken off, whoever names it: every reason heldWhy knows is refused by its name', () => {
    // The fixtures cover every reason: a new one in thread-ended.ts fails here until it is decided.
    const fixture = (why: string) => leads(HELD[why as keyof typeof HELD])
    for (const why of Object.keys(HELD)) expect(heldWhy(fixture(why), NOW), why).toBe(why)
    // "acknowledged" is the one reason with no fixture: only a pending card is in Acknowledged, and a
    // pending card asks him nothing, so naming it is "nothing" before anything is weighed.
    // His watch is the other: a watched card steps aside open and stays in his Watching (next test).
    expect(Object.keys(HELD).sort()).toEqual(['delivery', 'word', ...Object.keys(HOLDS)].sort())
    for (const why of Object.keys(HELD)) {
      for (const p of PLACES.filter((x) => x.mine)) {
        const t = leads({ ...(p.over as Partial<OrgThread>), ...HELD[why as keyof typeof HELD] })
        expect(namedVerdict(t, TASK, p.where, NOW), `${why}, ${p.name}`).toEqual({ verdict: 'refuse', why })
        expect(setAsideNamed(file(t), t.id, 'x', WRITER, ago(0)), `${why}, ${p.name}`).toMatchObject({ out: 'held', why })
      }
    }
  })

  it('a card he watches steps aside open and keeps his watch, unless something else of his is on it too', () => {
    expect(heldWhy(leads(WATCHED), NOW)).toBe('watch')
    expect(namedVerdict(leads(WATCHED), TASK, at(false, false), NOW)).toEqual({ verdict: 'replace' })
    const r = setAsideNamed(file(leads(WATCHED)), 'th-lead0001', 'x', WRITER, ago(0))
    expect(r.out).toBe('aside')
    expect(r.file.threads[0]).toMatchObject({ state: 'pending', reply: 'x', ...WATCHED })
    expect(r.file.threads[0]!.closed).toBeUndefined()
    expect(r.file.threads[0]!.options).toBeUndefined()
    const both = leads({ ...WATCHED, ...HELD.word })
    expect(namedVerdict(both, TASK, at(false, false), NOW)).toEqual({ verdict: 'refuse', why: 'word' })
    expect(setAsideNamed(file(both), 'th-lead0001', 'x', WRITER, ago(0))).toMatchObject({ out: 'held', why: 'word' })
  })

  it('a card that shows a task\'s own question waits on him whatever state it stores', () => {
    for (const state of ['working', 'pending'] as const) {
      expect(namedVerdict(leads({ state, reportAsk: { id: 'ask-1', at: ago(5) } } as never), TASK, at(false, true), NOW)).toEqual({ verdict: 'refuse', why: 'ask' })
    }
  })

  it('taken off, it closes with where it is asked now: no buttons, no pointer left, its conversation kept', () => {
    const line = replacedLine({ id: 'th-task0001', title: 'Orchard fence: larch or oak posts?' })
    const r = setAsideNamed(file(leads({ askOwner: { task: TASK, at: ago(9), by: BY } } as never)), 'th-lead0001', line, WRITER, ago(0))
    expect(r.out).toBe('closed')
    expect(r.changed).toEqual({ kind: 'updated', threadId: 'th-lead0001' })
    const t = r.file.threads[0]!
    expect(t).toMatchObject({ reply: line, reply_by: WRITER, closed: { how: 'dropped', by: WRITER, told: true } })
    expect(t.options).toBeUndefined()
    expect(t.askOwner).toBeUndefined()
    expect(t.messages).toHaveLength(1)
    expect(holdsHim(t, NOW)).toBe(false)
  })

  it('while an answer on it is still his to read, it steps aside open instead', () => {
    const unread = leads({ messages: [{ id: 'tm-his0001', at: ago(70), text: 'which posts should we order?', via: 'chat', answer: { text: 'Larch or oak: I will ask you.', at: ago(69) } }] } as never)
    expect(answerUnread(unread)).toBe(true)
    const r = setAsideNamed(file(unread), 'th-lead0001', 'x', WRITER, ago(0))
    expect(r.out).toBe('aside')
    expect(r.file.threads[0]).toMatchObject({ state: 'pending', reply: 'x' })
    expect(r.file.threads[0]!.closed).toBeUndefined()
  })

  it('a card that no longer waits on him is left as it is', () => {
    for (const over of [{ state: 'answered' }, { state: 'pending' }, { closed: { how: 'acked', at: ago(5), by: 'human' } }] as Array<Partial<OrgThread>>) {
      const f = file(leads(over))
      const r = setAsideNamed(f, 'th-lead0001', 'x', WRITER, ago(0))
      expect(r.out).toBe('gone')
      expect(r.file).toBe(f)
    }
    expect(setAsideNamed(file(), 'th-lead0001', 'x', WRITER, ago(0)).out).toBe('gone')
  })

  it('a refusal names the id, the reason and the way on', () => {
    const where = { node: LEAD, nodeTitle: 'Orchard lead', title: 'Fence posts' }
    expect(namedRefusal('th-lead0001', 'not_yours', where)).toMatch(/supersedes names th-lead0001.*waits on the user on "Orchard lead" \(lead-1\) as "Fence posts".*does not name your task.*task_send lead-1/)
    expect(namedRefusal('th-lead0001', 'shared', where)).toMatch(/names other tasks beside yours.*task_send lead-1/)
    expect(namedRefusal('th-lead0001', 'word', where)).toMatch(/a word of his on it has no answer yet.*task_send lead-1/)
    expect(namedRefusal('th-none0001', 'unknown')).toMatch(/supersedes names th-none0001.*no open thread within your reach/)
    expect(namedRefusal('lt-none0001', 'letter')).toMatch(/supersedes names lt-none0001.*no decision letter of your task/)
    expect(namedRefusal('th-lead0001', 'no_ask')).toMatch(/goes only with a thread that waits on the user/)
  })
})
