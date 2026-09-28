/**
 * Stopping ONE background task of a session (the Background tasks reader's Stop):
 * POST /api/v1/sessions/:id/background-tasks/:taskId/stop → core/sessions/
 * background-task-stop.ts → ClaudeCodeSession.stopBackgroundTask → the CLI's
 * `stop_task` control request (the same one the Agent SDK's `stopTask` sends).
 *
 * Real startServer({ port: 0, dev: true }), real session records, a real
 * ClaudeCodeSession registered with the runner. The only fake is the CLI: the
 * session's transport records what would be written to its stdin, and the test
 * answers with the control_response the CLI would send.
 *
 * Pinned: the exact request on the wire; an id outside this session's ledger
 * never reaches the CLI; an ended task answers without a round trip; a CLI
 * refusal is an error, never "stopped"; and the relay action a replica uses
 * reaches the same code.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-bg-task-stop'))

import { WALNUT_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { addTask } from '../../../src/core/task-manager.js'
import { createSessionRecord } from '../../../src/core/session-tracker.js'
import { ClaudeCodeSession, sessionRunner } from '../../../src/providers/claude-code-session.js'
import { handleSessionControlRelay } from '../../../src/core/sessions/session-controls.js'

let server: HttpServer
let port: number
const api = (p: string): string => `http://localhost:${port}${p}`

type Internals = {
  claudeSessionId: string | null
  _transport: { writeRaw: (line: string) => Promise<boolean> } | null
  _bgTasks: Map<string, { status: string; taskType?: string; description?: string }>
  handleStreamLine: (line: string) => void
}

let seq = 0
/** A live session with `tasks` in its ledger; `written` collects its stdin lines. */
async function liveSession(tasks: Record<string, { status: string; taskType?: string }>) {
  seq += 1
  const { task } = await addTask({ title: `Stop test ${seq}`, project: 'stoptest' })
  const sid = `33333333-4444-5555-6666-${String(seq).padStart(12, '0')}`
  await createSessionRecord(sid, task.id, 'stoptest', '/repo/stoptest', { title: task.title })
  const session = new ClaudeCodeSession(task.id, 'stoptest')
  const inner = session as unknown as Internals
  const written: string[] = []
  let writeOk = true
  inner.claudeSessionId = sid
  inner._transport = { writeRaw: async (line: string) => { written.push(line); return writeOk } }
  for (const [id, t] of Object.entries(tasks)) inner._bgTasks.set(id, { description: id, ...t })
  ;(sessionRunner as unknown as { sessions: Map<string, ClaudeCodeSession> }).sessions.set(task.id, session)
  return {
    sid, written,
    failWrites: () => { writeOk = false },
    /** Answer the newest control_request the way the CLI does. */
    answer: (reply: { error?: string }) => {
      const req = JSON.parse(written[written.length - 1]) as { request_id: string }
      inner.handleStreamLine(JSON.stringify({
        type: 'control_response',
        response: reply.error
          ? { subtype: 'error', request_id: req.request_id, error: reply.error }
          : { subtype: 'success', request_id: req.request_id, response: {} },
      }))
    },
  }
}

async function waitForWrite(written: string[], n = 1): Promise<void> {
  for (let i = 0; i < 200 && written.length < n; i++) await new Promise((r) => setTimeout(r, 10))
  expect(written.length).toBeGreaterThanOrEqual(n)
}

function stop(sid: string, taskId: string): Promise<Response> {
  return fetch(api(`/api/v1/sessions/${sid}/background-tasks/${taskId}/stop`), { method: 'POST' })
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  port = addr.port
}, 30_000)

afterAll(async () => {
  ;(sessionRunner as unknown as { sessions: Map<string, ClaudeCodeSession> }).sessions.clear()
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

beforeEach(() => {
  ;(sessionRunner as unknown as { sessions: Map<string, ClaudeCodeSession> }).sessions.clear()
})

describe('POST /api/v1/sessions/:id/background-tasks/:taskId/stop', () => {
  it('sends stop_task for that one task and answers stopped once the CLI confirms', async () => {
    const s = await liveSession({ b7xk2m: { status: 'running', taskType: 'local_agent' }, bother1: { status: 'running' } })

    const pending = stop(s.sid, 'b7xk2m')
    await waitForWrite(s.written)
    const envelope = JSON.parse(s.written[0]) as Record<string, any>
    expect(envelope.type).toBe('control_request')
    expect(envelope.request).toEqual({ subtype: 'stop_task', task_id: 'b7xk2m' })
    expect(envelope.request_id).toMatch(/^stp-/)
    s.answer({})
    const res = await pending

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ sessionId: s.sid, taskId: 'b7xk2m', stopped: true, status: 'running' })
    // Only the one request: the other task and the turn are untouched.
    expect(s.written).toHaveLength(1)
  })

  it('reports a CLI refusal as 409 with its words, never as stopped', async () => {
    const s = await liveSession({ bgone: { status: 'running', taskType: 'local_bash' } })

    const pending = stop(s.sid, 'bgone')
    await waitForWrite(s.written)
    s.answer({ error: 'No task found with ID: bgone' })
    const res = await pending

    expect(res.status).toBe(409)
    const body = await res.json() as { error: { code: string; message: string } }
    expect(body.error.code).toBe('conflict')
    expect(body.error.message).toBe('The CLI did not stop the task: No task found with ID: bgone')
  })

  it('answers an already-ended task without a round trip', async () => {
    const s = await liveSession({ bdone: { status: 'completed' } })

    const res = await stop(s.sid, 'bdone')

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ stopped: false, status: 'completed' })
    expect(s.written).toHaveLength(0)
  })

  it('never sends an id outside this session\'s ledger (404)', async () => {
    const mine = await liveSession({ bmine: { status: 'running' } })
    const other = await liveSession({ btheirs: { status: 'running' } })

    const res = await stop(mine.sid, 'btheirs')

    expect(res.status).toBe(404)
    expect((await res.json() as { error: { code: string } }).error.code).toBe('not_found')
    expect(mine.written).toHaveLength(0)
    expect(other.written).toHaveLength(0)
  })

  it('refuses a malformed task id (400), an unknown session (404) and a session that is not running (409)', async () => {
    const s = await liveSession({ bok: { status: 'running' } })
    expect((await stop(s.sid, 'bad%20id')).status).toBe(400)
    expect((await stop('no-such-session', 'bok')).status).toBe(404)

    const { task } = await addTask({ title: 'Idle one', project: 'stoptest' })
    const deadSid = '33333333-4444-5555-6666-999999999999'
    await createSessionRecord(deadSid, task.id, 'stoptest', '/repo/stoptest', { title: 'Idle one' })
    const res = await stop(deadSid, 'bok')
    expect(res.status).toBe(409)
    expect((await res.json() as { error: { message: string } }).error.message).toMatch(/not running/)
    expect(s.written).toHaveLength(0)
  })

  it('reports a failed write to the CLI as 409', async () => {
    const s = await liveSession({ bwrite: { status: 'running' } })
    s.failWrites()

    const res = await stop(s.sid, 'bwrite')

    expect(res.status).toBe(409)
    expect((await res.json() as { error: { message: string } }).error.message).toMatch(/failed to write stop_task/)
  })
})

describe('the background-task.stop relay action (a replica\'s Stop)', () => {
  it('reaches the same stop on the primary', async () => {
    const s = await liveSession({ brelay: { status: 'running', taskType: 'local_workflow' } })

    const pending = handleSessionControlRelay('background-task.stop', s.sid, { taskId: 'brelay' })
    await waitForWrite(s.written)
    s.answer({})

    expect(await pending).toEqual({ ok: true, result: { sessionId: s.sid, taskId: 'brelay', stopped: true, status: 'running' } })
    expect(JSON.parse(s.written[0]).request).toEqual({ subtype: 'stop_task', task_id: 'brelay' })
  })

  it('carries a refusal back as an error, not a result', async () => {
    const s = await liveSession({})
    const reply = await handleSessionControlRelay('background-task.stop', s.sid, { taskId: 'bnope' })
    expect(reply.ok).toBe(false)
    if (!reply.ok) expect(reply.errorKind).toBe('not_found')
  })
})
