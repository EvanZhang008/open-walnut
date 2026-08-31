/**
 * Real wiring for the unified send surface through startServer({ dev: true }):
 *   POST /api/v1/messages     (session_send core)
 *   GET  /api/v1/requests/:id (expect_reply status read)
 *
 * The repo rule is that every feature has at least one E2E through a real
 * server, not just a hand-mounted router. This drives the ACTUAL route table,
 * the real target resolver against the real task store, and the real on-disk
 * request ledger — the paths that do NOT need a spawned CLI. The reply loop and
 * fallback notification against a live session were verified manually against an
 * ephemeral server + real claude CLI; here we pin the deterministic contracts.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-messages-v1-e2e'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { addTask } from '../../src/core/task-manager.js'
import { createSessionRequest } from '../../src/core/session-requests.js'

let server: HttpServer
let port = 0
const api = (p: string): string => `http://localhost:${port}${p}`

async function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
  const res = await fetch(api(path), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
}, 30_000)

afterAll(async () => {
  await stopServer()
})

describe('POST /api/v1/messages', () => {
  it('rejects an empty text with 400 bad_request', async () => {
    const { status, json } = await post('/api/v1/messages', { to: 'anything', text: '   ' })
    expect(status).toBe(400)
    expect(json.error.code).toBe('bad_request')
  })

  it('404 unknown_target when nothing resolves', async () => {
    const { status, json } = await post('/api/v1/messages', { to: 'zzz-no-such-target', text: 'hi' })
    expect(status).toBe(404)
    expect(json.error.code).toBe('unknown_target')
  })

  it('409 task_has_no_session for a real task with no live session', async () => {
    const { task } = await addTask({ title: 'e2e no-session task' })
    const { status, json } = await post('/api/v1/messages', { to: task.id, text: 'hi' })
    expect(status).toBe(409)
    expect(json.error.code).toBe('task_has_no_session')
    // detail spreads as a TOP-LEVEL sibling of error (documented shape).
    expect(json.taskId).toBe(task.id)
  })
})

describe('GET /api/v1/requests/:id', () => {
  it('400 on a malformed id (never reads the ledger)', async () => {
    const res = await fetch(api('/api/v1/requests/notarq'))
    expect(res.status).toBe(400)
  })

  it('404 on a well-formed but unknown id', async () => {
    const res = await fetch(api('/api/v1/requests/rq-deadbeef0000'))
    expect(res.status).toBe(404)
  })

  it('200 with the row for a request seeded in the real ledger', async () => {
    const req = await createSessionRequest({
      fromSessionId: 'sess-asker',
      toSessionId: 'sess-target',
      toTaskId: 'task-1',
      text: 'did it work?',
    })
    const res = await fetch(api(`/api/v1/requests/${req.id}`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.request.id).toBe(req.id)
    expect(body.request.status).toBe('pending')
  })
})
