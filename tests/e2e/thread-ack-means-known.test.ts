/**
 * His Acknowledge means he knows, on a real server (experiment ack_means_known,
 * src/core/org/thread-ack.ts; 2026-11-20, the user: "I acknowledge it, but that does not mean the
 * thread is gone ... the thread is truly closed only when the problem is really solved").
 *
 *   Bakery lead (a session) ─ "Fix the oven timer" (open) ─ "Order the flour" (done)
 *
 *   1. off: his Acknowledge closes a thread whose task still runs, as before;
 *   2. on, its task still open: pending, every exchange known by him, out of his view (shown_count
 *      drops), the ack recorded; the node hears it once riding its next message;
 *   3. on, its only task done: it closes as before;
 *   4. the node may close the thread he acknowledged without a new reaction of his;
 *   5. its tasks all done: the follow pass tells the node once.
 *
 * What's real: server, bus, task store, threads store, the riding store, the session runner.
 * Mocked: constants, the daemon (MockDaemon), the CLI.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-thread-ack-known'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'
import { addTask, updateTaskRaw } from '../../src/core/task-manager.js'
import { getSessionByClaudeId } from '../../src/core/session-tracker.js'
import { ensureProjectLead } from '../../src/core/org/org-store.js'
import { fileThreadMessage, patchThread, readThreads, setThreadAnswers } from '../../src/core/org/threads-store.js'
import { runThreadFollowPass } from '../../src/core/org/thread-follow.js'
import { pendingRiding, ridingLine } from '../../src/core/sessions/status-riding.js'
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

/** One ask of his the node answered and handed to `tasks`: in his view as answered. */
async function answeredThread(text: string, tasks: string[]): Promise<string> {
  const filed = await fileThreadMessage(lead, { text, via: 'chat', at: new Date().toISOString() })
  await setThreadAnswers(lead, new Map([[filed.message.id, { text: 'Handed it on; I will tell you how it went.', at: new Date().toISOString() }]]))
  await patchThread(lead, filed.thread.id, { title: text.slice(0, 30), state: 'answered', reply: 'It is with the team now.', tasks }, `task:${lead}`)
  return filed.thread.id
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
    const id = await answeredThread('Fix the oven timer before Friday', [oven])
    const r = await ack(id)
    expect(r.status).toBe(200)
    expect(r.json.thread.closed).toMatchObject({ how: 'acked', by: 'human' })
    expect((await threadOf(id)).ackedAt).toBeUndefined()
    expect(ridingLine(sid, `thread-ack:${id}`)).toBeUndefined()
  })

  it('on, its task still open: pending and known, out of his view, and the node hears it once', async () => {
    await flag(true)
    const id = await answeredThread('Keep the oven at 180 degrees', [oven])
    const before = await shownCount()
    const r = await ack(id)
    expect(r.status).toBe(200)
    expect(r.json.thread.closed).toBeUndefined()
    expect(r.json.thread.state).toBe('pending')
    const t = await threadOf(id)
    expect(t.closed).toBeUndefined()
    expect(t.state).toBe('pending')
    expect(t.ackedAt).toBeTruthy()
    expect(t.known).toMatchObject({ by: 'human', through: t.messages[t.messages.length - 1].id })
    expect(await shownCount()).toBe(before - 1)
    const line = ridingLine(sid, `thread-ack:${id}`)
    expect(line).toContain(`He acknowledged thread ${id}`)
    expect(line).toContain(`it waits on "Fix the oven timer" (${oven})`)
    expect(line).toContain('set it answered once with the outcome (he closes it), or close it if there is nothing new to tell')
    // Told once: the item leaves with the message that carries it.
    const ride = pendingRiding(sid)!
    expect(ride.text).toContain(`He acknowledged thread ${id}`)
    ride.markTold()
    expect(ridingLine(sid, `thread-ack:${id}`)).toBeUndefined()
  })

  it('on, its only task done: Acknowledge closes it as before', async () => {
    const id = await answeredThread('Order the rye flour', [flour])
    const r = await ack(id)
    expect(r.json.thread.closed).toMatchObject({ how: 'acked', by: 'human' })
    expect(ridingLine(sid, `thread-ack:${id}`)).toBeUndefined()
  })

  it('the node closes the thread he acknowledged without a new reaction of his', async () => {
    const id = await answeredThread('Check the oven thermostat', [oven])
    // Before his ack the node may not close an answer he never reacted to.
    expect((await api('PATCH', `/tasks/${lead}/threads/${id}`, { close: 'acked' }, sid)).status).toBe(409)
    await ack(id)
    const r = await api<{ thread: OrgThread }>('PATCH', `/tasks/${lead}/threads/${id}`, { close: 'acked' }, sid)
    expect(r.status).toBe(200)
    expect(r.json.thread.closed).toMatchObject({ how: 'acked', by: `task:${lead}` })
  })

  it('its tasks all done: the follow pass tells the node once', async () => {
    const timer = (await addTask({ title: 'Replace the timer knob', project: 'Bakery', parent_task_id: lead })).task.id
    await updateTaskRaw(timer, { phase: 'IN_PROGRESS' } as never, { emitEvent: true })
    const id = await answeredThread('Replace the oven timer knob', [timer])
    await ack(id)
    pendingRiding(sid)?.markTold()
    await runThreadFollowPass()
    expect(ridingLine(sid, `thread-ack:${id}`)).toBeUndefined()
    await updateTaskRaw(timer, { phase: 'COMPLETE' } as never, { emitEvent: true })
    await runThreadFollowPass()
    expect(ridingLine(sid, `thread-ack:${id}`)).toContain(`Thread ${id}`)
    expect(ridingLine(sid, `thread-ack:${id}`)).toContain('its tasks are done. Tell him the outcome once (answered) or close it.')
    expect((await threadOf(id)).ackDone).toBeTruthy()
    pendingRiding(sid)?.markTold()
    await runThreadFollowPass()
    expect(ridingLine(sid, `thread-ack:${id}`)).toBeUndefined()
  })
})
