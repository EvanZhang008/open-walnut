/**
 * Walnut's default model and effort (Settings > Sessions: `launch_defaults.model`, `launch_defaults.effort`)
 * reach every Claude Code spawn that has none of its own (src/core/sessions/claude-launch-defaults.ts).
 *
 * Contract, each case on the real CLI command line (the mock CLI echoes `[model:…]` / `[effort:…]`):
 *   - unset (the default): no --model, no --effort, so Claude Code decides, as before
 *   - set: every launch path with no pick spawns with them: the web draft (quick-start), the phone
 *     (POST /api/v1/sessions) and an agent's task_start (POST /api/v1/tasks/:id/start)
 *   - a pick at create wins; a project's default_effort wins over Walnut's
 *   - a restart (task_restart's route) of a session that had no effort takes the default
 *   - an effort switched in the session survives a restart, over the default
 *   - Walnut's own lanes (a spawn with a lane: ai.run, Ask Walnut, subagent_run) take neither
 *
 * What's real: Express server, WebSocket, event bus, session tracker, task manager, project
 * registry, the daemon protocol (mock daemon). Mocked: constants (temp dir) and the CLI.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Server as HttpServer } from 'node:http'
import { WebSocket } from 'ws'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-launch-defaults'))

import { WALNUT_HOME } from '../../src/constants.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'
import { getSessionByClaudeId } from '../../src/core/session-tracker.js'
import { waitForWsEvent } from '../helpers/ws-event-wait.js'

const MOCK_CLI = path.resolve(import.meta.dirname, '../providers/mock-claude.mjs')

let server: HttpServer
let port: number
let daemon: MockDaemon
let ws: WebSocket
let workDir: string

async function call(method: string, p: string, body?: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`http://localhost:${port}${p}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  return { status: res.status, json: await res.json().catch(() => ({})) as Record<string, unknown> }
}

/** The turn result whose text holds `words` (the mock CLI echoes the prompt), armed before `act`. */
async function turnOf(words: string, act: () => Promise<string>): Promise<{ sessionId: string; text: string }> {
  const result = waitForWsEvent(ws, 'session:result', (d) => String(d.result ?? '').includes(words), 30_000)
  const sessionId = await act()
  const frame = await result
  expect(frame.data?.sessionId).toBe(sessionId)
  return { sessionId, text: String((frame.data as { result?: string }).result ?? '') }
}

function quickStart(body: Record<string, unknown>): Promise<{ sessionId: string; text: string }> {
  return turnOf(String(body.message), async () => {
    const sessionId = randomUUID()
    const res = await call('POST', '/api/sessions/quick-start', { cwd: workDir, engine: 'claude', ...body, sessionId })
    expect(res.status, JSON.stringify(res.json)).toBeLessThan(300)
    return sessionId
  })
}

/** A write as the Settings page makes it: only the keys it names, null removes one. */
async function setDefaults(patch: Record<string, unknown>): Promise<void> {
  const res = await call('PUT', '/api/config', { launch_defaults: patch })
  expect(res.status, JSON.stringify(res.json)).toBeLessThan(300)
}

/** A spawn of one of Walnut's own lanes (ai.run's shape: no task, a lane), as its starter emits it. */
async function laneStart(message: string): Promise<{ sessionId: string; text: string }> {
  return turnOf(message, async () => {
    const { bus, EventNames } = await import('../../src/core/event-bus.js')
    const sessionId = randomUUID()
    bus.emit(EventNames.SESSION_START, {
      taskId: '', message, cwd: workDir, title: 'lane test', lane: `chat:launch-defaults:${sessionId}`,
      mode: 'dontAsk', preassignedSessionId: sessionId,
    } as never, ['session-runner'], { source: 'ai-run' })
    return sessionId
  })
}

const effortOf = (text: string) => /\[effort:([a-z]+)\]/.exec(text)?.[1]
const modelOf = (text: string) => /\[model:([^\]\s]+)\]/.exec(text)?.[1]

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

let unsetSession = ''
let switchedSession = ''

describe('Walnut defaults unset (how every install starts)', () => {
  it('a launch with no pick sends no --model and no --effort: Claude Code decides', async () => {
    const { sessionId, text } = await quickStart({ message: 'unset defaults one' })
    expect(effortOf(text)).toBeUndefined()
    expect(modelOf(text)).toBeUndefined()
    expect((await getSessionByClaudeId(sessionId))?.effort).toBeUndefined()
    unsetSession = sessionId
    switchedSession = (await quickStart({ message: 'unset defaults two' })).sessionId
  })

  it('the settings refuse a value that is no effort or no model', async () => {
    expect((await call('PUT', '/api/config', { launch_defaults: { effort: 'turbo' } })).status).toBe(400)
    expect((await call('PUT', '/api/config', { launch_defaults: { model: '  ' } })).status).toBe(400)
    expect((await call('PUT', '/api/config', { launch_defaults: { model: 'gpt-6' } })).status).toBe(400)
    expect((await call('PUT', '/api/config', { launch_defaults: { engine: 'codex' } })).status).toBe(400)
  })
})

describe('Walnut defaults set: effort high, model sonnet', () => {
  beforeAll(async () => { await setDefaults({ effort: 'high', model: 'sonnet' }) })

  it('the web draft with no pick spawns at them', async () => {
    const { sessionId, text } = await quickStart({ message: 'draft takes defaults' })
    expect(effortOf(text)).toBe('high')
    expect(modelOf(text)).toMatch(/^sonnet/)
    expect((await getSessionByClaudeId(sessionId))?.effort).toBe('high')
  })

  it('the phone with no pick spawns at them', async () => {
    const { text } = await turnOf('phone takes defaults', async () => {
      const res = await call('POST', '/api/v1/sessions', { cwd: workDir, engine: 'claude', message: 'phone takes defaults' })
      expect(res.status, JSON.stringify(res.json)).toBeLessThan(300)
      return String(res.json.sessionId)
    })
    expect(effortOf(text)).toBe('high')
    expect(modelOf(text)).toMatch(/^sonnet/)
  })

  it('an agent\'s task_start with no effort spawns at the default', async () => {
    const created = await call('POST', '/api/tasks', { title: 'agent start with defaults' })
    expect(created.status, JSON.stringify(created.json)).toBeLessThan(300)
    const taskId = String((created.json.task as { id?: string } | undefined)?.id ?? created.json.id)
    const { text } = await turnOf('agent start takes defaults', async () => {
      const res = await call('POST', `/api/v1/tasks/${taskId}/start`, { message: 'agent start takes defaults', cwd: workDir })
      expect(res.status, JSON.stringify(res.json)).toBeLessThan(300)
      return String(res.json.sessionId)
    })
    expect(effortOf(text)).toBe('high')
  })

  it('Walnut\'s own lanes (ai.run, Ask Walnut, subagent_run, side threads) take neither default', async () => {
    const { text } = await laneStart('lane takes no defaults')
    expect(effortOf(text)).toBeUndefined()
    expect(modelOf(text)).toBeUndefined()
  })

  it('a pick at create wins over the defaults', async () => {
    const { text } = await quickStart({ message: 'own pick wins', model: 'opus', effort: 'low' })
    expect(effortOf(text)).toBe('low')
    expect(modelOf(text)).toMatch(/^opus/)
  })

  it('a project\'s default effort wins over Walnut\'s', async () => {
    const meta = await call('PUT', '/api/projects/Alpha/metadata', { default_effort: 'medium' })
    expect(meta.status, JSON.stringify(meta.json)).toBeLessThan(300)
    const { text } = await quickStart({ message: 'project effort wins', project: 'Alpha' })
    expect(effortOf(text)).toBe('medium')
    expect((await call('PUT', '/api/projects/Alpha/metadata', { default_effort: 'turbo' })).status).toBe(400)
  })

  it('a restart of a session that had no effort takes the default; its model stays the conversation\'s', async () => {
    expect((await call('POST', `/api/v1/sessions/${unsetSession}/restart`, {})).status).toBeLessThan(300)
    const { text } = await turnOf('after restart one', async () => {
      const res = await call('POST', `/api/v1/sessions/${unsetSession}/messages`, { text: 'after restart one' })
      expect(res.status, JSON.stringify(res.json)).toBeLessThan(300)
      return unsetSession
    })
    expect(effortOf(text)).toBe('high')
    expect(modelOf(text) ?? '').not.toMatch(/^sonnet/)
  })

  it('an effort switched in the session survives a restart over the default', async () => {
    // Medium: a level the mock CLI's model takes, and not the default.
    const sw = await call('POST', `/api/sessions/${switchedSession}/effort`, { effort: 'medium' })
    expect(sw.status, JSON.stringify(sw.json)).toBeLessThan(300)
    expect((await getSessionByClaudeId(switchedSession))?.effort).toBe('medium')
    expect((await call('POST', `/api/v1/sessions/${switchedSession}/restart`, {})).status).toBeLessThan(300)
    const { text } = await turnOf('after restart two', async () => {
      const res = await call('POST', `/api/v1/sessions/${switchedSession}/messages`, { text: 'after restart two' })
      expect(res.status, JSON.stringify(res.json)).toBeLessThan(300)
      return switchedSession
    })
    expect(effortOf(text)).toBe('medium')
  })

  it('clearing the settings brings back Claude Code\'s own choice', async () => {
    await setDefaults({ effort: null, model: null })
    const { text } = await quickStart({ message: 'cleared again' })
    expect(effortOf(text)).toBeUndefined()
    expect(modelOf(text)).toBeUndefined()
  })
})
