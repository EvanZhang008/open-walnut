/**
 * His words in a node's chat keep the thread they follow (2026-11-20, the user, on a task's card
 * that still read as an unread answer while he kept talking about its subject in the chat: he had
 * been following up on that thread all along, so it had no need to stay on show; a thread he
 * acknowledged stays closed).
 *
 * The real case, in invented words: he asked in thread A (answered at once), the task's turn-end
 * status question opened thread B for its own bookkeeping (working, out of his sight), and his
 * next message two minutes later about A's subject went to a new thread C, so A's card stayed up.
 *  1. A node's thread he cannot see does not break the conversation: his next words join A. Since
 *     2026-11-23 a join by timing alone moves nothing on an answered A until the node's status answer
 *     checked it (the user: his words on another subject took a card out of his view, "我随便一聊，它就
 *     直接就消失"); once checked as A's subject, his words read as his reaction and the stale card leaves.
 *  2. A thread the node opened that he can see (needs, answered) still starts a new conversation.
 *  3. A thread waiting on his decision (needs) is the node's turn again when he follows up within
 *     the window: no thread stays on "needs you" after his reply. An answered or pending one keeps its
 *     state until the node checked the join (1), then leaves his view too.
 *  4. When his words still went elsewhere, the turn-end check names each answered thread he wrote
 *     after (answeredBeforeHim), so the node marks it known, closes it, or merges his words in.
 *  5. A thread he acknowledged himself is never reopened by a node.
 */
import { describe, expect, it } from 'vitest'
import {
  emptyThreads, fileMessage, setAnswers, updateThread, ThreadError, type OrgThread, type ThreadState, type ThreadsFile,
} from '../../../src/core/org/threads-model.js'
import { answeredBeforeHim, answeredBeforeHimReason } from '../../../src/core/org/thread-summary-stop.js'
import { threadCounts } from '../../../src/core/org/thread-groups.js'
import { clearJoin } from '../../../src/core/sessions/status-thread-split.js'

const T0 = Date.UTC(2026, 10, 20, 7, 59, 12)
const at = (s: number) => new Date(T0 + s * 1000).toISOString()

/** His first question, answered 31 s later: thread A, answered, the answer still news on his card. */
function asked(state: ThreadState = 'answered'): { f: ThreadsFile; a: OrgThread } {
  let f = emptyThreads('task-1')
  const r = fileMessage(f, { text: 'What does a scheduled job start, a whole new run each time?', via: 'chat', at: at(0), joinRecent: 180_000 })
  f = setAnswers(r.file, new Map([[r.message.id, { text: 'Yes: each time it fires it starts a new run.', at: at(31) }]])).file
  f = updateThread(f, r.thread.id, { title: 'What a scheduled job starts', reply: 'Each time it fires it starts a new run.', state, ...(state === 'needs' ? { user_kind: 'user_own', user_kind_why: 'His own design call.' } : {}) }, 'task:task-1', at(32)).file
  return { f, a: f.threads.find((t) => t.id === r.thread.id)! }
}

/** The status question opens a thread for the task's own bookkeeping (status-threads.ts planThreadWrites opens). */
function nodeOpens(f: ThreadsFile, state: ThreadState, s: number): ThreadsFile {
  const t: OrgThread = {
    id: 'th-b00000000001', title: 'Scheduler change in progress', titled: true, state, messages: [],
    opener: { text: 'About 100 lines, being written.', at: at(s), from: 'node', by: 'task:task-1' },
    createdAt: at(s), updatedAt: at(s), by: 'task:task-1',
  }
  return { ...f, threads: [...f.threads, t] }
}

const follow = (f: ThreadsFile, s: number) =>
  fileMessage(f, { text: 'Could the function itself fire on a schedule, without a separate run?', via: 'chat', at: at(s), joinRecent: 180_000 })

describe('his follow-up in the chat keeps the thread it follows', () => {
  it('a bookkeeping thread the node opened (out of his sight) does not move the conversation: his words join A', () => {
    for (const hidden of ['working', 'pending'] as const) {
      const { f, a } = asked()
      const r = follow(nodeOpens(f, hidden, 47), 144)
      expect(r.created, hidden).toBe(false)
      expect(r.thread.id).toBe(a.id)
      expect(r.joined).toBe('recent')
      // Not checked yet: A keeps its card (11-23); once the node checked it is A's subject, his words read his answer.
      expect(r.thread.state).toBe('answered')
      expect(threadCounts(r.file.threads, T0 + 150_000).shown).toBe(1)
      expect(threadCounts(clearJoin(r.file, r.message.id).threads, T0 + 150_000).shown).toBe(0)
    }
  })

  it('a thread the node opened that he can see still starts a new conversation', () => {
    for (const seen of ['needs', 'answered'] as const) {
      const { f, a } = asked()
      const r = follow(nodeOpens(f, seen, 47), 144)
      expect(r.created, seen).toBe(true)
      expect(r.thread.id).not.toBe(a.id)
    }
  })

  it('no thread stays on needs you (or shows a stale answer) once he followed it up in the chat', () => {
    // A decision waiting on him is the node's turn again after his words; an answer keeps its card
    // until the node checked the join, then his words read it (11-23).
    for (const [state, after] of [['needs', 'working'], ['answered', 'answered'], ['pending', 'pending']] as const) {
      const { f, a } = asked(state)
      const r = follow(nodeOpens(f, 'working', 47), 144)
      expect(r.thread.id, state).toBe(a.id)
      expect(r.thread.state, state).toBe(after)
      expect(threadCounts(clearJoin(r.file, r.message.id).threads, T0 + 150_000).shown, state).toBe(0)
    }
  })
})

describe('the turn-end check names the answered threads he wrote after (answeredBeforeHim)', () => {
  it('his words filed in another thread name A; once marked known it is not named', () => {
    const { f, a } = asked()
    // Past the join window: a new thread, as when he changes subject or comes back later.
    const r = follow(f, 600)
    expect(r.created).toBe(true)
    const named = answeredBeforeHim(r.file.threads, T0 + 610_000)
    expect(named.map((t) => t.id)).toEqual([a.id])
    const reason = answeredBeforeHimReason(named, { at: at(600), thread: r.thread })
    expect(reason).toContain(a.id)
    expect(reason).toContain('known')
    expect(reason).toContain('close it')
    expect(reason).toContain('one question left')
    // The node checked: he read it.
    const known = updateThread(r.file, a.id, { known: 'all' }, 'task:task-1', at(620)).file
    expect(answeredBeforeHim(known.threads, T0 + 630_000)).toEqual([])
  })

  it('names nothing he has not written after, nor one he watches or snoozed, nor the thread his words went to', () => {
    const { f, a } = asked()
    expect(answeredBeforeHim(f.threads, T0 + 60_000)).toEqual([])
    const r = follow(f, 600)
    const watched = updateThread(r.file, a.id, { watch: true }, 'human', at(601)).file
    expect(answeredBeforeHim(watched.threads, T0 + 610_000)).toEqual([])
    const snoozed = updateThread(r.file, a.id, { snooze: '4h' }, 'human', at(601)).file
    expect(answeredBeforeHim(snoozed.threads, T0 + 610_000)).toEqual([])
    // A reply he gave on another card is not his chat words: it says nothing about A.
    const other = fileMessage(f, { text: 'Another subject', via: 'chat', at: at(500) })
    const onCard = fileMessage(other.file, { text: 'Yes, go', via: 'follow-up', threadId: other.thread.id, at: at(600) })
    expect(answeredBeforeHim(onCard.file.threads, T0 + 610_000).map((t) => t.id)).toEqual([a.id])
    const cardOnly = fileMessage(f, { text: 'Yes, go', via: 'follow-up', threadId: nodeOpens(f, 'needs', 40).threads.at(-1)!.id, at: at(600) })
    expect(answeredBeforeHim(cardOnly.file.threads, T0 + 610_000)).toEqual([])
    // His newest words in A itself: A is the node's turn (working), the summary check's case.
    const inA = fileMessage(f, { text: 'And the run, is it kept?', via: 'follow-up', threadId: a.id, at: at(600) })
    expect(answeredBeforeHim(inA.file.threads, T0 + 610_000)).toEqual([])
  })
})

describe('a thread he acknowledged stays closed', () => {
  it('a node may not reopen it; his own Follow up still does', () => {
    const { f, a } = asked()
    const acked = updateThread(f, a.id, { close: 'acked' }, 'human', at(60)).file
    expect(() => updateThread(acked, a.id, { reopen: true, reply: 'More on this.' }, 'task:task-1', at(120)))
      .toThrowError(ThreadError)
    try { updateThread(acked, a.id, { reopen: true }, 'task:task-1', at(120)) } catch (err) {
      expect((err as ThreadError).message).toContain('new thread')
    }
    const his = fileMessage(acked, { text: 'One more thing on this', via: 'follow-up', threadId: a.id, at: at(120) })
    expect(his.created).toBe(false)
    expect(his.thread.closed).toBeUndefined()
  })
})
