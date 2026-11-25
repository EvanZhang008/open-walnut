/**
 * With threads_reply_tag on, the Stop hook sends no turn back to tidy threads, and what it used to
 * ask is asked in the status question after the turn (src/core/org/thread-summary-stop.ts,
 * src/core/org/threads-kept.ts linesAreCards, src/core/sessions/status-thread-question.ts).
 *
 * 2026-11-25, a live session with three answered threads: his message on a new subject made the
 * Stop hook send the turn back ("the user wrote to you after these answers ... thread_update
 * merge_into / close: acked / known: all"), and the session closed its reply to him with a chat
 * message about its threads. The tag is there so that he never reads that.
 *
 * The same real turn end as tests/e2e/reply-card-real-flow.test.ts (tests/helpers/reply-card-flow.ts),
 * and the session's Stop hook as its CLI calls it. Three answered threads, then his message on a
 * new subject: the hook holds nothing (a missing line still goes back, alone and in the line's own
 * words), and the status question of that turn asks whether he reacted to the earlier answers, with
 * the reminder switch on and off and with threads_kept_by_walnut on and off; its answer marks the
 * one he reacted to known. With the tag off the hook sends back today's words.
 * The checks are listed in tests/core/org/stop-checks-guard.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'
import { mockLocalDaemonReader } from '../helpers/mock-local-daemon-reader.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-reply-card-stop-quiet', { IS_EPHEMERAL: true }))
vi.mock('../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader())

import { readThreads } from '../../src/core/org/threads-store.js'
import { cardStopEnd } from '../../src/core/org/reply-card-stop.js'
import { resetSummaryNudges } from '../../src/core/org/thread-summary-stop.js'
import type { OrgThread } from '../../src/core/org/threads-model.js'
import { cardTagLine } from '../../src/lib/card-tag.js'
import { cliAnswers, cliTakes, filedUnder, flow, of, questionAfter, say, setTag, startFlow, stopFlow, stopHook, turnEnds, type Asked } from '../helpers/reply-card-flow.js'

const SID = '5e55104a-0000-4000-8000-00000000901e'
let taskId = ''

beforeAll(async () => {
  await startFlow({ sid: SID, title: 'Garden plan helper', project: 'Garden' })
  taskId = flow.taskId
}, 40_000)

afterAll(stopFlow)

const WORKING = 'FOR_USER_STATE: working\nFOR_USER_NOW: Planning the garden.'
/** The ref the question lists a thread under (`t2 "its title" (...)`). */
const refOf = (prompt: string, title: string): string => new RegExp(`\\b(t\\d+) "${title}" \\(`).exec(prompt)?.[1] ?? ''
/** What the question says of a thread it lists. */
const saidOf = (prompt: string, title: string): string => new RegExp(`\\bt\\d+ "${title}" \\(([^)]*)\\)`).exec(prompt)?.[1] ?? ''
/** What a thread write is called when a session is told to make one. */
const THREAD_WRITE = /thread_update|merge_into|close: acked|known:/

/** His message on a new subject, read and answered by a turn whose reply ends with that thread's line. */
async function newSubject(text: string, answer: string, title: string): Promise<{ id: string; hook: { decision?: string; reason?: string }; q: Asked }> {
  await say(text)
  const rows = await cliTakes()
  const id = filedUnder(rows[0])
  await cliAnswers(rows)
  const line = `<walnut-card thread="${id}" state="answered" title="${title}"/>`
  // The CLI runs the Stop hook before the turn ends, with the reply's last lines.
  const hook = await stopHook(`x\n\n${line}`)
  const endedAt = await turnEnds(rows, `${answer}\n\n${line}`)
  return { id, hook, q: await questionAfter(endedAt) }
}

describe('his message on a new subject after answered threads: no turn is sent back to tidy them', () => {
  let fence = ''
  let seeds = ''
  let gate = ''

  it('three subjects are answered, each by its line, and their answers are kept under his messages', async () => {
    await setTag(true, { threads_reminder: true })
    flow.statusAnswer = WORKING
    for (const [text, answer, title, set] of [
      ['How tall should the orchard fence be?', 'Two metres keeps the deer out.', 'Orchard fence height', (id: string) => { fence = id }],
      ['Which seeds do we sow first?', 'Peas, in March.', 'First seeds to sow', (id: string) => { seeds = id }],
      ['Which way should the gate swing?', 'Inward: the path outside is narrow.', 'Gate swing', (id: string) => { gate = id }],
    ] as const) {
      const { id, hook } = await newSubject(text, answer, title)
      set(id)
      expect(hook).toEqual({})
    }
    expect(new Set([fence, seeds, gate]).size).toBe(3)
    // Here answers are kept when his Threads are read (an isolated server has no job for it).
    await vi.waitFor(async () => {
      const res = await fetch(`${flow.base}/api/v1/tasks/${taskId}/threads`)
      const threads = ((await res.json()) as { threads: OrgThread[] }).threads
      for (const id of [fence, seeds, gate]) expect(of(threads, id)?.messages[0].answer?.text, id).toBeTruthy()
    }, { timeout: 20_000, interval: 500 })
    for (const id of [fence, seeds, gate]) expect(of((await readThreads(taskId)).threads, id)).toMatchObject({ state: 'answered', titled: true })
  }, 90_000)

  it('reminder on: the hook holds nothing, and the question of that turn asks whether he reacted; its answer marks the one he did known', async () => {
    // The session says he reacted to the fence answer, and gives no line for a thread that did not move.
    flow.statusAnswer = (prompt) => `FOR_USER_STATE: working\nFOR_USER_THREAD_SEEN: ${refOf(prompt, 'Orchard fence height')}\nFOR_USER_NOW: Planning the garden.`
    const { id: barrel, hook, q } = await newSubject('Two metres is fine, thanks. Now: where does the rain barrel go?', 'By the shed downpipe.', 'Rain barrel place')
    // Nothing about the answers he wrote after, and nothing about a summary: the turn ends.
    expect(hook).toEqual({})
    // The three answered threads are asked about, quietly: he wrote elsewhere since their answer.
    for (const title of ['Orchard fence height', 'First seeds to sow', 'Gate swing']) expect(saidOf(q.prompt, title), title).toContain('he wrote elsewhere since your answer here')
    expect(q.prompt).toContain('His messages since, newest first: ')
    expect(q.prompt).toContain('"Two metres is fine, thanks. Now: where does the rain barrel go?"')
    expect(q.prompt).toContain('FOR_USER_THREAD_SEEN: <ref>, <ref>')
    // The thread this turn's line spoke for is not asked about.
    expect(refOf(q.prompt, 'Rain barrel place')).toBe('')
    // The answer cost no chat message: the fence answer is known, the others are as they were.
    const after = (await readThreads(taskId)).threads
    expect(of(after, fence)?.known).toBeTruthy()
    expect(of(after, seeds)?.known).toBeUndefined()
    expect(of(after, gate)?.known).toBeUndefined()
    expect(of(after, barrel)).toMatchObject({ state: 'answered', title: 'Rain barrel place' })
  }, 60_000)

  it('a reply with no line for the new thread still goes back, alone, as the line to write and no other words', async () => {
    await say('And how big a barrel?')
    const rows = await cliTakes()
    const size = filedUnder(rows[0])
    await cliAnswers(rows)
    const held = await stopHook('x\n\nx')
    expect(held.decision).toBe('block')
    // The whole reason: one line to write. No other check added a word about threads.
    expect(held.reason).toBe(`Walnut: your reply holds no card line for thread ${size} "And how big a barrel?", where his message went: ${cardTagLine(size)}, with its state (working, waiting, answered or done). ${cardStopEnd(1)}`)
    expect(held.reason).not.toMatch(THREAD_WRITE)
    flow.statusAnswer = WORKING
    const endedAt = await turnEnds(rows, `Two hundred litres.\n\n<walnut-card thread="${size}" state="answered" title="Barrel size"/>`)
    await questionAfter(endedAt)
  }, 40_000)

  it('reminder off: the same, the question lists the answered threads and asks his reaction', async () => {
    await setTag(true, { threads_reminder: false })
    flow.statusAnswer = WORKING
    const { hook, q } = await newSubject('Next: what goes in the cold frame?', 'Lettuce, from February.', 'Cold frame crops')
    expect(hook).toEqual({})
    for (const title of ['First seeds to sow', 'Gate swing']) expect(saidOf(q.prompt, title), title).toContain('he wrote elsewhere since your answer here')
    expect(q.prompt).toContain('FOR_USER_THREAD_SEEN: <ref>, <ref>')
    // The one already marked known is asked no reaction again.
    expect(saidOf(q.prompt, 'Orchard fence height')).not.toContain('he wrote elsewhere')
  }, 40_000)

  it('with threads_kept_by_walnut on too, reminder on: the same', async () => {
    await setTag(true, { threads_reminder: true, threads_kept_by_walnut: true })
    flow.statusAnswer = WORKING
    const { hook, q } = await newSubject('And the herb bed, sun or shade?', 'Sun, by the south wall.', 'Herb bed place')
    expect(hook).toEqual({})
    for (const title of ['First seeds to sow', 'Gate swing']) expect(saidOf(q.prompt, title), title).toContain('he wrote elsewhere since your answer here')
    expect(q.prompt).toContain('FOR_USER_THREAD_SEEN: <ref>, <ref>')
  }, 40_000)

  it('tag off: the hook sends the turn back with today\'s words, as before', async () => {
    await setTag(false, { threads_reminder: true, threads_kept_by_walnut: false })
    resetSummaryNudges()
    await say('Last one: when do we prune the apple trees?')
    const rows = await cliTakes()
    const prune = filedUnder(rows[0])
    await cliAnswers(rows)
    const held = await stopHook('x\n\nx')
    expect(held.decision).toBe('block')
    expect(held.reason).not.toContain('card line')
    // The summary his message outdated, by thread_update.
    expect(held.reason).toContain('Walnut: before this turn ends, these Threads do not say where they stand after his latest message:')
    expect(held.reason).toContain(`- ${prune} "Last one: when do we prune the apple trees?": no summary yet`)
    expect(held.reason).toContain('Rewrite each summary now (thread_update reply, latest first, with its state), or set pending for one that only went to a team.')
    // And the answers he wrote after, each to check by thread_update.
    expect(held.reason).toContain(`Walnut: the user wrote to you after these answers (his message `)
    expect(held.reason).toContain(`, filed in ${prune} "Last one: when do we prune the apple trees?"), and their cards still show them as unread:`)
    expect(held.reason).toContain(`- ${seeds} "First seeds to sow": answered `)
    expect(held.reason).toContain(`- ${gate} "Gate swing": answered `)
    expect(held.reason).toContain('Check each against what he said since. Same subject: merge his message into it (thread_update merge_into). He read it and its work is done: close it (close: acked). '
      + 'He read it and it goes on: mark it known (known: "all") with a summary of where it stands now. Still waiting on him: keep only the one question left. '
      + 'His words did not touch it: leave it as it is.')
    flow.statusAnswer = WORKING
    const endedAt = await turnEnds(rows, 'In late winter.')
    await questionAfter(endedAt)
  }, 40_000)
})
