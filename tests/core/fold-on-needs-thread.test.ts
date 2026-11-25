/**
 * A teammate's ask folded under a decision stays folded when the decision moves to a needs thread
 * of its holder, and his answer on that thread settles it (experiment threads_reply_tag;
 * src/core/org/thread-held-decision.ts; review 2026-11-25: the holder's report stopped asking the
 * decision once its card line put it on a thread, the teammate's ask came back, one decision twice,
 * and his answer on the thread reached only the holder).
 *
 * The real statusOf runs pass after pass as the sync does, for every source a fold takes
 * (FOLDABLE_SOURCES), and for a session's ask both ways it folds: by its words and by an explicit
 * decision_owner pointer. A new foldable source fails here until it has a case.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { childrenByParent, completeStatusFacts, statusOf, type StatusFacts } from '../../src/core/user-status-sync.js'
import { askKey, FOLDABLE_SOURCES } from '../../src/core/same-ask.js'
import { setReplyTag } from '../../src/core/org/reply-card-switch.js'
import { decisionOnThread, type HolderThreads } from '../../src/core/org/thread-held-decision.js'
import type { Task } from '../../src/core/types.js'

const ASK = 'Should the orchard fence be two metres tall or three?'
/** The same decision as the holder's card line put it on its thread, in other words. */
const ON_THREAD = 'Two metres or three for the orchard fence?'
const D = 'ask-fe4ce001'
const T0 = '2026-11-25T09:00:00.000Z'
const ASKED = '2026-11-25T09:30:00.000Z'
const NOW = Date.parse('2026-11-25T10:00:00.000Z')
const REPLIED = '2026-11-25T10:20:00.000Z'
const LATER = NOW + 60 * 60_000

const own = { kind: 'user_own' as const, why: 'He decides the fence' }

function base(id: string, extra: Partial<Task>): Task {
  return { id, title: `Task ${id}`, phase: 'NEED_ACTION', project: 'Orchard', status: 'todo', phase_changed_at: T0, session_id: `sid-${id}`, ...extra } as Task
}
const lead = base('lead', { org_role: 'lead', phase: 'IN_PROGRESS', session_id: undefined })
/** The holder: its report asks the decision; older than its teammate, so it shows it. */
const holder = (): Task => base('holder', { created_at: '2026-11-01T00:00:00.000Z', threads_on: true,
  status_report: { state: 'needs', ask: ASK, ask_id: D, ask_own: own, at: ASKED, rule: 2 } })
/** The holder once its card line put the decision on its thread (thread-report-ask.ts askNowOnThread). */
const moved = (t: Task): Task => ({ ...t, status_report: { state: 'needs', at: ASKED, rule: 2, last_ask: { id: D, ask: ASK, at: ASKED } } })

/** The teammate, by the source its ask comes from; a session's ask both ways it folds. */
const TEAMMATES: Record<string, { source: string; make: () => Task; facts?: (f: StatusFacts) => void }> = {
  'session (its words)': { source: 'session', make: () => base('mate', { created_at: '2026-11-02T00:00:00.000Z',
    status_report: { state: 'needs', ask: ASK, ask_own: own, at: ASKED, rule: 2 } }) },
  'session (decision_owner)': { source: 'session', make: () => base('mate', { created_at: '2026-11-02T00:00:00.000Z',
    status_report: { state: 'needs', ask: 'Confirm the fence height decision the holder owns?', ask_own: own, at: ASKED, rule: 2,
      same_as: 'holder', decision_owner: { taskId: 'holder', decisionId: D, askKey: askKey(ASK) } } }) },
  'choice': { source: 'choice', make: () => base('mate', { created_at: '2026-11-02T00:00:00.000Z', phase: 'IN_PROGRESS', session_id: undefined }),
    facts: (f) => f.choices.set('mate', [{ title: ASK, board: 'mate', id: 'ch-fe4ce001', at: ASKED }]) },
}

interface World { held?: HolderThreads; heAt?: string }

function facts(tasks: readonly Task[], world: World, extra?: (f: StatusFacts) => void): StatusFacts {
  const f: StatusFacts = { sessions: new Map(), letters: new Map(), choices: new Map(), requestsFrom: new Map(), triggers: new Map(), schedules: new Map(), titles: new Map(), sessionsOf: new Map() }
  for (const t of tasks) if (t.session_id) { f.sessions.set(t.session_id, { processStatus: 'idle', taskId: t.id, startedAt: T0 }); f.sessionsOf.set(t.id, [t.session_id]) }
  extra?.(f)
  completeStatusFacts(f, tasks)
  // What readFoldEvidence reads: the holder's needs thread, and his message on it.
  f.personInputAt = new Map(world.heAt ? [['holder', world.heAt]] : [])
  f.holderThreads = new Map(world.held ? [['holder', world.held]] : [])
  if (world.held?.asks.length) f.threads = new Map([['holder', { shown: 1, needs: 1, title: 'Orchard fence height', id: 'th-fe4ce001' }]])
  return f
}

function settle(start: readonly Task[], world: World, nowMs: number, extra?: (f: StatusFacts) => void): Task[] {
  let tasks = start.map((t) => ({ ...t }))
  for (let pass = 0; pass < 12; pass++) {
    const f = facts(tasks, world, extra)
    const kids = childrenByParent(tasks)
    const next = tasks.map((t) => ({ ...t, user_status: statusOf(t, f, kids, nowMs).status }))
    const moved = next.some((t, i) => JSON.stringify(t.user_status) !== JSON.stringify(tasks[i]!.user_status))
    tasks = next
    if (!moved) return tasks
  }
  throw new Error('the statuses never settled')
}
const of = (tasks: readonly Task[], id: string) => tasks.find((t) => t.id === id)!

afterEach(() => setReplyTag(false))

describe('a fold under a decision its holder put on a needs thread', () => {
  it('every foldable source has a case here', () => {
    expect([...new Set(Object.values(TEAMMATES).map((c) => c.source))].sort()).toEqual([...FOLDABLE_SOURCES].sort())
  })

  for (const [name, mate] of Object.entries(TEAMMATES)) {
    it(`${name}: stays folded while the thread asks it, and his answer there settles it`, () => {
      setReplyTag(true)
      // Folded under the holder's own ask.
      let tasks = settle([lead, holder(), mate.make()], {}, NOW, mate.facts)
      expect(of(tasks, 'holder').user_status).toMatchObject({ state: 'needs', ask: ASK })
      expect(of(tasks, 'mate').user_status).toMatchObject({ state: 'waiting', sameAsk: { id: 'holder' } })
      expect(of(tasks, 'mate').user_status?.sameAsk?.answered).toBeUndefined()

      // The holder's card line put it on its thread: its report asks nothing of its own now.
      tasks = tasks.map((t) => (t.id === 'holder' ? moved(t) : t))
      tasks = settle(tasks, { held: { asks: [ON_THREAD] } }, NOW + 60_000, mate.facts)
      expect(of(tasks, 'holder').user_status).toMatchObject({ state: 'needs', source: 'thread' })
      expect(of(tasks, 'mate').user_status, 'the teammate shows the decision a second time').toMatchObject({ state: 'waiting', sameAsk: { id: 'holder' } })
      expect(of(tasks, 'mate').user_status?.sameAsk?.answered).toBeUndefined()
      expect(tasks.filter((t) => t.user_status?.state === 'needs').map((t) => t.id)).toEqual(['holder'])

      // He answers on the thread; the thread asks no more: the fold reads answered, as after his answer in the holder's chat.
      tasks = settle(tasks, { held: { asks: [], heAt: REPLIED }, heAt: REPLIED }, LATER, mate.facts)
      expect(of(tasks, 'mate').user_status).toMatchObject({ state: 'waiting', sameAsk: { id: 'holder', answered: true } })
      expect(tasks.filter((t) => t.user_status?.state === 'needs').map((t) => t.id)).not.toContain('mate')
    })
  }

  it('the thread asking another decision holds nothing: the teammate\'s ask shows again', () => {
    setReplyTag(true)
    const mate = TEAMMATES['session (its words)']!
    let tasks = settle([lead, holder(), mate.make()], {}, NOW)
    tasks = tasks.map((t) => (t.id === 'holder' ? moved(t) : t))
    tasks = settle(tasks, { held: { asks: ['Which gate colour, green or brown?'] } }, NOW + 60_000)
    expect(of(tasks, 'mate').user_status).toMatchObject({ state: 'needs', ask: ASK })
  })

  it('with the experiment off nothing is read as held on a thread', () => {
    const t = moved(holder())
    expect(decisionOnThread(t, { asks: [ON_THREAD] })).toBeNull()
    setReplyTag(true)
    expect(decisionOnThread(t, { asks: [ON_THREAD] })).toMatchObject({ id: D })
    // A report that asks something now holds that, not the memory.
    expect(decisionOnThread(holder(), { asks: [ON_THREAD] })).toBeNull()
  })
})
