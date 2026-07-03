/**
 * E2E test for session model switching.
 *
 * Model switches use the SAME live mechanism as effort (verified on binary
 * 2.1.170): apply_flag_settings control_request on the live CLI (no respawn,
 * running turn untouched) + record.cliModel persisted as the durable cold-resume
 * fallback. Two entry points, one mechanism:
 *
 *   POST /api/sessions/:id/model   (what the ModelPicker calls)
 *   session:send RPC with { model } (message + switch in one call)
 *
 * The mock CLI exits per turn (it can't hold the control loop), so what these
 * tests can prove is: route/RPC validation, cliModel persistence, and that the
 * NEXT turn's cold resume carries --model <new> (echoed as [model:…]). The live
 * apply_flag_settings delivery itself is proven by real-binary probes.
 *
 * What's real: Express server, WebSocket, event bus, session-tracker, task-manager.
 * What's mocked: constants.js (temp dir), Claude CLI (mock-claude.mjs), daemon.
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

// ── Helpers ──

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

function collectWsEvents(ws: WebSocket, eventNames: string[]): WsEvent[] {
  const events: WsEvent[] = []
  ws.on('message', (raw) => {
    const frame = JSON.parse(raw.toString()) as WsEvent
    if (frame.type === 'event' && eventNames.includes(frame.name!)) {
      events.push(frame)
    }
  })
  return events
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

// ── Setup / Teardown ──

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })

  // Isolated mock daemon — without this, sessions route through the REAL local
  // daemon and spawn the REAL claude CLI (setCliCommand alone isn't enough since
  // the daemon became the mandatory transport). Same harness as session-effort-cli.
  daemon = await createMockDaemon()
  sessionRunner.setCliCommand(MOCK_CLI)
  sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemon.port}`)

  // Seed test tasks (one per test scenario)
  const tasksDir = path.join(WALNUT_HOME, 'tasks')
  await fs.mkdir(tasksDir, { recursive: true })
  await fs.writeFile(
    path.join(tasksDir, 'tasks.json'),
    JSON.stringify({
      version: 1,
      tasks: ['001', '002', '003', '004', '005', '006', '007', '008'].map(n => ({
        id: `model-switch-task-${n}`,
        title: `Model switch test task ${n}`,
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

// ── Tests ──

describe('Session model switch: E2E', () => {
  it('deferred model switch — follow-up with model: sonnet', async () => {
    const ws = await connectWs()

    // Start session (default model = opus)
    const firstResultPromise = waitForWsEvent(ws, 'session:result')
    const rpcRes = await sendWsRpc(ws, 'session:start', {
      taskId: 'model-switch-task-001',
      message: 'initial turn, no model switch',
      project: 'Walnut',
      mode: 'bypass',
    })
    expect((rpcRes as Record<string, unknown>).ok).toBe(true)

    // Wait for first turn to complete
    const firstResult = await firstResultPromise
    const sessionId = (firstResult.data as { sessionId: string }).sessionId
    expect(sessionId).toBeTruthy()

    const firstText = (firstResult.data as { result?: string }).result ?? ''
    // First turn uses default model (opus) — should NOT contain [model:sonnet]
    expect(firstText).not.toContain('[model:sonnet]')

    // Send follow-up with model switch to sonnet. New semantics: the model is
    // applied live (apply_flag_settings) + persisted as cliModel; the mock CLI
    // exits per turn, so this next turn cold-resumes with --model sonnet.
    // Predicate filters by content — a replayed first result must not match.
    const secondResultPromise = waitForWsEvent(
      ws,
      'session:result',
      (evt) => (evt.data as { sessionId?: string })?.sessionId === sessionId
        && ((evt.data as { result?: string })?.result ?? '').includes('follow-up after model switch'),
    )
    await sendWsRpc(ws, 'session:send', {
      sessionId,
      message: 'follow-up after model switch',
      model: 'sonnet',
    })

    const secondResult = await secondResultPromise
    const secondText = (secondResult.data as { result?: string }).result ?? ''

    // Second turn must have [model:sonnet] — proves --model sonnet was passed
    expect(secondText).toContain('[model:sonnet]')

    ws.close()
    await delay(50)
  })

  it('immediate model switch (interrupt) — model: haiku with slow session', async () => {
    const ws = await connectWs()

    // Start a SLOW session (3s delay gives window for interrupt).
    // session:started doesn't carry sessionId, so we wait for session:status-changed
    // which has both taskId and sessionId (set after init event is received).
    const statusPromise = waitForWsEvent(
      ws,
      'session:status-changed',
      (evt) => {
        const d = evt.data as { taskId?: string; sessionId?: string }
        return d.taskId === 'model-switch-task-002' && !!d.sessionId
      },
    )
    const rpcRes = await sendWsRpc(ws, 'session:start', {
      taskId: 'model-switch-task-002',
      message: 'slow:3000 long running task',
      project: 'Walnut',
      mode: 'bypass',
    })
    expect((rpcRes as Record<string, unknown>).ok).toBe(true)

    // Wait for a status-changed event that has the sessionId (after init)
    const statusEvt = await statusPromise
    const sessionId = (statusEvt.data as { sessionId: string }).sessionId
    expect(sessionId).toBeTruthy()

    // Small delay to ensure the session is mid-processing
    await delay(500)

    // Send interrupt + model switch to haiku
    const resultPromise = waitForWsEvent(
      ws,
      'session:result',
      (evt) => {
        const d = evt.data as { sessionId?: string; result?: string }
        return d.sessionId === sessionId && (d.result?.includes('[model:haiku]') ?? false)
      },
    )
    await sendWsRpc(ws, 'session:send', {
      sessionId,
      message: 'interrupt and switch model',
      model: 'haiku',
      interrupt: true,
    })

    const result = await resultPromise
    const resultText = (result.data as { result?: string }).result ?? ''

    // Must have [model:haiku] — proves --model haiku was used on resume
    expect(resultText).toContain('[model:haiku]')
    expect(resultText).toContain('interrupt and switch model')

    ws.close()
    await delay(50)
  })

  it('model persists in session record — verify via REST', async () => {
    const ws = await connectWs()

    // Start session
    const firstResultPromise = waitForWsEvent(ws, 'session:result')
    await sendWsRpc(ws, 'session:start', {
      taskId: 'model-switch-task-003',
      message: 'initial turn',
      project: 'Walnut',
      mode: 'bypass',
    })

    const firstResult = await firstResultPromise
    const sessionId = (firstResult.data as { sessionId: string }).sessionId

    // Send follow-up with model switch
    const secondResultPromise = waitForWsEvent(
      ws,
      'session:result',
      (evt) => (evt.data as { sessionId?: string })?.sessionId === sessionId,
    )
    await sendWsRpc(ws, 'session:send', {
      sessionId,
      message: 'model switch to sonnet',
      model: 'sonnet',
    })

    await secondResultPromise

    // Let async record updates settle
    await delay(500)

    // Fetch session via REST
    const sessRes = await fetch(`http://localhost:${port}/api/sessions/${sessionId}`)
    expect(sessRes.status).toBe(200)
    const sessData = (await sessRes.json()) as {
      session: {
        claudeSessionId: string
      }
    }

    // Session record should exist with a valid claude session ID
    expect(sessData.session.claudeSessionId).toBeTruthy()

    ws.close()
    await delay(50)
  })

  it('model switch is durable — a later send without model keeps the new model', async () => {
    const ws = await connectWs()

    // Turn 1: start session (default model = opus)
    const firstResultPromise = waitForWsEvent(ws, 'session:result')
    await sendWsRpc(ws, 'session:start', {
      taskId: 'model-switch-task-004',
      message: 'initial turn',
      project: 'Walnut',
      mode: 'bypass',
    })

    const firstResult = await firstResultPromise
    const sessionId = (firstResult.data as { sessionId: string }).sessionId

    // Let the first turn's result handler drain before the next send.
    await delay(500)

    // Turn 2: switch to sonnet (persisted as cliModel — durable, not one-shot)
    const secondResultPromise = waitForWsEvent(
      ws,
      'session:result',
      (evt) => (evt.data as { sessionId?: string })?.sessionId === sessionId
        && ((evt.data as { result?: string })?.result ?? '').includes('switch to sonnet'),
    )
    await sendWsRpc(ws, 'session:send', {
      sessionId,
      message: 'switch to sonnet',
      model: 'sonnet',
    })

    const secondResult = await secondResultPromise
    const secondText = (secondResult.data as { result?: string }).result ?? ''
    expect(secondText).toContain('[model:sonnet]')

    // Wait for turn 2's result handler processNext to drain before sending turn 3
    await delay(500)

    // Turn 3: send WITHOUT model field — the switch is durable (cliModel), so the
    // session STAYS on sonnet. This is the new contract: a model switch behaves
    // like the CLI's own /model — set once, stays until changed again.
    const thirdResultPromise = waitForWsEvent(
      ws,
      'session:result',
      (evt) => {
        const d = evt.data as { sessionId?: string; result?: string }
        return d.sessionId === sessionId && (d.result?.includes('no model override this time') ?? false)
      },
    )
    await sendWsRpc(ws, 'session:send', {
      sessionId,
      message: 'no model override this time',
    })

    const thirdResult = await thirdResultPromise
    const thirdText = (thirdResult.data as { result?: string }).result ?? ''

    expect(thirdText).toContain('no model override this time')
    expect(thirdText).toContain('[model:sonnet]')

    ws.close()
    await delay(50)
  })

  it('empty message model switch — pure switch, no turn triggered, applies on next real turn', async () => {
    const ws = await connectWs()

    // Start session
    const firstResultPromise = waitForWsEvent(ws, 'session:result')
    await sendWsRpc(ws, 'session:start', {
      taskId: 'model-switch-task-005',
      message: 'initial turn before empty model switch',
      project: 'Walnut',
      mode: 'bypass',
    })

    const firstResult = await firstResultPromise
    const sessionId = (firstResult.data as { sessionId: string }).sessionId
    await delay(500)

    // Empty message + model = a PURE switch under the new semantics: applied live /
    // persisted, nothing enqueued, no turn, RPC resolves immediately (old path had
    // to fake an empty-message turn to force a respawn).
    const rpcRes = await sendWsRpc(ws, 'session:send', {
      sessionId,
      message: '',
      model: 'sonnet',
    })
    expect((rpcRes as Record<string, unknown>).ok).toBe(true)

    // Persisted for cold resume.
    const recResp = await fetch(`http://localhost:${port}/api/sessions/${sessionId}`)
    const recBody = await recResp.json() as { session?: { cliModel?: string } }
    expect(recBody.session?.cliModel).toBe('sonnet')

    // The next REAL turn resumes with --model sonnet.
    const secondResultPromise = waitForWsEvent(
      ws,
      'session:result',
      (evt) => (evt.data as { sessionId?: string })?.sessionId === sessionId
        && ((evt.data as { result?: string })?.result ?? '').includes('real turn after pure switch'),
    )
    await sendWsRpc(ws, 'session:send', { sessionId, message: 'real turn after pure switch' })
    const secondText = ((await secondResultPromise).data as { result?: string }).result ?? ''
    expect(secondText).toContain('[model:sonnet]')

    ws.close()
    await delay(50)
  })
})

// ── Live model switch via POST /api/sessions/:id/model ─────────────────────
// The NEW primary switch path (what the ModelPicker now calls): NO message send,
// NO respawn — apply_flag_settings control_request on the live CLI + persisted
// cliModel for cold resume. The live control_request delivery itself is proven by
// real-binary probes (2.1.170: {model:'sonnet'} flips the next turn's assistant
// model, ACK lies for garbage values, [1m] round-trips); the mock CLI can't drive
// the control loop, so this E2E covers route validation, persistence, and the
// cold-resume fallback.
describe('POST /api/sessions/:id/model — live switch route', () => {
  it('persists cliModel and a later resume uses it', async () => {
    const ws = await connectWs()

    const firstResultPromise = waitForWsEvent(ws, 'session:result')
    await sendWsRpc(ws, 'session:start', {
      taskId: 'model-switch-task-006',
      message: 'initial turn before REST model switch',
      project: 'Walnut',
      mode: 'bypass',
    })
    const firstResult = await firstResultPromise
    const sessionId = (firstResult.data as { sessionId: string }).sessionId
    expect(sessionId).toBeTruthy()
    await delay(500)

    // Switch via the REST route (no message, no respawn).
    const resp = await fetch(`http://localhost:${port}/api/sessions/${sessionId}/model`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'sonnet' }),
    })
    expect(resp.status).toBe(200)
    const body = await resp.json() as { model?: string; cliModel?: string; appliedLive?: boolean }
    expect(body.model).toBe('sonnet')
    expect(body.cliModel).toBe('sonnet')

    // Persisted onto the record (durable cold-resume fallback).
    const recResp = await fetch(`http://localhost:${port}/api/sessions/${sessionId}`)
    const recBody = await recResp.json() as { session?: { cliModel?: string } }
    expect(recBody.session?.cliModel).toBe('sonnet')

    // Cold-resume fallback: the next turn (mock CLI exits per turn → respawn with
    // --resume) must carry --model sonnet from the persisted cliModel.
    const secondResultPromise = waitForWsEvent(
      ws,
      'session:result',
      (evt) => (evt.data as { sessionId?: string })?.sessionId === sessionId
        && ((evt.data as { result?: string })?.result ?? '').includes('turn after REST switch'),
    )
    await sendWsRpc(ws, 'session:send', { sessionId, message: 'turn after REST switch' })
    const secondResult = await secondResultPromise
    const secondText = (secondResult.data as { result?: string }).result ?? ''
    expect(secondText).toContain('[model:sonnet]')

    ws.close()
    await delay(50)
  })

  it('rejects an unknown model alias (400) and a missing session (404)', async () => {
    const ws = await connectWs()
    const resultPromise = waitForWsEvent(ws, 'session:result')
    await sendWsRpc(ws, 'session:start', {
      taskId: 'model-switch-task-007',
      message: 'validation test session',
      project: 'Walnut',
      mode: 'bypass',
    })
    const sessionId = ((await resultPromise).data as { sessionId: string }).sessionId
    await delay(400)

    const bad = await fetch(`http://localhost:${port}/api/sessions/${sessionId}/model`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5' }),
    })
    expect(bad.status).toBe(400)

    const missing = await fetch(`http://localhost:${port}/api/sessions/no-such-session/model`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'sonnet' }),
    })
    expect(missing.status).toBe(404)

    ws.close()
    await delay(50)
  })
})

describe('PATCH /api/sessions/:id mode — live switch (set_permission_mode, no pendingMode)', () => {
  // Mode joined the live-settings family: PATCH persists record.mode and fires a
  // set_permission_mode control_request at any live CLI. The old respawn trigger
  // (pendingMode) must never be set — a later send must NOT force --resume.
  // (The live control-loop delivery itself is proven by the real-binary probe +
  // the gated session-mode-live suite; the mock CLI exits per turn, so here we
  // assert route semantics: persistence + no pendingMode debris.)
  it('persists record.mode without setting pendingMode; cold resume carries the new mode', async () => {
    const ws = await connectWs()

    const firstResultPromise = waitForWsEvent(ws, 'session:result')
    await sendWsRpc(ws, 'session:start', {
      taskId: 'model-switch-task-008',
      message: 'initial turn before mode PATCH',
      project: 'Walnut',
      mode: 'bypass',
    })
    const sessionId = ((await firstResultPromise).data as { sessionId: string }).sessionId
    expect(sessionId).toBeTruthy()
    await delay(500)

    const resp = await fetch(`http://localhost:${port}/api/sessions/${sessionId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'accept' }),
    })
    expect(resp.status).toBe(200)
    await delay(300)

    // record.mode persisted (durable cold-resume fallback); pendingMode NOT set.
    const recResp = await fetch(`http://localhost:${port}/api/sessions/${sessionId}`)
    const recBody = await recResp.json() as { session?: { mode?: string; pendingMode?: string } }
    expect(recBody.session?.mode).toBe('accept')
    expect(recBody.session?.pendingMode).toBeUndefined()

    // Cold resume (mock CLI exits per turn) falls back to record.mode —
    // the respawn carries --permission-mode acceptEdits without any pendingMode.
    const secondResultPromise = waitForWsEvent(
      ws,
      'session:result',
      (evt) => (evt.data as { sessionId?: string })?.sessionId === sessionId
        && ((evt.data as { result?: string })?.result ?? '').includes('turn after mode patch'),
    )
    await sendWsRpc(ws, 'session:send', { sessionId, message: 'turn after mode patch' })
    const secondText = ((await secondResultPromise).data as { result?: string }).result ?? ''
    expect(secondText).toContain('[permission-mode:acceptEdits]')

    ws.close()
    await delay(50)
  })
})
