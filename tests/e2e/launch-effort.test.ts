/**
 * The reasoning effort picked when a task is created reaches the CLI as `--effort`.
 *
 * Every launch surface a person creates a task from: the web draft column
 * (POST /api/sessions/quick-start), the phone (POST /api/v1/sessions) and an Ask
 * Walnut draft. The agent ops (task_create / task_start) go through
 * /api/v1/tasks/:id/start and are pinned in tests/web/routes/task-v1-start-expect-reply.test.ts.
 *
 * Contract:
 *   - each level is spawned as `--effort <level>` and stored on the session record
 *   - no pick sends no flag at all, so Claude Code's own settings decide
 *   - an unknown level is refused before anything is written
 *
 * What's real: Express server, WebSocket, event bus, session tracker, task manager,
 * the daemon protocol (mock daemon). What's mocked: constants (temp dir) and the CLI
 * (mock-claude.mjs, which echoes `[effort:<value>]` for the --effort it received).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Server as HttpServer } from 'node:http'
import { WebSocket } from 'ws'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-launch-effort'))

import { WALNUT_HOME } from '../../src/constants.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'
import { getSessionByClaudeId } from '../../src/core/session-tracker.js'
import { listTasks } from '../../src/core/task-manager.js'
import { SESSION_EFFORT_IDS } from '../../src/core/types.js'
import { waitForWsEvent } from '../helpers/ws-event-wait.js'

const MOCK_CLI = path.resolve(import.meta.dirname, '../providers/mock-claude.mjs')

let server: HttpServer
let port: number
let daemon: MockDaemon
let ws: WebSocket
let workDir: string

async function post(p: string, body: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`http://localhost:${port}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: await res.json().catch(() => ({})) as Record<string, unknown> }
}

/**
 * Launch and wait for its first turn's result. The wait is armed before the request and
 * matched on the launch's own words (the mock CLI echoes the prompt), so a turn that ends
 * before the HTTP answer is still caught. The quick-start route also takes a client id.
 */
async function launch(route: string, body: Record<string, unknown>): Promise<{ sessionId: string; text: string }> {
  const words = String(body.message)
  const result = waitForWsEvent(ws, 'session:result', (d) => String(d.result ?? '').includes(words))
  const minted = route === '/api/sessions/quick-start' ? randomUUID() : undefined
  const res = await post(route, { ...body, ...(minted ? { sessionId: minted } : {}) })
  expect(res.status, JSON.stringify(res.json)).toBeLessThan(300)
  const frame = await result
  const sessionId = minted ?? String(res.json.sessionId)
  expect(frame.data?.sessionId).toBe(sessionId)
  return { sessionId, text: String((frame.data as { result?: string }).result ?? '') }
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  workDir = path.join(WALNUT_HOME, 'work')
  await fs.mkdir(workDir, { recursive: true })
  daemon = await createMockDaemon()
  sessionRunner.setCliCommand(MOCK_CLI)
  sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemon.port}`)
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
  ws = await new Promise<WebSocket>((resolve, reject) => {
    const s = new WebSocket(`ws://localhost:${port}/ws`)
    s.on('open', () => resolve(s))
    s.on('error', reject)
  })
})

afterAll(async () => {
  ws?.close()
  sessionRunner.setTestDaemonUrl(undefined)
  await stopServer()
  await daemon.stop()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('effort picked at task creation: web draft (POST /api/sessions/quick-start)', () => {
  it.each(SESSION_EFFORT_IDS)('effort %s spawns with --effort %s and is stored on the record', async (effort) => {
    const { sessionId, text } = await launch('/api/sessions/quick-start', {
      cwd: workDir, message: `effort ${effort} please`, model: 'opus', engine: 'claude', effort,
    })
    expect(text).toContain(`[effort:${effort}]`)
    expect((await getSessionByClaudeId(sessionId))?.effort).toBe(effort)
  })

  it('no pick sends no --effort: Claude Code decides', async () => {
    const { sessionId, text } = await launch('/api/sessions/quick-start', {
      cwd: workDir, message: 'no effort named', model: 'opus', engine: 'claude',
    })
    expect(text).not.toContain('[effort:')
    expect((await getSessionByClaudeId(sessionId))?.effort).toBeUndefined()
  })

  it('an unknown level is refused before any task is written', async () => {
    const before = (await listTasks()).length
    const res = await post('/api/sessions/quick-start', { cwd: workDir, message: 'bad effort', effort: 'turbo' })
    expect(res.status).toBe(400)
    expect(String(res.json.error)).toMatch(/effort must be one of/)
    expect((await listTasks()).length).toBe(before)
  })

  it('an Ask Walnut draft takes the picked level over its chat default', async () => {
    const { sessionId, text } = await launch('/api/sessions/quick-start', {
      walnutAgent: true, message: 'quick question', model: 'opus', effort: 'low',
    })
    expect(text).toContain('[effort:low]')
    expect((await getSessionByClaudeId(sessionId))?.effort).toBe('low')
  })
})

describe('effort picked at task creation: the phone (POST /api/v1/sessions)', () => {
  it('a picked level spawns with --effort', async () => {
    const { sessionId, text } = await launch('/api/v1/sessions', {
      cwd: workDir, message: 'from the phone', model: 'opus', engine: 'claude', effort: 'max',
    })
    expect(text).toContain('[effort:max]')
    expect((await getSessionByClaudeId(sessionId))?.effort).toBe('max')
  })

  it('no pick sends no --effort', async () => {
    const { text } = await launch('/api/v1/sessions', { cwd: workDir, message: 'phone, no effort', model: 'opus', engine: 'claude' })
    expect(text).not.toContain('[effort:')
  })

  it('an unknown level is a 400', async () => {
    const res = await post('/api/v1/sessions', { cwd: workDir, message: 'bad', effort: 'turbo' })
    expect(res.status).toBe(400)
  })
})
