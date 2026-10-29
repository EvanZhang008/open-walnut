/**
 * A task's message to a stuck task: its sender sees what it waits on, and can send it now.
 *
 * 2026-10-29: the user's bubble learned to say "Not sent yet: the computer running this
 * session did not start it in time ... next try at T" with a Send now (b0db96f09). A message
 * Main or another task sent the same stuck task only read "queued". Now the sender gets the
 * same facts in the task_send outcome and in request_get, and message_send_now sends it at
 * once, through the bubble's own path (core/sessions/send-now.ts).
 *
 * Also: org_send to a running task whose task row lost its session link answered
 * 409 session_exists instead of delivering (the contact read only the row).
 *
 * What's real: server, bus, queue, request store, runner, the slow-host clock.
 * Mocked: constants, the daemon (MockDaemon: a start that reports a command timeout),
 * the CLI (mock-claude.mjs).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Server } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-agent-send-wait'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { sessionRunner, slowHostReason } from '../../src/providers/claude-code-session.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'
import { addTask, getTask, updateTaskRaw } from '../../src/core/task-manager.js'
import { enqueueMessage, getQueue, resetCache } from '../../src/core/session-message-queue.js'
import { parkMessages } from '../../src/core/session-queue-park.js'
import { STOP_PARKED_REASON } from '../../src/core/relay-fates.js'
import { getSessionByClaudeId, updateSessionRecord } from '../../src/core/session-tracker.js'
import { getOp } from '../../src/ops/index.js'

let server: Server
let daemon: MockDaemon
let port: number
let asker: { taskId: string; sid: string }

const MOCK_CLI = path.resolve(import.meta.dirname, '../providers/mock-claude.mjs')
const START_TIMEOUT = 'daemon command timeout: start (30000ms) [traceId=d324a031]'

async function startOn(title: string): Promise<{ taskId: string; sid: string }> {
  const taskId = (await addTask({ title, project: 'Test' })).task.id
  const sid = (await sessionRunner.startSession({ taskId, cwd: WALNUT_HOME, message: 'Ready', project: 'Test', preassignedSessionId: randomUUID() })).claudeSessionId
  await vi.waitFor(async () => {
    expect((await getSessionByClaudeId(sid))?.process_status).toMatch(/idle|stopped/)
  }, { timeout: 20_000 })
  return { taskId, sid }
}

async function api<T = Record<string, unknown>>(method: string, p: string, body?: unknown, callerSid?: string): Promise<{ status: number; json: T }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/v1${p}`, {
    method,
    headers: { 'content-type': 'application/json', ...(callerSid ? { 'x-walnut-caller-sid': callerSid } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  return { status: res.status, json: await res.json().catch(() => ({})) as T }
}

type Delivery = { state: string; reason?: string; retryAt?: string; messageId?: string }

beforeAll(async () => {
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  daemon = await createMockDaemon()
  sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemon.port}`)
  daemon.setCliCommand(MOCK_CLI)
  server = await startServer({ port: 0, dev: true })
  port = (server.address() as { port: number }).port
  asker = await startOn('Asking lead')
}, 120_000)

// Each case stands alone: a fault one leaves (it failed partway) never reaches the next.
afterEach(() => { daemon.injectStartFault(null) })

afterAll(async () => {
  daemon.injectStartFault(null)
  sessionRunner.setTestDaemonUrl(undefined)
  await stopServer()
  await daemon?.stop()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
}, 60_000)

describe('a message to a task whose host did not start it in time', () => {
  it('its sender reads the wait, the next try and how to send it now; Send now sends the same row once', async () => {
    const target = await startOn('Stuck target')
    // Its CLI is gone, so the message needs a start, and the host does not answer it.
    daemon.simulateDeath(target.sid, 0)
    await updateSessionRecord(target.sid, { process_status: 'stopped' })
    daemon.injectStartFault(START_TIMEOUT)

    const sent = await api<{ requestId: string; messageId: string }>('POST', '/messages',
      { to: target.taskId, title: 'Check the build', text: 'Is the build green?', expect_reply: true }, asker.sid)
    expect(sent.status).toBe(202)
    const { requestId, messageId } = sent.json
    expect(requestId).toMatch(/^rq-/)

    // request_get: still pending, and the message has not reached the session yet.
    let delivery: Delivery | undefined
    await vi.waitFor(async () => {
      delivery = (await api<{ delivery?: Delivery }>('GET', `/requests/${requestId}`)).json.delivery
      expect(delivery?.state).toBe('waiting')
    }, { timeout: 30_000 })
    expect(delivery).toMatchObject({ messageId, reason: slowHostReason('start') })
    const wait = Date.parse(delivery!.retryAt ?? '') - Date.now()
    expect(wait).toBeGreaterThan(0)
    expect(wait).toBeLessThanOrEqual(15_000)
    const read = getOp('request_get')!.mapResult!({ body: { request: { id: requestId, status: 'pending' }, delivery }, args: { id: requestId } } as never) as { outcome: string }
    expect(read.outcome).toContain('has not reached that session yet')
    expect(read.outcome).toContain(slowHostReason('start'))
    expect(read.outcome).toContain(`message_send_now {"id":"${requestId}"}`)

    // A second message: it tries again at once, fails the same way, and its outcome says so.
    const startsOf = () => daemon.getCommandHistoryFor('start').filter((c) => c.payload.sid === target.sid).length
    const triedFirst = startsOf()
    const second = await api<{ waiting?: { reason: string; retryAt?: string }; messageId: string; requestId?: string }>('POST', '/messages',
      { to: target.taskId, title: 'One more', text: 'And the tests?', expect_reply: false }, asker.sid)
    expect(second.status).toBe(202)
    expect(second.json.waiting?.reason).toBe(slowHostReason('start'))
    const told = getOp('task_send')!.mapResult!({ body: second.json, args: { to: target.taskId } } as never) as { outcome: string }
    expect(told.outcome).toContain('did not answer the last message in time')
    // No request was asked for this one: no request_get to point at.
    expect(told.outcome).not.toContain('request_get')
    expect(told.outcome).toContain('This send tries again now')
    expect(told.outcome).toContain(`message_send_now {"id":"${second.json.messageId}"}`)
    await vi.waitFor(async () => {
      expect(startsOf()).toBeGreaterThan(triedFirst)
      const d = (await api<{ delivery?: Delivery }>('GET', `/requests/${requestId}`)).json.delivery
      expect(d?.state).toBe('waiting')
      // The clock doubled after the second refusal: the next try is well past what this test waits.
      expect(Date.parse(d?.retryAt ?? '') - Date.now()).toBeGreaterThan(20_000)
    }, { timeout: 30_000 })

    // The host answers again, but nothing goes out before the clock unless someone asks.
    daemon.injectStartFault(null)
    const cutoff = Date.now()
    await new Promise((r) => setTimeout(r, 1_500))
    expect(startsOf()).toBe(daemon.getCommandHistoryFor('start').filter((c) => c.payload.sid === target.sid && c.timestamp < cutoff).length)
    resetCache()
    expect((await getQueue(target.sid)).map((m) => m.id)).toContain(messageId)

    // Send now: the queued rows go at once, the same rows, never a copy.
    const now = await api<{ sent: boolean; messageId: string; sessionId: string }>('POST', `/messages/${requestId}/send-now`, {}, asker.sid)
    expect(now.status).toBe(200)
    expect(now.json).toMatchObject({ sent: true, messageId, sessionId: target.sid })
    await vi.waitFor(async () => {
      resetCache()
      expect((await getQueue(target.sid)).map((m) => m.id)).not.toContain(messageId)
    }, { timeout: 15_000 })
    // Written to the CLI once (a start that carries a line, or a write to its FIFO); a
    // send's own re-sends carry a dedupe uuid the daemon drops.
    const lines = [
      ...daemon.getCommandHistoryFor('start').filter((c) => c.payload.sid === target.sid && c.timestamp >= cutoff).map((c) => String(c.payload.message ?? '')),
      ...daemon.getFifoWrites().filter((w) => w.sid === target.sid && w.timestamp >= cutoff).map((w) => w.message),
    ]
    expect(lines.filter((m) => m.includes('Is the build green?'))).toHaveLength(1)
    // Gone from the queue: nothing to report, and nothing to send again.
    expect((await api<{ delivery?: Delivery }>('GET', `/requests/${requestId}`)).json.delivery).toBeUndefined()
    const again = await api<{ error?: { code?: string } }>('POST', `/messages/${requestId}/send-now`, {}, asker.sid)
    expect(again.status).toBe(409)
    expect(again.json.error?.code).toBe('not_queued')
  }, 120_000)
})

describe('a message the user set aside', () => {
  it("an agent's send now leaves it for the user's Retry, and request_get says so", async () => {
    const target = await startOn('Stopped by the user')
    const row = await enqueueMessage(target.sid, 'held by a stop')
    await parkMessages([row], STOP_PARKED_REASON)
    const out = await api<{ error?: { code?: string }; parkedReason?: string }>('POST', `/messages/${row.id}/send-now`, {}, asker.sid)
    expect(out.status).toBe(409)
    expect(out.json.error?.code).toBe('parked')
    expect(out.json.parkedReason).toBe(STOP_PARKED_REASON)
    resetCache()
    expect((await getQueue(target.sid)).find((m) => m.id === row.id)?.status).toBe('parked')
    const read = getOp('request_get')!.mapResult!({ body: { request: { id: 'rq-aaaaaa', status: 'pending' }, delivery: { state: 'parked', reason: STOP_PARKED_REASON } }, args: {} } as never) as { outcome: string }
    expect(read.outcome).toContain('set aside before it reached that session')
  }, 60_000)
})

describe('a send from a script outside every session', () => {
  it('reads as the automation that sent it, never as the user', async () => {
    const target = await startOn('Told by a watchdog')
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-walnut-caller-kind': 'automation', 'x-walnut-sender': 'load-watchdog' },
      body: JSON.stringify({ to: target.taskId, title: 'Paused your job', text: 'Your vitest run was paused.' }),
    })
    expect(res.status).toBe(202)
    const { messageId } = await res.json() as { messageId: string }
    // The row's sender and the words the session reads.
    resetCache()
    const row = (await getQueue(target.sid)).find((m) => m.id === messageId)
    const text = row?.message ?? [...daemon.getCommandHistoryFor('start'), ...daemon.getCommandHistoryFor('send')]
      .filter((c) => c.payload.sid === target.sid).map((c) => String(c.payload.message ?? '')).find((m) => m.includes('Your vitest run was paused.')) ?? ''
    expect(text).toContain('from="automation: load-watchdog"')
    expect(text).toContain('not your user')
    if (row) expect(row.sentBy).not.toBe('person')

    // The real CLI, run the way a LaunchAgent runs it: no session, no terminal, no Walnut env.
    const { spawn } = await import('node:child_process')
    const cli = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn('bun', [path.resolve('src/cli.ts'), 'tools', 'call', 'task_send',
        JSON.stringify({ to: target.taskId, title: 'From the CLI', text: 'Sent by a job with no terminal.' })], {
        env: { HOME: process.env.HOME ?? '', PATH: process.env.PATH ?? '', WALNUT_SENDER: 'load-watchdog', OPEN_WALNUT_API_URL: `http://127.0.0.1:${port}` },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (d) => { stdout += String(d) })
      child.stderr.on('data', (d) => { stderr += String(d) })
      const kill = setTimeout(() => child.kill('SIGTERM'), 90_000)
      child.on('close', (status) => { clearTimeout(kill); resolve({ status, stdout, stderr }) })
    })
    expect(cli.status, cli.stderr).toBe(0)
    const cliId = (JSON.parse(cli.stdout) as { messageId?: string }).messageId
    expect(cliId).toBeTruthy()
    resetCache()
    const cliRow = (await getQueue(target.sid)).find((m) => m.id === cliId)
    const cliText = cliRow?.message ?? [...daemon.getCommandHistoryFor('start'), ...daemon.getCommandHistoryFor('send')]
      .filter((c) => c.payload.sid === target.sid).map((c) => String(c.payload.message ?? '')).find((m) => m.includes('Sent by a job with no terminal.')) ?? ''
    expect(cliText).toContain('from="automation: load-watchdog"')

    // The user's own terminal (no headers) still writes as the user: plain text, no fence.
    const own = await fetch(`http://127.0.0.1:${port}/api/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: target.taskId, text: 'From me, typed.' }),
    })
    expect(own.status).toBe(202)
  }, 150_000)
})

describe('org_send to a running task', () => {
  it('reads the session records, so a task whose row lost its session link is messaged, not started', async () => {
    const target = await startOn('Running teammate')
    await updateTaskRaw(target.taskId, { session_id: '', exec_session_id: '', session_ids: [] } as never, { source: 'test' } as never)
    expect((await getTask(target.taskId)).session_id || undefined).toBeUndefined()
    const contact = await api<{ started: boolean }>('POST', '/org/contact', { to: target.taskId }, asker.sid)
    expect(contact.status).toBe(200)
    expect(contact.json.started).toBe(true)
  }, 60_000)

  it('a start that answers session_exists sends the message instead', async () => {
    const calls: Array<[string, string]> = []
    const call = async (method: string, p: string) => {
      calls.push([method, p])
      if (p === '/org/contact') return { task: { id: 't-run', title: 'Teammate' }, kind: 'task', started: false }
      if (p.endsWith('/start')) throw new Error('Walnut API error (session_exists): Task t-run already has a running session')
      if (p === '/messages') return { delivery: 'queued', messageId: 'qm-1', targetSessionId: 's-run' }
      throw new Error(`unexpected ${method} ${p}`)
    }
    const out = await getOp('org_send')!.handler!({ to: 't-run', text: 'Status?' } as never, call as never) as { outcome: string }
    expect(calls.map(([, p]) => p)).toEqual(['/org/contact', '/tasks/t-run/start', '/messages'])
    expect(out.outcome).toContain('Message queued for Teammate')
  })
})
