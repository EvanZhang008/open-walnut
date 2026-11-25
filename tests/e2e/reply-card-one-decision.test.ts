/**
 * One decision is shown once (experiment threads_reply_tag; src/core/org/thread-report-ask.ts
 * needsThreadOf, askOnNeedsThread, askNowOnThread).
 *
 * 2026-11-25, a real session on an isolated Walnut: its reply put a decision on a thread with a
 * card line (the thread stored needs, with its buttons), and the status question after the turn
 * then got the same decision as the task's ask, in other words. Walnut kept that ask as the task's
 * own and placed it on another open thread, the one about the compost heap: one decision on two
 * cards and on the task's own item. The tests of that day asserted the thread's state and never
 * what the status answer did next, because their session answered "working".
 *
 * Here the session answers the status question the way the real one did, through the real turn end
 * (tests/helpers/reply-card-flow.ts: nothing called by hand), and each test reads what he reads:
 * the task's threads as his clients get them, and the task's own status. Both orders: the line
 * first and the status answer after, and the status ask first with a later line for it. With the
 * switch off, today's behaviour stays, shown on a thread a thread_update put in needs.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'
import { mockLocalDaemonReader } from '../helpers/mock-local-daemon-reader.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-reply-card-one-decision', { IS_EPHEMERAL: true }))
vi.mock('../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader())

import { getTask } from '../../src/core/task-manager.js'
import { readThreads } from '../../src/core/org/threads-store.js'
import type { OrgThread } from '../../src/core/org/threads-model.js'
import type { Task } from '../../src/core/types.js'
import { executeOp } from '../../src/ops/executor.js'
import { LOCAL_ORIGIN } from '../../src/lib/caller-origin.js'
import { cliTakes, filedUnder, flow, of, questionAfter, say, setTag, startFlow, stopFlow, turnEnds } from '../helpers/reply-card-flow.js'

const SID = '5e55104a-0000-4000-8000-0000000dec1d'
const SWITCHES = { threads_reminder: true, threads_one_card: true }
let taskId = ''

beforeAll(async () => {
  await startFlow({ sid: SID, title: 'Garden plan helper', project: 'Garden' })
  taskId = flow.taskId
}, 40_000)

afterAll(stopFlow)

/** The status answer of a session that asks him a decision, as the real one writes it. */
const asking = (ask: string, options: string): string => [
  'FOR_USER_STATE: needs-you',
  `FOR_USER_ASK: ${ask}`,
  'FOR_USER_ASK_OWN: spending: the dearer choice costs twice the budget he set',
  'FOR_USER_ASK_KIND: single',
  `FOR_USER_ASK_OPTIONS: ${options}`,
  'FOR_USER_NOW: The choice is laid out for him.',
  'FOR_USER_NEXT: He picks, then I order.',
].join('\n')
const WORKING = 'FOR_USER_STATE: working\nFOR_USER_NOW: Planning the garden.'

type Shown = OrgThread & { heldAsk?: { id: string; ask: string } }
/** His Threads as his clients read them: the cards that wait on him now. */
async function waitingOnHim(): Promise<Shown[]> {
  const res = await fetch(`${flow.base}/api/v1/tasks/${taskId}/threads`)
  expect(res.status).toBe(200)
  return ((await res.json()) as { threads: Shown[] }).threads.filter((t) => !t.closed && t.state === 'needs')
}
/** The threads that hold a place for the task's own ask (stored). */
const places = async (): Promise<string[]> => (await readThreads(taskId)).threads.filter((t) => t.reportAsk).map((t) => t.id)
/** The task's own ask item, as its row and the chat's card show it. */
const ownAsk = (t: Task | null | undefined) => (t?.user_status?.actions ?? []).filter((i) => i.kind === 'ask')
const task = async (): Promise<Task> => (await getTask(taskId))!

/** A reply to the session's op, as its CLI makes it. */
async function threadUpdate(args: Record<string, unknown>): Promise<void> {
  const r = await executeOp('thread_update', args, { apiBase: `${flow.base}/api/v1`, origin: LOCAL_ORIGIN, callerMode: 'session', callerSid: SID })
  expect(r.ok, JSON.stringify(r)).toBe(true)
}

describe('one decision is shown once: a card line and the task\'s own ask', () => {
  let compost = ''
  let tomatoes = ''
  let fence = ''

  it('the line first: the status answer naming the same decision in other words adds no second card and no place on another thread', async () => {
    await setTag(true, SWITCHES)
    // An open subject first: the thread the place rule took for the ask.
    await say('When should I start the compost heap?')
    let rows = await cliTakes()
    compost = filedUnder(rows[0])
    flow.statusAnswer = WORKING
    let endedAt = await turnEnds(rows, `Now: the autumn leaves give plenty of material.\n\n<walnut-card thread="${compost}" state="answered" title="Starting a compost heap"/>`)
    await questionAfter(endedAt)

    await say('Raised bed or straight in the ground for the tomatoes? Do not pick for me: put it to me as a decision.')
    rows = await cliTakes()
    tomatoes = filedUnder(rows[0])
    expect(tomatoes).not.toBe(compost)
    // The session says the decision again in the status answer, reworded, as the real one did.
    flow.statusAnswer = asking('Pick where the tomatoes go: in a raised bed, or planted straight in the ground?', 'Raised bed (recommended) | In the ground')
    endedAt = await turnEnds(rows, `Both work; the raised bed warms sooner.\n\n<walnut-card thread="${tomatoes}" state="needs" title="Tomato bed" ask="Raised bed or planting straight in the ground for the tomatoes?" options="Raised bed (recommended); In the ground" kind="spending" why="the raised bed costs twice the budget he set"/>`)
    const q = await questionAfter(endedAt)
    // Up before the question was built, with its buttons (the mark the real session wrote is no part of a button's words).
    expect(of(q.threads, tomatoes)).toMatchObject({ state: 'needs', ask: 'Raised bed or planting straight in the ground for the tomatoes?' })
    expect(of(q.threads, tomatoes)?.options?.map((o) => [o.label, !!o.recommended])).toEqual([['Raised bed', true], ['In the ground', false]])

    // What he reads: one card, on the thread the line named. Nothing on the compost thread.
    const cards = await waitingOnHim()
    expect(cards.map((t) => t.id)).toEqual([tomatoes])
    expect(cards[0].heldAsk).toBeUndefined()
    expect(await places()).toEqual([])
    // The task asks nothing of its own: it reads Needs you through the thread.
    expect((await task()).status_report).toMatchObject({ state: 'needs' })
    expect((await task()).status_report?.ask).toBeUndefined()
    await vi.waitFor(async () => {
      const t = await task()
      expect(t.user_status).toMatchObject({ state: 'needs', source: 'thread' })
      expect(ownAsk(t)).toEqual([])
    }, { timeout: 10_000, interval: 200 })
    // And the question said it was up already, so a session need not say it twice.
    expect(q.prompt).toMatch(/Your threads' cards already ask him: "Raised bed or planting straight in the ground for the tomatoes\?" \(ask-[a-z0-9]+\)\. A decision up there stays out of FOR_USER_ASK/)
  }, 60_000)

  it('a later turn while the decision is still up: said again word for word, or left out, it stays one card', async () => {
    await say('And how big should the heap be?', compost)
    let rows = await cliTakes()
    flow.statusAnswer = asking('Raised bed or planting straight in the ground for the tomatoes?', 'Raised bed (recommended) | In the ground')
    let endedAt = await turnEnds(rows, `A cubic metre holds its heat.\n\n<walnut-card thread="${compost}" state="answered" summary="A cubic metre; start now."/>`)
    await questionAfter(endedAt)
    expect((await waitingOnHim()).map((t) => t.id)).toEqual([tomatoes])
    expect(await places()).toEqual([])
    expect((await task()).status_report?.ask).toBeUndefined()

    // The session follows the question: needs-you, and no ask of its own.
    await say('Thanks. Does it need a lid?', compost)
    rows = await cliTakes()
    flow.statusAnswer = 'FOR_USER_STATE: needs-you\nFOR_USER_NOW: The tomato bed choice waits for him.\nFOR_USER_NEXT: He picks, then I order.'
    endedAt = await turnEnds(rows, `A lid keeps the rain out.\n\n<walnut-card thread="${compost}" state="answered" summary="A cubic metre with a lid; start now."/>`)
    await questionAfter(endedAt)
    expect((await waitingOnHim()).map((t) => t.id)).toEqual([tomatoes])
    await vi.waitFor(async () => { expect((await task()).user_status).toMatchObject({ state: 'needs', source: 'thread' }) }, { timeout: 10_000, interval: 200 })
  }, 60_000)

  it('another decision in the status answer is still the task\'s own ask, placed by the rule: two decisions, two cards', async () => {
    await say('And the soil for the heap?', compost)
    const rows = await cliTakes()
    flow.statusAnswer = asking('Order 40 or 60 bags of soil for the compost heap?', '40 bags (recommended) | 60 bags')
    const endedAt = await turnEnds(rows, `Forty bags fill it.\n\n<walnut-card thread="${compost}" state="answered" summary="A cubic metre with a lid; soil to order."/>`)
    await questionAfter(endedAt)
    expect((await task()).status_report?.ask).toBe('Order 40 or 60 bags of soil for the compost heap?')
    expect(await places()).toEqual([compost])
    // The compost thread reads needs once the task's status shows its ask (derived after the report).
    await vi.waitFor(async () => {
      const cards = await waitingOnHim()
      expect(cards.map((t) => t.id).sort()).toEqual([compost, tomatoes].sort())
      expect(cards.find((t) => t.id === compost)?.heldAsk?.ask).toBe('Order 40 or 60 bags of soil for the compost heap?')
    }, { timeout: 10_000, interval: 200 })
  }, 40_000)

  it('the status ask first, a later line for the same decision: the ask moves to the line\'s thread at the turn\'s end, before any status answer', async () => {
    // He settles the soil; the task asks nothing of its own again.
    await say('40 bags.', compost)
    let rows = await cliTakes()
    flow.statusAnswer = WORKING
    let endedAt = await turnEnds(rows, `Ordered.\n\n<walnut-card thread="${compost}" state="answered" summary="A cubic metre with a lid; 40 bags ordered."/>`)
    await questionAfter(endedAt)
    expect(await places()).toEqual([])

    // A new subject; this turn's reply holds no decision line, its status answer asks.
    await say('Now the orchard fence: what wood for the posts?')
    rows = await cliTakes()
    fence = filedUnder(rows[0])
    flow.statusAnswer = asking('Larch or oak for the orchard fence posts?', 'Larch (recommended) | Oak')
    endedAt = await turnEnds(rows, `Larch or oak both last; oak costs more.\n\n<walnut-card thread="${fence}" state="working" title="Orchard fence posts"/>`)
    await questionAfter(endedAt)
    // The task's own ask, on the fence thread, as before this change.
    expect((await task()).status_report?.ask).toBe('Larch or oak for the orchard fence posts?')
    expect(await places()).toEqual([fence])
    await vi.waitFor(async () => {
      expect((await waitingOnHim()).find((t) => t.id === fence)?.heldAsk?.ask).toBe('Larch or oak for the orchard fence posts?')
    }, { timeout: 10_000, interval: 200 })

    // Its next turn puts that decision up with a line, in other words, while he asked about the heap.
    await say('Is the heap warm yet?', compost)
    rows = await cliTakes()
    flow.statusAnswer = asking('Larch or oak for the orchard fence posts?', 'Larch (recommended) | Oak')
    endedAt = await turnEnds(rows, `Not yet.\n\n<walnut-card thread="${compost}" state="answered" summary="A cubic metre with a lid; not warm yet."/>\n<walnut-card thread="${fence}" state="needs" ask="Which wood for the orchard fence posts: larch or oak?" options="Larch; Oak" kind="spending" why="oak costs twice the budget he set"/>`)
    const q = await questionAfter(endedAt)
    // When the question was asked (no answer of this turn stored yet): the decision is the thread's alone.
    expect(of(q.threads, fence)).toMatchObject({ state: 'needs', ask: 'Which wood for the orchard fence posts: larch or oak?' })
    expect(q.threads.filter((t) => t.reportAsk)).toEqual([])
    expect(q.report?.ask).toBeUndefined()
    expect(q.report?.last_ask?.ask).toBe('Larch or oak for the orchard fence posts?')
    const cards = await waitingOnHim()
    expect(cards.filter((t) => t.id === fence)).toHaveLength(1)
    expect(cards.find((t) => t.id === fence)?.heldAsk).toBeUndefined()
    // And the status answer that names it again changes nothing.
    expect(await places()).toEqual([])
    expect((await task()).status_report?.ask).toBeUndefined()
    await vi.waitFor(async () => {
      const t = await task()
      expect(t.user_status).toMatchObject({ state: 'needs', source: 'thread' })
      expect(ownAsk(t)).toEqual([])
    }, { timeout: 10_000, interval: 200 })
  }, 90_000)

  it('switch off: a thread a thread_update put in needs and the same decision as the task\'s ask stay as today', async () => {
    await setTag(false, SWITCHES)
    await say('Which liner for the pond?')
    const rows = await cliTakes()
    const pond = filedUnder(rows[0])
    await threadUpdate({ id: pond, title: 'Pond liner', state: 'needs', ask: 'Rubber or clay liner for the pond?', reply: 'Rubber or clay liner for the pond? I recommend rubber.', options: [{ label: 'Rubber', recommended: true }, { label: 'Clay' }], user_kind: 'spending', user_kind_why: 'clay costs twice the budget he set' })
    flow.statusAnswer = asking('Rubber or clay liner for the pond?', 'Rubber (recommended) | Clay')
    const endedAt = await turnEnds(rows, 'Rubber is cheaper; clay lasts longer.')
    const q = await questionAfter(endedAt)
    expect(q.prompt).not.toContain('already ask him')
    // Today: the report keeps the ask as the task's own, and the place rule puts it on another open thread.
    expect((await task()).status_report?.ask).toBe('Rubber or clay liner for the pond?')
    const held = await places()
    expect(held).toHaveLength(1)
    expect(held[0]).not.toBe(pond)
  }, 40_000)
})
