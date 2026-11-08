/**
 * A thread goes with its work, on a real server (src/core/org/thread-follow.ts; 2026-11-08, the
 * user, after his thread stayed on the VP that had passed the work on: "should go to walnut vp",
 * then, translated: once the task is moved under the other VP, "then you no longer need to monitor
 * it").
 *
 *   1. the user moves the task from Marina VP's project to Walnut's: his thread about it moves to
 *      Walnut VP's Threads by itself (his message, the answer, its state and tasks), closes on Marina
 *      VP's as moved, both VPs are told in a line riding their next message, and his next message
 *      in it files there;
 *   2. Marina VP hands an ask on with task_send naming its thread: the thread goes with it;
 *   3. Marina VP hands a request on (hands_on) to a Walnut task its thread lists: the same;
 *   4. Main's thread stays when its task is in a VP's team; Main's org_send naming it moves it;
 *   5. the user moves a thread by hand (thread_move to a project name); a moved thread cannot be
 *      reopened where it left.
 *
 * What's real: server, bus, task store, threads store, the follow rule and its event loop, the
 * message routes, the request store. Mocked: constants, the daemon (MockDaemon), the CLI.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Server } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-thread-follow'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'
import { addTask } from '../../src/core/task-manager.js'
import { getSessionByClaudeId } from '../../src/core/session-tracker.js'
import { ensureMainTask, ensureProjectLead } from '../../src/core/org/org-store.js'
import { fileThreadMessage, moveThread, setThreadAnswers } from '../../src/core/org/threads-store.js'
import { pendingStatusNote } from '../../src/core/sessions/status-push.js'
import { prepareHintedSend } from '../../src/core/hints/hint-send.js'
import { runThreadFollowPass } from '../../src/core/org/thread-follow.js'
import type { OrgThread } from '../../src/core/org/threads-model.js'

let server: Server
let daemon: MockDaemon
let port: number
const MOCK_CLI = path.resolve(import.meta.dirname, '../providers/mock-claude.mjs')

type Node = { taskId: string; sid: string }
let main: Node
let marina: Node
let walnut: Node

async function startSessionFor(taskId: string, project: string): Promise<string> {
  const sid = (await sessionRunner.startSession({ taskId, cwd: WALNUT_HOME, message: 'Ready', project, preassignedSessionId: randomUUID() })).claudeSessionId
  await vi.waitFor(async () => {
    expect((await getSessionByClaudeId(sid))?.process_status).toMatch(/idle|stopped/)
  }, { timeout: 20_000 })
  return sid
}

async function api<T = Record<string, unknown>>(method: string, p: string, body?: unknown, callerSid?: string): Promise<{ status: number; json: T }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/v1${p}`, {
    method,
    headers: { 'content-type': 'application/json', ...(callerSid ? { 'x-walnut-caller-sid': callerSid } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  return { status: res.status, json: await res.json().catch(() => ({})) as T }
}

async function threadsOf(taskId: string, q = ''): Promise<OrgThread[]> {
  const r = await api<{ threads: OrgThread[] }>('GET', `/tasks/${taskId}/threads${q}`)
  expect(r.status).toBe(200)
  return r.json.threads
}

/** One of his messages filed on a node's Threads, as Walnut files what he types. */
async function fileHisWords(taskId: string, text: string, thread?: string): Promise<OrgThread> {
  const r = await api<{ thread: OrgThread }>('POST', `/tasks/${taskId}/threads`, { text, ...(thread ? { thread } : {}) })
  expect(r.status).toBeLessThan(300)
  return r.json.thread
}

beforeAll(async () => {
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  daemon = await createMockDaemon()
  sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemon.port}`)
  daemon.setCliCommand(MOCK_CLI)
  server = await startServer({ port: 0, dev: true })
  port = (server.address() as { port: number }).port
  const mainTask = await ensureMainTask()
  const marinaLead = await ensureProjectLead('Marina')
  const walnutLead = await ensureProjectLead('Walnut')
  main = { taskId: mainTask.id, sid: await startSessionFor(mainTask.id, '') }
  marina = { taskId: marinaLead.id, sid: await startSessionFor(marinaLead.id, 'Marina') }
  walnut = { taskId: walnutLead.id, sid: await startSessionFor(walnutLead.id, 'Walnut') }
}, 120_000)

afterAll(async () => {
  sessionRunner.setTestDaemonUrl(undefined)
  await stopServer()
  await daemon?.stop()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
}, 60_000)

describe('moving the task is the whole handoff', () => {
  it('the thread follows the task to the other VP, whole, and the old VP stops following it', async () => {
    const research = (await addTask({ title: 'Learn from the open-source bot', project: 'Marina' })).task.id
    const filed = await fileHisWords(marina.taskId, 'what can our org learn from this open-source bot?')
    const msgId = filed.messages[0].id
    // Marina VP handed it to a task in its project, and answered him in its chat.
    expect((await api('PATCH', `/tasks/${marina.taskId}/threads/${filed.id}`, { title: 'Bot lessons', state: 'working', tasks: [research] }, marina.sid)).status).toBe(200)
    await setThreadAnswers(marina.taskId, new Map([[msgId, { text: 'A research task is on it.', at: new Date().toISOString() }]]))

    // The user moves the task under the other VP.
    expect((await api('PATCH', `/tasks/${research}`, { project: 'Walnut' })).status).toBe(200)

    await vi.waitFor(async () => {
      expect((await threadsOf(walnut.taskId, '?open=1')).map((t) => t.id)).toContain(filed.id)
    }, { timeout: 30_000, interval: 500 })
    const there = (await threadsOf(walnut.taskId)).find((t) => t.id === filed.id)!
    expect(there).toMatchObject({ title: 'Bot lessons', state: 'working', tasks: [research], movedFrom: { task: marina.taskId, title: expect.stringContaining('Marina') } })
    expect(there.messages[0]).toMatchObject({ id: msgId, text: 'what can our org learn from this open-source bot?', answer: { text: 'A research task is on it.' } })
    expect(there.closed).toBeUndefined()

    expect((await threadsOf(marina.taskId, '?open=1')).map((t) => t.id)).not.toContain(filed.id)
    const left = (await threadsOf(marina.taskId, '?closed=1')).find((t) => t.id === filed.id)!
    expect(left.closed?.how).toBe('dropped')
    expect(left.movedTo).toMatchObject({ task: walnut.taskId, kind: 'work' })
    expect(left.movedTo?.why).toContain('Learn from the open-source bot')

    // Both VPs hear it in one line riding their next message.
    expect(pendingStatusNote(marina.sid)?.text).toMatch(new RegExp(`Thread ${filed.id} .*moved to .*you no longer follow it`))
    expect(pendingStatusNote(walnut.sid)?.text).toMatch(new RegExp(`Thread ${filed.id} .*moved to your Threads from`))

    // His next message in it is filed there, under the same thread.
    const follow = await fileHisWords(walnut.taskId, 'any results yet?', filed.id)
    expect(follow.id).toBe(filed.id)
    expect(follow.messages.map((m) => m.text)).toEqual(['what can our org learn from this open-source bot?', 'any results yet?'])

    // It stays there: the next pass moves nothing back.
    expect((await threadsOf(marina.taskId, '?open=1')).map((t) => t.id)).not.toContain(filed.id)
  }, 60_000)
})

describe('the real shapes', () => {
  it('a task the VP itself created (its parent link names the VP) moved to the other VP\'s project takes the thread', async () => {
    const created = await api<{ task: { id: string }; placement: { parent_task_id?: string } }>('POST', '/tasks', { title: 'Study the bot', record_only: true }, marina.sid)
    expect(created.status).toBe(201)
    expect(created.json.placement.parent_task_id).toBe(marina.taskId)
    const work = created.json.task.id
    const filed = await fileHisWords(marina.taskId, 'study this bot for us')
    await api('PATCH', `/tasks/${marina.taskId}/threads/${filed.id}`, { tasks: [work], state: 'working' }, marina.sid)
    expect((await api('PATCH', `/tasks/${work}`, { project: 'Walnut' })).status).toBe(200)
    await vi.waitFor(async () => {
      expect((await threadsOf(walnut.taskId, '?open=1')).map((t) => t.id)).toContain(filed.id)
    }, { timeout: 30_000, interval: 500 })
  }, 60_000)

  it('his Follow up from the old VP\'s card after the move lands in the thread where it lives now, and the old VP is told it is not its own', async () => {
    const filed = await fileHisWords(marina.taskId, 'a thread to move before he follows up')
    await api('POST', `/tasks/${marina.taskId}/threads/${filed.id}/move`, { to: walnut.taskId })
    const record = await getSessionByClaudeId(marina.sid)
    const prepared = await prepareHintedSend(marina.sid, record, 'is this done yet?', { sentBy: 'person', threadId: filed.id })
    expect(prepared.enqueueText).toMatch(new RegExp(`thread ${filed.id} .*moved to .*Not yours to act on`))
    await prepared.commit()
    // Sent on to Walnut VP's session as his own message, and filed there by that send: its answer is read there.
    await vi.waitFor(async () => {
      const there = (await threadsOf(walnut.taskId, '?open=1')).find((t) => t.id === filed.id)!
      expect(there.messages.map((m) => m.text)).toEqual(['a thread to move before he follows up', 'is this done yet?'])
      expect((there.messages[1] as { sid?: string }).sid).toBe(walnut.sid)
    }, { timeout: 10_000 })
    // No new thread on the old VP.
    expect((await threadsOf(marina.taskId, '?open=1')).some((t) => t.messages.some((m) => m.text === 'is this done yet?'))).toBe(false)
  }, 60_000)
})

describe('a message filed into a thread that moved', () => {
  it('goes to the node holding it, without the old node\'s session, so its answer is read in the holder\'s chat', async () => {
    const filed = await fileHisWords(marina.taskId, 'a thread that moves before his words are written')
    await api('POST', `/tasks/${marina.taskId}/threads/${filed.id}/move`, { to: walnut.taskId })
    const res = await fileThreadMessage(marina.taskId, { text: 'written after the move', via: 'follow-up', threadId: filed.id, sid: marina.sid, at: new Date().toISOString() })
    expect(res).toMatchObject({ node: walnut.taskId, created: false })
    expect(res.thread.id).toBe(filed.id)
    const msg = res.thread.messages.find((m) => m.text === 'written after the move')!
    expect((msg as { sid?: string }).sid).toBeUndefined()
    expect((await threadsOf(marina.taskId, '?open=1')).some((t) => t.messages.some((m) => m.text === 'written after the move'))).toBe(false)
  }, 30_000)
})

describe('handing an ask on hands the thread on', () => {
  it('task_send naming the thread: it goes to the receiver\'s VP', async () => {
    const target = (await addTask({ title: 'Walnut org follow-up', project: 'Walnut' })).task.id
    await startSessionFor(target, 'Walnut')
    const filed = await fileHisWords(marina.taskId, 'this belongs to walnut, pass it on')
    const sent = await api<{ thread_handoff?: { moved: Array<{ id: string; to: { task: string } }> } }>('POST', '/messages',
      { to: target, title: 'His ask', text: 'He asked for this; it is yours.', expect_reply: false, thread: filed.id }, marina.sid)
    expect(sent.status).toBe(202)
    expect(sent.json.thread_handoff?.moved).toEqual([expect.objectContaining({ id: filed.id, to: expect.objectContaining({ task: walnut.taskId }) })])
    const there = (await threadsOf(walnut.taskId, '?open=1')).find((t) => t.id === filed.id)!
    expect(there.tasks).toEqual([target])
    expect(there.movedFrom?.why).toContain('handed it to "Walnut org follow-up"')
    expect((await threadsOf(marina.taskId, '?open=1')).map((t) => t.id)).not.toContain(filed.id)
  }, 60_000)

  it('a thread named for a task in the sender\'s own team only lists the task', async () => {
    const own = (await addTask({ title: 'Marina own work', project: 'Marina' })).task.id
    await startSessionFor(own, 'Marina')
    const filed = await fileHisWords(marina.taskId, 'do this in our own team')
    const sent = await api<{ thread_handoff?: { moved: unknown[]; linked: Array<{ id: string }> } }>('POST', '/messages',
      { to: own, title: 'Do it', text: 'Please do it.', expect_reply: false, thread: filed.id }, marina.sid)
    expect(sent.json.thread_handoff).toMatchObject({ moved: [], linked: [expect.objectContaining({ id: filed.id })] })
    expect((await threadsOf(marina.taskId, '?open=1')).find((t) => t.id === filed.id)?.tasks).toEqual([own])
  }, 60_000)

  it('hands_on to a Walnut task its thread lists: the thread goes with the request', async () => {
    const target = (await addTask({ title: 'Walnut takes the request', project: 'Walnut' })).task.id
    await startSessionFor(target, 'Walnut')
    const filed = await fileHisWords(marina.taskId, 'Main asked about this; walnut owns it')
    await api('PATCH', `/tasks/${marina.taskId}/threads/${filed.id}`, { tasks: [target], state: 'working' }, marina.sid)
    // Main asks Marina VP something; Marina VP hands that request on to the Walnut task.
    const ask = await api<{ requestId: string }>('POST', '/messages', { to: marina.taskId, title: 'Q', text: 'Who owns this?', expect_reply: true }, main.sid)
    expect(ask.json.requestId).toMatch(/^rq-/)
    const sent = await api<{ handedOn?: string[]; thread_handoff?: { moved: Array<{ id: string }> } }>('POST', '/messages',
      { to: target, title: 'Yours', text: 'Main asks who owns this: you do.', hands_on: ask.json.requestId }, marina.sid)
    expect(sent.status).toBe(202)
    expect(sent.json.handedOn).toEqual([ask.json.requestId])
    expect(sent.json.thread_handoff?.moved.map((m) => m.id)).toEqual([filed.id])
    expect((await threadsOf(walnut.taskId, '?open=1')).map((t) => t.id)).toContain(filed.id)
  }, 60_000)
})

describe('Main and by hand', () => {
  it('Main\'s thread stays with Main while a VP does the work; Main naming it in org_send moves it', async () => {
    const work = (await addTask({ title: 'Walnut piece', project: 'Walnut' })).task.id
    const filed = await fileHisWords(main.taskId, 'get walnut to look at this')
    await api('PATCH', `/tasks/${main.taskId}/threads/${filed.id}`, { tasks: [work], state: 'working' }, main.sid)
    // A pass runs on that change; Main's thread is not moved by it.
    await new Promise((r) => setTimeout(r, 7_000))
    expect((await threadsOf(main.taskId, '?open=1')).map((t) => t.id)).toContain(filed.id)
    const sent = await api<{ thread_handoff?: { moved: Array<{ id: string; to: { task: string } }> } }>('POST', '/messages',
      { to: walnut.taskId, title: 'For you', text: 'Please take this.', expect_reply: false, thread: filed.id }, main.sid)
    expect(sent.json.thread_handoff?.moved).toEqual([expect.objectContaining({ id: filed.id, to: expect.objectContaining({ task: walnut.taskId }) })])
    // The VP itself is the target: the thread does not list the VP as its own task.
    expect((await threadsOf(walnut.taskId, '?open=1')).find((t) => t.id === filed.id)?.tasks).toEqual([work])
  }, 60_000)

  it('the user moves a thread by hand to a project\'s VP; it cannot be reopened where it left', async () => {
    const filed = await fileHisWords(marina.taskId, 'wrong channel, this is for walnut')
    const moved = await api<{ moved_to: { task: string } }>('POST', `/tasks/${marina.taskId}/threads/${filed.id}/move`, { to: 'Walnut' })
    expect(moved.status).toBe(200)
    expect(moved.json.moved_to.task).toBe(walnut.taskId)
    expect((await threadsOf(walnut.taskId, '?open=1')).find((t) => t.id === filed.id)?.movedFrom?.why).toBe('the user moved it there')
    // Its old task in Marina VP's team does not pull a thread he moved by hand back.
    const marinaWork = (await addTask({ title: 'Marina leftover', project: 'Marina' })).task.id
    await api('PATCH', `/tasks/${walnut.taskId}/threads/${filed.id}`, { tasks: [marinaWork] }, walnut.sid)
    await runThreadFollowPass()
    expect((await threadsOf(walnut.taskId, '?open=1')).map((t) => t.id)).toContain(filed.id)
    const again = await api<{ error?: { code?: string }; code?: string }>('PATCH', `/tasks/${marina.taskId}/threads/${filed.id}`, { reopen: true })
    expect(again.status).toBe(409)
    // To where it already is: refused, nothing changes.
    const same = await api('POST', `/tasks/${walnut.taskId}/threads/${filed.id}/move`, { to: walnut.taskId })
    expect(same.status).toBe(409)
  }, 60_000)
})

describe('two moves at once', () => {
  it('to the same node: one open copy there, the source closed as moved (never lost)', async () => {
    const filed = await fileHisWords(marina.taskId, 'two movers race on this one')
    const ends = { from: { task: marina.taskId, title: 'Marina VP' }, to: { task: walnut.taskId, title: 'Walnut VP' } }
    const results = await Promise.allSettled([
      moveThread({ ...ends, threadId: filed.id, by: 'agent', why: 'race one' }),
      moveThread({ ...ends, threadId: filed.id, by: 'agent', why: 'race two' }),
    ])
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true)
    expect((await threadsOf(walnut.taskId, '?open=1')).filter((t) => t.id === filed.id)).toHaveLength(1)
    expect((await threadsOf(marina.taskId)).find((t) => t.id === filed.id)?.movedTo?.task).toBe(walnut.taskId)
  }, 30_000)

  it('to two nodes: the thread is open on exactly one of them', async () => {
    const filed = await fileHisWords(marina.taskId, 'two movers to two places')
    const from = { task: marina.taskId, title: 'Marina VP' }
    await Promise.allSettled([
      moveThread({ from, to: { task: walnut.taskId, title: 'Walnut VP' }, threadId: filed.id, by: 'agent' }),
      moveThread({ from, to: { task: main.taskId, title: 'Main' }, threadId: filed.id, by: 'agent' }),
    ])
    const onWalnut = (await threadsOf(walnut.taskId, '?open=1')).some((t) => t.id === filed.id)
    const onMain = (await threadsOf(main.taskId, '?open=1')).some((t) => t.id === filed.id)
    expect(Number(onWalnut) + Number(onMain)).toBe(1)
    const left = (await threadsOf(marina.taskId)).find((t) => t.id === filed.id)!
    expect(left.closed).toBeTruthy()
    // The source points at the one node that holds it.
    expect(left.movedTo?.task).toBe(onWalnut ? walnut.taskId : main.taskId)
  }, 30_000)
})
