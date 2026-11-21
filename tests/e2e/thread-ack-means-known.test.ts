/**
 * His Acknowledge means he knows, on a real server (experiment ack_means_known,
 * src/core/org/thread-ack.ts, src/core/org/thread-known.ts; 2026-11-20, the user: "I acknowledge it,
 * but that does not mean the thread is gone ... the thread is truly closed only when the problem is
 * really solved"; then "if I ack and ai should determine if it should go to closed or wait or wip",
 * and "keep Acknowledged, simpler").
 *
 *   Bakery lead (a session) ─ "Fix the oven timer" (open) ─ "Order the flour" (done)
 *
 *   1. off: his Acknowledge closes a thread whose task still runs, as before;
 *   2. on: every Acknowledge sends the card to Acknowledged ("AI is deciding where this goes."),
 *      out of his view, the ack recorded; the node hears it once with Walnut's own reading;
 *   3. the node decides first (thread_update place + place_why): its decision wins, the card says
 *      where it went and why, and Walnut never moves it after;
 *   4. the node's own close is its decision too; a place on a thread he did not acknowledge, or
 *      his own, is refused;
 *   5. nobody decided in 10 minutes (fake clock): nothing stays in Acknowledged; Walnut places each
 *      by the rule (Closed, Waiting, Working) with why, and logs it;
 *   6. one Walnut placed in Working: when its task is done the node hears it once, and 10 minutes
 *      later Walnut closes it; one with news the node left pending comes back to Done;
 *   7. he writes in one: it is working, not acknowledged; his second Acknowledge closes it;
 *   8. a thread that changed after the pass read it is settled only as it is now;
 *   9. the flag turned off: one left in Acknowledged is still placed.
 *   Neither the placement nor the close buzzes his phone.
 *
 * What's real: server, bus, task store, threads store, the riding store, the session runner, the
 * push path up to Apple's service. Mocked: constants, the daemon (MockDaemon), the CLI, Apple's service.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-thread-ack-known'))
const sendApns = vi.hoisted(() => vi.fn(async (targets: unknown[]) => ({ attempted: true, sent: targets.length, failed: 0, deadTokens: [] as string[] })))
vi.mock('../../src/core/push/apns.js', () => ({
  sendApns,
  apnsStatus: vi.fn(async () => ({ configured: true, environment: 'production', topic: 'test' })),
}))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'
import { addTask, listTasks, updateTaskRaw } from '../../src/core/task-manager.js'
import { getSessionByClaudeId } from '../../src/core/session-tracker.js'
import { updateConfig } from '../../src/core/config-manager.js'
import { ensureProjectLead } from '../../src/core/org/org-store.js'
import { fileThreadMessage, patchThread, readThreads, setThreadAnswers } from '../../src/core/org/threads-store.js'
import { runThreadFollowPass } from '../../src/core/org/thread-follow.js'
import { ackedThreads, openTasksOf, settleKnown } from '../../src/core/org/thread-ack.js'
import { ackOutcome, ackWhy } from '../../src/core/org/thread-ack-outcome.js'
import { ACK_DECIDING_LINE, KNOWN_CLOSE_MS, ackCardLine, inAcknowledged, isKnown } from '../../src/core/org/thread-known.js'
import { threadGroupOf } from '../../src/core/org/thread-groups.js'
import { pendingRiding, ridingLine } from '../../src/core/sessions/status-riding.js'
import type { AckWaits } from '../../src/core/org/thread-known.js'
import type { OrgThread } from '../../src/core/org/threads-model.js'

let daemon: MockDaemon
let port: number
let lead = ''
let sid = ''
let oven = ''
let flour = ''
const MOCK_CLI = path.resolve(import.meta.dirname, '../providers/mock-claude.mjs')

async function api<T = Record<string, unknown>>(method: string, p: string, body?: unknown, callerSid?: string): Promise<{ status: number; json: T }> {
  const res = await fetch(`http://127.0.0.1:${port}${p.startsWith('/api/') ? '' : '/api/v1'}${p}`, {
    method,
    headers: { 'content-type': 'application/json', ...(callerSid ? { 'x-walnut-caller-sid': callerSid } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  return { status: res.status, json: await res.json().catch(() => ({})) as T }
}

async function flag(on: boolean): Promise<void> {
  expect((await api('PUT', '/api/config', { experimental: { ack_means_known: on } })).status).toBe(200)
}

async function shownCount(): Promise<number> {
  const r = await api<{ shown_count: number }>('GET', `/tasks/${lead}/threads`)
  expect(r.status).toBe(200)
  return r.json.shown_count
}

/** One ask of his the node answered and handed to `tasks`, in `state`: answered (the result is on his card) or working. */
async function leadThread(text: string, tasks: string[], state: 'answered' | 'working' = 'answered'): Promise<string> {
  const filed = await fileThreadMessage(lead, { text, via: 'chat', at: new Date().toISOString() })
  await setThreadAnswers(lead, new Map([[filed.message.id, { text: 'Handed it on; I will tell you how it went.', at: new Date().toISOString() }]]))
  await patchThread(lead, filed.thread.id, { title: text.slice(0, 30), state, reply: 'It is with the team now.', tasks }, `task:${lead}`)
  return filed.thread.id
}
const answeredThread = (text: string, tasks: string[]) => leadThread(text, tasks, 'answered')
const runningThread = (text: string, tasks: string[]) => leadThread(text, tasks, 'working')

type ReadThread = OrgThread & { shown: boolean; awaits?: AckWaits }
async function readOne(id: string): Promise<ReadThread> {
  const r = await api<{ threads: ReadThread[] }>('GET', `/tasks/${lead}/threads`)
  expect(r.status).toBe(200)
  return r.json.threads.find((t) => t.id === id)!
}

async function newTask(title: string, description?: string): Promise<string> {
  const id = (await addTask({ title, project: 'Bakery', parent_task_id: lead, ...(description ? { description } : {}) })).task.id
  await updateTaskRaw(id, { phase: 'IN_PROGRESS' } as never, { emitEvent: true })
  return id
}

/** Nothing reached Apple's service, and no thread of these was ever marked as buzzed. */
async function noBuzz(...ids: string[]): Promise<void> {
  expect(sendApns).not.toHaveBeenCalled()
  for (const id of ids) expect((await threadOf(id)).needsBuzzedAt).toBeUndefined()
}

async function threadOf(id: string): Promise<OrgThread> {
  return (await readThreads(lead)).threads.find((t) => t.id === id)!
}

const ack = (id: string) => api<{ thread: OrgThread }>('PATCH', `/tasks/${lead}/threads/${id}`, { close: 'acked' })

beforeAll(async () => {
  process.env.WALNUT_THREAD_FOLLOW = '0'
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  daemon = await createMockDaemon()
  sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemon.port}`)
  daemon.setCliCommand(MOCK_CLI)
  const server = await startServer({ port: 0, dev: true })
  port = (server.address() as { port: number }).port
  // One phone, so a buzz would have somewhere to go.
  await updateConfig({ push_tokens: [{ token: 'a'.repeat(64), platform: 'ios' }] } as never)
  lead = (await ensureProjectLead('Bakery')).id
  oven = (await addTask({ title: 'Fix the oven timer', project: 'Bakery', parent_task_id: lead })).task.id
  flour = (await addTask({ title: 'Order the flour', project: 'Bakery', parent_task_id: lead })).task.id
  await updateTaskRaw(oven, { phase: 'IN_PROGRESS' } as never, { emitEvent: true })
  await updateTaskRaw(flour, { phase: 'COMPLETE' } as never, { emitEvent: true })
  sid = (await sessionRunner.startSession({ taskId: lead, cwd: WALNUT_HOME, message: 'Ready', project: 'Bakery', preassignedSessionId: randomUUID() })).claudeSessionId
  await vi.waitFor(async () => {
    expect((await getSessionByClaudeId(sid))?.process_status).toMatch(/idle|stopped/)
  }, { timeout: 20_000 })
}, 120_000)

afterAll(async () => {
  sessionRunner.setTestDaemonUrl(undefined)
  await stopServer()
  await daemon?.stop()
  delete process.env.WALNUT_THREAD_FOLLOW
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
}, 60_000)

/** The node's thread_update on `id` from its own session. */
const nodePatch = (id: string, body: Record<string, unknown>) => api<{ thread: OrgThread; error?: string }>('PATCH', `/tasks/${lead}/threads/${id}`, body, sid)
/** Ten minutes after now, and a little: past the node's time to decide. */
const pastDeadline = () => Date.now() + KNOWN_CLOSE_MS + 1_000

describe('his Acknowledge means he knows', () => {
  it('off: Acknowledge closes a thread whose task still runs, as today', async () => {
    await flag(false)
    const id = await runningThread('Fix the oven timer before Friday', [oven])
    const r = await ack(id)
    expect(r.status).toBe(200)
    expect(r.json.thread.closed).toMatchObject({ how: 'acked', by: 'human' })
    expect((await threadOf(id)).ackedAt).toBeUndefined()
    expect(ridingLine(sid, `thread-ack:${id}`)).toBeUndefined()
  })

  it('on: the card goes to Acknowledged at once, out of his view; the node hears it once with Walnut\'s reading', async () => {
    await flag(true)
    const proof = await newTask('Prove the oven holds 180', 'Run the oven for an hour and log the temperature every minute.')
    const id = await runningThread('Keep the oven at 180 degrees', [proof])
    const before = await shownCount()
    const r = await ack(id)
    expect(r.status).toBe(200)
    expect(r.json.thread.closed).toBeUndefined()
    expect(r.json.thread.state).toBe('pending')
    const t = await threadOf(id)
    expect(t.ackedAt).toBeTruthy()
    expect(inAcknowledged(t)).toBe(true)
    expect(t.known).toMatchObject({ by: 'human', through: t.messages[t.messages.length - 1].id })
    expect(threadGroupOf(t, false)).toBe('known')
    expect(ackCardLine(t)).toBe(ACK_DECIDING_LINE)
    expect(await shownCount()).toBe(before)
    const read = await readOne(id)
    expect(read.shown).toBe(false)
    expect(read.awaits).toEqual({
      tasks: [{ id: proof, title: 'Prove the oven holds 180', what: 'Run the oven for an hour and log the temperature every minute.' }],
      replies: false, letter: false,
    })
    const line = ridingLine(sid, `thread-ack:${id}`)
    expect(line).toContain(`He acknowledged thread ${id}`)
    expect(line).toContain('Decide now with thread_update place')
    expect(line).toContain(`Walnut reads it as working: work on it still runs ("Prove the oven holds 180" (${proof}))`)
    expect(line).toContain('Walnut places it there in 10 minutes.')
    // Told once: the item leaves with the message that carries it.
    const ride = pendingRiding(sid)!
    expect(ride.text).toContain(`He acknowledged thread ${id}`)
    ride.markTold()
    expect(ridingLine(sid, `thread-ack:${id}`)).toBeUndefined()
  })

  it('on: even a card the rule would close goes to Acknowledged first, and the node hears the rule says closed', async () => {
    const sign = await newTask('Paint the shop sign')
    const id = await answeredThread('Tell me how the oven timer went', [sign])
    const r = await ack(id)
    expect(r.json.thread.closed).toBeUndefined()
    expect(inAcknowledged(await threadOf(id))).toBe(true)
    expect(ridingLine(sid, `thread-ack:${id}`)).toContain('Walnut reads it as closed: nothing on it is still open, so it closes;')
    pendingRiding(sid)?.markTold()
  })

  it('the node decides first: its place wins, the card says where and why, and Walnut never moves it after', async () => {
    sendApns.mockClear()
    const id = await runningThread('Bake the test loaf', [oven])
    await ack(id)
    pendingRiding(sid)?.markTold()
    const r = await nodePatch(id, { place: 'waiting', place_why: 'waits on the new thermostat, due Friday' })
    expect(r.status).toBe(200)
    const t = await threadOf(id)
    expect(t.ackPlaced).toMatchObject({ to: 'waiting', by: 'node', why: 'waits on the new thermostat, due Friday' })
    expect(t.state).toBe('pending')
    expect(threadGroupOf(t, false)).toBe('waiting')
    expect(ackCardLine(t)).toBe('Moved to Waiting: waits on the new thermostat, due Friday')
    // Past the deadline, and long after: the node's decision stands (its task still works, the rule would say Working).
    await runThreadFollowPass({ now: pastDeadline() })
    await runThreadFollowPass({ now: pastDeadline() + 6 * KNOWN_CLOSE_MS })
    expect((await threadOf(id)).ackPlaced).toMatchObject({ to: 'waiting', by: 'node' })
    expect((await threadOf(id)).closed).toBeUndefined()
    // It may change its mind while it stays acknowledged.
    expect((await nodePatch(id, { place: 'working', place_why: 'the oven task is on it now' })).status).toBe(200)
    expect(threadGroupOf(await threadOf(id), false)).toBe('working')
    expect((await nodePatch(id, { place: 'closed', place_why: 'the loaf is baked and he saw the photo' })).json.thread.closed).toMatchObject({ how: 'acked', by: `task:${lead}` })
    expect(ackCardLine(await threadOf(id))).toBe('Moved to Closed: the loaf is baked and he saw the photo')
    await noBuzz(id)
  })

  it('the node\'s own close on one he acknowledged is its decision; a place anywhere else is refused', async () => {
    const id = await answeredThread('Check the oven thermostat', [oven])
    // Before his ack the node may not close an answer he never reacted to, nor place it.
    expect((await nodePatch(id, { close: 'acked' })).status).toBe(409)
    expect((await nodePatch(id, { place: 'closed', place_why: 'done' })).status).toBe(409)
    await ack(id)
    pendingRiding(sid)?.markTold()
    // His own place, a place without a why, or with a state: refused.
    expect((await api('PATCH', `/tasks/${lead}/threads/${id}`, { place: 'closed', place_why: 'done' })).status).toBe(400)
    expect((await nodePatch(id, { place: 'waiting' })).status).toBe(400)
    expect((await nodePatch(id, { place: 'waiting', place_why: 'x', state: 'pending' })).status).toBe(400)
    expect((await nodePatch(id, { place: 'waiting', place_why: 'x', reply: 'All good.' })).status).toBe(400)
    const r = await nodePatch(id, { close: 'acked' })
    expect(r.status).toBe(200)
    expect(r.json.thread.closed).toMatchObject({ how: 'acked', by: `task:${lead}` })
    expect((await threadOf(id)).ackPlaced).toMatchObject({ to: 'closed', by: 'node' })
  })

  it('nobody decided in 10 minutes (fake clock): nothing stays in Acknowledged; the rule places each, with why', async () => {
    sendApns.mockClear()
    const proving = await newTask('Proof the rye dough')
    // Its session at work on it (the status sync may derive it again: wait until it reads working).
    await updateTaskRaw(proving, { status_report: { state: 'working', now: 'Kneading', at: new Date().toISOString() }, user_status: { state: 'working' } } as never, { emitEvent: true })
    await vi.waitFor(async () => expect((await listTasks()).find((x) => x.id === proving)?.user_status?.state).toBe('working'), { timeout: 5_000 })
    const cooling = await newTask('Cool the rye loaves')
    await updateTaskRaw(cooling, { phase: 'WAITING', user_status: { state: 'waiting', waitingOn: 'the loaves to cool', until: new Date(Date.now() + 3_600_000).toISOString() } } as never, { emitEvent: true })
    const ids = {
      working: await runningThread('Proof the rye dough today', [proving]),
      waiting: await runningThread('Cool the rye loaves tonight', [cooling]),
      closed: await runningThread('Order the rye flour', [flour]),
    }
    for (const id of Object.values(ids)) { await ack(id); pendingRiding(sid)?.markTold() }
    const ackedAt = Date.parse((await threadOf(ids.working)).ackedAt!)
    // Before the deadline they wait for the node.
    await runThreadFollowPass({ now: ackedAt + KNOWN_CLOSE_MS - 2_000 })
    for (const id of Object.values(ids)) expect(inAcknowledged(await threadOf(id)), id).toBe(true)
    // The rule as it reads the store now.
    const open = openTasksOf(await listTasks())
    const rule = new Map(await Promise.all(Object.values(ids).map(async (id) => [id, ackOutcome(await threadOf(id), open)] as const)))
    expect(rule.get(ids.closed)?.outcome).toBe('closed')
    expect(rule.get(ids.waiting)?.outcome).toBe('waiting')
    expect(rule.get(ids.working)?.outcome).toBe('working')
    await runThreadFollowPass({ now: pastDeadline() })
    for (const id of Object.values(ids)) expect(inAcknowledged(await threadOf(id)), id).toBe(false)
    for (const id of [ids.working, ids.waiting]) {
      const t = await threadOf(id)
      const r = rule.get(id)!
      expect(t.ackPlaced, id).toMatchObject({ to: r.outcome, by: 'walnut', why: ackWhy(r) })
      expect(threadGroupOf(t, false), id).toBe(r.outcome)
      expect(ackCardLine(t), id).toBe(`Moved to ${r.outcome === 'working' ? 'Working' : 'Waiting'} by Walnut: ${ackWhy(r)}`)
    }
    const waiting = await threadOf(ids.waiting)
    expect(waiting.ackPlaced).toMatchObject({ to: 'waiting', by: 'walnut', why: 'waits on \u201cCool the rye loaves\u201d' })
    expect(threadGroupOf(waiting, false)).toBe('waiting')
    expect((await readOne(ids.waiting)).awaits?.tasks[0]).toMatchObject({ id: cooling })
    const closed = await threadOf(ids.closed)
    expect(closed.closed).toMatchObject({ how: 'acked', by: 'agent', reacted: true })
    expect(ackCardLine(closed)).toBe('Moved to Closed by Walnut: nothing on it was still open')
    // The node is not told again for a placement; nothing buzzed.
    expect(ridingLine(sid, `thread-ack:${ids.working}`)).toBeUndefined()
    await noBuzz(...Object.values(ids))
  })

  it('one he pinned in Acknowledged stays in his hands: Walnut places it in Waiting, never closes it, and its timer never spins', async () => {
    const id = await runningThread('Order the oven gloves', [flour])
    await ack(id)
    pendingRiding(sid)?.markTold()
    expect((await api('PATCH', `/tasks/${lead}/threads/${id}`, { pin: true })).status).toBe(200)
    const t0 = pastDeadline()
    await runThreadFollowPass({ now: t0 })
    const placed = await threadOf(id)
    expect(placed.ackPlaced).toMatchObject({ to: 'waiting', by: 'walnut', why: 'nothing on it is open; you pinned it' })
    expect(placed.closed).toBeUndefined()
    await runThreadFollowPass({ now: t0 + 1_000 })
    pendingRiding(sid)?.markTold()
    expect((await threadOf(id)).ackDone).toBeTruthy()
    // Long past its close time: still his, and the next due time is never one already past.
    const late = t0 + 3 * KNOWN_CLOSE_MS
    const r = await settleKnown(await ackedThreads(), openTasksOf(await listTasks()), late)
    expect((await threadOf(id)).closed).toBeUndefined()
    expect(r.nextAt === undefined || r.nextAt > late).toBe(true)
    expect((await api('PATCH', `/tasks/${lead}/threads/${id}`, { pin: false })).status).toBe(200)
  })

  it('one Walnut placed while its task was open: its task done, the node hears it once, and 10 minutes later Walnut closes it quietly', async () => {
    sendApns.mockClear()
    const dough = await newTask('Proof the dough overnight')
    const id = await runningThread('Proof the dough for tomorrow', [dough])
    await ack(id)
    pendingRiding(sid)?.markTold()
    await runThreadFollowPass({ now: pastDeadline() })
    // Working while a session runs it; marked in progress with none, Waiting: either way still open.
    expect(['working', 'waiting']).toContain((await threadOf(id)).ackPlaced?.to)
    expect((await threadOf(id)).ackPlaced?.by).toBe('walnut')
    expect((await threadOf(id)).ackDone).toBeUndefined()
    await updateTaskRaw(dough, { phase: 'COMPLETE' } as never, { emitEvent: true })
    const doneAt = pastDeadline() + 60_000
    await runThreadFollowPass({ now: doneAt })
    const line = ridingLine(sid, `thread-ack:${id}`)
    expect(line).toContain(`Thread ${id}`)
    expect(line).toContain('nothing on it is open now.')
    expect(line).toContain('Walnut closes it in 10 minutes.')
    expect((await threadOf(id)).ackDone).toBe(new Date(doneAt).toISOString())
    pendingRiding(sid)?.markTold()
    await runThreadFollowPass({ now: doneAt + KNOWN_CLOSE_MS - 1_000 })
    expect(isKnown(await threadOf(id))).toBe(true)
    await runThreadFollowPass({ now: doneAt + KNOWN_CLOSE_MS })
    const closed = await threadOf(id)
    expect(closed.closed).toMatchObject({ how: 'acked', by: 'agent', reacted: true })
    expect(ackCardLine(closed)).toBe('Moved to Closed by Walnut: its work ended and nothing new came')
    expect((await readOne(id)).shown).toBe(false)
    await noBuzz(id)
  })

  it('the node brings the outcome instead of placing it: Done, and the settling leaves it there', async () => {
    sendApns.mockClear()
    const knob = await newTask('Replace the timer knob')
    const id = await runningThread('Replace the oven timer knob', [knob])
    await ack(id)
    pendingRiding(sid)?.markTold()
    const r = await nodePatch(id, { state: 'answered', reply: 'The new knob is on and the timer counts down right.' })
    expect(r.status).toBe(200)
    const read = await readOne(id)
    expect(read.state).toBe('answered')
    expect(read.shown).toBe(true)
    await runThreadFollowPass({ now: pastDeadline() })
    expect((await readOne(id)).shown).toBe(true)
    expect((await ack(id)).json.thread.closed).toBeUndefined()
    await noBuzz(id)
  })

  it('news the node left pending while nobody decided: at the deadline it comes back to Done, never closed unseen', async () => {
    sendApns.mockClear()
    const tray = await newTask('Wash the baking trays')
    const id = await runningThread('Wash the trays before Monday', [tray])
    await ack(id)
    pendingRiding(sid)?.markTold()
    expect((await nodePatch(id, { state: 'pending', reply: 'All twelve trays are washed and stacked.' })).status).toBe(200)
    await updateTaskRaw(tray, { phase: 'COMPLETE' } as never, { emitEvent: true })
    await runThreadFollowPass({ now: pastDeadline() })
    const back = await readOne(id)
    expect(back.closed).toBeUndefined()
    expect(back.state).toBe('answered')
    expect(back.shown).toBe(true)
    await noBuzz(id)
  })

  it('he writes in one he acknowledged: it is working again; his second Acknowledge closes it at once', async () => {
    const id = await runningThread('Clean the oven door', [oven])
    await ack(id)
    pendingRiding(sid)?.markTold()
    await fileThreadMessage(lead, { text: 'and the glass inside too', via: 'follow-up', threadId: id, at: new Date().toISOString() })
    const t = await threadOf(id)
    expect(t.state).toBe('working')
    expect(isKnown(t)).toBe(false)
    expect(ackCardLine(t)).toBeNull()
    expect((await readOne(id)).awaits).toBeUndefined()
    const id2 = await runningThread('Set the oven timer for the bread', [oven])
    await ack(id2)
    pendingRiding(sid)?.markTold()
    const r = await ack(id2)
    expect(r.json.thread.closed).toMatchObject({ how: 'acked', by: 'human' })
    expect(ridingLine(sid, `thread-ack:${id2}`)).toBeUndefined()
  })

  it('a thread that changed after the pass read it is settled only as it is now', async () => {
    const jar = await newTask('Label the jam jars')
    const id = await runningThread('Label the jars', [jar])
    await ack(id)
    pendingRiding(sid)?.markTold()
    const open = openTasksOf(await listTasks())
    // Read before he writes in it: the pass would place it.
    const stale = await ackedThreads()
    expect(stale.some((n) => n.threads.some((t) => t.id === id))).toBe(true)
    await fileThreadMessage(lead, { text: 'use the round labels', via: 'follow-up', threadId: id, at: new Date().toISOString() })
    const r = await settleKnown(stale, open, pastDeadline())
    expect(r.placed).toBe(0)
    expect((await threadOf(id)).ackPlaced).toBeUndefined()
    expect((await threadOf(id)).state).toBe('working')
    // A task added to its list after the read: it waits for a pass that knows that task.
    const lid = await newTask('Print the lids')
    const id2 = await runningThread('Print the jar lids', [jar])
    await ack(id2)
    pendingRiding(sid)?.markTold()
    const before = await ackedThreads()
    await patchThread(lead, id2, { add_tasks: [lid] }, `task:${lead}`)
    expect((await settleKnown(before, open, pastDeadline())).placed).toBe(0)
    expect(inAcknowledged(await threadOf(id2))).toBe(true)
  })

  it('the flag turned off: one left in Acknowledged is still placed, never left there', async () => {
    const bin = await newTask('Empty the flour bin')
    const id = await runningThread('Empty the flour bin', [bin])
    await ack(id)
    pendingRiding(sid)?.markTold()
    await flag(false)
    try {
      await runThreadFollowPass({ now: pastDeadline() })
      expect((await threadOf(id)).ackPlaced?.by).toBe('walnut')
      expect(inAcknowledged(await threadOf(id))).toBe(false)
    } finally {
      await flag(true)
    }
  })
})
