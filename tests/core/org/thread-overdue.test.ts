/**
 * Three rules of his Threads view (2026-11-07, the user, with three cards from his VP's Threads):
 *
 *   1. A thread shows only once there is a real reply for him: a working thread with the node's
 *      chat answer on it (one that only said who took it) stays out ("about 20 s later it replies;
 *      before it replies, what is the use?").
 *   2. A newer summary replaces the older answer on the card: the card never shows both.
 *   3. A thread that waits too long with nothing from the node is a fault: Walnut wakes the node
 *      once (thread-recheck.ts), and if it still writes nothing his view says so.
 *
 * The state table is a ratchet: a new thread state fails here until it is put in one of the groups.
 */
import { describe, it, expect } from 'vitest'
import {
  NEEDS_QUIET_MS, OVERDUE_SHOW_MS, REPLY_AT_SINCE, REPLY_DUE_MS, SUMMARY_COVERS_MS, cardView, overdueLine, shownToHim, summaryAt, threadOverdue,
  type ViewMessage, type ViewThread,
} from '../../../src/core/org/thread-view.js'
import { THREAD_STATES, emptyThreads, fileMessage, normalizeThreads, openThread, setAnswers, updateThread, type OrgThread } from '../../../src/core/org/threads-model.js'
import { RETRY_MS, threadRecheckBody, threadRecheckMessage, threadsDueRecheck } from '../../../src/core/org/thread-recheck.js'
import { classifyInjectedLine } from '../../../src/core/task-wait-resume.js'

const T0 = Date.parse('2026-11-07T14:00:00Z')
const iso = (ms: number) => new Date(T0 + ms).toISOString()
const MIN = 60_000
const msg = (id: string, atMs: number, answer?: { atMs: number; text: string }): ViewMessage => ({
  id, at: iso(atMs), text: `ask ${id}`, ...(answer ? { answer: { at: iso(answer.atMs), text: answer.text } } : {}),
})
type T = ViewThread & { state: string; updatedAt: string; by?: string }
const thread = (over: Partial<T>): T => ({ messages: [], state: 'working', updatedAt: iso(0), ...over })

describe('1. a thread in the node\'s hands stays out of his view, its chat answer included', () => {
  // His VP's real card: he asked at 2:04, the VP marked it working, its chat answer said two teams took it.
  const handoff = thread({
    state: 'working', by: 'task:vp', updatedAt: iso(10_000),
    messages: [msg('tm-1', 0, { atMs: 20_000, text: 'Both went to the action button team.' })],
  })

  it('is hidden with an unread answer on it, and shows once the node gives it a state', () => {
    expect(cardView(handoff).unread).toHaveLength(1)
    expect(shownToHim(handoff, new Set(), T0 + MIN)).toBe(false)
    expect(shownToHim({ ...handoff, state: 'answered' }, new Set(), T0 + MIN)).toBe(true)
  })

  it('every state is classified: shown, hidden however answered, or the node\'s call', () => {
    const shown = new Set(['needs', 'answered'])
    const nodesMove = new Set(['new', 'working'])
    const nodesCall = new Set(['pending'])
    for (const state of THREAD_STATES) {
      expect(shown.has(state) || nodesMove.has(state) || nodesCall.has(state), `thread state "${state}" is in no group of this test`).toBe(true)
      const t = { ...handoff, state }
      expect(shownToHim(t, new Set(), T0 + MIN)).toBe(shown.has(state))
      // Only the node's move can become overdue for a missing reply; only needs for a stale ask.
      const late = threadOverdue(t, T0 + NEEDS_QUIET_MS + REPLY_DUE_MS)
      expect(late?.why ?? null).toBe(nodesMove.has(state) ? 'reply' : state === 'needs' ? 'needs' : null)
    }
  })
})

describe('2. a newer summary replaces the older answer on the card', () => {
  const base = (over: Partial<T>) => thread({ state: 'answered', reply: 'iOS allows it; a new TestFlight build ships both.', by: 'task:vp', ...over })

  it('a summary written after the answer (a later turn): only the summary', () => {
    const t = base({ replyAt: iso(2 * MIN), updatedAt: iso(2 * MIN), messages: [msg('tm-1', 0, { atMs: 20_000, text: 'Both went to the team.' })] })
    expect(cardView(t).unread).toEqual([])
  })

  it('a summary written in the turn that answered (just before its chat reply): only the summary', () => {
    const t = base({ replyAt: iso(10_000), messages: [msg('tm-1', 0, { atMs: 25_000, text: 'Same, at length.' })] })
    expect(cardView(t).unread).toEqual([])
  })

  it('an answer that came long after the summary was written is news the summary did not see: it stays', () => {
    const t = base({ replyAt: iso(10_000), messages: [msg('tm-1', 0, { atMs: 10_000 + SUMMARY_COVERS_MS + MIN, text: 'The result.' })] })
    expect(cardView(t).unread.map((x) => x.answer?.text)).toEqual(['The result.'])
  })

  it('his message after the summary: its answer is on the card under the summary', () => {
    const t = base({ replyAt: iso(MIN), messages: [msg('tm-1', 0, { atMs: 20_000, text: 'old' }), msg('tm-2', 2 * MIN, { atMs: 3 * MIN, text: 'new' })] })
    expect(cardView(t).unread.map((x) => x.answer?.text)).toEqual(['new'])
  })

  it('a thread written before replyAt: the node\'s last change stands in for answers from before replyAt existed, never later ones', () => {
    const answered = [msg('tm-1', 0, { atMs: 20_000, text: 'Both went to the team.' })]
    expect(cardView(base({ updatedAt: iso(2 * MIN), messages: answered })).unread).toEqual([])
    expect(cardView(base({ updatedAt: iso(10_000), messages: answered })).unread).toHaveLength(1)
    // Review 2026-11-07: after replyAt exists, a legacy summary, then his follow-up, the node's new
    // result, and a state-only write: the result stays on the card.
    const after = Date.parse(REPLY_AT_SINCE) - T0
    const late = [msg('tm-1', after + 2 * MIN, { atMs: after + 3 * MIN, text: 'The new result.' })]
    expect(cardView(base({ updatedAt: iso(after + 4 * MIN), messages: late })).unread.map((x) => x.answer?.text)).toEqual(['The new result.'])
    const answered2 = late
    // Once the node writes a summary again, replyAt says when.
    expect(cardView(base({ updatedAt: iso(after + 5 * MIN), replyAt: iso(after + 5 * MIN), messages: answered2 })).unread).toEqual([])
    // His own last change is no summary time.
    expect(summaryAt(base({ by: 'human', updatedAt: iso(2 * MIN) }))).toBeUndefined()
  })

  it('a thread the node opened: a summary written after its first post replaces the post', () => {
    const opener = { text: 'Be at the home PC once for an admin prompt.', at: iso(0), from: 'task' }
    expect(cardView(base({ opener, state: 'needs', replyAt: iso(MIN) })).unread).toHaveLength(0)
    expect(cardView(thread({ opener, state: 'needs' })).unread).toHaveLength(1)
  })

  it('the model stamps replyAt on each summary write and drops it with the summary', () => {
    let f = fileMessage(emptyThreads('vp'), { text: 'can it skip opening the app?', via: 'chat', at: iso(0) }).file
    const id = f.threads[0].id
    f = updateThread(f, id, { reply: 'Yes, with a Live Activity.' }, 'task:vp', iso(MIN)).file
    expect(f.threads[0]).toMatchObject({ reply: 'Yes, with a Live Activity.', replyAt: iso(MIN), state: 'answered' })
    f = updateThread(f, id, { state: 'needs', user_kind: 'user_own', user_kind_why: 'He picks which build to try' }, 'task:vp', iso(2 * MIN)).file
    expect(f.threads[0].replyAt).toBe(iso(MIN))
    f = updateThread(f, id, { reply: '' }, 'task:vp', iso(3 * MIN)).file
    expect(f.threads[0].replyAt).toBeUndefined()
    // A file an older Walnut wrote without it reads the same; a stray replyAt with no summary is dropped.
    const raw = { threads: [{ ...f.threads[0], replyAt: iso(4 * MIN) }] }
    expect(normalizeThreads(raw, 'vp').threads[0].replyAt).toBeUndefined()
  })
})

describe('3. a thread that waits too long with nothing from the node', () => {
  it('his message with no reply: due after REPLY_DUE_MS, shown to him (saying so) OVERDUE_SHOW_MS later', () => {
    const t = thread({ state: 'working', by: 'human', messages: [msg('tm-1', 0)] })
    expect(threadOverdue(t, T0 + REPLY_DUE_MS - 1)).toBeNull()
    expect(threadOverdue(t, T0 + REPLY_DUE_MS)).toMatchObject({ why: 'reply', since: iso(0), unanswered: true })
    expect(shownToHim(t, new Set(), T0 + REPLY_DUE_MS)).toBe(false)
    expect(shownToHim(t, new Set(), T0 + REPLY_DUE_MS + OVERDUE_SHOW_MS)).toBe(true)
    expect(overdueLine(t, 'Walnut VP', T0 + REPLY_DUE_MS)).toBeNull()
    expect(overdueLine(t, 'Walnut VP', T0 + REPLY_DUE_MS + OVERDUE_SHOW_MS)).toBe(`No reply from Walnut VP · last activity ${iso(0)}`)
    const woken = { ...t, recheck: { since: iso(0), at: iso(REPLY_DUE_MS) } }
    expect(overdueLine(woken, 'Walnut VP', T0 + REPLY_DUE_MS + OVERDUE_SHOW_MS)).toBe(`No reply from Walnut VP · last activity ${iso(0)} · Walnut reminded Walnut VP ${iso(REPLY_DUE_MS)}`)
  })

  it('anything from the node on the thread starts the clock again', () => {
    const t = thread({ state: 'working', by: 'task:vp', updatedAt: iso(20 * MIN), messages: [msg('tm-1', 0)] })
    expect(threadOverdue(t, T0 + REPLY_DUE_MS)).toBeNull()
    expect(threadOverdue(t, T0 + 20 * MIN + REPLY_DUE_MS)?.since).toBe(iso(20 * MIN))
  })

  it('answered in chat but left working: due, and shows with that answer; one whose answers he knew stays the node\'s', () => {
    const t = thread({ state: 'working', by: 'task:vp', updatedAt: iso(10_000), messages: [msg('tm-1', 0, { atMs: 20_000, text: 'Done: it ships in 161.' })] })
    const late = T0 + 20_000 + REPLY_DUE_MS + OVERDUE_SHOW_MS
    expect(threadOverdue(t, late)).toMatchObject({ why: 'reply', unanswered: false })
    expect(shownToHim(t, new Set(), late)).toBe(true)
    const knew = { ...t, known: { through: 'tm-1' } }
    expect(threadOverdue(knew, late)).not.toBeNull()
    expect(shownToHim(knew, new Set(), late)).toBe(false)
  })

  it('needs with nothing new for NEEDS_QUIET_MS: due (the node checks it still stands); answered, pending, snoozed and closed never', () => {
    const opener = { text: 'Click yes on the admin prompt at the home PC.', at: iso(0), from: 'task' }
    const t = thread({ state: 'needs', by: 'task:vp', opener })
    expect(threadOverdue(t, T0 + NEEDS_QUIET_MS - 1)).toBeNull()
    expect(threadOverdue(t, T0 + NEEDS_QUIET_MS)).toMatchObject({ why: 'needs', since: iso(0) })
    expect(overdueLine(t, 'Walnut VP', T0 + NEEDS_QUIET_MS + OVERDUE_SHOW_MS)).toContain('Nothing new from Walnut VP on this')
    const far = T0 + 10 * NEEDS_QUIET_MS
    expect(threadOverdue({ ...t, state: 'answered' }, far)).toBeNull()
    expect(threadOverdue({ ...t, state: 'pending' }, far)).toBeNull()
    expect(threadOverdue({ ...t, snoozed: { until: iso(20 * NEEDS_QUIET_MS), at: iso(MIN) } }, far)).toBeNull()
    expect(threadOverdue({ ...t, closed: { by: 'human' } }, far)).toBeNull()
  })

  it('a wake is due once per stretch, and the note names each thread with what to do', () => {
    let f = fileMessage(emptyThreads('vp'), { text: 'why still queued?', via: 'chat', at: iso(0) }).file
    f = openThread(f, { title: 'Admin prompt at the home PC', text: 'Click yes once.', from: 'task', user_kind: 'user_info', user_kind_why: 'Only he can sit at that PC' }, 'task:vp', iso(0)).file
    f = setAnswers(f, new Map()).file
    const threads = f.threads as OrgThread[]
    const now = T0 + NEEDS_QUIET_MS
    const due = threadsDueRecheck(threads, now)
    expect(due.map((d) => d.overdue.why).sort()).toEqual(['needs', 'reply'])
    const body = threadRecheckBody(due, now)
    for (const d of due) expect(body).toContain(d.thread.id)
    expect(body).toContain('has no reply on this thread')
    expect(body).toContain('Check it still stands')
    const marked = threads.map((t) => ({ ...t, recheck: { since: due.find((d) => d.thread.id === t.id)!.overdue.since, at: iso(NEEDS_QUIET_MS), why: 'reply' as const } }))
    expect(threadsDueRecheck(marked, now + MIN)).toEqual([])
    // One that never went in (a failed send, a restart before it): tried again after RETRY_MS, not every pass.
    const pending = marked.map((t) => ({ ...t, recheck: { ...t.recheck, pending: true } }))
    expect(threadsDueRecheck(pending, now + MIN)).toEqual([])
    expect(threadsDueRecheck(pending, now + RETRY_MS)).toHaveLength(2)
    // And his card never says "reminded" for it.
    const notSent = pending.find((t) => t.state === 'needs')!
    expect(overdueLine(notSent, 'VP', now + OVERDUE_SHOW_MS)).not.toContain('reminded')
    expect(overdueLine(marked.find((t) => t.state === 'needs')!, 'VP', now + OVERDUE_SHOW_MS)).toContain('Walnut reminded VP')
  })
})

describe('the note is an interruption of a wait, never what the wait waited for', () => {
  it('its envelope reads as a Walnut notice, so a parked node keeps its wait and clock', () => {
    const due = threadsDueRecheck([{ id: 'th-aaaaaaaaaaaa', title: 'Queued', state: 'working', messages: [{ id: 'tm-aaaaaaaaaaaa', at: iso(0), text: 'why queued?', via: 'chat' }], createdAt: iso(0), updatedAt: iso(0), by: 'human' } as OrgThread], T0 + REPLY_DUE_MS)
    expect(due).toHaveLength(1)
    // The very text runThreadRecheck sends.
    expect(classifyInjectedLine(threadRecheckMessage(due, T0 + REPLY_DUE_MS))).toBe('walnut-notify')
  })
})
