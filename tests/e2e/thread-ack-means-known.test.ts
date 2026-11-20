/**
 * His Acknowledge means he knows, on a real server (experiment ack_means_known,
 * src/core/org/thread-ack.ts, src/core/org/thread-known.ts; 2026-11-20, the user: "I acknowledge it,
 * but that does not mean the thread is gone ... the thread is truly closed only when the problem is
 * really solved"; then "I ack, she sees it herself, nothing else, so it closes, right?").
 *
 *   Bakery lead (a session) ─ "Fix the oven timer" (open) ─ "Order the flour" (done)
 *
 *   1. off: his Acknowledge closes a thread whose task still runs, as before;
 *   2. A, on: a card that holds the result (answered) closes, its task still open;
 *   3. B, on, its task still open: Known (pending, every exchange known by him, out of his view,
 *      the ack recorded), the read says what it waits on; the node hears it once;
 *   4. on, nothing open: it closes as before;
 *   5. the node may close the thread he acknowledged without a new reaction of his;
 *   6. B's task done and the node writes the outcome: back to To read;
 *   7. B's task done and nothing new: the node hears it once, and 10 minutes later Walnut closes it;
 *   8. he writes in a Known thread: it is working, not Known;
 *   9. the node wrote something new and left it pending: Walnut brings it back to To read;
 *  10. his second Acknowledge (Close) on a Known thread closes it at once;
 *  11. a thread that changed after the pass read it is settled only as it is now;
 *  12. the flag turned off: a Known thread left from before is still settled.
 *   Neither the return nor the close buzzes his phone.
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
import { KNOWN_CLOSE_MS, isKnown } from '../../src/core/org/thread-known.js'
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

  it('A, on: a card that holds the result closes for good, its task still open', async () => {
    await flag(true)
    const id = await answeredThread('Tell me how the oven timer went', [oven])
    const r = await ack(id)
    expect(r.status).toBe(200)
    expect(r.json.thread.closed).toMatchObject({ how: 'acked', by: 'human' })
    const t = await threadOf(id)
    expect(t.ackedAt).toBeUndefined()
    expect(isKnown(t)).toBe(false)
    expect(ridingLine(sid, `thread-ack:${id}`)).toBeUndefined()
    // The follow pass leaves it closed.
    await runThreadFollowPass()
    expect((await threadOf(id)).closed).toMatchObject({ how: 'acked', by: 'human' })
  })

  it('B, on, its task still open: Known, out of his view, the read says what it waits on, the node hears it once', async () => {
    const proof = await newTask('Prove the oven holds 180', 'Run the oven for an hour and log the temperature every minute.')
    const id = await runningThread('Keep the oven at 180 degrees', [proof])
    const before = await shownCount()
    const r = await ack(id)
    expect(r.status).toBe(200)
    expect(r.json.thread.closed).toBeUndefined()
    expect(r.json.thread.state).toBe('pending')
    const t = await threadOf(id)
    expect(t.closed).toBeUndefined()
    expect(t.state).toBe('pending')
    expect(t.ackedAt).toBeTruthy()
    expect(isKnown(t)).toBe(true)
    expect(t.known).toMatchObject({ by: 'human', through: t.messages[t.messages.length - 1].id })
    // A thread at work was out of his view before; it stays out, Known.
    expect(await shownCount()).toBe(before)
    const read = await readOne(id)
    expect(read.shown).toBe(false)
    expect(read.awaits).toEqual({
      tasks: [{ id: proof, title: 'Prove the oven holds 180', what: 'Run the oven for an hour and log the temperature every minute.' }],
      replies: false, letter: false,
    })
    // The write's answer carries it too, so the card says it at once.
    expect((r.json.thread as ReadThread).awaits?.tasks.map((x) => x.id)).toEqual([proof])
    const line = ridingLine(sid, `thread-ack:${id}`)
    expect(line).toContain(`He acknowledged thread ${id}`)
    expect(line).toContain(`it waits on "Prove the oven holds 180" (${proof})`)
    expect(line).toContain('set it answered with the outcome only if there is something he has not seen (he closes it); otherwise close it yourself.')
    // Told once: the item leaves with the message that carries it.
    const ride = pendingRiding(sid)!
    expect(ride.text).toContain(`He acknowledged thread ${id}`)
    ride.markTold()
    expect(ridingLine(sid, `thread-ack:${id}`)).toBeUndefined()
  })

  it('on, nothing open on it: Acknowledge closes it as before', async () => {
    const id = await runningThread('Order the rye flour', [flour])
    const r = await ack(id)
    expect(r.json.thread.closed).toMatchObject({ how: 'acked', by: 'human' })
    expect(ridingLine(sid, `thread-ack:${id}`)).toBeUndefined()
  })

  it('the node closes the thread he acknowledged without a new reaction of his', async () => {
    const id = await answeredThread('Check the oven thermostat', [oven])
    // Before his ack the node may not close an answer he never reacted to.
    expect((await api('PATCH', `/tasks/${lead}/threads/${id}`, { close: 'acked' }, sid)).status).toBe(409)
    await patchThread(lead, id, { state: 'working' }, `task:${lead}`)
    await ack(id)
    expect(isKnown(await threadOf(id))).toBe(true)
    const r = await api<{ thread: OrgThread }>('PATCH', `/tasks/${lead}/threads/${id}`, { close: 'acked' }, sid)
    expect(r.status).toBe(200)
    expect(r.json.thread.closed).toMatchObject({ how: 'acked', by: `task:${lead}` })
  })

  it('B, its task done and the node writes the outcome: back to To read, and the phone stays quiet', async () => {
    sendApns.mockClear()
    const knob = await newTask('Replace the timer knob')
    const id = await runningThread('Replace the oven timer knob', [knob])
    await ack(id)
    pendingRiding(sid)?.markTold()
    await updateTaskRaw(knob, { phase: 'COMPLETE' } as never, { emitEvent: true })
    await runThreadFollowPass()
    expect((await threadOf(id)).ackDone).toBeTruthy()
    pendingRiding(sid)?.markTold()
    // The node brings the outcome (its thread_update).
    const r = await api<{ thread: OrgThread }>('PATCH', `/tasks/${lead}/threads/${id}`, { state: 'answered', reply: 'The new knob is on and the timer counts down right.' }, sid)
    expect(r.status).toBe(200)
    const read = await readOne(id)
    expect(read.closed).toBeUndefined()
    expect(read.state).toBe('answered')
    expect(read.shown).toBe(true)
    expect(read.awaits).toBeUndefined()
    // Settling later leaves it on his card: it is not Known any more.
    await runThreadFollowPass({ now: Date.now() + KNOWN_CLOSE_MS + 60_000 })
    expect((await readOne(id)).shown).toBe(true)
    // And now it is a result: his Acknowledge closes it (A).
    expect((await ack(id)).json.thread.closed).toMatchObject({ how: 'acked', by: 'human' })
    await noBuzz(id)
  })

  it('B, its task done and nothing new: the node hears it once, and 10 minutes later Walnut closes it quietly', async () => {
    sendApns.mockClear()
    const dough = await newTask('Proof the dough overnight')
    const id = await runningThread('Proof the dough for tomorrow', [dough])
    await ack(id)
    pendingRiding(sid)?.markTold()
    await runThreadFollowPass()
    expect(ridingLine(sid, `thread-ack:${id}`)).toBeUndefined()
    expect((await threadOf(id)).ackDone).toBeUndefined()
    await updateTaskRaw(dough, { phase: 'COMPLETE' } as never, { emitEvent: true })
    const doneAt = Date.now()
    await runThreadFollowPass({ now: doneAt })
    const line = ridingLine(sid, `thread-ack:${id}`)
    expect(line).toContain(`Thread ${id}`)
    expect(line).toContain('nothing on it is open now.')
    expect(line).toContain('Walnut closes it in 10 minutes.')
    const told = await threadOf(id)
    expect(told.ackDone).toBe(new Date(doneAt).toISOString())
    expect(isKnown(told)).toBe(true)
    expect((await readOne(id)).awaits).toEqual({ tasks: [], replies: false, letter: false })
    pendingRiding(sid)?.markTold()
    // Told once, and still Known before the 10 minutes are up.
    await runThreadFollowPass({ now: doneAt + KNOWN_CLOSE_MS - 1_000 })
    expect(ridingLine(sid, `thread-ack:${id}`)).toBeUndefined()
    expect(isKnown(await threadOf(id))).toBe(true)
    // The node did nothing: Walnut closes it, as his Acknowledge already covered it.
    await runThreadFollowPass({ now: doneAt + KNOWN_CLOSE_MS })
    const closed = await threadOf(id)
    expect(closed.closed).toMatchObject({ how: 'acked', by: 'agent', reacted: true })
    expect(closed.state).toBe('pending')
    expect((await readOne(id)).shown).toBe(false)
    await noBuzz(id)
  })

  it('he writes in a Known thread: it is working again, not Known', async () => {
    const id = await runningThread('Clean the oven door', [oven])
    await ack(id)
    expect(isKnown(await threadOf(id))).toBe(true)
    pendingRiding(sid)?.markTold()
    await fileThreadMessage(lead, { text: 'and the glass inside too', via: 'follow-up', threadId: id, at: new Date().toISOString() })
    const t = await threadOf(id)
    expect(t.state).toBe('working')
    expect(isKnown(t)).toBe(false)
    expect((await readOne(id)).awaits).toBeUndefined()
  })

  it('the node wrote something new and left it pending: 10 minutes after its work ended Walnut brings it back to To read', async () => {
    sendApns.mockClear()
    const tray = await newTask('Wash the baking trays')
    const id = await runningThread('Wash the trays before Monday', [tray])
    await ack(id)
    pendingRiding(sid)?.markTold()
    // The node's quiet update after his ack: news he has not seen, kept out of sight.
    expect((await api('PATCH', `/tasks/${lead}/threads/${id}`, { state: 'pending', reply: 'All twelve trays are washed and stacked.' }, sid)).status).toBe(200)
    await updateTaskRaw(tray, { phase: 'COMPLETE' } as never, { emitEvent: true })
    const doneAt = Date.now()
    await runThreadFollowPass({ now: doneAt })
    pendingRiding(sid)?.markTold()
    expect((await readOne(id)).shown).toBe(false)
    await runThreadFollowPass({ now: doneAt + KNOWN_CLOSE_MS })
    const back = await readOne(id)
    expect(back.closed).toBeUndefined()
    expect(back.state).toBe('answered')
    expect(back.shown).toBe(true)
    await noBuzz(id)
  })

  it('his second Acknowledge on a Known thread closes it at once', async () => {
    const id = await runningThread('Sharpen the bread knives', [oven])
    await ack(id)
    expect(isKnown(await threadOf(id))).toBe(true)
    pendingRiding(sid)?.markTold()
    const r = await ack(id)
    expect(r.json.thread.closed).toMatchObject({ how: 'acked', by: 'human' })
    expect(ridingLine(sid, `thread-ack:${id}`)).toBeUndefined()
  })

  it('a thread that changed after the pass read it is settled only as it is now', async () => {
    const jar = await newTask('Label the jam jars')
    const id = await runningThread('Label the jars', [jar])
    await ack(id)
    pendingRiding(sid)?.markTold()
    await updateTaskRaw(jar, { phase: 'COMPLETE' } as never, { emitEvent: true })
    const open = openTasksOf(await listTasks())
    // Read before he writes in it: the pass would tell the node its work ended.
    const stale = await ackedThreads()
    expect(stale.some((n) => n.threads.some((t) => t.id === id))).toBe(true)
    await fileThreadMessage(lead, { text: 'use the round labels', via: 'follow-up', threadId: id, at: new Date().toISOString() })
    const r = await settleKnown(stale, open)
    expect(r.told).toBe(0)
    expect((await threadOf(id)).ackDone).toBeUndefined()
    expect((await threadOf(id)).state).toBe('working')
    expect(ridingLine(sid, `thread-ack:${id}`)).toBeUndefined()
    // A task added to its list after the read: it waits for a pass that knows that task.
    const lid = await newTask('Print the lids')
    const id2 = await runningThread('Print the jar lids', [jar])
    await ack(id2)
    pendingRiding(sid)?.markTold()
    const before = await ackedThreads()
    await patchThread(lead, id2, { add_tasks: [lid] }, `task:${lead}`)
    expect((await settleKnown(before, open)).told).toBe(0)
    expect((await threadOf(id2)).ackDone).toBeUndefined()
  })

  it('the flag turned off: a Known thread left from before is still settled, never left Known', async () => {
    const bin = await newTask('Empty the flour bin')
    const id = await runningThread('Empty the flour bin', [bin])
    await ack(id)
    pendingRiding(sid)?.markTold()
    await flag(false)
    try {
      await updateTaskRaw(bin, { phase: 'COMPLETE' } as never, { emitEvent: true })
      const doneAt = Date.now()
      await runThreadFollowPass({ now: doneAt })
      expect((await threadOf(id)).ackDone).toBeTruthy()
      pendingRiding(sid)?.markTold()
      await runThreadFollowPass({ now: doneAt + KNOWN_CLOSE_MS })
      expect((await threadOf(id)).closed).toMatchObject({ how: 'acked', by: 'agent' })
    } finally {
      await flag(true)
    }
  })
})
