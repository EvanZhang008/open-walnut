/**
 * POST /api/v1/tasks/:id/start (the `walnut tools call session_start` path).
 *
 * Two contracts pinned here:
 *
 * ① HOST INHERITANCE. 2026-08-26: a task in a project with default_host=clouddev
 * + default_cwd=/workplace/... was started from the CLI. The start handler
 * adopted the remote default_cwd but never read default_host, so it spawned on
 * the LOCAL box with a remote-only path — the local cwd pre-flight refused
 * ("Working directory no longer exists"), the error path flipped the task to
 * AGENT_COMPLETE, and the CLI caller (already holding a success response) saw a
 * task that looked finished but had no session. Host and cwd travel together.
 * The route no longer resolves either one (it passes the body through and the
 * session-runner resolves task → parent → project), so this test drives the
 * REAL runner and asserts the observable end state.
 *
 * Observable: with a configured-but-unreachable host in project metadata, the
 * spawn must fail REMOTELY (daemon/ssh error naming the host), never on a local
 * existence check of the remote-only path.
 *
 * ② THE SESSION SLOT. A task whose session is still live gets 409
 * session_exists + existing_session_id instead of a second session — the caller
 * is meant to send into the live one with session_send.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-task-start-host'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { addTask, setProjectMetadata } from '../../src/core/task-manager.js'
import { bus, EventNames } from '../../src/core/event-bus.js'

let server: HttpServer
let port = 0

const api = (p: string): string => `http://localhost:${port}${p}`

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  // A real hosts entry so host resolution succeeds and the spawn proceeds to
  // the (unreachable) remote transport instead of throwing "Unknown host".
  await fs.writeFile(`${WALNUT_HOME}/config.yaml`, [
    'hosts:',
    '  test-remote:',
    '    hostname: nonexistent-host.invalid',
    '    user: nobody',
    '',
  ].join('\n'))
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
}, 30_000)

afterAll(async () => {
  await stopServer()
})

describe('session_start inherits project default_host with default_cwd', () => {
  it('routes to the project default_host instead of local + remote-only cwd', async () => {
    const { task } = await addTask({ title: 'remote-homed work', project: 'remote-proj' })
    await setProjectMetadata('remote-proj', {
      default_host: 'test-remote',
      default_cwd: '/workplace/only/on/the/remote/box',
    })

    const emitSpy = vi.spyOn(bus, 'emit')

    const res = await fetch(api(`/api/v1/tasks/${task.id}/start`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hello' }),
    })
    // 202: accepted — the route answers before the async spawn resolves.
    expect(res.status).toBe(202)
    const body = await res.json() as { taskId: string; title: string; sessionId?: string }
    expect(body.taskId).toBe(task.id)
    expect(body.title).toBe('remote-homed work')
    // The claude engine mints the session id up front, so the caller can open
    // the conversation without polling for it.
    expect(typeof body.sessionId).toBe('string')
    expect(body.sessionId).toMatch(/^[0-9a-f-]{36}$/)

    // The request named neither cwd nor host: resolving them is the RUNNER's job
    // now (task → parent chain → project metadata), and the route only passes the
    // body through plus the session id it minted.
    const startCall = emitSpy.mock.calls.find(([name, data]) =>
      name === EventNames.SESSION_START
      && (data as { taskId?: string }).taskId === task.id)
    expect(startCall, 'SESSION_START never emitted').toBeDefined()
    const startData = startCall![1] as Record<string, unknown>
    expect(startData.preassignedSessionId).toBe(body.sessionId)

    // Wait for the async spawn to fail and emit session:error for this task.
    const deadline = Date.now() + 15_000
    let errorText: string | undefined
    while (Date.now() < deadline && errorText === undefined) {
      const call = emitSpy.mock.calls.find(([name, data]) =>
        name === EventNames.SESSION_ERROR
        && (data as { taskId?: string }).taskId === task.id)
      if (call) errorText = String((call[1] as { error?: unknown }).error ?? '')
      else await new Promise((r) => setTimeout(r, 250))
    }

    expect(errorText, 'spawn failure never surfaced as session:error').toBeDefined()
    // The failure must be the REMOTE transport (proves default_host was
    // adopted), never the local existence check of the remote-only cwd.
    expect(errorText).not.toContain('Working directory no longer exists')
    expect(errorText!.toLowerCase()).toMatch(/test-remote|nonexistent-host|ssh|daemon/)

    // The runner writes the adopted host back onto the same event object, so the
    // inheritance is observable directly and not only through the error text.
    expect(startData.host, 'project default_host was not adopted').toBe('test-remote')
  }, 30_000)
})

describe('session_start refuses a second session for the same task', () => {
  it('409 session_exists carries the live session id to send into', async () => {
    const { task } = await addTask({ title: 'already running work', project: 'slot-proj' })
    const { createSessionRecord } = await import('../../src/core/session-tracker.js')
    const liveSid = '11111111-2222-3333-4444-555555555555'
    await createSessionRecord(liveSid, task.id, 'slot-proj', '/tmp/slot-proj', { title: task.title })

    const res = await fetch(api(`/api/v1/tasks/${task.id}/start`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'start another one' }),
    })
    expect(res.status).toBe(409)
    // sendV1Error spreads `extra` at the TOP level of the body, beside `error` —
    // not inside it. A client reading error.existing_session_id gets undefined.
    const body = await res.json() as {
      error: { code: string; message: string }
      existing_session_id?: string
    }
    expect(body.error.code).toBe('session_exists')
    expect(body.existing_session_id).toBe(liveSid)
    // The message must name the replacement call, not just refuse.
    expect(body.error.message).toContain('session_send')
  }, 30_000)

  it('404 for an unknown task id', async () => {
    const res = await fetch(api('/api/v1/tasks/task-does-not-exist/start'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'go' }),
    })
    expect(res.status).toBe(404)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe('not_found')
  }, 30_000)

  it('400 for a relative cwd and for a bogus engine', async () => {
    const { task } = await addTask({ title: 'shape checks', project: 'slot-proj' })
    for (const payload of [
      { cwd: 'relative/path' },
      { engine: 'nonsense' },
      { mode: 'yolo' },
      { model: 'not-a-model!!' },
    ]) {
      const res = await fetch(api(`/api/v1/tasks/${task.id}/start`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'go', ...payload }),
      })
      expect(res.status, JSON.stringify(payload)).toBe(400)
      const body = await res.json() as { error: { code: string } }
      expect(body.error.code, JSON.stringify(payload)).toBe('bad_request')
    }
  }, 30_000)
})
