/**
 * Cloud launch → immediate use (the projection gap) — 2026-08-07 regression.
 *
 * Real startServer({ port: 0 }) with CLOUD_MODE forced and the bridge mocked
 * at its module seam. Reproduces the phone's EXACT sequence after creating a
 * session through the replica:
 *
 *   POST /api/v1/sessions           → 201 { sessionId }
 *   GET  /sessions/:id/stream       ─┐  all fired within seconds, BEFORE the
 *   GET  /sessions/:id/transcript   ─┤  git-synced projection.json contains
 *   POST /sessions/:id/messages     ─┘  the new session (60s sweep + 30s git
 *                                       ticks = a 1–3 minute blind window)
 *
 * Before the launch-seed fix every one of those returned 404 "Session not
 * found" and the phone showed "Not sent — tap to retry" on a session whose
 * CLI was alive and waiting on the primary. The launch relay now seeds the
 * id→host mapping at 201 time; projectedSession() falls back to it when the
 * projection misses, and the projection takes over once it lands.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-launch-seed-cloud', { CLOUD_MODE: true }))

const bridgeRequestMock = vi.fn()
class BridgeOfflineError extends Error {
  constructor(hostAlias: string) { super(`No live bridge for host: ${hostAlias}`) }
}
vi.mock('../../../src/web/ws/bridge-registry.js', () => ({
  bridgeRequest: bridgeRequestMock,
  BridgeOfflineError,
  bridgeForHost: () => ({ connected: true }),
  bridgeHosts: () => [],
  bridgeAttachSession: async () => {},
  bridgeDetachSession: () => {},
  attachBridge: () => {},
  closeAllBridges: () => {},
}))

import { WALNUT_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { createDevice, _resetDeviceAuthForTesting } from '../../../src/core/device-auth.js'
import { _resetLaunchSeedsForTesting, seedLaunchedSession, getLaunchSeed } from '../../../src/core/sessions/launch-seed.js'

let server: HttpServer
let port: number
let deviceToken: string

const SID = 'launch-seed-sid-0001'
const HOST = 'devbox'

function authHeaders(): Record<string, string> {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${deviceToken}` }
}

function apiUrl(p: string): string {
  return `http://localhost:${port}${p}`
}

/** Bridge behavior for a freshly launched, alive session on HOST. */
function daemonAnswers(): Array<{ host: string; cmd: string }> {
  const calls: Array<{ host: string; cmd: string }> = []
  bridgeRequestMock.mockImplementation(async (host: string, cmd: string, params: Record<string, unknown> = {}) => {
    calls.push({ host, cmd })
    switch (cmd) {
      case 'session.launch': {
        const action = (params as { action?: string }).action
        if (action === 'launch') {
          return { ok: true, result: { sessionId: SID, taskId: 'task-1', title: 'Session: repo' } }
        }
        return { ok: true, result: { hosts: [], dirs: [] } }
      }
      case 'status': return { ok: true, exists: true, alive: true }
      case 'appendUserMarker': return { ok: true }
      case 'send': return { ok: true }
      // Freshly spawned session: jsonl exists but is empty-ish.
      case 'read-history': return { ok: true, main: '' }
      default: return { ok: true }
    }
  })
  return calls
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  _resetDeviceAuthForTesting()
  // Projection exists but does NOT contain SID — the blind window.
  await fs.mkdir(path.join(WALNUT_HOME, 'sessions'), { recursive: true })
  await fs.writeFile(path.join(WALNUT_HOME, 'sessions', 'projection.json'), JSON.stringify({
    version: 1, exportedAt: new Date().toISOString(), sessions: [],
  }))
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  port = addr.port
  const device = await createDevice('launch-seed-test')
  deviceToken = device.token
}, 30_000)

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
})

beforeEach(() => {
  bridgeRequestMock.mockReset()
  _resetLaunchSeedsForTesting()
})

describe('mobile launch through the replica → immediate use (projection gap)', () => {
  it('messages / transcript / stream all work within seconds of the 201, before the projection syncs', async () => {
    const calls = daemonAnswers()

    // 1. Create — phone's New Session sheet.
    const create = await fetch(apiUrl('/api/v1/sessions'), {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({ cwd: '/home/user/repo', host: HOST, message: 'hi' }),
    })
    expect(create.status).toBe(201)
    expect((await create.json()).sessionId).toBe(SID)

    // 2. Send a message immediately — this was the "Not sent — tap to retry".
    const send = await fetch(apiUrl(`/api/v1/sessions/${SID}/messages`), {
      method: 'POST', headers: authHeaders(), body: JSON.stringify({ text: '你好' }),
    })
    expect(send.status).toBe(202)
    expect((await send.json()).messageId).toMatch(/^qm-mobile-/)
    // The send rode the bridge to the session's actual host, via the durable
    // session.message relay (the 2026-08-13 asymmetry fix).
    expect(calls.some((c) => c.cmd === 'session.message' && c.host === HOST)).toBe(true)

    // 3. Transcript poll (fresh=1 path the app uses while the view is open).
    const fresh = await fetch(apiUrl(`/api/v1/sessions/${SID}/transcript?fresh=1`), { headers: authHeaders() })
    expect(fresh.status).toBe(200)
    const freshBody = await fresh.json()
    expect(freshBody.sessionId).toBe(SID)
    expect(Array.isArray(freshBody.messages)).toBe(true)

    // 4. Non-fresh transcript (first paint) — no synced file yet → 200-empty,
    //    NOT 404 (the iOS view treats 404 as a dead session).
    const plain = await fetch(apiUrl(`/api/v1/sessions/${SID}/transcript`), { headers: authHeaders() })
    expect(plain.status).toBe(200)
    expect((await plain.json()).messages).toEqual([])

    // 5. SSE stream attach resolves the host and answers 200.
    const controller = new AbortController()
    const stream = await fetch(apiUrl(`/api/v1/sessions/${SID}/stream`), {
      headers: { ...authHeaders(), Accept: 'text/event-stream' },
      signal: controller.signal,
    })
    expect(stream.status).toBe(200)
    controller.abort()
  })

  it('send racing the async CLI spawn waits instead of 409 (live-suite catch, 2026-08-07)', async () => {
    // 201 is "accepted": the spawn on the primary is async. A send fired
    // milliseconds later sees status.exists=false; pre-fix it dropped into
    // the resume path and the daemon refused (no jsonl yet) → 409 on a
    // session seconds from alive. With a fresh seed the route now polls.
    // The spawn-wait poll lives on the DIRECT fallback path (the durable
    // session.message relay needs no probe — the primary's queue absorbs the
    // race), so this fake daemon predates session.message to exercise it.
    let statusCalls = 0
    const calls = daemonAnswers()
    bridgeRequestMock.mockImplementation(async (host: string, cmd: string, params: Record<string, unknown> = {}) => {
      calls.push({ host, cmd })
      if (cmd === 'session.launch' && (params as { action?: string }).action === 'launch') {
        return { ok: true, result: { sessionId: SID, taskId: 'task-1', title: 'Session: repo' } }
      }
      if (cmd === 'session.message') {
        return { ok: false, error: 'unknown command: session.message' }
      }
      if (cmd === 'status') {
        statusCalls++
        // First 2 probes: not spawned yet. Then alive.
        return statusCalls <= 2 ? { ok: true, exists: false } : { ok: true, exists: true, alive: true }
      }
      return { ok: true }
    })

    const create = await fetch(apiUrl('/api/v1/sessions'), {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({ cwd: '/home/user/repo', host: HOST, message: 'hi' }),
    })
    expect(create.status).toBe(201)

    const send = await fetch(apiUrl(`/api/v1/sessions/${SID}/messages`), {
      method: 'POST', headers: authHeaders(), body: JSON.stringify({ text: 'race the spawn' }),
    })
    expect(send.status).toBe(202)
    expect(statusCalls).toBeGreaterThanOrEqual(3) // it actually waited
    // Delivered via the live FIFO path, not resume.
    expect(calls.some((c) => c.cmd === 'send')).toBe(true)
    expect(calls.some((c) => c.cmd === 'bridgeResume')).toBe(false)
  }, 30_000)

  it('an unknown session id (never launched here, not in projection) still 404s', async () => {
    daemonAnswers()
    const send = await fetch(apiUrl('/api/v1/sessions/never-launched-here/messages'), {
      method: 'POST', headers: authHeaders(), body: JSON.stringify({ text: 'hi' }),
    })
    expect(send.status).toBe(404)
    expect((await send.json()).error.code).toBe('not_found')
  })

  it('once the projection lands it wins over the seed (host change follows the projection)', async () => {
    daemonAnswers()
    // Seed says devbox…
    seedLaunchedSession(SID, { host: HOST })
    // …but the projection has since synced with the authoritative record
    // (session actually runs on the primary box, host '').
    await fs.writeFile(path.join(WALNUT_HOME, 'sessions', 'projection.json'), JSON.stringify({
      version: 1, exportedAt: new Date().toISOString(),
      sessions: [{
        id: SID, host: '', process_status: 'running',
        started_at: new Date().toISOString(), last_active_at: new Date().toISOString(),
        message_count: 1, cwd: '/home/user/repo',
      }],
    }))
    const calls: Array<{ host: string; cmd: string }> = []
    bridgeRequestMock.mockImplementation(async (host: string, cmd: string) => {
      calls.push({ host, cmd })
      if (cmd === 'status') return { ok: true, exists: true, alive: true }
      return { ok: true }
    })
    const send = await fetch(apiUrl(`/api/v1/sessions/${SID}/messages`), {
      method: 'POST', headers: authHeaders(), body: JSON.stringify({ text: 'hello' }),
    })
    expect(send.status).toBe(202)
    // Bridge calls targeted the projection's host mapping ('' → '__local__'),
    // NOT the stale seed.
    expect(calls.every((c) => c.host === '__local__')).toBe(true)
    // Restore the empty projection for other tests.
    await fs.writeFile(path.join(WALNUT_HOME, 'sessions', 'projection.json'), JSON.stringify({
      version: 1, exportedAt: new Date().toISOString(), sessions: [],
    }))
  })

  it('a failed launch (validation error from the primary) seeds nothing', async () => {
    bridgeRequestMock.mockResolvedValue({ ok: false, error: 'Task "x" not found', errorKind: 'not_found' })
    const create = await fetch(apiUrl('/api/v1/sessions'), {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({ cwd: '/home/user/repo', host: HOST, taskId: 'x' }),
    })
    expect(create.status).toBe(404)
    expect(getLaunchSeed(SID)).toBeNull()
  })
})

describe('launch-seed cache semantics', () => {
  it('expires entries after the TTL', () => {
    vi.useFakeTimers()
    try {
      seedLaunchedSession('sid-ttl', { host: 'devbox' })
      expect(getLaunchSeed('sid-ttl')).toEqual({ host: 'devbox', cwd: undefined, model: undefined })
      vi.advanceTimersByTime(10 * 60 * 1000 + 1)
      expect(getLaunchSeed('sid-ttl')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('caps the map size FIFO without evicting fresh entries for expired ones', () => {
    for (let i = 0; i < 105; i++) seedLaunchedSession(`sid-${i}`, { host: 'h' })
    // Oldest dropped, newest kept.
    expect(getLaunchSeed('sid-0')).toBeNull()
    expect(getLaunchSeed('sid-104')).not.toBeNull()
  })
})
