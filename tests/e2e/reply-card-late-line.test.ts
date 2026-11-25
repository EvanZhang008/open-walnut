/**
 * A decision line that lands while the turn's status answer is on its way still leaves one card
 * (experiment threads_reply_tag; src/core/org/thread-report-ask.ts askOnNeedsThread, askNowOnThread;
 * review 2026-11-25). The question waits for the turn's card write ten seconds at most; a write
 * slower than that puts the decision up after the status answer read the threads and before it was
 * stored. The answer then kept the decision as the task's own ask, and the line's own check had
 * already run against the report before it: the thread and the task both asked it until the next
 * status answer.
 *
 * Here the late write is the real one (reply-card-decision.ts applyNeedsCard), run exactly in that window:
 * after askOnNeedsThread read the threads, before the answer is stored. The turn end, the question
 * and the store are the real ones (tests/helpers/reply-card-flow.ts).
 *
 * And a decision a card line put on its thread, which the report never asked, is still its task's
 * to hold (review 2026-11-25, B1): the thread stores the decision's id, and a teammate reporting the
 * same decision with same_as binds to it (before, task_report_set answered 409) and shows no card
 * of its own. And the status question names each card's decision id, so a status answer that says
 * the same decision again in other words, with no choices, names it and adds no card (N2).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'
import { mockLocalDaemonReader } from '../helpers/mock-local-daemon-reader.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-reply-card-late-line', { IS_EPHEMERAL: true }))
vi.mock('../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader())

/** The write that lands in the window, set by the test; run once. */
const late = vi.hoisted(() => ({ write: null as null | (() => Promise<void>) }))
vi.mock('../../src/core/org/thread-report-ask.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/core/org/thread-report-ask.js')>()
  return {
    ...real,
    askOnNeedsThread: async (...args: Parameters<typeof real.askOnNeedsThread>) => {
      const out = await real.askOnNeedsThread(...args)
      const write = late.write
      late.write = null
      if (write) await write()
      return out
    },
  }
})

import { addTask, getTask, updateTaskRaw } from '../../src/core/task-manager.js'
import { setTaskReport } from '../../src/core/sessions/report-set.js'
import { askKey } from '../../src/core/same-ask.js'
import { readThreads } from '../../src/core/org/threads-store.js'
import { applyNeedsCard } from '../../src/core/org/reply-card-decision.js'
import { readCardTags } from '../../src/lib/card-tag.js'
import { cliTakes, filedUnder, flow, questionAfter, say, setTag, startFlow, stopFlow, turnEnds } from '../helpers/reply-card-flow.js'

const SID = '5e55104a-0000-4000-8000-00000000a7e1'

beforeAll(async () => {
  await startFlow({ sid: SID, title: 'Garden plan helper', project: 'Garden' })
}, 40_000)

afterAll(stopFlow)

const ASK = 'Pick where the tomatoes go: in a raised bed, or planted straight in the ground?'
const LINE = '<walnut-card thread="TH" state="needs" title="Tomato bed" ask="Raised bed or planting straight in the ground for the tomatoes?" options="Raised bed (recommended); In the ground" kind="spending" why="the raised bed costs twice the budget he set"/>'

describe('a decision line later than the status answer\'s read', () => {
  it('lands between the read and the store: the stored answer stops asking it at once, one card is left', async () => {
    await setTag(true, { threads_reminder: true, threads_one_card: true })
    await say('Raised bed or straight in the ground for the tomatoes? Put it to me as a decision.')
    const rows = await cliTakes()
    const tomatoes = filedUnder(rows[0])
    const card = readCardTags(LINE.replace('TH', tomatoes)).cards[0]!
    expect(card).toBeTruthy()
    // The session says the decision in its status answer; its line's write lands in the window.
    flow.statusAnswer = [
      'FOR_USER_STATE: needs-you', `FOR_USER_ASK: ${ASK}`,
      'FOR_USER_ASK_OWN: spending: the dearer choice costs twice the budget he set', 'FOR_USER_ASK_KIND: single',
      'FOR_USER_ASK_OPTIONS: Raised bed (recommended) | In the ground', 'FOR_USER_NOW: The choice is laid out for him.', 'FOR_USER_NEXT: He picks, then I order.',
    ].join('\n')
    let wrote = false
    late.write = async () => { await applyNeedsCard(flow.taskId, SID, card); wrote = true }
    const endedAt = await turnEnds(rows, 'Both work; the raised bed warms sooner.')
    await questionAfter(endedAt)
    expect(wrote).toBe(true)

    const threads = (await readThreads(flow.taskId)).threads
    expect(threads.find((t) => t.id === tomatoes)).toMatchObject({ state: 'needs', ask: 'Raised bed or planting straight in the ground for the tomatoes?' })
    // The report asks it no more, and no thread holds a place for it: one card, on the line's thread.
    const task = (await getTask(flow.taskId))!
    expect(task.status_report?.ask).toBeUndefined()
    expect(task.status_report?.last_ask?.ask).toBe(ASK)
    expect(threads.filter((t) => t.reportAsk)).toEqual([])
    await vi.waitFor(async () => {
      const t = (await getTask(flow.taskId))!
      expect(t.user_status).toMatchObject({ state: 'needs', source: 'thread' })
      expect((t.user_status?.actions ?? []).filter((i) => i.kind === 'ask')).toEqual([])
    }, { timeout: 10_000, interval: 200 })
  }, 60_000)

  it('a card line puts a decision the report never asked on its thread: a teammate\'s same_as binds to it, one card', async () => {
    await say('Wood or plastic for the compost bin? Put it to me as a decision.')
    const rows = await cliTakes()
    const bin = filedUnder(rows[0])
    flow.statusAnswer = 'FOR_USER_STATE: needs-you\nFOR_USER_NOW: The bin choice waits for him.\nFOR_USER_NEXT: He picks, then I order.'
    const ASK_BIN = 'Wood or plastic for the compost bin?'
    const endedAt = await turnEnds(rows, `Both last.\n\n<walnut-card thread="${bin}" state="needs" title="Compost bin" ask="${ASK_BIN}" options="Wood (recommended); Plastic" kind="spending" why="the wooden bin costs twice the budget he set"/>`)
    await questionAfter(endedAt)
    // The thread stores the decision it carries; the report never asked it.
    const th = (await readThreads(flow.taskId)).threads.find((t) => t.id === bin)!
    expect(th).toMatchObject({ state: 'needs', ask: ASK_BIN })
    expect(th.askId).toMatch(/^ask-[a-z0-9]+$/)
    expect((await getTask(flow.taskId))!.status_report?.ask).toBeUndefined()

    // A teammate (the same parent) reports the same decision, naming the holder. The holder has two
    // decisions up (the tomato bed's too): the teammate's words name which (the same content words).
    const parent = (await addTask({ title: 'Garden plan', project: 'Garden' })).task.id
    const mate = (await addTask({ title: 'Compost helper', project: 'Garden' })).task.id
    for (const id of [flow.taskId, mate]) await updateTaskRaw(id, { parent_task_id: parent }, { source: 'test' })
    await updateTaskRaw(mate, { phase: 'IN_PROGRESS' }, { source: 'test' })
    await setTaskReport(mate, {
      state: 'needs', ask: ASK_BIN, same_as: flow.taskId,
      ask_kind: 'single', ask_options: [{ label: 'Wood', recommended: true, detail: 'lasts ten years, costs twice the budget' }, { label: 'Plastic', detail: 'cheaper and lighter, cracks in frost' }],
      ask_more: 'The garden plan needs one compost bin before the autumn leaves. I recommend wood: it lasts longer, but it costs twice the budget he set. Nobody else is touched.',
      user_kind: 'spending', user_kind_why: 'the wooden bin costs twice the budget he set',
    }, { taskId: mate, title: 'Compost helper' })
    expect((await getTask(mate))!.status_report?.decision_owner).toEqual({ taskId: flow.taskId, decisionId: th.askId, askKey: askKey(ASK_BIN) })
    // One card: the holder's thread; the teammate waits on it.
    await vi.waitFor(async () => {
      const [holder, other] = [(await getTask(flow.taskId))!, (await getTask(mate))!]
      expect(holder.user_status).toMatchObject({ state: 'needs', source: 'thread' })
      expect(other.user_status).toMatchObject({ state: 'waiting', sameAsk: { id: flow.taskId, ask: ASK_BIN, decision: th.askId } })
    }, { timeout: 15_000, interval: 200 })
  }, 60_000)

  it('N2: the status answer asks the card\'s decision again in other words, no choices: it names the card\'s id, one card', async () => {
    await say('Should the pond get a pump? Put it to me as a decision.')
    const rows = await cliTakes()
    const pond = filedUnder(rows[0])
    const CARD = 'Add a pump to the pond?'
    // The session repeats it as FOR_USER_ASK, in its own words, naming the id the question gave the card.
    flow.statusAnswer = (prompt: string) => [
      'FOR_USER_STATE: needs-you', 'FOR_USER_ASK: Should the pond get a pump?',
      `FOR_USER_ASK_ID: ${new RegExp(`"${CARD.replace('?', '\\?')}" \\((ask-[a-z0-9]+)\\)`).exec(prompt)?.[1] ?? 'none'}`,
      'FOR_USER_ASK_OWN: spending: the pump costs twice the budget he set', 'FOR_USER_NOW: The pump choice waits for him.', 'FOR_USER_NEXT: He picks, then I order.',
    ].join('\n')
    const endedAt = await turnEnds(rows, `A pump keeps the water clear.\n\n<walnut-card thread="${pond}" state="needs" title="Pond pump" ask="${CARD}" summary="A pump keeps the pond water clear all summer; it costs twice the budget he set, and nobody else is touched." options="Buy the pump (recommended); Leave the pond as it is" kind="spending" why="the pump costs twice the budget he set"/>`)
    const q = await questionAfter(endedAt)
    const th = (await readThreads(flow.taskId)).threads.find((t) => t.id === pond)!
    expect(th.askId).toMatch(/^ask-[a-z0-9]+$/)
    expect(q.prompt).toContain(`"${CARD}" (${th.askId})`)
    // The report asks nothing of its own: the decision lives on the card only.
    await vi.waitFor(async () => {
      const t = (await getTask(flow.taskId))!
      expect(t.status_report?.ask).toBeUndefined()
      expect((t.user_status?.actions ?? []).filter((i) => i.kind === 'ask')).toEqual([])
    }, { timeout: 10_000, interval: 200 })
    expect((await readThreads(flow.taskId)).threads.filter((t) => t.reportAsk)).toEqual([])
  }, 60_000)
})
