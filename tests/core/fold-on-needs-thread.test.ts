/**
 * A teammate's ask folded under a decision stays folded while a needs thread of its holder carries
 * that decision, and his answer on THAT thread settles it (experiment threads_reply_tag;
 * src/core/org/thread-held-decision.ts; reviews 2026-11-25).
 *
 *  - The report asked it first and a card line moved it to a thread (the first review: the
 *    teammate's ask came back, one decision twice).
 *  - B1: a card line put it on a thread and the report never asked it; and the holder's report
 *    asks another decision of the same subject while the thread still carries the first one. The
 *    holder was not foldable (status source `thread`), a same_as pointer bound to nothing, and the
 *    fold came apart.
 *  - B2: a thread asking ANOTHER decision of the same subject holds nothing: the teammate's ask
 *    stays visible. Shared words were enough before ("two metres tall or three" and "the gate green
 *    or brown").
 *  - C5: his message on another thread of the holder is no answer to it.
 *
 * The real statusOf runs pass after pass as the sync does, and the real readFoldEvidence reads the
 * holder's stored threads (the store's read is the test's world), for every source a fold takes
 * (FOLDABLE_SOURCES) and for a session's ask both ways it folds: by its words and by an explicit
 * decision_owner pointer. A new foldable source fails here until it has a case.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-fold-on-needs-thread'))
/** The holder's threads as the store holds them. */
const world = vi.hoisted(() => ({ threads: new Map<string, unknown[]>() }))
vi.mock('../../src/core/org/threads-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/org/threads-store.js')>()),
  readThreads: async (taskId: string) => ({ version: 1, taskId, threads: structuredClone(world.threads.get(taskId) ?? []) }),
}))

import { _dropNodeThreadsForTesting, childrenByParent, completeStatusFacts, readFoldEvidence, statusOf, type StatusFacts } from '../../src/core/user-status-sync.js'
import { askKey, FOLDABLE_SOURCES } from '../../src/core/same-ask.js'
import { setReplyTag } from '../../src/core/org/reply-card-switch.js'
import { bindDecisionOwnerNow } from '../../src/core/decision-owner.js'
import { cardDecisionId } from '../../src/core/org/thread-report-ask.js'
import { keepThreadDecisions } from '../../src/core/org/thread-popup-rules.js'
import type { OrgThread, ThreadMessage } from '../../src/core/org/threads-model.js'
import type { Task } from '../../src/core/types.js'

const D = 'ask-fe4ce001'
const D_OTHER = 'ask-fe4ce0b2'
const T0 = '2026-11-25T09:00:00.000Z'
const ASKED = '2026-11-25T09:30:00.000Z'
const NOW = Date.parse('2026-11-25T10:00:00.000Z')
const REPLIED = '2026-11-25T10:20:00.000Z'
const LATER = NOW + 60 * 60_000
const TH = 'th-fe4ce001'
const TH_B = 'th-fe4ce002'

/** One subject: the decision, the same decision as a card line rewords it, another decision of that subject. */
interface Subject { ask: string; onThread: string; other: string }
const EN: Subject = {
  ask: 'Should the orchard fence be two metres tall or three?',
  onThread: 'Two metres or three for the orchard fence?',
  other: 'Should the orchard fence gate be painted green or brown?',
}
/** The same in Chinese: turn the sync toggle on by default; the same reworded; shorten the toggle's description. */
const ZH: Subject = {
  ask: '\u8981\u4e0d\u8981\u628a\u540c\u6b65\u5f00\u5173\u9ed8\u8ba4\u6253\u5f00\uff1f',
  onThread: '\u540c\u6b65\u5f00\u5173\u8981\u4e0d\u8981\u9ed8\u8ba4\u6253\u5f00\u5462\uff1f',
  other: '\u8981\u4e0d\u8981\u628a\u540c\u6b65\u5f00\u5173\u7684\u8bf4\u660e\u6539\u77ed\uff1f',
}

const own = { kind: 'user_own' as const, why: 'He decides the fence' }

function base(id: string, extra: Partial<Task>): Task {
  return { id, title: `Task ${id}`, phase: 'NEED_ACTION', project: 'Orchard', status: 'todo', phase_changed_at: T0, session_id: `sid-${id}`, ...extra } as Task
}
const lead = base('lead', { org_role: 'lead', phase: 'IN_PROGRESS', session_id: undefined })
/** The holder: older than its teammate, so it shows the decision; its report asks `ask` (`id`), or nothing. */
const holder = (ask?: string, id = D): Task => base('holder', { created_at: '2026-11-01T00:00:00.000Z', threads_on: true,
  status_report: ask ? { state: 'needs', ask, ask_id: id, ask_own: own, at: ASKED, rule: 2 } : { state: 'needs', at: ASKED, rule: 2 } })
/** The holder once its decision moved to its thread (thread-report-ask.ts askNowOnThread): remembered as last_ask. */
const moved = (t: Task, ask: string): Task => ({ ...t, status_report: { state: 'needs', at: ASKED, rule: 2, last_ask: { id: D, ask, at: ASKED } } })

/** The teammate, by the source its ask comes from; a session's ask both ways it folds. */
const TEAMMATES: Record<string, { source: string; make: (ask: string, decision?: string) => Task; facts?: (ask: string) => (f: StatusFacts) => void }> = {
  'session (its words)': { source: 'session', make: (ask) => base('mate', { created_at: '2026-11-02T00:00:00.000Z',
    status_report: { state: 'needs', ask, ask_own: own, at: ASKED, rule: 2 } }) },
  'session (decision_owner)': { source: 'session', make: (ask, decision = D) => base('mate', { created_at: '2026-11-02T00:00:00.000Z',
    status_report: { state: 'needs', ask: 'Confirm the decision the holder owns?', ask_own: own, at: ASKED, rule: 2,
      same_as: 'holder', decision_owner: { taskId: 'holder', decisionId: decision, askKey: askKey(ask) } } }) },
  'choice': { source: 'choice', make: () => base('mate', { created_at: '2026-11-02T00:00:00.000Z', phase: 'IN_PROGRESS', session_id: undefined }),
    facts: (ask) => (f) => f.choices.set('mate', [{ title: ask, board: 'mate', id: 'ch-fe4ce001', at: ASKED }]) },
}

function thread(id: string, extra: Partial<OrgThread>): OrgThread {
  return { id, title: 'Orchard fence', state: 'working', messages: [], createdAt: T0, updatedAt: T0, ...extra } as OrgThread
}
/** His own message on a thread (no delivery mark: typed by him). */
const his = (at: string, n = 1): ThreadMessage => ({ id: `tm-fe4ce00${n}`, at, text: 'Two metres.', via: 'chat' })
const holderThreads = (...threads: OrgThread[]) => world.threads.set('holder', threads)

async function facts(tasks: readonly Task[], extra?: (f: StatusFacts) => void): Promise<StatusFacts> {
  const f: StatusFacts = { sessions: new Map(), letters: new Map(), choices: new Map(), requestsFrom: new Map(), triggers: new Map(), schedules: new Map(), titles: new Map(), sessionsOf: new Map() }
  for (const t of tasks) if (t.session_id) { f.sessions.set(t.session_id, { processStatus: 'idle', taskId: t.id, startedAt: T0 }); f.sessionsOf.set(t.id, [t.session_id]) }
  extra?.(f)
  completeStatusFacts(f, tasks)
  // The real read of the holders' threads (each pass reads the world as it is now).
  _dropNodeThreadsForTesting()
  await readFoldEvidence(f, tasks.filter((t) => t.phase !== 'COMPLETE'))
  // What the holder's Threads count: its needs threads make its status Needs you through a thread.
  const open = ((world.threads.get('holder') ?? []) as OrgThread[]).filter((t) => t.state === 'needs' && !t.closed)
  if (open.length) f.threads = new Map([['holder', { shown: open.length, needs: open.length, title: open[0]!.title, id: open[0]!.id }]])
  return f
}

async function settle(start: readonly Task[], nowMs: number, extra?: (f: StatusFacts) => void): Promise<Task[]> {
  let tasks = start.map((t) => ({ ...t }))
  for (let pass = 0; pass < 12; pass++) {
    const f = await facts(tasks, extra)
    const kids = childrenByParent(tasks)
    const next = tasks.map((t) => ({ ...t, user_status: statusOf(t, f, kids, nowMs).status }))
    const changed = next.some((t, i) => JSON.stringify(t.user_status) !== JSON.stringify(tasks[i]!.user_status))
    tasks = next
    if (!changed) return tasks
  }
  throw new Error('the statuses never settled')
}
const of = (tasks: readonly Task[], id: string) => tasks.find((t) => t.id === id)!
const needsYou = (tasks: readonly Task[]) => tasks.filter((t) => t.user_status?.state === 'needs').map((t) => t.id)
const swap = (tasks: readonly Task[], next: (t: Task) => Task) => tasks.map((t) => (t.id === 'holder' ? next(t) : t))

/** The teammate folded under the holder's report ask of `s.ask` (decision D), with no thread yet. */
async function foldedFirst(name: string, s: Subject): Promise<Task[]> {
  const mate = TEAMMATES[name]!
  holderThreads()
  const tasks = await settle([lead, holder(s.ask), mate.make(s.ask)], NOW, mate.facts?.(s.ask))
  expect(of(tasks, 'holder').user_status).toMatchObject({ state: 'needs', ask: s.ask })
  expect(of(tasks, 'mate').user_status).toMatchObject({ state: 'waiting', sameAsk: { id: 'holder', decision: D } })
  return tasks
}

afterEach(() => { setReplyTag(false); world.threads.clear() })

describe('a fold under a decision its holder carries on a needs thread', () => {
  it('every foldable source has a case here', () => {
    expect([...new Set(Object.values(TEAMMATES).map((c) => c.source))].sort()).toEqual([...FOLDABLE_SOURCES].sort())
  })

  for (const [name, mate] of Object.entries(TEAMMATES)) {
    it(`${name}: the report asked it first; reworded on the thread under its id, it stays folded, and his answer there settles it`, async () => {
      setReplyTag(true)
      let tasks = await foldedFirst(name, EN)
      // The card line put it on its thread under the report's id (cardDecisionId), the report asks nothing of its own now.
      tasks = swap(tasks, (t) => moved(t, EN.ask))
      holderThreads(thread(TH, { state: 'needs', ask: EN.onThread, askId: D }))
      tasks = await settle(tasks, NOW + 60_000, mate.facts?.(EN.ask))
      expect(of(tasks, 'holder').user_status).toMatchObject({ state: 'needs', source: 'thread' })
      expect(of(tasks, 'mate').user_status, 'the teammate shows the decision a second time').toMatchObject({ state: 'waiting', sameAsk: { id: 'holder' } })
      expect(of(tasks, 'mate').user_status?.sameAsk?.answered).toBeUndefined()
      expect(needsYou(tasks)).toEqual(['holder'])

      // He answers on that thread; it asks no more: the fold reads answered, as after his answer in the holder's chat.
      holderThreads(thread(TH, { state: 'working', ask: EN.onThread, askId: D, messages: [his(REPLIED)] }))
      tasks = await settle(tasks, LATER, mate.facts?.(EN.ask))
      expect(of(tasks, 'mate').user_status).toMatchObject({ state: 'waiting', sameAsk: { id: 'holder', answered: true } })
      expect(needsYou(tasks)).not.toContain('mate')
    })

    it(`${name}: B1, a card line put it on the thread and the report never asked it: the teammate's same ask folds under the thread`, async () => {
      setReplyTag(true)
      const D1 = 'ask-fe4ce0c1'
      holderThreads(thread(TH, { state: 'needs', ask: EN.ask, askId: D1 }))
      let tasks = await settle([lead, holder(), mate.make(EN.ask, D1)], NOW, mate.facts?.(EN.ask))
      expect(of(tasks, 'holder').user_status).toMatchObject({ state: 'needs', source: 'thread' })
      expect(of(tasks, 'mate').user_status, 'one decision on two cards').toMatchObject({ state: 'waiting', sameAsk: { id: 'holder', ask: EN.ask } })
      expect(needsYou(tasks)).toEqual(['holder'])

      holderThreads(thread(TH, { state: 'working', ask: EN.ask, askId: D1, messages: [his(REPLIED)] }))
      tasks = await settle(tasks, LATER, mate.facts?.(EN.ask))
      expect(of(tasks, 'mate').user_status).toMatchObject({ state: 'waiting', sameAsk: { id: 'holder', answered: true } })
    })

    for (const [lang, s] of [['English', EN], ['Chinese', ZH]] as const) {
      it(`${name}: B1, the holder's report then asks another decision of the same subject (${lang}): the fold on the first holds`, async () => {
        setReplyTag(true)
        let tasks = await foldedFirst(name, s)
        tasks = swap(tasks, (t) => moved(t, s.ask))
        holderThreads(thread(TH, { state: 'needs', ask: s.onThread, askId: D }))
        tasks = await settle(tasks, NOW + 60_000, mate.facts?.(s.ask))
        // Its report asks a second decision of that subject, its own one now.
        tasks = swap(tasks, (t) => ({ ...t, status_report: { state: 'needs', ask: s.other, ask_id: D_OTHER, ask_own: own, at: '2026-11-25T10:05:00.000Z', rule: 2 } }))
        tasks = await settle(tasks, NOW + 6 * 60_000, mate.facts?.(s.ask))
        expect(of(tasks, 'holder').user_status).toMatchObject({ state: 'needs', ask: s.other })
        expect(of(tasks, 'mate').user_status, 'the first decision shows a second time').toMatchObject({ state: 'waiting', sameAsk: { id: 'holder' } })
        expect(of(tasks, 'mate').user_status?.sameAsk?.answered).toBeUndefined()
        expect(needsYou(tasks)).toEqual(['holder'])
      })
    }
  }

  // B2: the reviewer's pairs, each two decisions of one subject.
  const PAIRS: Array<[string, string]> = [
    [EN.ask, EN.other],
    ['Turn the sync toggle on by default?', 'Shorten the sync toggle description?'],
    [ZH.ask, ZH.other],
  ]
  for (const [name, mate] of Object.entries(TEAMMATES)) {
    for (const [first, second] of PAIRS) {
      it(`${name}: B2, the thread asks another decision of the subject (${JSON.stringify(second).slice(0, 40)}): the teammate's ask is not folded under it`, async () => {
        setReplyTag(true)
        let tasks = await foldedFirst(name, { ask: first, onThread: first, other: second })
        tasks = swap(tasks, (t) => moved(t, first))
        // The card line's id for it: a new decision, never the report's (cardDecisionId).
        const id = cardDecisionId(undefined, { ask: second }, of(tasks, 'holder').status_report)
        expect(id).not.toBe(D)
        for (const askId of [id, undefined]) {
          holderThreads(thread(TH, { state: 'needs', ask: second, ...(askId ? { askId } : {}) }))
          const now = await settle(tasks, NOW + 60_000, mate.facts?.(first))
          expect(of(now, 'mate').user_status, `thread id ${askId}: a different decision folded away`).toMatchObject({ state: 'needs' })
          expect(of(now, 'mate').user_status?.sameAsk).toBeUndefined()
        }
      })
    }
  }

  it('B2: the same question with no id on the thread (an older build wrote it) still folds by the strict rule (the same content words)', async () => {
    setReplyTag(true)
    let tasks = await foldedFirst('session (its words)', EN)
    tasks = swap(tasks, (t) => moved(t, EN.ask))
    holderThreads(thread(TH, { state: 'needs', ask: 'Orchard fence: two metres tall, or three?' }))
    tasks = await settle(tasks, NOW + 60_000)
    expect(of(tasks, 'mate').user_status).toMatchObject({ state: 'waiting', sameAsk: { id: 'holder' } })
  })

  it('N1: the thread, still in needs, asks another question: the teammate shows his decision again, and the answer to the other is no answer to his', async () => {
    setReplyTag(true)
    let tasks = await foldedFirst('session (its words)', EN)
    tasks = swap(tasks, (t) => moved(t, EN.ask))
    const onThread = thread(TH, { state: 'needs', ask: EN.onThread, askId: D })
    holderThreads(onThread)
    tasks = await settle(tasks, NOW + 60_000)
    expect(of(tasks, 'mate').user_status).toMatchObject({ state: 'waiting', sameAsk: { id: 'holder' } })
    // A thread_update makes it ask the gate colour, staying in needs: the store's write judges its id again.
    const file = (threads: OrgThread[]) => ({ version: 1 as const, taskId: 'holder', threads })
    const gate = keepThreadDecisions(file([onThread]), file([{ ...onThread, ask: EN.other }])).threads[0]!
    expect(gate.askId).not.toBe(D)
    holderThreads(gate)
    tasks = await settle(tasks, NOW + 2 * 60_000)
    expect(of(tasks, 'mate').user_status, 'the fence height shows nowhere').toMatchObject({ state: 'needs', ask: EN.ask })
    // He answers the colour there; the thread leaves needs: the fence height is still unanswered.
    holderThreads({ ...gate, state: 'working', messages: [his(REPLIED)] })
    tasks = await settle(tasks, LATER)
    expect(of(tasks, 'mate').user_status?.sameAsk?.answered).toBeUndefined()
    expect(of(tasks, 'mate').user_status).toMatchObject({ state: 'needs', ask: EN.ask })
  })

  it('C5: his message on another thread of the holder is no answer to it; on the thread that carried it, it is', async () => {
    setReplyTag(true)
    let tasks = await foldedFirst('session (its words)', EN)
    tasks = swap(tasks, (t) => moved(t, EN.ask))
    holderThreads(thread(TH, { state: 'needs', ask: EN.onThread, askId: D }), thread(TH_B, { title: 'Orchard gate', messages: [] }))
    tasks = await settle(tasks, NOW + 60_000)
    expect(of(tasks, 'mate').user_status).toMatchObject({ state: 'waiting', sameAsk: { id: 'holder' } })
    // The node takes the decision off its thread; he wrote only about the gate.
    holderThreads(thread(TH, { state: 'working', ask: EN.onThread, askId: D }), thread(TH_B, { title: 'Orchard gate', messages: [his(REPLIED, 2)] }))
    const elsewhere = await settle(tasks, LATER)
    expect(of(elsewhere, 'mate').user_status?.sameAsk?.answered).toBeUndefined()
    expect(of(elsewhere, 'mate').user_status).toMatchObject({ state: 'needs', ask: EN.ask })
    holderThreads(thread(TH, { state: 'working', ask: EN.onThread, askId: D, messages: [his(REPLIED)] }), thread(TH_B, { title: 'Orchard gate' }))
    const there = await settle(tasks, LATER)
    expect(of(there, 'mate').user_status).toMatchObject({ state: 'waiting', sameAsk: { id: 'holder', answered: true } })
  })

  it('B1 through same_as: a pointer to a holder whose decision is only on its thread binds to it, also while its report asks another', async () => {
    setReplyTag(true)
    const D1 = 'ask-fe4ce0c1'
    const mate = base('mate', { created_at: '2026-11-02T00:00:00.000Z' })
    const report = { state: 'needs' as const, ask: EN.ask, at: ASKED, rule: 2 as const, same_as: 'holder' }
    holderThreads(thread(TH, { state: 'needs', ask: EN.ask, askId: D1 }))
    let tasks = await settle([lead, holder(), mate], NOW)
    expect((await bindDecisionOwnerNow(mate, report, tasks))?.decision_owner).toEqual({ taskId: 'holder', decisionId: D1, askKey: askKey(EN.ask) })
    // Its report asks another decision of the subject now: the words name the thread's.
    tasks = swap(tasks, (t) => ({ ...t, status_report: { state: 'needs', ask: EN.other, ask_id: D_OTHER, ask_own: own, at: ASKED, rule: 2 } }))
    tasks = await settle(tasks, NOW)
    expect((await bindDecisionOwnerNow(mate, report, tasks))?.decision_owner?.decisionId).toBe(D1)
    expect((await bindDecisionOwnerNow(mate, { ...report, ask: EN.other }, tasks))?.decision_owner?.decisionId).toBe(D_OTHER)
  })

  it('with the experiment off nothing is read and no fold keeps a decision: as before', async () => {
    const mate = TEAMMATES['session (its words)']!
    holderThreads(thread(TH, { state: 'needs', ask: EN.ask, askId: 'ask-fe4ce0c1' }))
    const tasks = await settle([lead, holder(), mate.make(EN.ask)], NOW)
    expect(of(tasks, 'mate').user_status).toMatchObject({ state: 'needs', ask: EN.ask })
    const folded = await settle([lead, holder(EN.ask), mate.make(EN.ask)], NOW)
    expect(of(folded, 'mate').user_status).toMatchObject({ state: 'waiting', sameAsk: { id: 'holder' } })
    expect(of(folded, 'mate').user_status?.sameAsk).not.toHaveProperty('decision')
    const f = await facts(folded)
    expect(f.holderThreads?.size).toBe(0)
  })
})
