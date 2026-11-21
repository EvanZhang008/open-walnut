/**
 * Threads pop up, on a real server (experiment threads_pop_up, src/core/org/thread-popup.ts and
 * thread-reply.ts; 2026-11-20, the user: "the thread can pop up like the leader's thread can go up
 * ... if we reply I think it should go directly to that thread, also send a buffer message to the
 * main agent").
 *
 *   Orchard VP ─ "Plan the orchard" (Threads on) ─ "Order the seed trays" (Threads on, owner)
 *                                                └ "Fix the drip hose" (Threads on, no session)
 *
 *   1. off: the leader's list is its own threads only;
 *   2. on: the owner's needs thread is listed by the leader, the VP and Main, the same id, with its
 *      owner; only the owner reads Needs you;
 *   3. his reply at the leader lands in the owner's thread and its session; the leaders get one
 *      line riding their next message and no message of their own;
 *   4. five quick replies to one owner are one message; a reply to an older ask is marked stale;
 *   5. a reply while the owner has no session stays pending (the owner cannot close the thread)
 *      and goes when a session of it starts;
 *   6. a move changes the owner: one copy, and the old link still finds it.
 *
 * What's real: server, bus, task store, threads store, the queue, the session runner. Mocked:
 * constants, the daemon (MockDaemon), the CLI.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Server } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-threads-pop-up'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'
import { addTask, getTask, updateTaskRaw } from '../../src/core/task-manager.js'
import { getSessionByClaudeId } from '../../src/core/session-tracker.js'
import { ensureMainTask, ensureProjectLead } from '../../src/core/org/org-store.js'
import { openNodeThread, patchThread, readThreads, threadTaskIds } from '../../src/core/org/threads-store.js'
import { threadsPopUpNow } from '../../src/core/org/thread-popup.js'
import { ridingKeys, ridingLine } from '../../src/core/sessions/status-riding.js'
import { ANSWERED_KEY } from '../../src/core/org/thread-answered-notes.js'
import { bus, EventNames } from '../../src/core/event-bus.js'
import { syncUserStatuses, settleUserStatusSync } from '../../src/core/user-status-sync.js'
import { DaemonConnection } from '../../src/providers/daemon-connection.js'
import type { OrgThread, ThreadMessage } from '../../src/core/org/threads-model.js'

let server: Server
let daemon: MockDaemon
let port: number
const MOCK_CLI = path.resolve(import.meta.dirname, '../providers/mock-claude.mjs')

type Node = { taskId: string; sid: string }
let main: Node
let vp: Node
let garden: Node
let plan: Node
let trays: Node
let hose = ''

/** Every message queued into a session, by session id. */
const queued = new Map<string, Array<{ messageId: string; message?: string }>>()

async function startSessionFor(taskId: string, project: string): Promise<string> {
  const sid = (await sessionRunner.startSession({ taskId, cwd: WALNUT_HOME, message: 'Ready', project, preassignedSessionId: randomUUID() })).claudeSessionId
  await vi.waitFor(async () => {
    expect((await getSessionByClaudeId(sid))?.process_status).toMatch(/idle|stopped/)
  }, { timeout: 20_000 })
  return sid
}

async function api<T = Record<string, unknown>>(method: string, p: string, body?: unknown, callerSid?: string): Promise<{ status: number; json: T }> {
  const res = await fetch(`http://127.0.0.1:${port}${p.startsWith('/api/') ? '' : '/api/v1'}${p}`, {
    method,
    headers: { 'content-type': 'application/json', ...(callerSid ? { 'x-walnut-caller-sid': callerSid } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  return { status: res.status, json: await res.json().catch(() => ({})) as T }
}

type Listed = OrgThread & { owner?: { task_id: string; title: string }; can_answer_now?: boolean; ask_id?: string }
async function listOf(taskId: string): Promise<{ threads: Listed[]; shown_count: number }> {
  const r = await api<{ threads: Listed[]; shown_count: number }>('GET', `/tasks/${taskId}/threads`)
  expect(r.status).toBe(200)
  return r.json
}

async function flag(on: boolean): Promise<void> {
  expect((await api('PUT', '/api/config', { experimental: { threads_pop_up: on } })).status).toBe(200)
  await vi.waitFor(() => expect(threadsPopUpNow()).toBe(on), { timeout: 5000 })
}

/** The owner asks him something (a needs thread of its own). */
async function ask(taskId: string, title: string): Promise<OrgThread> {
  return openNodeThread(taskId, { title, text: `${title} The orchard budget covers one of them.`, from: 'task', state: 'needs', user_kind: 'spending', user_kind_why: 'It buys orchard supplies with real money',
    // Each asks its own decision beside the task's others (thread-supersede.ts).
    separate_reason: 'Each one is its own orchard supply decision' }, `task:${taskId}`)
}

async function messageOf(owner: string, messageId: string): Promise<ThreadMessage | undefined> {
  return (await readThreads(owner)).threads.flatMap((t) => t.messages).find((m) => m.id === messageId)
}

const otherSids = () => [main.sid, vp.sid, plan.sid]
const queuedCount = (sids: string[]) => sids.reduce((n, sid) => n + (queued.get(sid)?.length ?? 0), 0)

beforeAll(async () => {
  process.env.WALNUT_THREAD_FOLLOW = '0'
  process.env.WALNUT_THREAD_REPLY_GATHER_MS = '800'
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  daemon = await createMockDaemon()
  sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemon.port}`)
  daemon.setCliCommand(MOCK_CLI)
  server = await startServer({ port: 0, dev: true })
  port = (server.address() as { port: number }).port
  const mainTask = await ensureMainTask()
  const vpTask = await ensureProjectLead('Orchard')
  const gardenTask = await ensureProjectLead('Garden')
  const planId = (await addTask({ title: 'Plan the orchard', project: 'Orchard', parent_task_id: vpTask.id })).task.id
  const traysId = (await addTask({ title: 'Order the seed trays', project: 'Orchard', parent_task_id: planId })).task.id
  hose = (await addTask({ title: 'Fix the drip hose', project: 'Orchard', parent_task_id: planId })).task.id
  for (const id of [planId, traysId, hose]) await updateTaskRaw(id, { threads_on: true, phase: 'IN_PROGRESS' } as never, { emitEvent: true })
  main = { taskId: mainTask.id, sid: await startSessionFor(mainTask.id, '') }
  vp = { taskId: vpTask.id, sid: await startSessionFor(vpTask.id, 'Orchard') }
  garden = { taskId: gardenTask.id, sid: await startSessionFor(gardenTask.id, 'Garden') }
  plan = { taskId: planId, sid: await startSessionFor(planId, 'Orchard') }
  trays = { taskId: traysId, sid: await startSessionFor(traysId, 'Orchard') }
  bus.subscribe('test-threads-pop-up', (event) => {
    const d = event.data as { sessionId: string; messageId: string; message?: string }
    queued.set(d.sessionId, [...(queued.get(d.sessionId) ?? []), { messageId: d.messageId, message: d.message }])
  }, { global: true, interest: [EventNames.SESSION_MESSAGE_QUEUED] })
}, 150_000)

afterAll(async () => {
  bus.unsubscribe('test-threads-pop-up')
  sessionRunner.setTestDaemonUrl(undefined)
  await stopServer()
  await daemon?.stop()
  delete process.env.WALNUT_THREAD_FOLLOW
  delete process.env.WALNUT_THREAD_REPLY_GATHER_MS
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
}, 60_000)

let first: OrgThread

describe('threads pop up', () => {
  it('off: a leader lists its own threads only', async () => {
    await flag(false)
    first = await ask(trays.taskId, 'Buy the 72-cell trays or the 128-cell ones?')
    expect((await listOf(plan.taskId)).threads.map((t) => t.id)).not.toContain(first.id)
    expect((await api('GET', `/tasks/${plan.taskId}/threads/${first.id}`)).status).toBe(404)
  })

  it('on: the owner\'s needs thread is the same record in the leader\'s, the VP\'s and Main\'s lists, and only the owner reads Needs you', async () => {
    await flag(true)
    // The thread entered needs before the switch: its next write gives it its ask id.
    await patchThread(trays.taskId, first.id, { ask: 'Buy the 72-cell trays or the 128-cell ones?' }, `task:${trays.taskId}`)
    for (const node of [plan, vp, main]) {
      const list = await listOf(node.taskId)
      const row = list.threads.find((t) => t.id === first.id)
      expect(row, node.taskId).toMatchObject({ state: 'needs', owner: { task_id: trays.taskId, title: 'Order the seed trays' }, can_answer_now: true })
      expect(list.shown_count).toBeGreaterThanOrEqual(1)
    }
    expect((await listOf(trays.taskId)).threads.find((t) => t.id === first.id)?.owner).toBeUndefined()
    const one = await api<{ thread: Listed }>('GET', `/tasks/${vp.taskId}/threads/${first.id}`)
    expect(one.status).toBe(200)
    expect(one.json.thread.owner?.task_id).toBe(trays.taskId)
    await settleUserStatusSync()
    await syncUserStatuses(new Set([trays.taskId, plan.taskId, main.taskId, vp.taskId]))
    expect((await getTask(trays.taskId)).user_status).toMatchObject({ state: 'needs', source: 'thread' })
    const planStatus = (await getTask(plan.taskId)).user_status
    expect(planStatus?.state).not.toBe('needs')
    const mainStatus = (await getTask(main.taskId)).user_status
    expect(mainStatus?.state).not.toBe('needs')
    expect(mainStatus?.threads).toMatchObject({ below: 1 })
    expect(mainStatus?.threads?.needs ?? 0).toBe(0)
    // One record, on the owner alone.
    let copies = 0
    for (const node of await threadTaskIds()) copies += (await readThreads(node)).threads.filter((t) => t.id === first.id).length
    expect(copies).toBe(1)
  })

  it('his reply at the leader lands in the owner\'s thread and session; the leaders get one riding line and no message', async () => {
    const askId = (await listOf(plan.taskId)).threads.find((t) => t.id === first.id)!.ask_id
    expect(askId).toMatch(/^ak-/)
    const before = queuedCount(otherSids())
    const traysBefore = queued.get(trays.sid)?.length ?? 0
    const r = await api<{ thread: OrgThread; message: ThreadMessage; owner: { task_id: string }; delivery: { state: string } }>('POST', `/tasks/${plan.taskId}/threads`, { text: 'Get the 72-cell trays, two boxes.', thread: first.id, ask_id: askId })
    expect(r.status).toBe(200)
    expect(r.json.owner.task_id).toBe(trays.taskId)
    expect(r.json.delivery.state).toBe('pending')
    expect(r.json.message.answers).toEqual({ ask_id: askId })
    expect((await readThreads(plan.taskId)).threads.some((t) => t.id === first.id)).toBe(false)
    await vi.waitFor(() => {
      const rows = queued.get(trays.sid) ?? []
      expect(rows.length).toBe(traysBefore + 1)
      expect(rows[rows.length - 1].message).toContain('Get the 72-cell trays, two boxes.')
    }, { timeout: 15_000, interval: 200 })
    await vi.waitFor(async () => {
      expect((await messageOf(trays.taskId, r.json.message.id))?.delivery).toMatchObject({ state: 'delivered', told: true })
    }, { timeout: 20_000, interval: 300 })
    // His word left needs: off every list above at once.
    expect((await listOf(main.taskId)).threads.map((t) => t.id)).not.toContain(first.id)
    for (const node of [plan, vp, main]) {
      expect(ridingKeys(node.sid)).toContain(ANSWERED_KEY)
      expect(ridingLine(node.sid, ANSWERED_KEY)).toContain('Buy the 72-cell trays or the 128-cell ones?')
    }
    expect(queuedCount(otherSids())).toBe(before)
  }, 60_000)

  it('five quick replies to one owner are one message; a reply to an older ask is marked stale', async () => {
    const a = await ask(trays.taskId, 'Which week do the trays arrive?')
    const b = await ask(trays.taskId, 'Ship them to the barn or the shed?')
    await vi.waitFor(async () => expect((await listOf(vp.taskId)).threads.filter((t) => [a.id, b.id].includes(t.id))).toHaveLength(2), { timeout: 5000 })
    const traysBefore = queued.get(trays.sid)?.length ?? 0
    const sent: string[] = []
    const replies: Array<[string, string, Record<string, unknown>]> = [
      [vp.taskId, a.id, {}], [main.taskId, b.id, {}], [plan.taskId, a.id, {}], [vp.taskId, b.id, { ask_id: 'ak-0000000000' }], [main.taskId, a.id, {}],
    ]
    for (const [node, thread, extra] of replies) {
      const r = await api<{ message: ThreadMessage }>('POST', `/tasks/${node}/threads`, { text: `Reply ${sent.length + 1} about the trays`, thread, ...extra })
      expect(r.status).toBe(200)
      sent.push(r.json.message.id)
    }
    await vi.waitFor(async () => {
      const ms = await Promise.all(sent.map((id) => messageOf(trays.taskId, id)))
      expect(ms.map((m) => m?.delivery?.state)).toEqual(Array(5).fill('delivered'))
      expect(new Set(ms.map((m) => m?.delivery?.queued)).size).toBe(1)
    }, { timeout: 20_000, interval: 300 })
    const rows = (queued.get(trays.sid) ?? []).slice(traysBefore)
    expect(rows).toHaveLength(1)
    for (let i = 1; i <= 5; i++) expect(rows[0].message).toContain(`Reply ${i} about the trays`)
    expect((await messageOf(trays.taskId, sent[3]))?.answers).toEqual({ ask_id: 'ak-0000000000', stale: true })
  }, 60_000)

  it('a reply while the owner has no session stays pending, the owner cannot close it, and it goes when a session starts', async () => {
    const t = await ask(hose, 'Replace the whole drip line or patch it?')
    const row = (await listOf(vp.taskId)).threads.find((x) => x.id === t.id)
    expect(row).toMatchObject({ owner: { task_id: hose }, can_answer_now: false })
    const r = await api<{ message: ThreadMessage }>('POST', `/tasks/${vp.taskId}/threads`, { text: 'Patch it for this season.', thread: t.id })
    expect(r.status).toBe(200)
    await new Promise((res) => setTimeout(res, 2500))
    expect((await messageOf(hose, r.json.message.id))?.delivery?.state).toBe('pending')
    await expect(patchThread(hose, t.id, { close: 'dropped', user_words: 'done' }, `task:${hose}`)).rejects.toMatchObject({ code: 'reply_pending' })
    const sid = await startSessionFor(hose, 'Orchard')
    await vi.waitFor(() => {
      expect((queued.get(sid) ?? []).some((m) => m.message?.includes('Patch it for this season.'))).toBe(true)
    }, { timeout: 20_000, interval: 300 })
    await vi.waitFor(async () => {
      expect((await messageOf(hose, r.json.message.id))?.delivery?.state).toBe('delivered')
    }, { timeout: 20_000, interval: 300 })
  }, 90_000)

  it('a move changes the owner: one copy, and the old link still finds it', async () => {
    const t = await openNodeThread(vp.taskId, { title: 'Where do the garden seedlings go?', text: 'The seedling shelf is full.', from: 'node', state: 'answered' }, 'agent')
    const moved = await api<{ moved_to: { task: string } }>('POST', `/tasks/${vp.taskId}/threads/${t.id}/move`, { to: garden.taskId })
    expect(moved.status).toBe(200)
    expect(moved.json.moved_to.task).toBe(garden.taskId)
    // One record with the history; where it left, a pointer alone (no message, no summary).
    let copies = 0
    for (const node of await threadTaskIds()) copies += (await readThreads(node)).threads.filter((x) => x.id === t.id && x.messages.length + (x.opener ? 1 : 0) > 0).length
    expect(copies).toBe(1)
    const pointer = (await readThreads(vp.taskId)).threads.find((x) => x.id === t.id)
    expect(pointer).toMatchObject({ messages: [], movedTo: { task: garden.taskId } })
    expect(pointer?.opener).toBeUndefined()
    expect((await readThreads(garden.taskId)).threads.find((x) => x.id === t.id)?.movedFrom?.task).toBe(vp.taskId)
    const old = await api<{ thread: Listed }>('GET', `/tasks/${vp.taskId}/threads/${t.id}`)
    expect(old.status).toBe(200)
    expect(old.json.thread.owner?.task_id).toBe(garden.taskId)
    // His reply on the old card reaches the node that has it now.
    const r = await api<{ owner: { task_id: string } }>('POST', `/tasks/${vp.taskId}/threads`, { text: 'Put them on the bench by the gate.', thread: t.id })
    expect(r.json.owner.task_id).toBe(garden.taskId)
    await vi.waitFor(() => expect((queued.get(garden.sid) ?? []).some((m) => m.message?.includes('bench by the gate'))).toBe(true), { timeout: 15_000, interval: 300 })
  }, 60_000)

  it('a phone\'s Follow up through the companion on a task\'s card at its VP goes to that thread and its owner', async () => {
    // 2026-11-20, the user on his phone: "this already followed up, but it did not leave". The
    // phone announces the thread first (PUT .../follow-ups/:messageId), then the companion relays
    // the words alone into the VP's chat; the announce was refused (404: not the VP's own thread),
    // so the words were filed in another of the VP's threads and the card stayed on Needs you.
    const t = await ask(trays.taskId, 'Paint the gate green or leave it bare?')
    await vi.waitFor(async () => expect((await listOf(vp.taskId)).threads.map((x) => x.id)).toContain(t.id), { timeout: 10_000, interval: 200 })
    const messageId = 'qm-mobile-popped-follow-1'
    const announced = await api('PUT', `/tasks/${vp.taskId}/threads/${t.id}/follow-ups/${messageId}`)
    expect(announced.status).toBe(200)
    const conn = new DaemonConnection('__local__', null)
    ;(conn as unknown as { send: (cmd: string, params: Record<string, unknown>) => Promise<unknown> }).send = async () => ({ ok: true })
    await (conn as unknown as { handleMessageRequest: (e: Record<string, unknown>) => Promise<void> })
      .handleMessageRequest({ ev: 'message-request', relayId: 7, sessionId: vp.sid, message: 'Green, the same as the shed.', messageId })
    // Filed in the owner's one record, as his reply; none of the VP's own threads holds it.
    await vi.waitFor(async () => {
      const owned = (await readThreads(trays.taskId)).threads.find((x) => x.id === t.id)!
      expect(owned.messages.map((m) => m.text)).toContain('Green, the same as the shed.')
      expect(owned.state).not.toBe('needs')
    }, { timeout: 15_000, interval: 300 })
    expect((await readThreads(vp.taskId)).threads.some((x) => x.messages.some((m) => m.text === 'Green, the same as the shed.'))).toBe(false)
    // Off the VP's list: it no longer waits on him.
    await vi.waitFor(async () => expect((await listOf(vp.taskId)).threads.map((x) => x.id)).not.toContain(t.id), { timeout: 10_000, interval: 300 })
    // A thread that is on no node above or below is still refused.
    expect((await api('PUT', `/tasks/${vp.taskId}/threads/th-0000000000ff/follow-ups/qm-mobile-popped-follow-2`)).status).toBe(404)
  }, 60_000)
})
