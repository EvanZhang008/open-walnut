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
  NEEDS_QUIET_MS, OVERDUE_SHOW_MS, REPLY_DUE_MS, SUMMARY_COVERS_MS, cardView, overdueLine, shownToHim, summaryAt, threadOverdue,
  type ViewMessage, type ViewThread,
} from '../../../src/core/org/thread-view.js'
import { THREAD_STATES, emptyThreads, fileMessage, normalizeThreads, openThread, setAnswers, stampLegacyReplyAt, updateThread, type OrgThread } from '../../../src/core/org/threads-model.js'
import { RETRY_MS, threadRecheckBody, threadRecheckMessage, threadsDueRecheck } from '../../../src/core/org/thread-recheck.js'
import { threadsTidyOf } from '../../../src/core/org/thread-capture.js'
import { STAND_IN_MAX, plainLine, summaryBehindHim, summaryOwed } from '../../../src/core/org/thread-view.js'
import { staleSummaries, staleSummaryReason } from '../../../src/core/org/thread-summary-stop.js'
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
    // Review 2026-11-07: a legacy summary, then his follow-up, the node's new result, and a
    // state-only write, each through the store (which stamps replyAt first): the result stays.
    let f = { version: 1 as const, taskId: 'vp', threads: [thread({ id: 'th-1', state: 'answered', reply: 'Old words', by: 'task:vp', updatedAt: iso(MIN),
      messages: [msg('tm-1', 0, { atMs: 20_000, text: 'Old answer.' })] }) as never] }
    const write = (fn: (cur: typeof f) => typeof f) => { f = fn(stampLegacyReplyAt(f as never) as never) }
    write((cur) => fileMessage(cur as never, { text: 'and now?', via: 'follow-up', threadId: 'th-1', at: iso(2 * MIN) }).file as never)
    write((cur) => setAnswers(cur as never, new Map([[(cur.threads[0] as any).messages[1].id, { text: 'The new result.', at: iso(3 * MIN) }]])).file as never)
    write((cur) => updateThread(cur as never, 'th-1', { state: 'answered' }, 'task:vp', iso(4 * MIN)).file as never)
    const late = f.threads[0] as never
    expect(cardView(late).unread.map((x) => x.answer?.text)).toEqual(['The new result.'])
    expect(summaryBehindHim(late)).toBe(true)
    // Once the node writes a summary again, replyAt says when.
    write((cur) => updateThread(cur as never, 'th-1', { reply: 'New words.' }, 'task:vp', iso(5 * MIN)).file as never)
    expect(cardView(f.threads[0] as never).unread).toEqual([])
    expect(summaryBehindHim(f.threads[0] as never)).toBe(false)
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

describe('4. every card leads with a summary line', () => {
  // 2026-11-08, the user, on a card with only the node's answer and the Conversation toggle:
  // "no summary at all ... I should not need to open it".
  const answer = 'Good: the version that never opens the app.\n\n- a big **Send** button on the lock screen;\n- press the action button again.\n\nAbout <walnut-about ids="t1"/>'
  const shapes: Record<string, T> = {
    'node summary': thread({ state: 'answered', reply: 'Ships in the next build.', replyAt: iso(MIN), messages: [msg('tm-1', 0, { atMs: 20_000, text: 'ok' })] }),
    'answer, no summary': thread({ state: 'working', by: 'task:vp', messages: [msg('tm-1', 0, { atMs: 20_000, text: answer })] }),
    'opener, no summary': thread({ state: 'needs', opener: { text: 'Click yes on the admin prompt.', at: iso(0), from: 'task' } }),
    'only his message, an ask': thread({ state: 'working', ask: 'Why is it still queued?', messages: [msg('tm-1', 0)] }),
    'only his message': thread({ state: 'working', messages: [msg('tm-1', 0)] }),
    'only a long message of his': thread({ state: 'working', messages: [{ id: 'tm-1', at: iso(0), text: 'Paragraph 1: '.repeat(40) }] }),
    'shared answer only': thread({ state: 'answered', messages: [msg('tm-1', 0, { atMs: 20_000, text: 'One reply for two threads.' })] }),
  }

  it('has a non-empty line in every shape, from the node when it wrote one, else Walnut\'s', () => {
    for (const [name, t] of Object.entries(shapes)) {
      const c = cardView(t, name === 'shared answer only' ? new Set(['tm-1']) : new Set())
      expect(c.summary.text.trim(), name).not.toBe('')
      expect(c.summary.by, name).toBe(name === 'node summary' ? 'node' : 'walnut')
    }
    // His own words are never echoed back as the line (2026-11-01: "you don't need to put it in this thread").
    expect(cardView(shapes['only a long message of his']).summary).toEqual({ text: 'No answer yet', by: 'walnut', from: 'none' })
    // Every card a view of real-looking threads shows has one too.
    for (const t of Object.values(shapes)) if (shownToHim(t, new Set(), T0 + NEEDS_QUIET_MS)) expect(cardView(t).summary.text).not.toBe('')
  })

  it('the stand-in is the first sentence of the latest answer, plain; the answer stays whole below it', () => {
    const c = cardView(shapes['answer, no summary'])
    expect(c.summary).toMatchObject({ text: 'Good: the version that never opens the app.', by: 'walnut', from: 'answer' })
    // The line names the exchange it was cut from: its writer is the line's writer (a path in it opens there).
    expect(c.summary.exchange?.answer?.text).toContain('Good: the version that never opens the app.')
    expect(c.unread).toHaveLength(1)
    expect(plainLine('- a big **Send** button;\n- press again')).toBe('a big Send button; press again')
    // A test of CJK text data: "\u597d\u3002" is a two-character sentence ending in an ideographic full stop.
    expect(plainLine('\u597d\uff0c\u5c31\u505a\u4e0d\u6253\u5f00 app \u7684\u7248\u672c\u3002\u677e\u624b\u53d1\u4e0d\u4e86\u3002')).toBe('\u597d\uff0c\u5c31\u505a\u4e0d\u6253\u5f00 app \u7684\u7248\u672c\u3002')
    expect(Array.from(plainLine('x'.repeat(1000))).length).toBe(STAND_IN_MAX)
    // Left too long, the thread still shows for the answer the stand-in carries.
    expect(shownToHim(shapes['answer, no summary'], new Set(), T0 + 20_000 + REPLY_DUE_MS + OVERDUE_SHOW_MS)).toBe(true)
  })

  it('the node is asked for a missing or outdated summary (threads-tidy), never for one that covers its answers', () => {
    expect(summaryOwed(shapes['answer, no summary'])).toBe(true)
    expect(summaryOwed(shapes['node summary'])).toBe(false)
    // A thread he wrote in owes a summary even before the node said anything (2026-11-08).
    expect(summaryOwed(shapes['only his message'])).toBe(true)
    const outdated = thread({ state: 'answered', reply: 'Old', replyAt: iso(MIN), messages: [msg('tm-1', 2 * MIN, { atMs: 3 * MIN, text: 'New result' })] })
    expect(summaryOwed(outdated)).toBe(true)
    let f = fileMessage(emptyThreads('vp'), { text: 'can it skip the app?', via: 'chat', at: iso(0) }).file
    f = updateThread(f, f.threads[0].id, { title: 'Skip the app', state: 'working' }, 'task:vp', iso(10_000)).file
    f = setAnswers(f, new Map([[f.threads[0].messages[0].id, { text: 'Yes, two ways to send.', at: iso(20_000) }]])).file
    expect(threadsTidyOf(f, T0 + MIN)?.items).toEqual([expect.objectContaining({ id: f.threads[0].id, why: 'summary' })])
    f = updateThread(f, f.threads[0].id, { reply: 'Yes: a big Send button, or press again.' }, 'task:vp', iso(30_000)).file
    expect(threadsTidyOf(f, T0 + MIN)).toBeNull()
  })
})

describe('5. his message outdates the summary until the node rewrites it', () => {
  // 2026-11-08, the user, twice: "I already replied, but this thread is not updated at all"; "Walnut
  // needs to make sure it doesn't happen".
  const answered = () => {
    let f = fileMessage(emptyThreads('vp'), { text: 'is it you?', via: 'chat', at: iso(0) }).file
    const id = f.threads[0].id
    f = updateThread(f, id, { title: 'Is it you?', reply: 'Is it you on the home PC?', state: 'needs', user_kind: 'user_info', user_kind_why: 'Only he knows who sits at that PC' }, 'task:vp', iso(MIN)).file
    return { f, id }
  }

  it('his message in the thread marks the summary stale on the card and in the reminder, first', () => {
    const { f, id } = answered()
    expect(summaryBehindHim(f.threads[0])).toBe(false)
    const replied = fileMessage(f, { text: 'yes, it is me', via: 'follow-up', threadId: id, at: iso(2 * MIN) }).file
    const t = replied.threads[0]
    expect(summaryBehindHim(t)).toBe(true)
    expect(cardView(t).summary).toMatchObject({ by: 'node', stale: true })
    // Listed first in the threads-tidy line, ahead of other reasons.
    let other = openThread(replied, { title: 'A mail', text: 'Reply to the organizer', from: 'mail', state: 'answered' }, 'task:vp', iso(0)).file
    other = fileMessage(other, { text: 'ok', via: 'chat', at: iso(3 * MIN) }).file
    const tidy = threadsTidyOf(other, T0 + 4 * MIN)!
    const whys = tidy.items.map((i) => i.why)
    expect(tidy.items.filter((i) => i.why === 'summary').map((i) => i.id)).toContain(id)
    // Every stale summary is listed ahead of any other reason.
    expect(whys.slice(0, whys.filter((w) => w === 'summary').length).every((w) => w === 'summary')).toBe(true)
    expect(staleSummaries(other.threads, T0 + 4 * MIN).map((x) => x.id)).toContain(id)
    expect(staleSummaryReason([t])).toContain(`${id} "Is it you?": its summary is older than his message`)
    // The node rewrites it: no longer stale, off the reminder and the stop check.
    const fixed = updateThread(replied, id, { reply: 'It is you: the team starts the read-only check now.', state: 'answered' }, 'task:vp', iso(3 * MIN)).file
    expect(summaryBehindHim(fixed.threads[0])).toBe(false)
    expect(cardView(fixed.threads[0]).summary.stale).toBeUndefined()
    expect(staleSummaries(fixed.threads, T0 + 4 * MIN)).toEqual([])
  })

  it('a state-only write does not make it current; pending, snoozed and closed threads are not held', () => {
    const { f, id } = answered()
    let g = fileMessage(f, { text: 'yes', via: 'follow-up', threadId: id, at: iso(2 * MIN) }).file
    g = updateThread(g, id, { state: 'answered' }, 'task:vp', iso(3 * MIN)).file
    expect(summaryBehindHim(g.threads[0])).toBe(true)
    expect(staleSummaries(updateThread(g, id, { state: 'pending' }, 'task:vp', iso(4 * MIN)).file.threads, T0 + 5 * MIN)).toEqual([])
    expect(staleSummaries(updateThread(g, id, { snooze: iso(60 * MIN) }, 'human', iso(4 * MIN)).file.threads, T0 + 5 * MIN)).toEqual([])
  })

  it('a legacy summary he answered stays stale through a state-only write (review 2026-11-08)', () => {
    // His reply was filed by an older build (no replyAt, he the last writer); the node then only sets a state.
    let f = { version: 1 as const, taskId: 'vp', threads: [thread({ id: 'th-1', state: 'needs', reply: 'Is it you?', by: 'human', updatedAt: iso(2 * MIN),
      messages: [msg('tm-1', 0, { atMs: MIN, text: 'Is it you?' }), { id: 'tm-2', at: iso(2 * MIN), text: 'Yes, it is me', via: 'follow-up' }] }) as never] }
    expect(summaryBehindHim(f.threads[0] as never)).toBe(true)
    f = updateThread(stampLegacyReplyAt(f as never), 'th-1', { state: 'answered' }, 'task:vp', iso(3 * MIN)).file as never
    expect((f.threads[0] as any).replyAt).toBe(iso(MIN))
    expect(summaryBehindHim(f.threads[0] as never)).toBe(true)
    expect(cardView(f.threads[0] as never).summary).toMatchObject({ text: 'Is it you?', stale: true })
    // The node was the last writer: its last change is the summary's time, once.
    const nodeLast = stampLegacyReplyAt({ version: 1, taskId: 'vp', threads: [thread({ id: 'th-2', reply: 'Done.', by: 'task:vp', updatedAt: iso(4 * MIN) }) as never] } as never)
    expect((nodeLast.threads[0] as any).replyAt).toBe(iso(4 * MIN))
    expect(stampLegacyReplyAt(nodeLast)).toBe(nodeLast)
  })
})
