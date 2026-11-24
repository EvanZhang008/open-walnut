/**
 * E2E: an existing Claude Code session switched to Antigravity keeps talking, and a switch that
 * fails for want of Antigravity's sign-in (or of the `agy` CLI itself) leaves the task working.
 *
 *   real server → POST /api/v1/tasks/:id/switch-engine → core/sessions/engine-switch.ts
 *   → task-start → SessionRunner → AcpSession → MockDaemon (the real createAcpDaemon)
 *   → real acp-worker bundle → tests/providers/mock-acp-agent.mjs answering as `agy acp`
 *
 * Mocked: constants, the daemon transport (MockDaemon), the Claude CLI (mock-claude.mjs) and the
 * ACP agent. No Google account, key or network.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-e2e-switch-antigravity'))
// Offline model for the background title refinement.
vi.mock('../../src/model/model.js', () => ({
  sendMessage: vi.fn(async () => ({ content: [{ type: 'text', text: 'Switch Task' }], stopReason: 'end_turn' })),
}))

import { WALNUT_HOME } from '../../src/constants.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'
import { bus, EventNames } from '../../src/core/event-bus.js'
import { addTask, getTask } from '../../src/core/task-manager.js'
import { getSessionByClaudeId, getSessionsForTask } from '../../src/core/session-tracker.js'
import { sendMessageToSession } from '../../src/core/session-message-queue.js'
import { _resetEngineProbeCache, _seedEngineProbeCache } from '../../src/core/agents/engine-probe.js'
import { parseNotSignedIn } from '../../src/core/agents/engine-sign-in-words.js'
import { acpWorkerBundle } from '../helpers/acp-worker-bundle.js'

const REPO = path.resolve(import.meta.dirname, '../..')
const MOCK_CLI = path.join(REPO, 'tests/providers/mock-claude.mjs')
const MOCK_AGENT = path.join(REPO, 'tests/providers/mock-acp-agent.mjs')

let server: HttpServer
let port: number
let daemon: MockDaemon
let scratch: string
let promptLog: string
let authLog: string
const saved: Record<string, string | undefined> = {}
const ENV_KEYS = [
  'CLAUDE_CONFIG_DIR', 'MOCK_CLAUDE_TRANSCRIPT_DIR', 'MOCK_ACP_AGENT_NAME', 'MOCK_ACP_PROMPT_LOG',
  'MOCK_ACP_REQUIRE_AUTH', 'MOCK_ACP_AUTH_FAIL', 'MOCK_ACP_AUTH_LOG', 'MOCK_ACP_AUTH_METHODS',
] as const

/** How the sign-in sentence names this machine ("this Mac" on a Mac). */
const thisMachine = process.platform === 'darwin' ? 'this Mac' : 'this computer'

const captured: Array<{ name: string; data: Record<string, unknown> }> = []

async function waitFor<T>(fn: () => Promise<T | undefined | false> | T | undefined | false, what: string, ms = 30_000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v as T
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

async function api(method: string, p: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

function replyText(sid: string): string {
  return captured.filter((e) => e.name === EventNames.SESSION_TEXT_DELTA && e.data.sessionId === sid)
    .map((e) => String(e.data.delta ?? '')).join('')
}

function prompts(): Array<{ sessionId: string; text: string }> {
  if (!fs.existsSync(promptLog)) return []
  return fs.readFileSync(promptLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

/** A task whose Claude Code session has answered one turn and is idle again. */
async function claudeTaskWithOneTurn(title: string, words: string): Promise<{ taskId: string; sid: string }> {
  const { task } = await addTask({ title, project: 'marina' })
  bus.emit(EventNames.SESSION_START, { taskId: task.id, message: words, cwd: scratch }, ['session-runner'], { source: 'web-ui' })
  const sid = await waitFor(async () => (await getSessionsForTask(task.id))[0]?.claudeSessionId, `${title} session`)
  await waitFor(() => captured.some((e) => e.name === EventNames.SESSION_RESULT && e.data.sessionId === sid), `${title} first turn`)
  await waitFor(async () => (await getSessionByClaudeId(sid))?.process_status !== 'running' || undefined, `${title} idle`)
  return { taskId: task.id, sid }
}

async function switchTo(taskId: string, engine: string, text: string) {
  return api('POST', `/api/v1/tasks/${taskId}/switch-engine`, { engine, text, wait_ms: 60_000 })
}

/** The task's active session now, as the panel reads it. */
async function activeSession(taskId: string): Promise<{ id: string; engine: string }> {
  const r = await api('GET', `/api/v1/tasks/${taskId}/sessions`)
  expect(r.status).toBe(200)
  const row = (r.json.sessions as Array<{ session_id: string; engine: string; active: boolean }>).find((s) => s.active)!
  return { id: row.session_id, engine: row.engine }
}

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k]
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-switch-agy-'))
  // The mock CLI writes its transcript where the switch reads the old session's context.
  process.env.CLAUDE_CONFIG_DIR = path.join(scratch, 'claude')
  process.env.MOCK_CLAUDE_TRANSCRIPT_DIR = path.join(scratch, 'claude', 'projects')
  // The ACP mock introduces itself as agy does at initialize.
  process.env.MOCK_ACP_AGENT_NAME = 'Antigravity ACP Server'
  promptLog = path.join(scratch, 'prompts.jsonl')
  authLog = path.join(scratch, 'auth.log')
  process.env.MOCK_ACP_PROMPT_LOG = promptLog
  process.env.MOCK_ACP_AUTH_LOG = authLog
  daemon = await createMockDaemon()
  sessionRunner.setCliCommand(MOCK_CLI)
  sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemon.port}`)
  sessionRunner.setTestAcpArtifacts({ workerCmd: [process.execPath, acpWorkerBundle()], adapterCmd: [process.execPath, MOCK_AGENT] })
  bus.subscribe('switch-agy-capture', (event) => {
    captured.push({ name: event.name, data: (event.data ?? {}) as Record<string, unknown> })
  }, { global: true })
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
}, 60_000)

beforeEach(() => {
  // agy is installed on this machine (no real binary: the injected adapter stands for it).
  _resetEngineProbeCache()
  _seedEngineProbeCache('antigravity', { installed: true, version: '1.0.0', reason: null } as never)
  for (const k of ['MOCK_ACP_REQUIRE_AUTH', 'MOCK_ACP_AUTH_FAIL', 'MOCK_ACP_AUTH_METHODS'] as const) delete process.env[k]
})

afterAll(async () => {
  bus.unsubscribe('switch-agy-capture')
  sessionRunner.setTestDaemonUrl(undefined)
  sessionRunner.setTestAcpArtifacts(undefined)
  _resetEngineProbeCache()
  await stopServer()
  await daemon.stop()
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
  await fsp.rm(scratch, { recursive: true, force: true }).catch(() => {})
}, 30_000)

describe('switching a live Claude Code session to Antigravity', () => {
  it('the next message is answered by Antigravity, with the earlier turns carried over', async () => {
    const { taskId, sid } = await claudeTaskWithOneTurn('Carry the codeword', 'remember the codeword marina-pear-42')

    const r = await switchTo(taskId, 'antigravity', 'which codeword did I give you?')
    expect(r.status, JSON.stringify(r.json)).toBe(200)
    expect(r.json).toMatchObject({ state: 'done', engine: 'antigravity', fromSessionId: sid })
    const newSid = r.json.sessionId as string
    expect(newSid).not.toBe(sid)
    expect(r.json.carriedTurns).toBeGreaterThanOrEqual(1)

    // The ACP agent got one prompt: the carried context (the Claude turn) and the user's words.
    const first = await waitFor(() => prompts().at(-1), 'the Antigravity prompt')
    expect(first.text).toContain('marina-pear-42')
    expect(first.text).toContain('which codeword did I give you?')
    await waitFor(() => replyText(newSid).includes('hello from mock-acp'), 'the Antigravity reply')

    const rec = await getSessionByClaudeId(newSid)
    expect(rec?.engine).toBe('antigravity')
    // The worker was started with agy's own adapter env and auth plan (engine-registry.ts).
    const start = daemon.getCommandHistoryFor('acpStart').at(-1)!
    const env = (start.payload.env ?? {}) as Record<string, string>
    expect(env.AGY_ACP_FORCE_FILE_STORAGE).toBe('1')
    expect(JSON.parse(env.WALNUT_ACP_AUTH ?? '{}')).toMatchObject({ otherwise: 'oauth-personal' })
    expect(rec?.engineSwitch?.fromSessionId).toBe(sid)
    expect(await activeSession(taskId)).toEqual({ id: newSid, engine: 'antigravity' })
    const old = await getSessionByClaudeId(sid)
    expect(old?.archive_reason).toBe('engine_switched:antigravity')
    expect((await getTask(taskId)).engine_switch?.state).toBe('done')

    // It keeps talking: a follow-up on the same session is answered too.
    const before = prompts().length
    await sendMessageToSession(newSid, 'and one more thing')
    await waitFor(() => prompts().length > before, 'the follow-up prompt')
    expect(prompts().at(-1)!.text).toContain('and one more thing')
    await waitFor(() => replyText(newSid).split('hello from mock-acp').length - 1 >= 2 && replyText(newSid).includes('and one more thing'), 'the follow-up reply')
  }, 120_000)
})

describe('a switch to Antigravity that fails leaves the task working', () => {
  /** The task is on its Claude Code session again, and that session still answers. */
  async function stillOnClaude(taskId: string, sid: string, words: string): Promise<void> {
    expect(await activeSession(taskId)).toEqual({ id: sid, engine: 'claude' })
    const old = await getSessionByClaudeId(sid)
    expect(old?.archived).toBeFalsy()
    expect(old?.archive_reason).toBeFalsy()
    const results = () => captured.filter((e) => e.name === EventNames.SESSION_RESULT && e.data.sessionId === sid).length
    const before = results()
    await sendMessageToSession(sid, words)
    await waitFor(() => results() > before, 'the Claude Code answer after the failed switch')
  }

  it('not signed in (session/new answers Authentication required): a sign-in error, and a retry after sign-in goes through', async () => {
    const { taskId, sid } = await claudeTaskWithOneTurn('Sign-in first', 'remember the codeword marina-fig-7')
    process.env.MOCK_ACP_REQUIRE_AUTH = '1'

    const r = await switchTo(taskId, 'antigravity', 'are you there?')
    expect(r.status).toBe(409)
    expect(r.json.code).toBe('sign_in_required')
    // The words the chat recognises to offer Settings' sign-in for this machine.
    expect(parseNotSignedIn(r.json.error)).toMatchObject({ engine: 'antigravity', hostName: thisMachine })
    expect(r.json.signIn).toMatchObject({ engine: 'antigravity', host: '__local__' })
    const task = await getTask(taskId)
    expect(task.engine_switch?.state).toBe('failed')
    expect(parseNotSignedIn(task.engine_switch?.error)).toMatchObject({ engine: 'antigravity' })
    // No Antigravity session is left holding the task.
    const rows = await getSessionsForTask(taskId)
    for (const row of rows.filter((x) => x.engine === 'antigravity')) expect(row.claudeSessionId).not.toBe(task.session_id)
    await stillOnClaude(taskId, sid, 'still there?')

    // Signed in now: the same pick goes through and Antigravity answers with the context.
    delete process.env.MOCK_ACP_REQUIRE_AUTH
    const again = await switchTo(taskId, 'antigravity', 'which codeword now?')
    expect(again.status, JSON.stringify(again.json)).toBe(200)
    expect(again.json).toMatchObject({ state: 'done', engine: 'antigravity', fromSessionId: sid })
    const prompt = await waitFor(() => prompts().find((p) => p.text.includes('which codeword now?')), 'the retried prompt')
    expect(prompt.text).toContain('marina-fig-7')
    await waitFor(() => replyText(again.json.sessionId).includes('hello from mock-acp'), 'the retried reply')
  }, 150_000)

  it('the sign-in itself refused (authenticate fails): the same sign-in error, and the task goes back to Claude Code', async () => {
    const { taskId, sid } = await claudeTaskWithOneTurn('Refused sign-in', 'remember the codeword marina-plum-3')
    process.env.MOCK_ACP_REQUIRE_AUTH = '1'
    // agy's own method ids, so Walnut's auth plan for it asks for one (oauth-personal).
    process.env.MOCK_ACP_AUTH_METHODS = 'oauth-personal,gemini-api-key'
    process.env.MOCK_ACP_AUTH_FAIL = '1'
    const asked = fs.existsSync(authLog) ? fs.readFileSync(authLog, 'utf8').length : 0

    const r = await switchTo(taskId, 'antigravity', 'are you there?')
    expect(fs.readFileSync(authLog, 'utf8').slice(asked)).toContain('oauth-personal')
    expect(r.status).toBe(409)
    expect(r.json.code).toBe('sign_in_required')
    expect(parseNotSignedIn(r.json.error)).toMatchObject({ engine: 'antigravity', hostName: thisMachine })
    // The provider's own words (a token in them) never reach the answer.
    expect(JSON.stringify(r.json)).not.toContain('SUPER_SECRET_AUTH_TOKEN')
    await stillOnClaude(taskId, sid, 'back on Claude Code?')
  }, 150_000)

  it('agy missing on this machine: refused before anything changes', async () => {
    const { taskId, sid } = await claudeTaskWithOneTurn('No agy here', 'hello')
    _resetEngineProbeCache()
    _seedEngineProbeCache('antigravity', { installed: false, version: null, reason: 'agy is not installed' } as never)
    const sessionsBefore = (await getSessionsForTask(taskId)).length

    const r = await switchTo(taskId, 'antigravity', 'are you there?')
    expect(r.status, JSON.stringify(r.json)).toBe(409)
    expect(r.json.code).toBe('engine_not_on_host')
    expect(r.json.error).toMatch(/Antigravity is not available on this Mac: agy is not installed/)
    expect((await getSessionsForTask(taskId)).length).toBe(sessionsBefore)
    await stillOnClaude(taskId, sid, 'still on Claude Code?')
  }, 120_000)
})
