/** Client-supplied session id on POST /api/sessions/quick-start.
 *
 *  Root fix for the lost-response incident (2026-08-03): the browser's fetch
 *  timeout fired while the server had already started the session; the pending
 *  panel showed a false "Failed" and Retry created a duplicate. With the CLIENT
 *  minting the session id, a lost response is reconcilable: the client polls
 *  GET /api/sessions/<its-own-id> regardless of the response's fate.
 *
 *  Contract:
 *   - valid client `sessionId` (UUID) → server adopts it verbatim (response +
 *     session record use it, so a reconcile GET succeeds)
 *   - malformed `sessionId` → ignored, server mints its own (no injection into
 *     --session-id / file names)
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-qs-client-sid'))

import { WALNUT_HOME } from '../../src/constants.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'

const MOCK_CLI = path.resolve(import.meta.dirname, '../providers/mock-claude.mjs')

let server: HttpServer
let port: number
let daemon: MockDaemon

function apiUrl(p: string): string {
  return `http://localhost:${port}${p}`
}

async function quickStart(body: Record<string, unknown>): Promise<{ status: number; taskId?: string; sessionId?: string }> {
  const res = await fetch(apiUrl('/api/sessions/quick-start'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = res.status === 200 ? await res.json() as { taskId: string; sessionId?: string } : {}
  return { status: res.status, ...json }
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  daemon = await createMockDaemon()
  sessionRunner.setCliCommand(MOCK_CLI)
  sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemon.port}`)
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
})

afterAll(async () => {
  sessionRunner.setTestDaemonUrl(undefined)
  await stopServer()
  await daemon.stop()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('quick-start client-supplied session id', () => {
  it('adopts a valid client UUID and makes the session reconcilable by that id', async () => {
    const cwd = path.join(WALNUT_HOME, 'qs-client-sid')
    await fs.mkdir(cwd, { recursive: true })
    const clientId = '7f3e4d5c-1a2b-4c3d-8e9f-0a1b2c3d4e5f'

    const res = await quickStart({ cwd, message: '', sessionId: clientId })
    expect(res.status).toBe(200)
    expect(res.sessionId).toBe(clientId)

    // The reconcile path a timed-out client would use: GET by its own id.
    // Response envelope: { session: { taskId }, pendingPermissions }.
    const rec = await fetch(apiUrl(`/api/sessions/${clientId}`))
    expect(rec.status).toBe(200)
    const body = await rec.json() as { session?: { taskId?: string } }
    expect(body.session?.taskId).toBe(res.taskId)
  })

  it('ignores a malformed sessionId and mints its own', async () => {
    const cwd = path.join(WALNUT_HOME, 'qs-bad-sid')
    await fs.mkdir(cwd, { recursive: true })

    const res = await quickStart({ cwd, message: '', sessionId: '../../etc/passwd; rm -rf' })
    expect(res.status).toBe(200)
    expect(res.sessionId).toBeTruthy()
    expect(res.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
    expect(res.sessionId).not.toContain('passwd')
  })
})
