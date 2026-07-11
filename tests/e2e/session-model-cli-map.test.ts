/**
 * E2E test for MODEL_CLI_MAP alias resolution.
 *
 * Verifies that the picker model IDs (opus, opus-1m, sonnet, sonnet-1m, haiku,
 * fable, fable-1m) are correctly mapped to CLI --model arguments:
 *
 *   'opus'      → --model opus           (passthrough)
 *   'opus-1m'   → --model opus[1m]       (mapped)
 *   'sonnet'    → --model sonnet         (passthrough)
 *   'sonnet-1m' → --model sonnet[1m]     (mapped)
 *   'haiku'     → --model haiku          (passthrough)
 *   'fable'     → --model fable          (passthrough)
 *   'fable-1m'  → --model fable[1m]      (mapped)
 *   (no model)  → (no --model flag)      ("Auto" — Claude Code picks its own default)
 *
 * CRITICAL: If MODEL_CLI_MAP is reverted to use full Bedrock model IDs
 * (e.g., 'global.anthropic.claude-opus-4-6-v1[1m]'), the alias-based
 * assertions here will fail — ensuring regressions are caught.
 *
 * What's real: Express server, WebSocket, event bus, session-tracker, task-manager.
 * What's mocked: constants.js (temp dir), Claude CLI (mock-claude.mjs).
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

  // Route the server's local sessions through a MockDaemon that spawns the mock
  // CLI. Since the local+remote daemon unification, all local sessions go through
  // a daemon — a bare setCliCommand no longer reaches the spawn, so the --model
  // arg must be observed via the daemon-spawned mock CLI. (Same wiring as
  // observability-truncated-success.test.ts.)
  daemon = await createMockDaemon()
  sessionRunner.setCliCommand(MOCK_CLI)
  sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemon.port}`)

  // Seed test tasks — one per test scenario (8 tasks for safety margin)
  const tasksDir = path.join(WALNUT_HOME, 'tasks')
  await fs.mkdir(tasksDir, { recursive: true })
  await fs.writeFile(
    path.join(tasksDir, 'tasks.json'),
    JSON.stringify({
      version: 1,
      tasks: ['001', '002', '003', '004', '005', '006', '007', '008', '009', '010', '011'].map(n => ({
        id: `cli-map-task-${n}`,
        title: `CLI map test task ${n}`,
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

describe('MODEL_CLI_MAP alias resolution: E2E', () => {
  // Test 1: All 7 picker IDs produce correct --model args
  const pickerModels: Array<{ pickerId: string; expectedCliArg: string }> = [
    { pickerId: 'opus',      expectedCliArg: 'opus' },
    { pickerId: 'opus-1m',   expectedCliArg: 'opus[1m]' },
    { pickerId: 'sonnet',    expectedCliArg: 'sonnet' },
    { pickerId: 'sonnet-1m', expectedCliArg: 'sonnet[1m]' },
    { pickerId: 'haiku',     expectedCliArg: 'haiku' },
    { pickerId: 'fable',     expectedCliArg: 'fable' },
    { pickerId: 'fable-1m',  expectedCliArg: 'fable[1m]' },
  ]

  pickerModels.forEach(({ pickerId, expectedCliArg }, idx) => {
    it(`picker model "${pickerId}" → --model ${expectedCliArg}`, async () => {
      const ws = await connectWs()

      const resultPromise = waitForWsEvent(ws, 'session:result')
      const rpcRes = await sendWsRpc(ws, 'session:start', {
        taskId: `cli-map-task-${String(idx + 1).padStart(3, '0')}`,
        message: `test ${pickerId} model mapping`,
        project: 'Walnut',
        mode: 'bypass',
        model: pickerId,
      })
      expect((rpcRes as Record<string, unknown>).ok).toBe(true)

      const result = await resultPromise
      const text = (result.data as { result?: string }).result ?? ''

      // The mock CLI echoes [model:<value>] for whatever --model arg it received
      expect(text).toContain(`[model:${expectedCliArg}]`)

      ws.close()
      await delay(50)
    })
  })

  // Test 2: "Auto" (no model) → NO --model flag forwarded to the CLI.
  // Walnut has no config-time default; Claude Code resolves its own settings-layer
  // default. The mock CLI only echoes "[model:...]" when it actually received a
  // --model arg, so the absence of that token proves no flag was passed.
  it('"Auto" (no model specified) → no --model flag', async () => {
    const ws = await connectWs()

    const resultPromise = waitForWsEvent(ws, 'session:result')
    const rpcRes = await sendWsRpc(ws, 'session:start', {
      taskId: 'cli-map-task-008',
      message: 'test auto model mapping',
      project: 'Walnut',
      mode: 'bypass',
      // No model field — "Auto": Walnut must NOT pass --model.
    })
    expect((rpcRes as Record<string, unknown>).ok).toBe(true)

    const result = await resultPromise
    const text = (result.data as { result?: string }).result ?? ''

    expect(text).not.toContain('[model:')

    ws.close()
    await delay(50)
  })

  // Test 3: 1M model switch mid-session (opus-1m)
  it('mid-session model switch to opus-1m → --model opus[1m]', async () => {
    const ws = await connectWs()

    // Start session with default model
    const firstResultPromise = waitForWsEvent(ws, 'session:result')
    const rpcRes = await sendWsRpc(ws, 'session:start', {
      taskId: 'cli-map-task-009',
      message: 'initial turn before opus-1m switch',
      project: 'Walnut',
      mode: 'bypass',
    })
    expect((rpcRes as Record<string, unknown>).ok).toBe(true)

    const firstResult = await firstResultPromise
    const sessionId = (firstResult.data as { sessionId: string }).sessionId
    expect(sessionId).toBeTruthy()

    // Wait for result handler processNext to drain
    await delay(500)

    // Send follow-up with model switch to opus-1m.
    // Match on BOTH sessionId AND the new message text: a mid-session --resume
    // respawn re-opens the same JSONL in append mode, so the daemon may replay
    // the first turn's result on re-attach. Matching only by sessionId would
    // resolve on that stale replay; requiring the new message text skips it and
    // waits for the actual second-turn result.
    const secondResultPromise = waitForWsEvent(
      ws,
      'session:result',
      (evt) => (evt.data as { sessionId?: string })?.sessionId === sessionId
        && ((evt.data as { result?: string })?.result ?? '').includes('follow-up with opus-1m model'),
    )
    await sendWsRpc(ws, 'session:send', {
      sessionId,
      message: 'follow-up with opus-1m model',
      model: 'opus-1m',
    })

    const secondResult = await secondResultPromise
    const secondText = (secondResult.data as { result?: string }).result ?? ''

    // Must see the CLI alias, not a full Bedrock model ID
    expect(secondText).toContain('[model:opus[1m]]')
    expect(secondText).toContain('follow-up with opus-1m model')

    ws.close()
    await delay(50)
  })

  // Test 4: sonnet-1m model switch mid-session
  it('mid-session model switch to sonnet-1m → --model sonnet[1m]', async () => {
    const ws = await connectWs()

    // Start session with default model
    const firstResultPromise = waitForWsEvent(ws, 'session:result')
    const rpcRes = await sendWsRpc(ws, 'session:start', {
      taskId: 'cli-map-task-010',
      message: 'initial turn before sonnet-1m switch',
      project: 'Walnut',
      mode: 'bypass',
    })
    expect((rpcRes as Record<string, unknown>).ok).toBe(true)

    const firstResult = await firstResultPromise
    const sessionId = (firstResult.data as { sessionId: string }).sessionId
    expect(sessionId).toBeTruthy()

    // Wait for result handler processNext to drain
    await delay(500)

    // Send follow-up with model switch to sonnet-1m.
    // Match on BOTH sessionId AND the new message text — see the opus-1m test
    // above for why a sessionId-only predicate races against the resume replay.
    const secondResultPromise = waitForWsEvent(
      ws,
      'session:result',
      (evt) => (evt.data as { sessionId?: string })?.sessionId === sessionId
        && ((evt.data as { result?: string })?.result ?? '').includes('follow-up with sonnet-1m model'),
    )
    await sendWsRpc(ws, 'session:send', {
      sessionId,
      message: 'follow-up with sonnet-1m model',
      model: 'sonnet-1m',
    })

    const secondResult = await secondResultPromise
    const secondText = (secondResult.data as { result?: string }).result ?? ''

    // Must see the CLI alias, not a full Bedrock model ID
    expect(secondText).toContain('[model:sonnet[1m]]')
    expect(secondText).toContain('follow-up with sonnet-1m model')

    ws.close()
    await delay(50)
  })

  // Test 5: fable-1m model switch mid-session — exercises the pending-model →
  // resume path for the new fable alias (new family added to the registry).
  it('mid-session model switch to fable-1m → --model fable[1m]', async () => {
    const ws = await connectWs()

    // Start session with default model
    const firstResultPromise = waitForWsEvent(ws, 'session:result')
    const rpcRes = await sendWsRpc(ws, 'session:start', {
      taskId: 'cli-map-task-011',
      message: 'initial turn before fable-1m switch',
      project: 'Walnut',
      mode: 'bypass',
    })
    expect((rpcRes as Record<string, unknown>).ok).toBe(true)

    const firstResult = await firstResultPromise
    const sessionId = (firstResult.data as { sessionId: string }).sessionId
    expect(sessionId).toBeTruthy()

    // Wait for result handler processNext to drain
    await delay(500)

    // Send follow-up with model switch to fable-1m.
    // Match on BOTH sessionId AND the new message text — see the opus-1m test
    // above for why a sessionId-only predicate races against the resume replay.
    const secondResultPromise = waitForWsEvent(
      ws,
      'session:result',
      (evt) => (evt.data as { sessionId?: string })?.sessionId === sessionId
        && ((evt.data as { result?: string })?.result ?? '').includes('follow-up with fable-1m model'),
    )
    await sendWsRpc(ws, 'session:send', {
      sessionId,
      message: 'follow-up with fable-1m model',
      model: 'fable-1m',
    })

    const secondResult = await secondResultPromise
    const secondText = (secondResult.data as { result?: string }).result ?? ''

    // Must see the CLI alias, not a full Bedrock model ID
    expect(secondText).toContain('[model:fable[1m]]')
    expect(secondText).toContain('follow-up with fable-1m model')

    ws.close()
    await delay(50)
  })
})
