/**
 * E2E: a new task starts on the fallback engine while the default engine is out of usage
 * (src/core/agents/fallback-engine.ts).
 *
 * Full server pipeline with only the Claude CLI faked, both readings of "limited" as in use:
 * mock-claude "limit-error:<reset>" is a real usage-limit stop, so the usage-limit wait records it
 * on the session; "rate-limit-event:<json>" is the subscription limit line a signed-in CLI writes,
 * so the host's Claude reading says the 5-hour window is rejected (or allowed).
 * The fallback here is Claude Code on a model of another provider ('gpt-6.1-sol', behind the CLI):
 * the e2e has no Codex adapter, and the engine choice for another engine is the unit test's
 * (tests/core/agents/fallback-engine.test.ts). Another Claude model ('sonnet') shares the 5-hour
 * limit, so it does not take new tasks.
 *
 *   1. no setting: a new task starts on the default as before, even while it is limited
 *   2. setting on, nothing limited: the default
 *   2b. a session the limit stopped, the host's reading allowed: the session's record alone moves
 *      new tasks to the fallback, with its reset
 *   3. limited: quick-start (the web's new task) and a task start (task_create, task_start) both
 *      start on the fallback model and note it on the task; a start that names a model does not;
 *      GET /api/engines/fallback says so; the note's dismiss takes it off
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
import { readSubscriptionLimits } from '../../src/core/sessions/subscription-limits.js'
import { __setUsageLimitWaitForTesting } from '../../src/core/sessions/usage-limit-wait.js'
import { getSessionByClaudeId, getSessionsForTask } from '../../src/core/session-tracker.js'
import { getTask } from '../../src/core/task-manager.js'
import { getConfig, updateConfig } from '../../src/core/config-manager.js'
import { SESSION_MODEL_CLI_MAP } from '../../src/core/types.js'
import { getFrequentDirs } from '../../src/core/frequent-dirs.js'

const MOCK_CLI = path.resolve(import.meta.dirname, '../providers/mock-claude.mjs')

let server: HttpServer
let port: number
let daemon: MockDaemon

interface WsEvent { type: string; name?: string; data?: Record<string, unknown>; id?: string }

function delay(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)) }

function connectWs(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`)
    ws.on('open', () => resolve(ws))
    ws.on('error', reject)
  })
}

function waitForResultFor(ws: WebSocket, taskId: string, timeoutMs = 20_000): Promise<WsEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for session:result of ${taskId}`)), timeoutMs)
    const handler = (raw: WebSocket.RawData) => {
      const frame = JSON.parse(raw.toString()) as WsEvent
      if (frame.type === 'event' && frame.name === 'session:result' && frame.data?.taskId === taskId) {
        clearTimeout(timer); ws.off('message', handler); resolve(frame)
      }
    }
    ws.on('message', handler)
  })
}

function sendWsRpc(ws: WebSocket, method: string, payload: unknown): Promise<WsEvent> {
  return new Promise((resolve, reject) => {
    const id = `rpc-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const timer = setTimeout(() => reject(new Error(`RPC ${method} timed out`)), 15_000)
    const handler = (raw: WebSocket.RawData) => {
      const frame = JSON.parse(raw.toString()) as WsEvent
      if (frame.type === 'res' && frame.id === id) { clearTimeout(timer); ws.off('message', handler); resolve(frame) }
    }
    ws.on('message', handler)
    ws.send(JSON.stringify({ type: 'req', id, method, payload }))
  })
}

async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 10_000): Promise<T> {
  const end = Date.now() + timeoutMs
  let v = await read()
  while (!ok(v) && Date.now() < end) { await delay(150); v = await read() }
  return v
}

async function req(method: string, url: string, body?: unknown): Promise<{ status: number; json: Record<string, any> }> {
  const res = await fetch(`http://localhost:${port}${url}`, {
    method, headers: { 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  return { status: res.status, json: await res.json().catch(() => ({})) as Record<string, any> }
}

function seedTask(id: string, title: string) {
  return {
    id, title, status: 'todo', priority: 'none', category: 'Test', project: 'FallbackTest', cwd: '/tmp',
    session_ids: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    description: '', summary: '', note: '', subtasks: [], phase: 'TODO', source: 'ms-todo',
  }
}


async function setFallback(fb: { engine: string; model?: string; model_label?: string } | null): Promise<void> {
  const cfg = await getConfig()
  const rest = { ...cfg.defaults } as Record<string, unknown>
  delete rest.fallback_engine
  await updateConfig({ defaults: { ...rest, ...(fb ? { fallback_engine: fb } : {}) } as never })
}

/** The model the session of a quick-started task was spawned with. */
async function cliModelOf(sid: string, expectOne = true): Promise<string | undefined> {
  const rec = await until(() => getSessionByClaudeId(sid), (r) => !!r?.cliModel, expectOne ? 15_000 : 3_000)
  return rec?.cliModel ?? undefined
}

const SONNET_CLI = SESSION_MODEL_CLI_MAP.sonnet ?? 'sonnet'
/** A model of another provider behind Claude Code: the Claude subscription's limits do not cover it. */
const OTHER = 'gpt-6.1-sol'

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  // The session the limit stopped must not be continued during the test.
  __setUsageLimitWaitForTesting({ timing: { graceMs: 0, jitterMaxMs: 0, backoffMs: [3_600_000], resumeCheckMs: 3_600_000 } })
  daemon = await createMockDaemon()
  sessionRunner.setCliCommand(MOCK_CLI)
  sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemon.port}`)
  const tasksDir = path.join(WALNUT_HOME, 'tasks')
  await fs.mkdir(tasksDir, { recursive: true })
  await fs.writeFile(path.join(tasksDir, 'tasks.json'), JSON.stringify({
    version: 1,
    tasks: [seedTask('fb-session', 'Stopped by the limit'), seedTask('fb-allowed', 'Reads allowed'), seedTask('fb-limited', 'Hits the limit'), seedTask('fb-start', 'Started by an agent'), seedTask('fb-named', 'Names its model')],
  }))
  server = await startServer({ port: 0, dev: true })
  port = (server.address() as { port: number }).port
  await delay(1500)
}, 30_000)

afterAll(async () => {
  sessionRunner.setTestDaemonUrl(undefined)
  await stopServer()
  await daemon.stop()
  __setUsageLimitWaitForTesting({ timing: null })
  await delay(500)
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
}, 15_000)

describe('fallback engine E2E', () => {
  it('a config write refuses an unknown fallback engine and a malformed model', async () => {
    const cfg = await getConfig()
    const bad = await req('PUT', '/api/config', { ...cfg, defaults: { ...cfg.defaults, fallback_engine: { engine: 'nope' } } })
    expect(bad.status).toBe(400)
    const badModel = await req('PUT', '/api/config', { ...cfg, defaults: { ...cfg.defaults, fallback_engine: { engine: 'codex', model: 'a b' } } })
    expect(badModel.status).toBe(400)
    const badLabel = await req('PUT', '/api/config', { ...cfg, defaults: { ...cfg.defaults, fallback_engine: { engine: 'codex', model: 'gpt-5.5', model_label: 'x'.repeat(81) } } })
    expect(badLabel.status).toBe(400)
    // A model id the starts would refuse (task_start's charset) is refused here too.
    const badAt = await req('PUT', '/api/config', { ...cfg, defaults: { ...cfg.defaults, fallback_engine: { engine: 'codex', model: 'claude-sonnet-4@2025' } } })
    expect(badAt.status).toBe(400)
  })

  it('no limit: a new task starts on the default engine even with a fallback set', async () => {
    await setFallback({ engine: 'claude', model: OTHER })
    const started = await req('POST', '/api/sessions/quick-start', { cwd: '/tmp', message: 'hello' })
    expect(started.status, JSON.stringify(started.json)).toBe(200)
    expect((await getTask(started.json.taskId)).engine_fallback ?? undefined).toBeUndefined()
    expect(await cliModelOf(started.json.sessionId, false)).not.toBe(OTHER)
    expect((await req('GET', '/api/engines/fallback')).json.fallback).toBeNull()
  })

  it("a session the usage limit stopped: its own record holds the engine, with the host's reading allowed", async () => {
    const ws = await connectWs()
    try {
      // A real usage-limit stop (resets in 30 minutes): the wait records it on the session.
      const stopped = waitForResultFor(ws, 'fb-session')
      await sendWsRpc(ws, 'session:start', { taskId: 'fb-session', message: `limit-error:${Math.ceil((Date.now() + 30 * 60_000) / 1000)}` })
      const sid = (await stopped).data!.sessionId as string
      const rec = await until(() => getSessionByClaudeId(sid), (r) => r?.usageLimit?.state === 'waiting')
      // The host's own reading says allowed again: only the session's record says limited now.
      const allowed = waitForResultFor(ws, 'fb-allowed')
      await sendWsRpc(ws, 'session:start', { taskId: 'fb-allowed', message: 'rate-limit-event:{"status":"allowed","rateLimitType":"five_hour","resetsIn":1800}' })
      await allowed
      await until(async () => (await readSubscriptionLimits('__local__'))[0], (f) => f?.current?.status === 'allowed')

      await setFallback({ engine: 'claude', model: OTHER })
      const now = (await req('GET', '/api/engines/fallback')).json
      expect(now.fallback).toMatchObject({ engine: 'claude', model: OTHER, note: { from: 'claude', window: 'five_hour', resets_from: 'event' } })
      expect(Date.parse(now.fallback.note.resets_at)).toBe(Date.parse(rec!.usageLimit!.resetsAt!))
      const quick = await req('POST', '/api/sessions/quick-start', { cwd: '/tmp', message: 'hello' })
      expect((await getTask(quick.json.taskId)).engine_fallback).toMatchObject({ model: OTHER, resets_from: 'event' })
      expect(await cliModelOf(quick.json.sessionId)).toBe(OTHER)
      await setFallback(null)
    } finally {
      ws.close()
    }
  }, 60_000)

  it('limited: new tasks start on the fallback model and say so; a named model stays; dismiss clears', async () => {
    const ws = await connectWs()
    try {
      // The CLI's own limit line: this host's 5-hour window is rejected, resetting in an hour.
      const r1p = waitForResultFor(ws, 'fb-limited')
      await sendWsRpc(ws, 'session:start', { taskId: 'fb-limited', message: 'rate-limit-event:{"status":"rejected","rateLimitType":"five_hour","resetsIn":3600}' })
      await r1p
      const frame = await until(async () => (await readSubscriptionLimits('__local__'))[0], (f) => f?.current?.status === 'rejected')
      const resetsAt = frame!.current!.resetsAt!
      expect(resetsAt).toBeGreaterThan(Date.now())

      // Off: still the default, still noted nowhere.
      await setFallback(null)
      const off = await req('POST', '/api/sessions/quick-start', { cwd: '/tmp', message: 'hello' })
      expect((await getTask(off.json.taskId)).engine_fallback ?? undefined).toBeUndefined()
      // Nothing set: no reads unless Settings asks for the limit itself.
      const offNow = (await req('GET', '/api/engines/fallback')).json
      expect(offNow).toMatchObject({ fallback: null, setting: null })
      expect(offNow.limit).toBeUndefined()
      const offLimit = (await req('GET', '/api/engines/fallback?limit=1')).json
      expect(offLimit.fallback).toBeNull()
      expect(offLimit.limit).toMatchObject({ window: 'five_hour' })

      // Another Claude model: the 5-hour limit covers it too, so new tasks wait, and Settings says why.
      await setFallback({ engine: 'claude', model: 'sonnet' })
      const shares = (await req('GET', '/api/engines/fallback')).json
      expect(shares).toMatchObject({ fallback: null, skip: 'shares_limit', limit: { window: 'five_hour' } })
      const sharesQuick = await req('POST', '/api/sessions/quick-start', { cwd: '/tmp', message: 'hello' })
      expect((await getTask(sharesQuick.json.taskId)).engine_fallback ?? undefined).toBeUndefined()
      expect(await cliModelOf(sharesQuick.json.sessionId, false)).not.toBe(SONNET_CLI)

      // On, a model of another provider: the web's new task.
      await setFallback({ engine: 'claude', model: OTHER, model_label: 'Sol' })
      const now = (await req('GET', '/api/engines/fallback')).json
      expect(now.fallback).toMatchObject({ engine: 'claude', model: OTHER, note: { from: 'claude', to: 'claude', model_label: 'Sol', window: 'five_hour' } })
      const quick = await req('POST', '/api/sessions/quick-start', { cwd: '/tmp', message: 'hello' })
      expect(quick.status, JSON.stringify(quick.json)).toBe(200)
      const qTask = await getTask(quick.json.taskId)
      expect(qTask.engine_fallback).toMatchObject({ from: 'claude', to: 'claude', model: OTHER, window: 'five_hour', resets_from: 'host' })
      expect(Date.parse(qTask.engine_fallback!.resets_at!)).toBe(resetsAt)
      expect(await cliModelOf(quick.json.sessionId)).toBe(OTHER)

      // An agent's start (task_create / task_start): the answer carries the note too.
      const started = await req('POST', '/api/v1/tasks/fb-start/start', { message: 'go', cwd: '/tmp' })
      expect([200, 202], JSON.stringify(started.json)).toContain(started.status)
      expect(started.json.fallback).toMatchObject({ from: 'claude', to: 'claude', model: OTHER })
      expect((await getTask('fb-start')).engine_fallback).toMatchObject({ model: OTHER })
      const startSid = await until(async () => (await getSessionsForTask('fb-start'))[0]?.claudeSessionId, (v) => !!v)
      expect(await cliModelOf(startSid!)).toBe(OTHER)

      // A start that names its model chose for itself.
      const named = await req('POST', '/api/v1/tasks/fb-named/start', { message: 'go', cwd: '/tmp', model: 'opus' })
      expect([200, 202], JSON.stringify(named.json)).toContain(named.status)
      expect(named.json.fallback).toBeUndefined()
      expect((await getTask('fb-named')).engine_fallback ?? undefined).toBeUndefined()
      const namedQuick = await req('POST', '/api/sessions/quick-start', { cwd: '/tmp', message: 'hello', model: 'opus' })
      expect((await getTask(namedQuick.json.taskId)).engine_fallback ?? undefined).toBeUndefined()

      // The named launch was the user's pick, so the folder remembers it; a launch the fallback took
      // next leaves that memory as it was (it comes back once the limit resets).
      const memOf = async () => (await getFrequentDirs()).find((d) => d.cwd === '/tmp' && !d.host)?.lastLaunch
      await until(memOf, (m) => m?.model === 'opus')
      const again = await req('POST', '/api/sessions/quick-start', { cwd: '/tmp', message: 'hello' })
      expect((await getTask(again.json.taskId)).engine_fallback).toMatchObject({ model: OTHER })
      await delay(800)
      expect(await memOf()).toMatchObject({ model: 'opus' })

      // Ask Walnut runs the Personal AI profile only Claude Code carries: never on the fallback.
      const ask = await req('POST', '/api/sessions/quick-start', { cwd: '', message: 'hello', walnutAgent: true })
      expect(ask.status, JSON.stringify(ask.json)).toBe(200)
      expect((await getTask(ask.json.taskId)).engine_fallback ?? undefined).toBeUndefined()

      // The banner's ×: the note goes, and a second dismiss changes nothing.
      const gone = await req('POST', '/api/engines/fallback/dismiss', { taskId: quick.json.taskId })
      expect(gone.json).toMatchObject({ ok: true, changed: true })
      expect((await getTask(quick.json.taskId)).engine_fallback ?? undefined).toBeUndefined()
      expect((await req('POST', '/api/engines/fallback/dismiss', { taskId: quick.json.taskId })).json).toMatchObject({ changed: false })
      expect((await req('POST', '/api/engines/fallback/dismiss', {})).status).toBe(400)
    } finally {
      ws.close()
    }
  }, 90_000)
})
