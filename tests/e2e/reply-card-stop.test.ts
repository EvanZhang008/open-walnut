/**
 * A wrong or missing card line is sent back before the turn ends, and a thread a line spoke for is
 * not asked about again, on a real server with only the CLI faked (experiment threads_reply_tag;
 * src/core/org/reply-card-stop.ts, src/core/sessions/status-thread-carded.ts).
 *
 * The session's Stop hook calls `open_items {"hook":"stop","last_lines":...}` (the shape of the
 * reply's last lines, tests/providers/stop-hook-last-lines.test.ts runs the hook's own shell): this
 * test makes that call as the hook does and reads the block answer.
 *
 *   - off: the call answers exactly what it answers without the last lines, and writes nothing;
 *   - a message of his this turn read, no line for its thread: held once with the exact line, at
 *     most MAX_CARD_NUDGES times, never for a message still waiting in the session's queue;
 *   - a line that cannot be read, that names a closed thread, or a decision the store refuses:
 *     held with the reason (the store's own words for a decision);
 *   - a good line: no hold; a decision is written right then and not again when the turn ends;
 *   - the status question after the turn lists only the threads no line spoke for.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { createMockConstants } from '../helpers/mock-constants.js'
import { mockLocalDaemonReader } from '../helpers/mock-local-daemon-reader.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-reply-card-stop'))
vi.mock('../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader())
// This file plays the session's CLI itself (it takes the queued rows), so the server's runner takes
// no row here (tests/core/hand-played-cli-guard.test.ts).
vi.mock('../../src/core/session-message-queue.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/core/session-message-queue.js')>()
  return { ...real, markProcessing: (async () => []) as typeof real.markProcessing }
})

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { addTask, getTask, updateTaskRaw } from '../../src/core/task-manager.js'
import { createSessionRecord, getSessionByClaudeId, updateSessionRecord } from '../../src/core/session-tracker.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { askStatus, settleStatusQuestion } from '../../src/core/sessions/status-question.js'
import { getQueue, markNextProcessing, removeProcessed, sendMessageToSession } from '../../src/core/session-message-queue.js'
import { prepareHintedSend } from '../../src/core/hints/hint-send.js'
import { threadsKeptNow } from '../../src/core/org/threads-kept.js'
import { replyTagNow } from '../../src/core/org/reply-card-switch.js'
import { patchThread, readThreads, writeThreadsFor } from '../../src/core/org/threads-store.js'
import { applyReplyCards, holdCards, noteStopCheck, resetHeldCards } from '../../src/core/org/reply-card.js'
import { cardStopEnd, MAX_CARD_NUDGES, resetCardNudges } from '../../src/core/org/reply-card-stop.js'
import { resetCarded } from '../../src/core/sessions/status-thread-carded.js'
import { linesThatAsked, noteLineAsks } from '../../src/core/sessions/status-thread-asked.js'
import { threadQuestionFor } from '../../src/core/sessions/status-thread-question.js'
import { cardTagLine, CARD_TAG_FORM, readCardTags } from '../../src/lib/card-tag.js'
import { executeOp } from '../../src/ops/executor.js'
import { LOCAL_ORIGIN } from '../../src/lib/caller-origin.js'
import type { OrgThread } from '../../src/core/org/threads-model.js'
import type { Task } from '../../src/core/types.js'
import '../../src/ops/index.js'

const SID = '55555555-5555-6666-7777-000000000001'
let base = ''
let taskId = ''
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString()

const FENCE = 'th-feec0de1'
const SEEDS = 'th-feec0de2'
const SHED = 'th-feec0de3'
const GATE = 'th-feec0de4'

function fixture(): OrgThread[] {
  return [
    // His message of two minutes ago, read by this session and not answered yet: the turn that ends answers it.
    { id: FENCE, title: 'Orchard fence', titled: true, state: 'working', reply: 'Measuring the orchard.', replyAt: ago(20), createdAt: ago(40), updatedAt: ago(2), by: 'task:x',
      messages: [
        { id: 'tm-feec0de1', at: ago(40), text: 'How tall should the orchard fence be?', via: 'chat', sid: SID, answer: { text: 'I measure the orchard first.', at: ago(39) } },
        { id: 'tm-feec0de5', at: ago(2), text: 'And which wood?', via: 'chat', sid: SID },
      ] },
    // Answered long ago, nothing of his since: no line is owed for it.
    { id: SEEDS, title: 'Spring seed order', titled: true, state: 'working', reply: 'Comparing two suppliers.', replyAt: ago(30), createdAt: ago(35), updatedAt: ago(30), by: 'task:x',
      messages: [{ id: 'tm-feec0de2', at: ago(35), text: 'Order the seeds for spring.', via: 'chat', sid: SID, answer: { text: 'On it: I compare two suppliers.', at: ago(30) } }] },
    { id: SHED, title: 'Shed colour', titled: true, state: 'answered', reply: 'Green.', replyAt: ago(50), createdAt: ago(60), updatedAt: ago(45), by: 'user', closed: { how: 'acked', at: ago(45), by: 'user' },
      messages: [{ id: 'tm-feec0de3', at: ago(60), text: 'What colour for the shed?', via: 'chat', sid: SID, answer: { text: 'Green.', at: ago(50) } }] },
    { id: GATE, title: 'Gate', titled: true, state: 'working', reply: 'Drawing it.', replyAt: ago(25), createdAt: ago(28), updatedAt: ago(25), by: 'task:x',
      messages: [{ id: 'tm-feec0de4', at: ago(28), text: 'Which way should the gate swing?', via: 'chat', sid: SID, answer: { text: 'I draw both ways first.', at: ago(25) } }] },
  ] as OrgThread[]
}

async function setTag(on: boolean): Promise<void> {
  const put = await fetch(`${base}/api/config`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ experimental: { threads_kept_by_walnut: true, threads_reply_tag: on } }) })
  expect(put.status).toBe(200)
  await vi.waitFor(() => { expect(threadsKeptNow()).toBe(true); expect(replyTagNow()).toBe(on) }, { timeout: 5000 })
}

/** The Stop hook's call, with the shape of the reply's last lines (absent: a hook from before it sent them). */
async function stop(tail?: string): Promise<{ decision?: string; reason?: string }> {
  const r = await executeOp('open_items', { hook: 'stop', ...(tail === undefined ? {} : { last_lines: tail }) }, { apiBase: `${base}/api/v1`, callerSid: SID, origin: LOCAL_ORIGIN })
  expect(r.ok, JSON.stringify(r)).toBe(true)
  return (r as { result: { decision?: string; reason?: string } }).result
}
const threadOf = async (id: string) => (await readThreads(taskId)).threads.find((t) => t.id === id)!
const fresh = () => { resetCardNudges(); resetHeldCards(); resetCarded() }

function fakeSession(answer: (prompt: string) => string) {
  const fake = { sessionId: SID, askSideQuestion: vi.fn(async (prompt: string) => answer(prompt)), detach: () => {}, kill: () => {}, get active() { return false } }
  ;(sessionRunner as unknown as { sessions: Map<string, unknown> }).sessions.set(SID, fake)
  return fake
}

beforeAll(async () => {
  process.env.WALNUT_THREAD_JOIN_SECS = '0'
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  vi.spyOn(sessionRunner as unknown as { processNext(sessionId: string, mode?: string): Promise<void> }, 'processNext').mockResolvedValue(undefined)
  const server = await startServer({ port: 0, dev: true })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  taskId = (await addTask({ title: 'Garden VP', project: 'Garden' })).task.id
  await updateTaskRaw(taskId, { phase: 'IN_PROGRESS', session_id: SID, org_role: 'lead' }, { source: 'test' })
  await createSessionRecord(SID, taskId, 'Garden', '/repo/garden', { title: 'Garden VP' })
  await updateSessionRecord(SID, { process_status: 'idle' })
  const dir = path.join(WALNUT_HOME, 'org', 'threads')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, `${taskId}.json`), JSON.stringify({ version: 1, taskId, threads: fixture() }))
}, 30_000)

afterAll(async () => {
  delete process.env.WALNUT_THREAD_JOIN_SECS
  await settleStatusQuestion(SID, 10_000)
  ;(sessionRunner as unknown as { sessions: Map<string, unknown> }).sessions.delete(SID)
  await stopServer()
  vi.restoreAllMocks()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('the card lines at a turn\'s end', () => {
  /** The thread his queued message opens, mid-way: owed a line from then on. */
  let bench = ''

  it('off: the last lines change nothing in the answer, and a line in them writes nothing', async () => {
    await setTag(false)
    fresh()
    const before = JSON.stringify(await readThreads(taskId))
    const without = await stop()
    expect(await stop('x\n\nx')).toEqual(without)
    expect(await stop(`x\n<walnut-card thread="${FENCE}" state="needs" ask="Which wood?" options="Larch; Oak" kind="spending" why="oak is twice the budget"/>`)).toEqual(without)
    expect(JSON.stringify(without)).not.toContain('card line')
    expect(JSON.stringify(await readThreads(taskId))).toBe(before)
  })

  it('on: a reply with no line for the thread his message went to is held once, with the exact line', async () => {
    await setTag(true)
    fresh()
    const held = await stop('x\n\nx')
    expect(held.decision).toBe('block')
    // The line to write, and nothing else: whatever else the session adds is a chat message to him.
    expect(held.reason).toBe(`Walnut: your reply holds no card line for thread ${FENCE} "Orchard fence", where his message went: ${cardTagLine(FENCE)}, with its state (working, waiting, answered or done). ${cardStopEnd(1)}`)
    expect(cardStopEnd(1)).toBe('Write only this line now, and no other words about it: anything else you add is shown to him as chat.')
    // The threads with nothing of his unanswered are not asked for.
    expect(held.reason).not.toContain(SEEDS)
    expect(held.reason).not.toContain(GATE)
    expect(held.reason).not.toContain(SHED)
  })

  it(`the same missing line is named at most ${MAX_CARD_NUDGES} times: a session that cannot write it is let go`, async () => {
    fresh()
    for (let i = 0; i < MAX_CARD_NUDGES; i++) expect((await stop('x')).reason, `stop ${i + 1}`).toContain(cardTagLine(FENCE))
    expect(JSON.stringify(await stop('x'))).not.toContain('card line')
  })

  it('a hook that sends no last lines (an older one, another engine) is never held for a line', async () => {
    fresh()
    expect(JSON.stringify(await stop())).not.toContain('card line')
  })

  // Review 2026-11-25: after a restart nothing in memory said which messages a turn that ended had
  // read, and every one of the last six hours with no answer kept was owed a line.
  it('after a restart, a message the session\'s last turn already read owes no line: its stored report says when that turn ended', async () => {
    fresh()
    const ended = new Date().toISOString()
    await updateTaskRaw(taskId, { status_report: { state: 'working', now: 'Measuring the orchard.', at: ended, turn_ended_at: ended, session_id: SID, rule: 2 } }, { source: 'test' })
    try {
      expect(JSON.stringify(await stop('x\n\nx'))).not.toContain('card line')
      // Another session's report says nothing of this one's turns: as before, the message is owed.
      fresh()
      await updateTaskRaw(taskId, { status_report: { state: 'working', now: 'Measuring the orchard.', at: ended, turn_ended_at: ended, session_id: 'another-session', rule: 2 } }, { source: 'test' })
      expect((await stop('x\n\nx')).reason).toContain(cardTagLine(FENCE))
    } finally {
      await updateTaskRaw(taskId, { status_report: undefined } as never, { source: 'test' })
      fresh()
    }
  })

  it('a good line: no hold', async () => {
    fresh()
    expect(JSON.stringify(await stop(`x\n\n${cardTagLine(FENCE, 'working')}`))).not.toContain('card line')
    resetHeldCards()
  })

  it('a line that cannot be read comes back with the one reason and the form, and is not also called missing', async () => {
    fresh()
    const held = await stop(`x\n<walnut-card thread="${FENCE}" state="finished"/>`)
    expect(held.decision).toBe('block')
    expect(held.reason).toBe(`Walnut: a card line of your reply was not read: ${FENCE}: state is working, waiting, answered, done, needs, not "finished". Its form: ${CARD_TAG_FORM} ${cardStopEnd(1)}`)
    expect(held.reason).not.toContain('holds no card line')
  })

  it('a line for a closed thread, or one that is not the task\'s, holds no turn by itself; it is named beside a line that is missing', async () => {
    fresh()
    // Nothing to write in its place: sent back alone, the session could only answer with chat text.
    const alone = await stop(`x\n${cardTagLine(FENCE, 'working')}\n${cardTagLine(SHED, 'done')}\n${cardTagLine('th-0000000000ff')}`)
    expect(JSON.stringify(alone)).not.toContain('card line')
    resetHeldCards()
    fresh()
    const held = await stop(`x\n${cardTagLine(SHED, 'done')}\n${cardTagLine('th-0000000000ff')}`)
    expect(held.decision).toBe('block')
    expect(held.reason).toContain(`- ${SHED} is closed: a new ask about it is a new thread, which Walnut files and names to you. That line is not written; give no line for it.`)
    expect(held.reason).toContain('- th-0000000000ff is no thread of this task: a card line names one of your own open threads. That line is not written; give no line for it.')
    expect(held.reason).toContain(`- your reply holds no card line for thread ${FENCE} `)
    expect(held.reason?.endsWith(`\n${cardStopEnd(3)}`)).toBe(true)
    expect(cardStopEnd(3)).toBe('Write only these lines now, each on a line of its own, and no other words about them: anything else you add is shown to him as chat.')
    resetHeldCards()
  })

  // 2026-11-26, real use: sessions with no thread id at hand wrote thread="none" or a placeholder,
  // and were held for a line they had no id to write.
  it('a line that names no thread at all holds no turn by itself; it is named beside a line that is missing', async () => {
    fresh()
    const alone = await stop(`x\n${cardTagLine(FENCE, 'working')}\n<walnut-card thread="none" state="answered"/>\n<walnut-card thread="th-placeholder" state="done"/>`)
    expect(JSON.stringify(alone)).not.toContain('card line')
    resetHeldCards()
    fresh()
    const held = await stop('x\n<walnut-card thread="none" state="answered"/>')
    expect(held.decision).toBe('block')
    expect(held.reason).toContain('- a card line named no thread (thread="none"): a line is only for a thread whose id you were given, in the note on his message or here. That line is not written; give no line for it.')
    expect(held.reason).toContain(`- your reply holds no card line for thread ${FENCE} `)
    expect(held.reason).not.toContain('was not read')
    // Nothing was written from it.
    expect((await threadOf(FENCE)).state).toBe((fixture().find((t) => t.id === FENCE)!).state)
    resetHeldCards()
  })

  it('a message of his still waiting in the session\'s queue owes no line yet', async () => {
    fresh()
    const record = await getSessionByClaudeId(SID)
    const prepared = await prepareHintedSend(SID, record, 'Also: paint the bench.', { sentBy: 'person' })
    await sendMessageToSession(SID, 'Also: paint the bench.', { source: 'ui', taskId: record?.taskId, enqueueMessage: prepared.enqueueText, hinted: true })
    await prepared.commit()
    bench = /th-[0-9a-f]{6,32}/.exec(prepared.enqueueText)![0]
    expect((await getQueue(SID)).length).toBe(1)
    // The turn that ends never read it: only the fence is owed.
    const waiting = await stop('x')
    expect(waiting.reason).toContain(cardTagLine(FENCE))
    expect(waiting.reason).not.toContain(bench)
    // The CLI takes the line: the next turn's end owes it a line.
    const rows = await markNextProcessing(SID)
    await removeProcessed(SID, rows.map((r) => r.id))
    fresh()
    const read = await stop('x')
    expect(read.reason).toContain(cardTagLine(bench))
    expect(read.reason).toContain(cardTagLine(FENCE))
    expect(read.reason).toMatch(/^Walnut, on the card lines of your reply:\n- /)
    // Both lines given: nothing is held.
    fresh()
    expect(JSON.stringify(await stop(`x\n${cardTagLine(FENCE, 'working')}\n${cardTagLine(bench, 'working')}`))).not.toContain('card line')
    resetHeldCards()
  })

  it('a decision the store refuses comes back with the store\'s own words, and nothing is written', async () => {
    fresh()
    const before = await threadOf(GATE)
    // No kind: the store hands him only what is his (user-kind.ts), and says so in its own words.
    const held = await stop(`x\n${cardTagLine(FENCE, 'working')}\n<walnut-card thread="${GATE}" state="needs" ask="Which way should the gate swing?" options="Inward; Outward"/>`)
    expect(held.decision).toBe('block')
    expect(held.reason).toContain(`the decision on ${GATE} was not put to him.`)
    expect(held.reason).toContain('a question reaches the user only when it is theirs')
    // The store names thread_update's fields: the line's own names are given beside them.
    expect(held.reason).toContain('In a card line user_kind is kind="..." and user_kind_why is why="...".')
    expect(held.reason).toContain('Its card line again, with that fixed.')
    // Two things to write (the bench thread has no line either): the reason ends by asking for the lines alone.
    expect(held.reason?.endsWith(`\n${cardStopEnd(2)}`)).toBe(true)
    expect(await threadOf(GATE)).toEqual(before)
    resetHeldCards()
  })

  it('a good decision is written right then, and not a second time when the turn ends', async () => {
    fresh()
    const line = `<walnut-card thread="${GATE}" state="needs" ask="Which way should the gate swing?" options="Inward; Outward" kind="irreversible" why="the hinges are welded on, so changing the swing later means a new gate"/>`
    const out = await stop(`x\n${cardTagLine(FENCE, 'working')}\n${cardTagLine(bench, 'working')}\n${line}`)
    expect(JSON.stringify(out)).not.toContain('card line')
    const asked = await threadOf(GATE)
    expect(asked).toMatchObject({ state: 'needs', ask: 'Which way should the gate swing?' })
    expect(asked.options?.map((o) => o.label)).toEqual(['Inward', 'Outward'])
    // The turn ends with the same reply: the decision stands as written, untouched.
    const task = await getTask(taskId) as Task
    const done = await applyReplyCards({ task, sessionId: SID, reply: `Both ways work.\n\n${cardTagLine(FENCE, 'working')}\n${line}` })
    expect(done.refused).toEqual([])
    expect(done.applied).toContain(GATE)
    expect((await threadOf(GATE)).updatedAt).toBe(asked.updatedAt)
  })

  it('a decision the check wrote is not written again when its hold was lost (a check that outlived its time, a restart)', async () => {
    fresh()
    const line = `<walnut-card thread="${GATE}" state="needs" ask="Which way should the gate swing?" options="Inward; Outward" kind="irreversible" why="the hinges are welded on, so changing the swing later means a new gate"/>`
    const asked = await threadOf(GATE)
    expect(asked.state).toBe('needs')
    // The same line at a later turn's end: the decision is up already, so it is not sent back as refused.
    expect(JSON.stringify(await stop(`x\n${cardTagLine(FENCE, 'working')}\n${cardTagLine(bench, 'working')}\n${line}`))).not.toContain('card line')
    // The hold is gone (nothing remembers that the check wrote it): the turn's end reads the thread itself.
    resetHeldCards()
    const task = await getTask(taskId) as Task
    const done = await applyReplyCards({ task, sessionId: SID, reply: `Both ways work.\n\n${line}` })
    expect(done.refused).toEqual([])
    expect(done.applied).toContain(GATE)
    expect((await threadOf(GATE)).updatedAt).toBe(asked.updatedAt)
    // So the status question is not told that a decision went unwritten.
    expect(linesThatAsked(taskId).has(GATE)).toBe(false)
  })

  it('a line given before the hold still counts when the turn ends on other words', async () => {
    fresh()
    // The reply held the seeds line; it was sent back for the fence, and the turn then ended on the fence line alone.
    await stop(`x\n<walnut-card thread="${SEEDS}" state="waiting" summary="The supplier answers on Friday."/>`)
    const task = await getTask(taskId) as Task
    const done = await applyReplyCards({ task, sessionId: SID, reply: `<walnut-card thread="${FENCE}" state="answered" summary="Larch, two metres."/>` })
    expect(done.applied.sort()).toEqual([FENCE, SEEDS].sort())
    expect(await threadOf(SEEDS)).toMatchObject({ state: 'pending', reply: 'The supplier answers on Friday.' })
    expect(await threadOf(FENCE)).toMatchObject({ state: 'answered', reply: 'Larch, two metres.', by: `task:${taskId}` })
  })

  it('the status question after that turn asks only about the threads no line spoke for', async () => {
    await settleStatusQuestion(SID, 10_000)
    const fake = fakeSession(() => 'FOR_USER_STATE: working\nFOR_USER_NOW: Building the fence.')
    expect(await askStatus(taskId, SID, Date.now())).toBe(true)
    const q = fake.askSideQuestion.mock.calls[0][0] as string
    // The seeds thread's line was written from the reply: it is not listed.
    expect(q).not.toContain('"Spring seed order"')
    // The bench thread got no line this turn: it is still asked. (The fence thread, spoken for too,
    // is named only as a subject that untitled thread may belong to.)
    expect(q).toContain('t1 "Also: paint the bench." (working, he wrote in')
    expect(q).not.toMatch(/t1 "Orchard fence"/)
    // Switch off: every open thread is asked again.
    await settleStatusQuestion(SID, 10_000)
    await setTag(false)
    fake.askSideQuestion.mockClear()
    expect(await askStatus(taskId, SID, Date.now())).toBe(true)
    const all = fake.askSideQuestion.mock.calls[0][0] as string
    expect(all).toContain('"Orchard fence"')
    expect(all).toContain('"Spring seed order"')
  })

  it('the turn\'s end waits a moment for a check still running, and what a check holds after that is dropped', async () => {
    await settleStatusQuestion(SID, 10_000)
    await setTag(true)
    fresh()
    const task = await getTask(taskId) as Task
    const seeds = (summary: string) => readCardTags(`<walnut-card thread="${SEEDS}" state="working" summary="${summary}"/>`).cards
    // A check that outlived its three seconds ends a moment later, holding the line it read.
    const turn = {}
    let finish = () => {}
    noteStopCheck(SID, turn, new Promise<void>((r) => { finish = r }))
    setTimeout(() => { holdCards(SID, seeds('The first crate arrived.'), [], Date.now(), turn); finish() }, 150)
    const done = await applyReplyCards({ task, sessionId: SID, reply: 'The crate is in.' })
    expect(done.applied).toContain(SEEDS)
    expect((await threadOf(SEEDS)).reply).toBe('The first crate arrived.')
    // One that never ends in time: the turn's end goes on without it, and its late hold is not the next turn's.
    const late = {}
    let end = () => {}
    noteStopCheck(SID, late, new Promise<void>((r) => { end = r }))
    const started = Date.now()
    expect((await applyReplyCards({ task, sessionId: SID, reply: 'Nothing new.' })).applied).toEqual([])
    expect(Date.now() - started).toBeLessThan(2500)
    holdCards(SID, seeds('A line from the turn before.'), [], Date.now(), late)
    end()
    expect((await applyReplyCards({ task, sessionId: SID, reply: 'Nothing new.' })).applied).toEqual([])
    expect((await threadOf(SEEDS)).reply).toBe('The first crate arrived.')
  })

  // Review 2026-11-25: a refusal left its mark for a day and nothing took it off, so with the
  // reminder on the thread was asked about at every turn.
  it('a decision refused once and written at the next turn leaves no mark; nor does a thread closed or gone since', async () => {
    fresh()
    const task = await getTask(taskId) as Task
    const bare = `<walnut-card thread="${SEEDS}" state="needs" ask="Which supplier for the spring seeds?" options="Larch Seeds; Oak Seeds"/>`
    const refused = await applyReplyCards({ task, sessionId: SID, reply: `Two suppliers carry them.\n\n${bare}` })
    expect(refused.refused.map((r) => r.thread)).toContain(SEEDS)
    expect(linesThatAsked(taskId).has(SEEDS)).toBe(true)
    const good = `<walnut-card thread="${SEEDS}" state="needs" ask="Which supplier for the spring seeds?" options="Larch Seeds; Oak Seeds" kind="spending" why="Oak Seeds costs twice the budget he set"/>`
    const done = await applyReplyCards({ task, sessionId: SID, reply: `Two suppliers carry them.\n\n${good}` })
    expect(done.refused).toEqual([])
    expect(await threadOf(SEEDS)).toMatchObject({ state: 'needs', ask: 'Which supplier for the spring seeds?' })
    expect(linesThatAsked(taskId).has(SEEDS)).toBe(false)

    // A mark on a thread closed since, or on one that is gone, is forgotten when the question reads the threads.
    const GONE = 'th-0dd0dd01'
    noteLineAsks(taskId, [FENCE, GONE], [])
    await writeThreadsFor(taskId, (cur) => ({ file: { ...cur, threads: cur.threads.map((t) => (t.id === FENCE ? { ...t, closed: { how: 'acked', at: new Date().toISOString(), by: 'user' } } : t)) }, out: undefined }))
    await threadQuestionFor(task)
    expect(linesThatAsked(taskId).has(FENCE)).toBe(false)
    expect(linesThatAsked(taskId).has(GONE)).toBe(false)
  })

  it('a line that says a decision still before him is over is sent back with the call that settles it, and writes nothing', async () => {
    fresh()
    await patchThread(taskId, GATE, { state: 'needs', ask: 'Which way should the gate swing?', options: [{ label: 'Inward', recommended: true }, { label: 'Outward' }], user_kind: 'user_own', user_kind_why: 'he asked to pick the way his own gate swings' }, `task:${taskId}`)
    const held = await stop(`The gate swings inward now.\n\n${cardTagLine(GATE, 'done')}`)
    expect(held.decision).toBe('block')
    expect(held.reason).toContain(`${GATE} waits on his decision, and a state line does not end that: it was not written.`)
    expect(held.reason).toContain(`thread_update {"id":"${GATE}","state":"answered","reply":`)
    expect(held.reason?.endsWith(cardStopEnd(1, 1))).toBe(true)
    expect(await threadOf(GATE)).toMatchObject({ state: 'needs' })
    // The turn's end writes nothing for it either, and names it.
    const end = await applyReplyCards({ task: await getTask(taskId) as Task, sessionId: SID, reply: `The gate swings inward now.\n\n${cardTagLine(GATE, 'done')}` })
    expect(end.refused).toEqual([{ thread: GATE, reason: `${GATE} waits on his decision: a state line does not end it` }])
    expect(await threadOf(GATE)).toMatchObject({ state: 'needs' })
    // Working or waiting says nothing new of a thread that waits on him: no hold.
    fresh()
    expect(JSON.stringify(await stop(`x\n\n${cardTagLine(GATE, 'waiting')}`))).not.toContain('waits on his decision')
    resetHeldCards()
    // The call it names settles it.
    expect(await patchThread(taskId, GATE, { state: 'answered', reply: 'You chose inward; the gate is hung.' }, `task:${taskId}`)).toMatchObject({ state: 'answered' })
  })
})
