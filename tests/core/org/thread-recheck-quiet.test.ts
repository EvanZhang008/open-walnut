/**
 * Overdue-thread reminders wake a node only when someone must act (2026-11-23, the org reflection:
 * 51 "threads-overdue" notices in one night, 57 of their 64 lines a working thread the user could
 * not see, 48 of them a full turn that only said "still waiting"):
 *
 *   - a working thread with nothing for him waits for the node's next turn while its own work
 *     (a background command or subagent, a trigger, its wait clock) runs on and wakes it;
 *   - a repeat reminder of one thread with nothing new from him waits twice as long as the last.
 */
import { describe, it, expect } from 'vitest'
import { REPLY_DUE_MS, shownToHim } from '../../../src/core/org/thread-view.js'
import { normalizeThreads, type OrgThread } from '../../../src/core/org/threads-model.js'
import { wakingTriggers, type TriggerFact } from '../../../src/core/user-status-sync.js'
import {
  MAX_REPEAT_GAP_MS, nextRepeats, nodeCarriesOn, quietWorking, repeatGapMs, threadsDueRecheck,
} from '../../../src/core/org/thread-recheck.js'

const T0 = Date.parse('2026-11-23T04:00:00Z')
const MIN = 60_000
const iso = (ms: number) => new Date(T0 + ms).toISOString()
const NONE: ReadonlySet<string> = new Set()

/** A working thread: his ask, the node's answer he already read, then only the node's own writes. */
function quiet(over: Partial<OrgThread> = {}): OrgThread {
  return {
    id: 'th-374c86860fce', title: 'Fix the land queue', state: 'working', by: 'task:node', createdAt: iso(0), updatedAt: iso(5 * MIN),
    messages: [{ id: 'tm-000000000001', at: iso(0), text: 'land it please', via: 'chat', answer: { at: iso(MIN), text: 'On it.' }, readAt: iso(2 * MIN) }],
    ...over,
  } as OrgThread
}

describe('a working thread he cannot see, while the node\'s own work runs on', () => {
  it('is due a check with no work running, and not while work carries the node on', () => {
    const t = quiet()
    const now = T0 + 5 * MIN + REPLY_DUE_MS
    expect(shownToHim(t, new Set(), now)).toBe(false)
    const due = threadsDueRecheck([t], now)
    expect(due).toHaveLength(1)
    expect(quietWorking(due[0], new Set())).toBe(true)
    expect(threadsDueRecheck([t], now, [], { carriesOn: true })).toEqual([])
  })

  it('a thread with something for him is still due while work runs: his unanswered message, an answer he has not seen, a needs thread', () => {
    const now = T0 + 5 * MIN + REPLY_DUE_MS
    const unanswered = quiet({ id: 'th-aaaaaaaaaaa1', messages: [{ id: 'tm-000000000002', at: iso(0), text: 'and the phone?', via: 'chat' }] } as Partial<OrgThread>)
    const unseen = quiet({ id: 'th-aaaaaaaaaaa2', messages: [{ id: 'tm-000000000003', at: iso(0), text: 'status?', via: 'chat', answer: { at: iso(MIN), text: 'Half done.' } }] } as Partial<OrgThread>)
    const fresh = quiet({ id: 'th-aaaaaaaaaaa3', state: 'new' } as Partial<OrgThread>)
    const due = threadsDueRecheck([unanswered, unseen, fresh, quiet()], now, [], { carriesOn: true })
    expect(due.map((d) => d.thread.id).sort()).toEqual(['th-aaaaaaaaaaa1', 'th-aaaaaaaaaaa2', 'th-aaaaaaaaaaa3'])
  })

  it('the node carries on through a background command or subagent, a trigger, or its wait clock; nothing else', () => {
    const now = T0
    const working = { phase: 'IN_PROGRESS' as const, wait_until: undefined }
    expect(nodeCarriesOn(working, { outliving: ['background'], triggers: 0 }, now)).toBe('background')
    expect(nodeCarriesOn(working, { outliving: [], triggers: 1 }, now)).toBe('trigger')
    expect(nodeCarriesOn({ phase: 'WAITING', wait_until: iso(60 * MIN) } as never, { outliving: [], triggers: 0 }, now)).toBe('wait_until')
    expect(nodeCarriesOn({ phase: 'WAITING', wait_until: iso(-MIN) } as never, { outliving: [], triggers: 0 }, now)).toBeNull()
    expect(nodeCarriesOn(working, { outliving: [], triggers: 0 }, now)).toBeNull()
  })
})

describe('repeat reminders of one thread spread out', () => {
  it('each repeat with nothing new from him waits twice as long as the one before, at most 8 hours', () => {
    expect([1, 2, 3, 4, 5, 9].map(repeatGapMs)).toEqual([REPLY_DUE_MS * 2, REPLY_DUE_MS * 4, REPLY_DUE_MS * 8, MAX_REPEAT_GAP_MS, MAX_REPEAT_GAP_MS, MAX_REPEAT_GAP_MS])

    // The first reminder at 35 min; the node answers it with "still waiting" at 40 min (a new stretch).
    const firstAt = 35 * MIN
    let t = quiet({ updatedAt: iso(40 * MIN), recheck: { since: iso(5 * MIN), at: iso(firstAt), why: 'reply' } })
    // The old rule: due again 30 min after that write. Now: one hour after the last reminder.
    expect(threadsDueRecheck([t], T0 + 70 * MIN)).toEqual([])
    const second = threadsDueRecheck([t], T0 + firstAt + 60 * MIN)
    expect(second).toHaveLength(1)
    expect(nextRepeats(second[0].thread, second[0].overdue, NONE)).toBe(1)

    // Recorded as repeat 1; the node writes again; the third waits two hours.
    const secondAt = firstAt + 60 * MIN
    t = { ...t, updatedAt: iso(secondAt + 5 * MIN), recheck: { since: iso(40 * MIN), at: iso(secondAt), why: 'reply', repeats: 1 } }
    expect(threadsDueRecheck([t], T0 + secondAt + 119 * MIN)).toEqual([])
    const third = threadsDueRecheck([t], T0 + secondAt + 120 * MIN)
    expect(third).toHaveLength(1)
    expect(nextRepeats(third[0].thread, third[0].overdue, NONE)).toBe(2)
  })

  it('a new message from him starts the count again (his unanswered message keeps the plain clock); a retry of an undelivered reminder keeps it', () => {
    const t = quiet({
      updatedAt: iso(40 * MIN),
      recheck: { since: iso(5 * MIN), at: iso(35 * MIN), why: 'reply', repeats: 3 },
      messages: [
        { id: 'tm-000000000001', at: iso(0), text: 'land it please', via: 'chat', answer: { at: iso(MIN), text: 'On it.' }, readAt: iso(2 * MIN) },
        { id: 'tm-000000000004', at: iso(38 * MIN), text: 'any news?', via: 'chat' },
      ],
    } as Partial<OrgThread>)
    const due = threadsDueRecheck([t], T0 + 70 * MIN)
    expect(due).toHaveLength(1)
    expect(nextRepeats(due[0].thread, due[0].overdue, NONE)).toBe(0)
    const pending = quiet({ updatedAt: iso(40 * MIN), recheck: { since: iso(40 * MIN), at: iso(70 * MIN), why: 'reply', repeats: 2, pending: true } })
    const retry = threadsDueRecheck([pending], T0 + 70 * MIN + 10 * MIN)
    expect(retry).toHaveLength(1)
    expect(nextRepeats(retry[0].thread, retry[0].overdue, NONE)).toBe(2)
  })
})

describe('only what will really wake the node counts, and no fact silences a thread for good', () => {
  const task = { recheck_watch: [], phase_changed_at: iso(30 * MIN), status_report: undefined } as never
  const awake = (list: TriggerFact[], workEndedMs: number | undefined, anyRunning = false) => wakingTriggers(task, list, { anyRunning, workEndedMs }).map((t) => t.id)

  it('an outside watch counts; an own-work watch only while its work is in flight; a spent one-shot does not', () => {
    const outside: TriggerFact = { id: 'trg-review', name: 'review', fires: 0 }
    // The Mac queue's own-work watch: armed until the task completes, its last check after the work ended said idle.
    const idleOwn: TriggerFact = { id: 'trg-queue', name: 'queue', ownWork: true, lastCheck: { idle: true, atMs: T0 + 20 * MIN } }
    const busyOwn: TriggerFact = { id: 'trg-queue2', name: 'queue', ownWork: true }
    // Fired once at 10 min; a turn took it (the phase moved at 30 min) and no report spoke since.
    const spent: TriggerFact = { id: 'trg-once', name: 'once', fires: 1, firedAtMs: T0 + 10 * MIN }
    expect(awake([outside, idleOwn, busyOwn, spent], T0 + 10 * MIN)).toEqual(['trg-review', 'trg-queue2'])
    // While a turn runs a one-shot still stands; an idle mark from before the work ended does not count.
    expect(awake([spent], T0, true)).toEqual(['trg-once'])
    expect(awake([idleOwn], T0 + 25 * MIN)).toEqual(['trg-queue'])
  })

  it('a quiet working thread is due anyway once MAX_REPEAT_GAP_MS passed since its last reminder or this stretch fell due, work or no work', () => {
    // Reminded at 35 min; the node wrote at 40 min, so this stretch fell due at 40 min + REPLY_DUE_MS.
    const t = quiet({ updatedAt: iso(40 * MIN), recheck: { since: iso(5 * MIN), at: iso(35 * MIN), why: 'reply', repeats: 4 } })
    const stretchDue = T0 + 40 * MIN + REPLY_DUE_MS
    expect(threadsDueRecheck([t], stretchDue + MAX_REPEAT_GAP_MS - MIN, [], { carriesOn: true })).toEqual([])
    expect(threadsDueRecheck([t], stretchDue + MAX_REPEAT_GAP_MS, [], { carriesOn: true })).toHaveLength(1)
    // Never reminded: counted from when it fell due.
    const never = quiet()
    const dueAt = T0 + 5 * MIN + REPLY_DUE_MS
    expect(threadsDueRecheck([never], dueAt + MAX_REPEAT_GAP_MS - MIN, [], { carriesOn: true })).toEqual([])
    expect(threadsDueRecheck([never], dueAt + MAX_REPEAT_GAP_MS, [], { carriesOn: true })).toHaveLength(1)
  })

  it('a reminder from an earlier stretch does not end the quiet: the 8h count starts when this stretch fell due', () => {
    // Reminded yesterday for an older stretch; the node wrote again today, so a new stretch fell due tonight.
    const day = 24 * 60 * MIN
    const t = quiet({ updatedAt: iso(day), recheck: { since: iso(5 * MIN), at: iso(35 * MIN), why: 'reply' } })
    const dueAt = T0 + day + REPLY_DUE_MS
    expect(threadsDueRecheck([t], dueAt + MIN)).toHaveLength(1)
    expect(threadsDueRecheck([t], dueAt + MIN, [], { carriesOn: true })).toEqual([])
    expect(threadsDueRecheck([t], dueAt + MAX_REPEAT_GAP_MS, [], { carriesOn: true })).toHaveLength(1)
  })

  it('a thread with something for him keeps the plain reply clock: no backoff', () => {
    // His message with no reply, a reminder 35 min in, the node's write at 40 min: due again at 70 min.
    const unanswered = quiet({
      updatedAt: iso(40 * MIN), recheck: { since: iso(5 * MIN), at: iso(35 * MIN), why: 'reply', repeats: 2 },
      messages: [{ id: 'tm-000000000005', at: iso(0), text: 'and the phone?', via: 'chat' }],
    } as Partial<OrgThread>)
    const due = threadsDueRecheck([unanswered], T0 + 70 * MIN)
    expect(due).toHaveLength(1)
    expect(nextRepeats(due[0].thread, due[0].overdue, NONE)).toBe(0)
    // An answer he has not seen: the same.
    const unseen = quiet({
      updatedAt: iso(40 * MIN), recheck: { since: iso(5 * MIN), at: iso(35 * MIN), why: 'reply', repeats: 2 },
      messages: [{ id: 'tm-000000000006', at: iso(0), text: 'status?', via: 'chat', answer: { at: iso(MIN), text: 'Half done.' } }],
    } as Partial<OrgThread>)
    expect(threadsDueRecheck([unseen], T0 + 70 * MIN)).toHaveLength(1)
  })

  it('a stored repeat count that is not a whole number of at least 0 reads as none', () => {
    const file = (repeats: unknown) => normalizeThreads({ version: 1, taskId: 'n', threads: [{ ...quiet(), recheck: { since: iso(0), at: iso(0), why: 'reply', repeats } }] } as never, 'n')
    for (const bad of [-1, 1.5, 'x', Number.NaN, Number.POSITIVE_INFINITY]) expect(file(bad).threads[0].recheck).not.toHaveProperty('repeats')
    expect(file(3).threads[0].recheck?.repeats).toBe(3)
  })
})
