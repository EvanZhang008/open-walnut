/**
 * Regression: POST /api/v1/tasks/:id/start (the `walnut tools call task_start`
 * path) must inherit the project's default_host alongside its default_cwd.
 *
 * 2026-08-26: a task in a project with default_host=clouddev +
 * default_cwd=/workplace/... was started from the CLI. handleStart adopted the
 * remote default_cwd but never read default_host, so it spawned on the LOCAL
 * box with a remote-only path — the local cwd pre-flight refused
 * ("Working directory no longer exists"), the error path flipped the task to
 * AGENT_COMPLETE, and the CLI caller (already holding 200 {"action":"start"})
 * saw a task that looked finished but had no session. Host and cwd travel
 * together (resolveSessionContext semantics).
 *
 * Observable: with a configured-but-unreachable host in project metadata, the
 * spawn must fail REMOTELY (daemon/ssh error naming the host), never on a
 * local existence check of the remote-only path.
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

describe('task_start inherits project default_host with default_cwd', () => {
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
      body: JSON.stringify({ prompt: 'hello' }),
    })
    // The start endpoint answers before the async spawn resolves.
    expect(res.status).toBe(200)
    const body = await res.json() as { action: string }
    expect(body.action).toBe('start')

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
  }, 30_000)
})
