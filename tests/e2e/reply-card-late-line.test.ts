/**
 * A decision line that lands while the turn's status answer is on its way still leaves one card
 * (experiment threads_reply_tag; src/core/org/thread-report-ask.ts askOnNeedsThread, askNowOnThread;
 * review 2026-11-25). The question waits for the turn's card write ten seconds at most; a write
 * slower than that puts the decision up after the status answer read the threads and before it was
 * stored. The answer then kept the decision as the task's own ask, and the line's own check had
 * already run against the report before it: the thread and the task both asked it until the next
 * status answer.
 *
 * Here the late write is the real one (reply-card.ts applyNeedsCard), run exactly in that window:
 * after askOnNeedsThread read the threads, before the answer is stored. The turn end, the question
 * and the store are the real ones (tests/helpers/reply-card-flow.ts).
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

import { getTask } from '../../src/core/task-manager.js'
import { readThreads } from '../../src/core/org/threads-store.js'
import { applyNeedsCard } from '../../src/core/org/reply-card.js'
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
})
