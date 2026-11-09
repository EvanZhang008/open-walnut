/**
 * An ask queued for a stopped session reaches it across a server restart and a daemon restart,
 * and its asker is never told the target "has shown nothing" once it has the ask.
 *
 * 2026-11-08, Operations VP's reflection: a task_send answered `delivery: queued` to an idle task,
 * and 55 minutes later Walnut told the asker the session had not taken up the work; the resend got
 * the same notice while the target was answering the first. The log showed the ask read 10 s after
 * it was queued and one turn on it for 100 minutes: the notices came from a server whose view of
 * the session a restart and two dropped daemon links had left stale.
 *
 * The server is killed between the queue and the delivery: the daemon holds every cold-resume
 * `start` of the target (no CLI is spawned, nothing is written), then the server goes away. The
 * queue row must still be on disk, the next server must resume the session with it, the CLI must
 * answer it, and the request must read reached, which keeps the silent-target notice off. The same
 * queue across a daemon killed between enqueue and delivery, against the real daemon, is
 * tests/e2e/cloud-send-daemon-death-redelivery-e2e.test.ts.
 *
 * What's real: server, WS, bus, queue, request store, hooks, the silent-target judge. Mocked:
 * constants, the daemon (MockDaemon), the CLI (mock-claude.mjs).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Server } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-queued-ask-restart'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'
import { addTask } from '../../src/core/task-manager.js'
import { getQueue, resetCache } from '../../src/core/session-message-queue.js'
import { getSessionByClaudeId, updateSessionRecord } from '../../src/core/session-tracker.js'
import { getSessionRequest } from '../../src/core/session-requests.js'
import { remindSilent, SILENT_AFTER_MS, setHostProbeForTests } from '../../src/core/sessions/session-request-notify.js'

const MOCK_CLI = path.resolve(import.meta.dirname, '../providers/mock-claude.mjs')

let server: Server
let daemon: MockDaemon
let port: number
let asker: { taskId: string; sid: string }

async function boot(): Promise<void> {
  sessionRunner.setCliCommand(MOCK_CLI)
  sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemon.port}`)
  server = await startServer({ port: 0, dev: true })
  port = (server.address() as { port: number }).port
}

async function startOn(title: string): Promise<{ taskId: string; sid: string }> {
  const taskId = (await addTask({ title, project: 'Test' })).task.id
  const sid = (await sessionRunner.startSession({ taskId, cwd: WALNUT_HOME, message: 'Ready', project: 'Test', preassignedSessionId: randomUUID() })).claudeSessionId
  await vi.waitFor(async () => {
    expect((await getSessionByClaudeId(sid))?.process_status).toMatch(/idle|stopped/)
  }, { timeout: 20_000 })
  return { taskId, sid }
}

/** Its CLI is gone (Walnut's idle reap): the next message cold-resumes it. */
async function stopped(sid: string): Promise<void> {
  daemon.simulateDeath(sid, 0)
  await updateSessionRecord(sid, { process_status: 'stopped' })
}

async function ask(toTask: string, text: string): Promise<{ requestId: string; delivery: string; messageId?: string }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-walnut-caller-sid': asker.sid },
    body: JSON.stringify({ to: toTask, text, expect_reply: true }),
  })
  expect(res.status).toBe(202)
  return await res.json() as { requestId: string; delivery: string; messageId?: string }
}

/** The CLI wrote an answer turn after taking these words (the mock answers every line). */
async function answered(sid: string, words: string): Promise<boolean> {
  const file = daemon.streamFilePath(sid)
  const text = await fs.readFile(file, 'utf-8').catch(() => '')
  const at = text.indexOf(words)
  return at >= 0 && text.slice(at).includes('"type":"result"')
}

/** Silent-target notices that reached the asker. */
const silentNotices = () => [...daemon.getCommandHistoryFor('send'), ...daemon.getCommandHistoryFor('start')]
  .filter((c) => c.payload.sid === asker.sid && String(c.payload.message ?? '').includes('has shown nothing'))

beforeAll(async () => {
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  daemon = await createMockDaemon()
  await boot()
  asker = await startOn('Operations VP')
}, 120_000)

afterAll(async () => {
  setHostProbeForTests(null)
  sessionRunner.setTestDaemonUrl(undefined)
  await stopServer()
  await daemon?.stop()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
})

describe('an ask queued for a stopped session', () => {
  /** Commands that carried these words to this session, from `since` on in the daemon's log. */
  const carried = (sid: string, words: string, since = 0) => daemon.getCommandHistory().slice(since)
    .filter((c) => c.payload.sid === sid && ['start', 'send'].includes(c.cmd) && String(c.payload.message ?? '').includes(words))

  it('survives a server killed before its delivery: the next server resumes the session with it', async () => {
    const target = await startOn('Mac load')
    await stopped(target.sid)
    // Every resume of it waits for an answer that never comes: the server dies with the ask queued.
    const hold = daemon.holdCommandsFor('start', target.sid)
    const words = 'Look at the 11-07 load spikes.'
    const sent = await ask(target.taskId, words)
    expect(sent.delivery).toBe('queued')
    const rq = (await getSessionRequest(sent.requestId))!
    // The request names its queue row from the start, and nothing reached the CLI yet.
    expect(rq.messageId).toBe(sent.messageId)
    await vi.waitFor(() => expect(daemon.getCommandHistory().some((c) => c.cmd === 'start' && c.payload.sid === target.sid)).toBe(true), { timeout: 10_000 })
    expect(await answered(target.sid, words)).toBe(false)
    expect((await getSessionRequest(sent.requestId))?.reachedAt).toBeUndefined()

    await stopServer()
    // Durable: the row is on disk with the server gone.
    resetCache()
    expect((await getQueue(target.sid)).map((m) => m.id)).toContain(sent.messageId)
    expect(await answered(target.sid, words)).toBe(false)

    hold.release()
    const mark = daemon.getCommandHistory().length
    await boot()
    // The new server resumes the session with the ask, the CLI answers it, and the row leaves.
    await vi.waitFor(async () => expect(await answered(target.sid, words)).toBe(true), { timeout: 90_000 })
    expect(carried(target.sid, words, mark).length).toBeGreaterThanOrEqual(1)
    await vi.waitFor(async () => { resetCache(); expect((await getQueue(target.sid)).map((m) => m.id)).not.toContain(sent.messageId) }, { timeout: 30_000 })
    await vi.waitFor(async () => expect((await getSessionRequest(sent.requestId))?.reachedAt).toBeTruthy(), { timeout: 10_000 })
    // Taken once: the CLI answered one turn for it.
    const stream = await fs.readFile(daemon.streamFilePath(target.sid), 'utf-8')
    expect(stream.split(words).length - 1).toBeGreaterThanOrEqual(1)

    // Long after the ask, with a host that would say idle: it reached, so the asker is never told.
    setHostProbeForTests(async () => ({ alive: true, working: false }))
    expect(await remindSilent(Date.now() + 2 * SILENT_AFTER_MS)).toBe(0)
    expect(silentNotices()).toEqual([])
  }, 240_000)

  it('a start refused because the task already runs names the open ask and says not to resend', async () => {
    const target = await startOn('Already working')
    const sent = await ask(target.taskId, 'First ask.')
    // The mock answers at once; then the session reads live (mid-turn on it), as the 11-08 target was.
    await vi.waitFor(async () => expect(await answered(target.sid, 'First ask.')).toBe(true), { timeout: 30_000 })
    await updateSessionRecord(target.sid, { process_status: 'running' })
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/tasks/${target.taskId}/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-walnut-caller-sid': asker.sid },
      body: JSON.stringify({ message: 'Same ask again' }),
    })
    expect(res.status).toBe(409)
    const body = await res.json() as { error: { code: string; message: string }; open_request?: { id: string } }
    expect(body.error.code).toBe('session_exists')
    expect(body.error.message).toContain(sent.requestId)
    expect(body.error.message).toContain('do not send it again')
    expect(body.open_request?.id).toBe(sent.requestId)
  }, 120_000)
})
