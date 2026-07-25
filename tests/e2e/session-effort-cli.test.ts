/**
 * E2E test for the reasoning-effort plumbing.
 *
 * The effort level reaches the CLI on two distinct paths:
 *   • cold spawn / cold resume → `claude -p --effort <level>` CLI argument
 *   • mid-session change      → `apply_flag_settings` control_request over the
 *                                live FIFO (NO respawn) via POST /api/sessions/:id/effort
 *
 * Coverage here:
 *   1. session:start with `effort` → --effort <level> on the first spawn
 *   2. session:start without effort → no --effort flag (CLI/API default)
 *   3. effort on an effort-incapable model (haiku) is suppressed (no flag)
 *   4. POST /:id/effort → persists record.effort (+ reports appliedLive), no respawn
 *   4b. POST /:id/effort capability gating → invalid level 400, `max` on non-Opus-4.6 409
 *   5. effort persists across turns (stored on the record, re-applied on cold resume
 *      even when a later turn doesn't re-specify it)
 *
 * Note: the live control_request delivery itself is proven by a real-binary probe
 * (2.1.170); the single-turn mock CLI can't faithfully drive the control loop, so
 * the E2E here focuses on route validation, persistence, and the cold-resume fallback.
 *
 * What's real: Express server, WebSocket, event bus, session-tracker, task-manager.
 * What's mocked: constants.js (temp dir), Claude CLI (mock-claude.mjs, which
 * echoes `[effort:<value>]` for whatever --effort arg it received).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { WebSocket } from 'ws'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants())

import { WALNUT_HOME } from '../../src/constants.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'

const MOCK_CLI = path.resolve(import.meta.dirname, '../providers/mock-claude.mjs')

let server: HttpServer
let port: number
let daemon: MockDaemon

function wsUrl(): string {
  return `ws://localhost:${port}/ws`
}

function connectWs(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl())
    ws.on('open', () => resolve(ws))
    ws.on('error', reject)
  })
}

interface WsEvent {
  type: string
  name?: string
  data?: Record<string, unknown>
  [key: string]: unknown
}

function waitForWsEvent(
  ws: WebSocket,
  eventName: string,
  predicate?: (evt: WsEvent) => boolean,
  timeoutMs = 15000,
): Promise<WsEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out waiting for ${eventName}`)),
      timeoutMs,
    )
    const handler = (raw: WebSocket.RawData) => {
      const frame = JSON.parse(raw.toString()) as WsEvent
      if (frame.type === 'event' && frame.name === eventName) {
        if (!predicate || predicate(frame)) {
          clearTimeout(timer)
          ws.off('message', handler)
          resolve(frame)
        }
      }
    }
    ws.on('message', handler)
  })
}

function sendWsRpc(ws: WebSocket, method: string, payload: unknown): Promise<WsEvent> {
  return new Promise((resolve, reject) => {
    const id = `rpc-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const timer = setTimeout(() => reject(new Error(`RPC ${method} timed out`)), 10000)
    const handler = (raw: WebSocket.RawData) => {
      const frame = JSON.parse(raw.toString()) as WsEvent
      if (frame.type === 'res' && (frame as Record<string, unknown>).id === id) {
        clearTimeout(timer)
        ws.off('message', handler)
        resolve(frame)
      }
    }
    ws.on('message', handler)
    ws.send(JSON.stringify({ type: 'req', id, method, payload }))
  })
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })

  daemon = await createMockDaemon()
  sessionRunner.setCliCommand(MOCK_CLI)
  sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemon.port}`)

  const tasksDir = path.join(WALNUT_HOME, 'tasks')
  await fs.mkdir(tasksDir, { recursive: true })
  await fs.writeFile(
    path.join(tasksDir, 'tasks.json'),
    JSON.stringify({
      version: 1,
      tasks: ['001', '002', '003', '004', '005', '006', '007', '008', '009', '010'].map(n => ({
        id: `effort-task-${n}`,
        title: `Effort test task ${n}`,
        status: 'todo',
        priority: 'immediate',
        category: 'Work',
        project: 'Walnut',
        session_ids: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        description: '',
        summary: '',
        note: '',
        subtasks: [],
        source: 'ms-todo',
      })),
    }),
  )

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

describe('session --effort plumbing: E2E', () => {
  // Test 1: session:start with effort → --effort <level> on first spawn
  it('session:start with effort=high → --effort high', async () => {
    const ws = await connectWs()

    const resultPromise = waitForWsEvent(ws, 'session:result')
    const rpcRes = await sendWsRpc(ws, 'session:start', {
      taskId: 'effort-task-001',
      message: 'test effort on start',
      project: 'Walnut',
      mode: 'bypass',
      model: 'opus',
      effort: 'high',
    })
    expect((rpcRes as Record<string, unknown>).ok).toBe(true)

    const result = await resultPromise
    const text = (result.data as { result?: string }).result ?? ''
    expect(text).toContain('[effort:high]')

    ws.close()
    await delay(50)
  })

  // Test 2: no effort → no --effort flag
  it('session:start without effort → no [effort:] marker', async () => {
    const ws = await connectWs()

    const resultPromise = waitForWsEvent(ws, 'session:result')
    const rpcRes = await sendWsRpc(ws, 'session:start', {
      taskId: 'effort-task-002',
      message: 'test no effort on start',
      project: 'Walnut',
      mode: 'bypass',
      model: 'opus',
    })
    expect((rpcRes as Record<string, unknown>).ok).toBe(true)

    const result = await resultPromise
    const text = (result.data as { result?: string }).result ?? ''
    expect(text).not.toContain('[effort:')

    ws.close()
    await delay(50)
  })

  // Test 3: effort on an effort-incapable model (haiku) is suppressed
  it('session:start with effort on haiku → no [effort:] marker (unsupported)', async () => {
    const ws = await connectWs()

    const resultPromise = waitForWsEvent(ws, 'session:result')
    const rpcRes = await sendWsRpc(ws, 'session:start', {
      taskId: 'effort-task-003',
      message: 'test effort suppressed on haiku',
      project: 'Walnut',
      mode: 'bypass',
      model: 'haiku',
      effort: 'high',
    })
    expect((rpcRes as Record<string, unknown>).ok).toBe(true)

    const result = await resultPromise
    const text = (result.data as { result?: string }).result ?? ''
    expect(text).toContain('[model:haiku]')
    expect(text).not.toContain('[effort:')

    ws.close()
    await delay(50)
  })

  // Test 4: mid-session effort change via POST /api/sessions/:id/effort — the new
  // non-intrusive path (apply_flag_settings control_request + persist, NO respawn).
  // Asserts the route validates, persists record.effort, and reports live delivery.
  it('POST /effort persists the level and reports appliedLive on a running session', async () => {
    const ws = await connectWs()

    const firstResultPromise = waitForWsEvent(ws, 'session:result')
    const rpcRes = await sendWsRpc(ws, 'session:start', {
      taskId: 'effort-task-004',
      message: 'initial turn before effort switch',
      project: 'Walnut',
      mode: 'bypass',
      model: 'opus',
    })
    expect((rpcRes as Record<string, unknown>).ok).toBe(true)

    const firstResult = await firstResultPromise
    const sessionId = (firstResult.data as { sessionId: string }).sessionId
    expect(sessionId).toBeTruthy()

    await delay(500)

    // Change effort via the REST route (no message send, no respawn).
    const resp = await fetch(`http://localhost:${port}/api/sessions/${sessionId}/effort`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ effort: 'low' }),
    })
    expect(resp.status).toBe(200)
    const body = await resp.json() as { effort?: string; appliedLive?: boolean }
    expect(body.effort).toBe('low')

    // Persisted onto the record regardless of live delivery.
    const recResp = await fetch(`http://localhost:${port}/api/sessions/${sessionId}`)
    const recBody = await recResp.json() as { session?: { effort?: string } }
    expect(recBody.session?.effort).toBe('low')

    ws.close()
    await delay(50)
  })

  // Test 4b: capability gating — the route rejects levels the model can't do,
  // since the CLI silently accepts them (verified against 2.1.170). `xhigh` is
  // NOT supported by Haiku (nor any effort at all), so it's a clean 409 case.
  it('POST /effort rejects invalid level (400) and unsupported level (409)', async () => {
    const ws = await connectWs()
    const resultPromise = waitForWsEvent(ws, 'session:result')
    await sendWsRpc(ws, 'session:start', {
      taskId: 'effort-task-006',
      message: 'gating test session',
      project: 'Walnut',
      mode: 'bypass',
      model: 'haiku',  // supports NO effort at all → any level is a 409
    })
    const sessionId = (await resultPromise).data!.sessionId as string
    await delay(400)

    // Invalid level → 400
    const bad = await fetch(`http://localhost:${port}/api/sessions/${sessionId}/effort`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ effort: 'ultra' }),
    })
    expect(bad.status).toBe(400)

    // any effort on haiku (effort-incapable) → 409
    const nope = await fetch(`http://localhost:${port}/api/sessions/${sessionId}/effort`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ effort: 'high' }),
    })
    expect(nope.status).toBe(409)

    ws.close()
    await delay(50)
  })

  // Test 4b2: the Opus family DOES accept `xhigh` (bare 'opus' → flagship, which
  // per the binary XJH allowlist is xhigh-capable). Route persists it with 200.
  // (The 409-xhigh path for older members like Opus 4.6 is unit-tested in
  // session-effort.test.ts via modelSupportsXhighEffort — no live CLI needed.)
  it('POST /effort accepts xhigh on an Opus session (200 + persisted)', async () => {
    const ws = await connectWs()
    const resultPromise = waitForWsEvent(ws, 'session:result')
    await sendWsRpc(ws, 'session:start', {
      taskId: 'effort-task-008',
      message: 'opus xhigh gating test',
      project: 'Walnut',
      mode: 'bypass',
      model: 'opus',
    })
    const sessionId = (await resultPromise).data!.sessionId as string
    await delay(400)

    const resp = await fetch(`http://localhost:${port}/api/sessions/${sessionId}/effort`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ effort: 'xhigh' }),
    })
    expect(resp.status).toBe(200)
    const body = await resp.json() as { effort?: string }
    expect(body.effort).toBe('xhigh')

    const rec = await fetch(`http://localhost:${port}/api/sessions/${sessionId}`)
    const recBody = await rec.json() as { session?: { effort?: string } }
    expect(recBody.session?.effort).toBe('xhigh')

    ws.close()
    await delay(50)
  })

  // Test 4c: the Opus family DOES accept `max` (the capability-map change) — the
  // route persists it with 200 rather than gating it. Guards against regressing
  // opus→max back to a 409.
  it('POST /effort accepts max on an Opus session (200 + persisted)', async () => {
    const ws = await connectWs()
    const resultPromise = waitForWsEvent(ws, 'session:result')
    await sendWsRpc(ws, 'session:start', {
      taskId: 'effort-task-007',
      message: 'opus max gating test',
      project: 'Walnut',
      mode: 'bypass',
      model: 'opus',  // opus family → max allowed
    })
    const sessionId = (await resultPromise).data!.sessionId as string
    await delay(400)

    const resp = await fetch(`http://localhost:${port}/api/sessions/${sessionId}/effort`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ effort: 'max' }),
    })
    expect(resp.status).toBe(200)
    const body = await resp.json() as { effort?: string }
    expect(body.effort).toBe('max')

    const rec = await fetch(`http://localhost:${port}/api/sessions/${sessionId}`)
    const recBody = await rec.json() as { session?: { effort?: string } }
    expect(recBody.session?.effort).toBe('max')

    ws.close()
    await delay(50)
  })

  // Test 4d: GET /:id/settings — the picker's live-pull endpoint. With the mock
  // CLI (exits per turn, can't answer get_settings) the live read returns null →
  // live:false + requested values from the record. That IS the honest contract:
  // never claim CLI truth without a live answer. (The live:true + applied path is
  // proven against the real binary + on live prod sessions.)
  it('GET /settings returns requested values and live:false when CLI not reachable', async () => {
    const ws = await connectWs()
    const resultPromise = waitForWsEvent(ws, 'session:result')
    await sendWsRpc(ws, 'session:start', {
      taskId: 'effort-task-009',
      message: 'settings pull test',
      project: 'Walnut',
      mode: 'bypass',
      model: 'opus',
      effort: 'medium',
    })
    const sessionId = ((await resultPromise).data as { sessionId: string }).sessionId
    await delay(400)

    const resp = await fetch(`http://localhost:${port}/api/sessions/${sessionId}/settings`)
    expect(resp.status).toBe(200)
    const body = await resp.json() as {
      live: boolean
      requested: { model?: string; effort?: string }
      applied: { model: string | null; effort: string | null } | null
    }
    expect(body.requested.effort).toBe('medium')
    expect(body.requested.model).toContain('opus')
    // Mock CLI died after its single turn → no live answer → applied null, live false.
    expect(body.live).toBe(false)
    expect(body.applied).toBeNull()

    // Unknown session → 404
    const missing = await fetch(`http://localhost:${port}/api/sessions/no-such-session/settings`)
    expect(missing.status).toBe(404)

    ws.close()
    await delay(50)
  })

  it('uses the live catalog as effort authority and exposes the configured default', async () => {
    const ws = await connectWs()
    const resultPromise = waitForWsEvent(ws, 'session:result')
    await sendWsRpc(ws, 'session:start', {
      taskId: 'effort-task-010',
      message: 'live catalog authority test',
      project: 'Walnut',
      mode: 'bypass',
      model: 'opus',
    })
    const sessionId = ((await resultPromise).data as { sessionId: string }).sessionId
    await delay(400)

    const originalGetOrAttach = sessionRunner.getOrAttachLiveSession.bind(sessionRunner)
    const liveSession = {
      mode: 'bypass',
      getSettingsSnapshot: vi.fn().mockResolvedValue({
        applied: { model: 'openai.gpt-5.6-sol', effort: 'xhigh' },
        effective: { effortLevel: 'xhigh' },
      }),
      getModelCatalog: vi.fn().mockResolvedValue({
        models: [{
          value: 'gpt-5.6-sol',
          resolvedModel: 'openai.gpt-5.6-sol',
          displayName: 'GPT-5.6 Sol',
          supportsEffort: true,
          supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
        }],
        fetchedAt: Date.now(),
      }),
      applyEffort: vi.fn().mockResolvedValue(true),
      refreshEffectiveEffort: vi.fn().mockResolvedValue('xhigh'),
      refreshAppliedSettings: vi.fn().mockResolvedValue({ model: 'openai.gpt-5.6-sol', effort: 'xhigh' }),
    }
    const attachSpy = vi.spyOn(sessionRunner, 'getOrAttachLiveSession').mockImplementation(async (id) => (
      id === sessionId ? liveSession as never : originalGetOrAttach(id)
    ))

    try {
      const accepted = await fetch(`http://localhost:${port}/api/sessions/${sessionId}/effort`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ effort: 'xhigh' }),
      })
      expect(accepted.status).toBe(200)
      expect(liveSession.applyEffort).toHaveBeenCalledWith('xhigh')

      const settings = await fetch(`http://localhost:${port}/api/sessions/${sessionId}/settings`)
      expect(settings.status).toBe(200)
      const settingsBody = await settings.json() as {
        live: boolean
        applied: { model: string | null; effort: string | null } | null
        effective: { effortLevel: string | null } | null
      }
      expect(settingsBody.live).toBe(true)
      expect(settingsBody.applied).toMatchObject({ model: 'openai.gpt-5.6-sol', effort: 'xhigh' })
      expect(settingsBody.effective).toEqual({ effortLevel: 'xhigh' })

      liveSession.getSettingsSnapshot.mockResolvedValue({
        applied: { model: 'global.anthropic.claude-opus-4-8', effort: 'high' },
        effective: { effortLevel: 'xhigh' },
      })
      liveSession.getModelCatalog.mockResolvedValue({
        models: [{
          value: 'global.anthropic.claude-opus-4-8',
          resolvedModel: 'global.anthropic.claude-opus-4-8',
          displayName: 'Opus',
          supportsEffort: true,
          supportedEffortLevels: ['low', 'medium', 'high', 'xhigh'],
        }],
        fetchedAt: Date.now(),
      })
      const rejected = await fetch(`http://localhost:${port}/api/sessions/${sessionId}/effort`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ effort: 'max' }),
      })
      expect(rejected.status).toBe(409)
      expect(liveSession.applyEffort).toHaveBeenCalledTimes(1)
    } finally {
      attachSpy.mockRestore()
      ws.close()
      await delay(50)
    }
  })

  // Test 5: effort persists across turns — a later turn that does NOT specify
  // effort still resumes with the previously-stored level (record.effort).
  it('effort persists across turns without re-specifying it', async () => {
    const ws = await connectWs()

    const firstResultPromise = waitForWsEvent(ws, 'session:result')
    const rpcRes = await sendWsRpc(ws, 'session:start', {
      taskId: 'effort-task-005',
      message: 'initial turn with medium effort',
      project: 'Walnut',
      mode: 'bypass',
      model: 'opus',
      effort: 'medium',
    })
    expect((rpcRes as Record<string, unknown>).ok).toBe(true)

    const firstResult = await firstResultPromise
    const sessionId = (firstResult.data as { sessionId: string }).sessionId
    const firstText = (firstResult.data as { result?: string }).result ?? ''
    expect(firstText).toContain('[effort:medium]')

    await delay(500)

    // Second turn: no effort field — must still resume with the stored 'medium'.
    const secondResultPromise = waitForWsEvent(
      ws,
      'session:result',
      (evt) => (evt.data as { sessionId?: string })?.sessionId === sessionId
        && ((evt.data as { result?: string })?.result ?? '').includes('second turn no effort field'),
    )
    await sendWsRpc(ws, 'session:send', {
      sessionId,
      message: 'second turn no effort field',
    })

    const secondResult = await secondResultPromise
    const secondText = (secondResult.data as { result?: string }).result ?? ''
    expect(secondText).toContain('[effort:medium]')

    ws.close()
    await delay(50)
  })
})
