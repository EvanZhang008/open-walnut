/**
 * One thread across a hand-off, on a real server (experiment threads_one_id,
 * src/core/org/thread-one-id.ts; 2026-11-25, the user, of one request he saw as his VP's card and a
 * second card its task opened: "two threads for the same thing").
 *
 *   Orchard VP ─ "Mend the orchard fence" (Threads on, a session)
 *
 *   1. off: Orchard VP hands his thread to the task with task_send `thread`: it stays on the VP and
 *      lists the task, the task holds no thread of that id (today's shape);
 *   2. on: the same hand-off moves it to the task under the same id: one open record on the task, a
 *      closed pointer on the VP, the task told which thread it is;
 *   3. while the task works on it, the VP's Threads read shows its pointer only; once the task marks
 *      it answered (and again in needs), that read shows the task's one record in its place, never two;
 *      the VP's status counts it;
 *   4. his reply on that card reaches the task's session and its record;
 *   5. the task opening a thread on the same subject is refused: it is on its own Threads;
 *      with threads_pop_up on too, still one card;
 *   6. a thread waiting on him stays on the VP and says why; task_create hands it the same way;
 *   7. the switch off again: an ordinary moved thread.
 *
 * What's real: server, bus, task store, threads store, the message routes, the queue. Mocked:
 * constants, the daemon (MockDaemon), the CLI.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Server } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-thread-one-id'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'
import { addTask, getTask, updateTaskRaw } from '../../src/core/task-manager.js'
import { getSessionByClaudeId } from '../../src/core/session-tracker.js'
import { ensureMainTask, ensureProjectLead } from '../../src/core/org/org-store.js'
import { patchThread, readThreads, threadTaskIds, writeThreadsFor } from '../../src/core/org/threads-store.js'
import { moveThreadIn } from '../../src/core/org/threads-model.js'
import { runThreadFollowPass } from '../../src/core/org/thread-follow.js'
import { oneIdNow } from '../../src/core/org/thread-one-id.js'
import { threadsForEveryTask } from '../../src/core/org/keeps-threads.js'
import { threadsPopUpNow } from '../../src/core/org/thread-popup.js'
import { newSubjectsOnly } from '../../src/core/org/thread-same-subject.js'
import { pendingStatusNote } from '../../src/core/sessions/status-push.js'
import { pendingHeldNotices } from '../../src/core/sessions/held-notices.js'
import { bus, EventNames } from '../../src/core/event-bus.js'
import { settleUserStatusSync, syncUserStatuses } from '../../src/core/user-status-sync.js'
import type { OrgThread, ThreadMessage } from '../../src/core/org/threads-model.js'

let server: Server
let daemon: MockDaemon
let port: number
const MOCK_CLI = path.resolve(import.meta.dirname, '../providers/mock-claude.mjs')

type Node = { taskId: string; sid: string }
let vp: Node
let fence: Node
const queued = new Map<string, string[]>()

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

type Listed = OrgThread & { owner?: { task_id: string }; carries?: string; shown?: boolean }
async function listOf(taskId: string): Promise<{ threads: Listed[]; shown_count: number }> {
  const r = await api<{ threads: Listed[]; shown_count: number }>('GET', `/tasks/${taskId}/threads`)
  expect(r.status).toBe(200)
  return r.json
}

async function flags(oneId: boolean, popUp = false): Promise<void> {
  expect((await api('PUT', '/api/config', { experimental: { threads_one_id: oneId, threads_pop_up: popUp } })).status).toBe(200)
  await vi.waitFor(() => { expect(oneIdNow()).toBe(oneId); expect(threadsPopUpNow()).toBe(popUp) }, { timeout: 30_000, interval: 100 })
}

/** Every task keeps Threads (task_threads), and the server reads it so before going on (the status sync sets it). */
async function everyTaskThreads(on: boolean): Promise<void> {
  expect((await api('PUT', '/api/config', { experimental: { threads_one_id: true, threads_pop_up: false, task_threads: on } })).status).toBe(200)
  await vi.waitFor(() => { expect(threadsForEveryTask()).toBe(on); expect(oneIdNow()).toBe(true) }, { timeout: 30_000, interval: 100 })
}

/** His message on the VP's Threads, as Walnut files what he types. */
async function hisWords(text: string): Promise<OrgThread> {
  const r = await api<{ thread: OrgThread }>('POST', `/tasks/${vp.taskId}/threads`, { text })
  expect(r.status).toBeLessThan(300)
  return r.json.thread
}

type Handoff = { moved: Array<{ id: string; to: { task: string }; same_card?: boolean }>; linked: Array<{ id: string; stays?: string }> }
async function handOn(thread: string, text: string): Promise<Handoff | undefined> {
  const sent = await api<{ thread_handoff?: Handoff }>('POST', '/messages', { to: fence.taskId, title: 'His ask', text, expect_reply: false, thread }, vp.sid)
  expect(sent.status).toBe(202)
  return sent.json.thread_handoff
}

async function copiesOf(id: string): Promise<{ open: string[]; closed: string[] }> {
  const out = { open: [] as string[], closed: [] as string[] }
  for (const node of await threadTaskIds()) {
    for (const t of (await readThreads(node)).threads) if (t.id === id) (t.closed ? out.closed : out.open).push(node)
  }
  return out
}

beforeAll(async () => {
  process.env.WALNUT_THREAD_FOLLOW = '0'
  process.env.WALNUT_THREAD_REPLY_GATHER_MS = '300'
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  daemon = await createMockDaemon()
  sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemon.port}`)
  daemon.setCliCommand(MOCK_CLI)
  server = await startServer({ port: 0, dev: true })
  port = (server.address() as { port: number }).port
  await ensureMainTask()
  const vpTask = await ensureProjectLead('Orchard')
  const fenceId = (await addTask({ title: 'Mend the orchard fence', project: 'Orchard', parent_task_id: vpTask.id })).task.id
  await updateTaskRaw(fenceId, { threads_on: true, phase: 'IN_PROGRESS' } as never, { emitEvent: true })
  vp = { taskId: vpTask.id, sid: await startSessionFor(vpTask.id, 'Orchard') }
  fence = { taskId: fenceId, sid: await startSessionFor(fenceId, 'Orchard') }
  bus.subscribe('test-thread-one-id', (event) => {
    const d = event.data as { sessionId: string; message?: string }
    queued.set(d.sessionId, [...(queued.get(d.sessionId) ?? []), d.message ?? ''])
  }, { global: true, interest: [EventNames.SESSION_MESSAGE_QUEUED] })
}, 150_000)

afterAll(async () => {
  bus.unsubscribe('test-thread-one-id')
  sessionRunner.setTestDaemonUrl(undefined)
  await stopServer()
  await daemon?.stop()
  delete process.env.WALNUT_THREAD_FOLLOW
  delete process.env.WALNUT_THREAD_REPLY_GATHER_MS
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
}, 60_000)

describe('switch off: today\'s shape', () => {
  it('the thread stays on the VP and lists the task; the task holds no thread of that id', async () => {
    await flags(false)
    const filed = await hisWords('paint the orchard gate green before spring')
    const handoff = await handOn(filed.id, 'He asked for the gate; please paint it.')
    expect(handoff).toEqual({ moved: [], linked: [{ id: filed.id, title: filed.title }] })
    const mine = (await listOf(vp.taskId)).threads.filter((t) => t.id === filed.id)
    expect(mine).toHaveLength(1)
    expect(mine[0]).toMatchObject({ tasks: [fence.taskId] })
    expect(mine[0].closed).toBeUndefined()
    expect(mine[0].owner).toBeUndefined()
    expect((await readThreads(fence.taskId)).threads.some((t) => t.id === filed.id)).toBe(false)
    expect(await copiesOf(filed.id)).toEqual({ open: [vp.taskId], closed: [] })
    // Nor does the handing message say anything of a thread.
    expect((queued.get(fence.sid) ?? []).find((m) => m.includes('He asked for the gate'))).not.toContain('This work is thread')
  }, 60_000)
})

describe('switch on: one request, one id', () => {
  let filed: OrgThread

  it('the hand-off moves the thread to the task under the same id, and the task is told which it is', async () => {
    await flags(true)
    filed = await hisWords('mend the orchard fence before the frost')
    const handoff = await handOn(filed.id, 'He asked for the fence; it is yours.')
    expect(handoff?.moved).toEqual([expect.objectContaining({ id: filed.id, to: expect.objectContaining({ task: fence.taskId }), same_card: true })])
    expect(handoff?.linked).toEqual([])
    expect(await copiesOf(filed.id)).toEqual({ open: [fence.taskId], closed: [vp.taskId] })
    const there = (await readThreads(fence.taskId)).threads.find((t) => t.id === filed.id)!
    expect(there.movedFrom).toMatchObject({ task: vp.taskId, kind: 'hand' })
    expect(there.messages[0].text).toBe('mend the orchard fence before the frost')
    const left = (await readThreads(vp.taskId)).threads.find((t) => t.id === filed.id)!
    expect(left.movedTo).toMatchObject({ task: fence.taskId, kind: 'hand' })
    // The message that handed the work over carries the line itself, so the task knows its thread in
    // that very turn; nothing rides its next message on top.
    const line = `This work is thread ${filed.id}`
    await vi.waitFor(() => {
      const handing = (queued.get(fence.sid) ?? []).find((m) => m.includes('He asked for the fence; it is yours.'))
      expect(handing).toContain(line)
    }, { timeout: 30_000, interval: 250 })
    const held = await pendingHeldNotices(fence.sid)
    held?.release()
    expect(held?.text ?? '').not.toContain(line)
    expect(pendingStatusNote(fence.sid)?.text ?? '').not.toContain(line)
  }, 60_000)

  it('while the task works on it the VP lists only its pointer; once answered, the task\'s one record in its place', async () => {
    let rows = (await listOf(vp.taskId)).threads.filter((t) => t.id === filed.id)
    expect(rows).toHaveLength(1)
    expect(rows[0].closed?.how).toBe('dropped')
    const r = await api('PATCH', `/tasks/${fence.taskId}/threads/${filed.id}`, { state: 'answered', reply: 'The fence is mended with new posts on the north side.' }, fence.sid)
    expect(r.status).toBe(200)
    const list = await listOf(vp.taskId)
    rows = list.threads.filter((t) => t.id === filed.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ state: 'answered', owner: { task_id: fence.taskId }, carries: filed.id, shown: true })
    expect(rows[0].closed).toBeUndefined()
    expect(list.shown_count).toBeGreaterThanOrEqual(1)
    // The one record whole, by its id on the VP.
    const one = await api<{ thread: Listed }>('GET', `/tasks/${vp.taskId}/threads/${filed.id}`)
    expect(one.json.thread).toMatchObject({ id: filed.id, state: 'answered', owner: { task_id: fence.taskId } })
    // The VP's status counts it as a card below, never as its own Needs you.
    await vi.waitFor(async () => {
      await settleUserStatusSync()
      await syncUserStatuses(new Set([vp.taskId, fence.taskId]))
      expect((await getTask(vp.taskId)).user_status?.threads).toMatchObject({ below: 1 })
    }, { timeout: 30_000, interval: 250 })
    expect(await copiesOf(filed.id)).toEqual({ open: [fence.taskId], closed: [vp.taskId] })
  }, 60_000)

  it('in needs it shows there too, still one card', async () => {
    const r = await api('PATCH', `/tasks/${fence.taskId}/threads/${filed.id}`, {
      state: 'needs', ask: 'Use oak posts or cedar posts for the fence?', user_kind: 'spending', user_kind_why: 'The posts are bought with real money',
      options: [{ id: 'oak', label: 'Oak posts' }, { id: 'cedar', label: 'Cedar posts' }],
    }, fence.sid)
    expect(r.status, JSON.stringify(r.json)).toBe(200)
    let rows = (await listOf(vp.taskId)).threads.filter((t) => t.id === filed.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ state: 'needs', owner: { task_id: fence.taskId } })
    // With threads_pop_up on too it pops up there as well: still one card.
    await flags(true, true)
    rows = (await listOf(vp.taskId)).threads.filter((t) => t.id === filed.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ state: 'needs', owner: { task_id: fence.taskId } })
    await flags(true, false)
  }, 60_000)

  it('his reply on that card reaches the task\'s record and its session', async () => {
    const before = queued.get(fence.sid)?.length ?? 0
    const r = await api<{ thread: OrgThread; message: ThreadMessage; owner: { task_id: string } }>('POST', `/tasks/${vp.taskId}/threads`, { text: 'Cedar posts, please.', thread: filed.id })
    expect(r.status).toBe(200)
    expect(r.json.owner.task_id).toBe(fence.taskId)
    expect(r.json.thread.id).toBe(filed.id)
    expect((await readThreads(fence.taskId)).threads.find((t) => t.id === filed.id)?.messages.some((m) => m.text === 'Cedar posts, please.')).toBe(true)
    await vi.waitFor(() => {
      const rows = queued.get(fence.sid) ?? []
      expect(rows.length).toBeGreaterThan(before)
      expect(rows.some((m) => m.includes('Cedar posts, please.'))).toBe(true)
    }, { timeout: 30_000, interval: 200 })
    // Never a second thread on the VP for it.
    expect((await readThreads(vp.taskId)).threads.filter((t) => !t.closed && t.messages.some((m) => m.text === 'Cedar posts, please.'))).toEqual([])
  }, 60_000)

  it('the task opening a thread on the same subject is refused, and a status line names the one it holds', async () => {
    const r = await api('POST', `/tasks/${fence.taskId}/threads/open`, { title: 'Mend the orchard fence before frost', text: 'Mending the north side.', from: 'node', state: 'working' }, fence.sid)
    expect(r.status).toBe(409)
    expect(JSON.stringify(r.json)).toContain('same_subject')
    const sorted = await newSubjectsOnly(fence.taskId, [{ title: 'Mend the orchard fence before frost' }])
    expect(sorted.own.map((o) => o.id)).toEqual([filed.id])
    expect(sorted.fresh).toEqual([])
  }, 60_000)

  it('a thread waiting on him stays on the VP, lists the task, and says why', async () => {
    const asked = await hisWords('which hedge shears should we buy for the orchard')
    expect((await api('PATCH', `/tasks/${vp.taskId}/threads/${asked.id}`, {
      state: 'needs', ask: 'Buy the long shears or the short ones?', user_kind: 'spending', user_kind_why: 'The shears are bought with real money',
      options: [{ id: 'long', label: 'Long shears' }, { id: 'short', label: 'Short shears' }],
    }, vp.sid)).status).toBe(200)
    const handoff = await handOn(asked.id, 'Look into the shears.')
    expect(handoff?.moved).toEqual([])
    expect(handoff?.linked).toEqual([expect.objectContaining({ id: asked.id, stays: expect.stringContaining('waits on the user') })])
    expect(await copiesOf(asked.id)).toEqual({ open: [vp.taskId], closed: [] })
  }, 60_000)

  it('task_start naming the thread: the start message itself carries the line', async () => {
    const latch = (await addTask({ title: 'Fix the orchard gate latch', project: 'Orchard', parent_task_id: vp.taskId })).task.id
    await updateTaskRaw(latch, { threads_on: true, phase: 'IN_PROGRESS' } as never, { emitEvent: true })
    const asked = await hisWords('the orchard gate latch sticks in the rain')
    const spy = vi.spyOn(sessionRunner, 'startSession')
    try {
      const started = await api<{ thread_handoff?: Handoff }>('POST', `/tasks/${latch}/start`, { message: 'He asked: fix the latch.', thread: asked.id, cwd: WALNUT_HOME }, vp.sid)
      expect(started.status, JSON.stringify(started.json)).toBeLessThan(300)
      expect(started.json.thread_handoff?.moved).toEqual([expect.objectContaining({ id: asked.id, to: expect.objectContaining({ task: latch }), same_card: true })])
      const first = spy.mock.calls.map((c) => (c[0] as { message?: string }).message ?? '').find((m) => m.includes('He asked: fix the latch.'))
      expect(first).toContain(`This work is thread ${asked.id}`)
    } finally {
      spy.mockRestore()
    }
    expect(await copiesOf(asked.id)).toEqual({ open: [latch], closed: [vp.taskId] })
  }, 90_000)

  it('task_create naming the thread (every task keeps Threads): the new task gets it under the same id', async () => {
    await everyTaskThreads(true)
    const asked = await hisWords('prune the orchard pear trees this winter')
    const created = await api<{ task: { id: string }; thread_handoff?: Handoff }>('POST', '/tasks', { title: 'Prune the pear trees', record_only: true, thread: asked.id }, vp.sid)
    expect(created.status).toBe(201)
    const id = created.json.task.id
    expect(created.json.thread_handoff?.moved).toEqual([expect.objectContaining({ id: asked.id, to: expect.objectContaining({ task: id }), same_card: true })])
    expect(await copiesOf(asked.id)).toEqual({ open: [id], closed: [vp.taskId] })
    await everyTaskThreads(false)
  }, 60_000)

  it('a move cut off between its two writes (two open copies): the task\'s copy is the thread, counted once, his reply goes there, and the node\'s copy heals to a pointer', async () => {
    const asked = await hisWords('stake the young orchard plum trees')
    // Built by hand: the task got its copy, the node's never closed (a crash between the move's writes).
    await writeThreadsFor(fence.taskId, (cur) => {
      const r = moveThreadIn(cur, asked, { task: vp.taskId, title: 'Orchard VP' }, `task:${vp.taskId}`, new Date().toISOString(), 'Orchard VP handed it to "Mend the orchard fence"', 'hand', '')
      return { file: r.file, out: r.thread }
    })
    expect((await copiesOf(asked.id)).open.sort()).toEqual([fence.taskId, vp.taskId].sort())
    expect((await api('PATCH', `/tasks/${fence.taskId}/threads/${asked.id}`, { state: 'answered', reply: 'The plum trees are staked.' }, fence.sid)).status).toBe(200)
    const list = await api<{ threads: Array<Listed & { counted?: boolean }>; shown_count: number }>('GET', `/tasks/${vp.taskId}/threads`)
    const rows = list.json.threads.filter((t) => t.id === asked.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ state: 'answered', owner: { task_id: fence.taskId } })
    // The phone's count of its list is the badge's: the leftover copy is never counted.
    expect(list.json.shown_count).toBe(list.json.threads.filter((t) => t.counted).length)
    const r = await api<{ owner?: { task_id: string } }>('POST', `/tasks/${vp.taskId}/threads`, { text: 'Use the green ties.', thread: asked.id })
    expect(r.status).toBe(200)
    expect(r.json.owner?.task_id).toBe(fence.taskId)
    expect((await readThreads(fence.taskId)).threads.find((t) => t.id === asked.id)?.messages.some((m) => m.text === 'Use the green ties.')).toBe(true)
    await vi.waitFor(async () => {
      expect(await copiesOf(asked.id)).toEqual({ open: [fence.taskId], closed: [vp.taskId] })
    }, { timeout: 30_000, interval: 250 })
    expect((await readThreads(vp.taskId)).threads.find((t) => t.id === asked.id)?.movedTo).toMatchObject({ task: fence.taskId, kind: 'hand' })
  }, 60_000)

  it('a task that finishes while a thread handed to it waits on him gives it back to the node, where it counts as his', async () => {
    await everyTaskThreads(true)
    const asked = await hisWords('choose the netting for the orchard cherries')
    const created = await api<{ task: { id: string }; thread_handoff?: Handoff }>('POST', '/tasks', { title: 'Net the cherry trees', record_only: true, thread: asked.id }, vp.sid)
    const id = created.json.task.id
    expect(created.json.thread_handoff?.moved.map((m) => m.id)).toEqual([asked.id])
    await patchThread(id, asked.id, {
      state: 'needs', ask: 'Fine netting or coarse netting for the cherries?', user_kind: 'spending', user_kind_why: 'The netting is bought with real money',
      options: [{ id: 'fine', label: 'Fine netting' }, { id: 'coarse', label: 'Coarse netting' }],
    } as never, `task:${id}`)
    await updateTaskRaw(id, { phase: 'COMPLETE' } as never, { emitEvent: true })
    // The pass the completion schedules (here run by hand: the loop is off in this file), until the
    // thread is back; under load the task store may answer the completion a moment late.
    await vi.waitFor(async () => {
      await runThreadFollowPass()
      expect(await copiesOf(asked.id)).toEqual({ open: [vp.taskId], closed: [id] })
    }, { timeout: 30_000, interval: 250 })
    const rows = (await listOf(vp.taskId)).threads.filter((t) => t.id === asked.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ state: 'needs' })
    expect(rows[0].owner).toBeUndefined()
    // His count and his list agree: every own thread waiting on him in the VP's list is in its Needs you.
    await vi.waitFor(async () => {
      await settleUserStatusSync()
      await syncUserStatuses(new Set([vp.taskId]))
      const waiting = (await listOf(vp.taskId)).threads.filter((t) => !t.owner && !t.closed && t.state === 'needs' && (t as { counted?: boolean }).counted)
      expect(waiting.map((t) => t.id)).toContain(asked.id)
      expect((await getTask(vp.taskId)).user_status?.threads?.needs).toBe(waiting.length)
    }, { timeout: 30_000, interval: 250 })
    await everyTaskThreads(false)
  }, 60_000)

  it('the same thread handed twice: the second is refused, naming where it is', async () => {
    const asked = await hisWords('trim the orchard grass paths')
    expect((await handOn(asked.id, 'Trim the paths.'))?.moved.map((m) => m.id)).toEqual([asked.id])
    const again = await api<{ thread_handoff?: Handoff & { refused?: string } }>('POST', '/messages', { to: fence.taskId, title: 'Again', text: 'Trim them again.', expect_reply: false, thread: asked.id }, vp.sid)
    expect(again.json.thread_handoff?.refused).toContain(`is on Mend the orchard fence's Threads already (${fence.taskId})`)
  }, 60_000)

  it('turned off again, the moved thread stays where it is and reads as an ordinary moved thread', async () => {
    await flags(false)
    const rows = (await listOf(vp.taskId)).threads.filter((t) => t.id === filed.id)
    expect(rows).toHaveLength(1)
    expect(rows[0].closed?.how).toBe('dropped')
    expect(rows[0].movedTo?.task).toBe(fence.taskId)
    expect(await copiesOf(filed.id)).toEqual({ open: [fence.taskId], closed: [vp.taskId] })
  }, 60_000)
})
