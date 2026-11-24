/**
 * E2E: a task running on Claude Code on another host, switched to Codex while that host has no
 * Codex provider of its own and the global `engines.codex.provider` is this machine's loopback
 * proxy (it reaches nothing on the host, codex-engine-config.ts codexProviderForPlace).
 *
 *   1. The switch is refused before anything changes: 422 `engine_config` with the setting's
 *      words, the task stays on its Claude Code session (not archived, still answering), no Codex
 *      session row is made, nothing is started on the host, and the switch's message is kept on
 *      the task's failed switch (engine_switch.message) for the person to send again.
 *   2. Messages sent while refused are not lost: they go to the Claude Code session.
 *   3. Once the host has its own provider (PUT /api/config, as the Settings page saves it), the
 *      same switch goes through on that provider, carrying the conversation, and the next message
 *      is answered on Codex.
 *
 *   real server → POST /api/v1/tasks/:id/switch-engine → core/sessions/engine-switch.ts
 *   → task-start → SessionRunner → AcpSession → MockDaemon (the real createAcpDaemon)
 *   → real acp-worker bundle → tests/providers/mock-acp-agent.mjs answering as Codex
 *
 * Real: the server, its routes, the config write, the switch, the session runner, the queue, the
 * Codex provider resolution and the env the host receives. Faked: the host's daemon transport
 * (MockDaemons running the real daemon code on this machine: the test daemon URL carries the
 * sessions' processes, and a second one is the host's pooled link, which its file reads and the
 * other-machine check go through, as codex-host-provider-e2e.test.ts does), the Claude CLI
 * (mock-claude.mjs) and the Codex ACP adapter (mock-acp-agent.mjs). The leader builds the env
 * (WALNUT_HOST_RUNS_SESSIONS=0), the path an older host's service relies on.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-e2e-switch-codex-host'))
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
import { getQueue, sendMessageToSession } from '../../src/core/session-message-queue.js'
import { updateConfig } from '../../src/core/config-manager.js'
import { _resetHostEngineCache, _seedHostEngineCache } from '../../src/core/agents/host-engines.js'
import { acpWorkerBundle } from '../helpers/acp-worker-bundle.js'

const REPO = path.resolve(import.meta.dirname, '../..')
const MOCK_CLI = path.join(REPO, 'tests/providers/mock-claude.mjs')
const MOCK_AGENT = path.join(REPO, 'tests/providers/mock-acp-agent.mjs')

const HOST = 'devbox'
const GLOBAL = { base_url: 'http://127.0.0.1:8402/openai/v1', name: 'local-proxy', wire_api: 'responses' }
const HOST_OWN = { base_url: 'http://127.0.0.1:18402/v1', name: 'host-relay', wire_api: 'responses' }

let server: HttpServer
let port = 0
let daemon: MockDaemon
/** The host's own daemon link (reads of its files): another daemon process, so another machine than this one. */
let hostDaemon: MockDaemon
let scratch: string
let promptLog: string
const saved: Record<string, string | undefined> = {}
const ENV_KEYS = ['CLAUDE_CONFIG_DIR', 'MOCK_CLAUDE_TRANSCRIPT_DIR', 'MOCK_ACP_PROMPT_LOG', 'WALNUT_HOST_RUNS_SESSIONS'] as const
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

const results = (sid: string) => captured.filter((e) => e.name === EventNames.SESSION_RESULT && e.data.sessionId === sid).length
const replyText = (sid: string) => captured.filter((e) => e.name === EventNames.SESSION_TEXT_DELTA && e.data.sessionId === sid)
  .map((e) => String(e.data.delta ?? '')).join('')

function prompts(): Array<{ sessionId: string; text: string }> {
  if (!fs.existsSync(promptLog)) return []
  return fs.readFileSync(promptLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

/**
 * Switch the task to Codex, as the picker's POST does. The host says it runs Codex (the injected
 * adapter stands for its CLI): what its daemon would answer to acpHostEngines, fresh for this ask.
 */
async function switchToCodex(taskId: string, text: string) {
  _seedHostEngineCache(HOST, { claude: { installed: true, version: null, reason: null }, codex: { installed: true, version: '1.0.0', reason: null } })
  return api('POST', `/api/v1/tasks/${taskId}/switch-engine`, { engine: 'codex', text, wait_ms: 60_000 })
}

/** The task's active session now, as the panel reads it. */
async function activeSession(taskId: string): Promise<{ id: string; engine: string; host: string | null }> {
  const r = await api('GET', `/api/v1/tasks/${taskId}/sessions`)
  expect(r.status).toBe(200)
  const row = (r.json.sessions as Array<{ session_id: string; engine: string; host: string | null; active: boolean }>).find((s) => s.active)!
  return { id: row.session_id, engine: row.engine, host: row.host }
}

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k]
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-switch-codex-host-'))
  // The mock CLI writes its transcripts where the host's `~/.claude/projects` is (the host daemon's
  // home is `scratch`), which is where the switch reads the old session's context.
  process.env.CLAUDE_CONFIG_DIR = path.join(scratch, '.claude')
  process.env.MOCK_CLAUDE_TRANSCRIPT_DIR = path.join(scratch, '.claude', 'projects')
  promptLog = path.join(scratch, 'prompts.jsonl')
  process.env.MOCK_ACP_PROMPT_LOG = promptLog
  process.env.WALNUT_HOST_RUNS_SESSIONS = '0'
  daemon = await createMockDaemon()
  sessionRunner.setCliCommand(MOCK_CLI)
  sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemon.port}`)
  sessionRunner.setTestAcpArtifacts({ workerCmd: [process.execPath, acpWorkerBundle()], adapterCmd: [process.execPath, MOCK_AGENT] })
  bus.subscribe('switch-codex-host-capture', (event) => {
    captured.push({ name: event.name, data: (event.data ?? {}) as Record<string, unknown> })
  }, { global: true })
  server = await startServer({ port: 0, dev: true })
  hostDaemon = await createMockDaemon({ home: scratch })
  const { DaemonConnection, setPooledConnectionForTest } = await import('../../src/providers/daemon-connection.js')
  const conn = new DaemonConnection(HOST, { hostname: 'devbox.invalid' })
  const url = `ws://127.0.0.1:${hostDaemon.port}`
  conn.connect = () => conn.connectDirect(url)
  setPooledConnectionForTest(HOST, conn)
  await conn.connectDirect(url)
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
  await updateConfig({
    engines: { codex: { provider: GLOBAL } },
    hosts: { [HOST]: { hostname: 'devbox.invalid', enabled: true } },
  } as never)
}, 60_000)

afterAll(async () => {
  bus.unsubscribe('switch-codex-host-capture')
  sessionRunner.setTestDaemonUrl(undefined)
  sessionRunner.setTestAcpArtifacts(undefined)
  _resetHostEngineCache()
  const { setPooledConnectionForTest } = await import('../../src/providers/daemon-connection.js')
  setPooledConnectionForTest(HOST, null)
  await stopServer()
  await hostDaemon?.stop()
  await daemon.stop()
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
  await fsp.rm(scratch, { recursive: true, force: true }).catch(() => {})
}, 30_000)

describe('switching a Claude Code task on another host to Codex, with no provider for that host', () => {
  it('is refused with engine_config and leaves the task as it was; once the host has a provider the same switch goes through', async () => {
    // A Claude Code task on the host, one turn answered.
    const { task } = await addTask({ title: 'Codex on a host', project: 'marina' })
    const taskId = task.id
    bus.emit(EventNames.SESSION_START, { taskId, message: 'remember the codeword marina-quince-9', cwd: scratch, host: HOST }, ['session-runner'], { source: 'web-ui' })
    const sid = await waitFor(async () => (await getSessionsForTask(taskId))[0]?.claudeSessionId, 'the Claude Code session')
    await waitFor(() => results(sid) > 0, 'the first turn')
    await waitFor(async () => (await getSessionByClaudeId(sid))?.process_status !== 'running' || undefined, 'the session idle')
    expect(await activeSession(taskId)).toMatchObject({ id: sid, engine: 'claude', host: HOST })
    const statusBefore = (await getSessionByClaudeId(sid))?.process_status
    const rowsBefore = (await getSessionsForTask(taskId)).map((r) => r.claudeSessionId).sort()
    const acpStartsBefore = daemon.getCommandHistoryFor('acpStart').length

    // 1. The switch is refused: a setting, with the words that say what to set.
    const refused = await switchToCodex(taskId, 'which codeword did I give you?')
    expect(refused.status, JSON.stringify(refused.json)).toBe(422)
    expect(refused.json.code).toBe('engine_config')
    expect(refused.json.error).toContain('provider "local-proxy"')
    expect(refused.json.error).toContain(`host "${HOST}"`)
    expect(refused.json.error).toContain('hosts.<name>.engines.codex.provider')
    expect(refused.json.error).toMatch(/^The switch to Codex did not start: engines\.codex: /)
    expect(refused.json.error).toContain('The task stays on Claude; pick Codex again once that setting is changed.')
    // Words for a switch, not a task start's.
    expect(refused.json.error).not.toContain('task_start')

    // Nothing half-switched: same active session on Claude Code, not archived, no new row, nothing on the host.
    expect(await activeSession(taskId)).toMatchObject({ id: sid, engine: 'claude', host: HOST })
    const old = await getSessionByClaudeId(sid)
    expect(old?.archived).toBeFalsy()
    expect(old?.archive_reason).toBeFalsy()
    // Its process was not stopped for a switch that could not start.
    expect(old?.process_status).toBe(statusBefore)
    expect((await getSessionsForTask(taskId)).map((r) => r.claudeSessionId).sort()).toEqual(rowsBefore)
    expect(daemon.getCommandHistoryFor('acpStart').length).toBe(acpStartsBefore)
    const afterRefusal = await getTask(taskId)
    expect(afterRefusal.session_id).toBe(sid)
    expect(afterRefusal.engine_switch).toMatchObject({ state: 'failed', message: 'which codeword did I give you?', to: { engine: 'codex' } })
    // The panel's line reads "The switch to Codex did not start: <error>." from it: the setting's words alone.
    expect(afterRefusal.engine_switch?.error).toMatch(/^engines\.codex: provider "local-proxy"/)
    expect(afterRefusal.engine_switch?.error).toContain('hosts.<name>.engines.codex.provider')
    expect(afterRefusal.engine_switch?.error).not.toMatch(/\.$/)

    // 2. Nothing sent while refused is lost. The switch's own message, held on the failed switch,
    //    goes to the Claude Code session with the panel's "Send here" (DELETE with deliver)...
    let before = results(sid)
    const sendHere = await api('DELETE', `/api/v1/tasks/${taskId}/switch-engine`, { deliver: true })
    expect(sendHere.status, JSON.stringify(sendHere.json)).toBe(200)
    expect(sendHere.json).toEqual({ cancelled: true, delivered: true })
    await waitFor(() => results(sid) > before, 'the Claude Code answer to the held message')
    expect((await getTask(taskId)).engine_switch?.message).toBeUndefined()
    // ...and a message typed meanwhile is answered there too.
    await waitFor(async () => (await getQueue(sid)).length === 0 || undefined, 'the Claude Code queue drained')
    before = results(sid)
    await sendMessageToSession(sid, 'still there on Claude Code?', { source: 'ui', taskId })
    await waitFor(() => results(sid) > before, 'the Claude Code answer after the refusal')
    await waitFor(async () => (await getQueue(sid)).length === 0 || undefined, 'the Claude Code queue drained')
    expect(daemon.getCommandHistoryFor('acpStart').length).toBe(acpStartsBefore)

    // 3. The host gets its own provider, saved the way the Settings page saves it.
    const put = await api('PUT', '/api/config', { hosts: { [HOST]: { hostname: 'devbox.invalid', enabled: true, engines: { codex: { provider: HOST_OWN } } } } })
    expect(put.status, JSON.stringify(put.json)).toBeLessThan(300)
    await waitFor(async () => (await getSessionByClaudeId(sid))?.process_status !== 'running' || undefined, 'the session idle again')

    const done = await switchToCodex(taskId, 'which codeword did I give you?')
    expect(done.status, JSON.stringify(done.json)).toBe(200)
    expect(done.json).toMatchObject({ state: 'done', engine: 'codex', fromSessionId: sid, host: HOST })
    const newSid = done.json.sessionId as string
    expect(newSid).not.toBe(sid)

    // Started on the host with the host's own provider, never the loopback global one.
    const start = await waitFor(() => daemon.getCommandHistoryFor('acpStart')[acpStartsBefore], 'the Codex start on the host')
    const env = (start.payload.env ?? {}) as Record<string, string>
    expect(JSON.parse(env.CODEX_CONFIG ?? '{}')).toMatchObject({ model_provider: 'host-relay', model_providers: { 'host-relay': { base_url: HOST_OWN.base_url } } })
    expect(JSON.stringify(env)).not.toContain(GLOBAL.base_url)

    // The conversation came along, and Codex answers the message.
    const first = await waitFor(() => prompts().find((p) => p.text.includes('which codeword did I give you?')), 'the Codex prompt')
    expect(first.text).toContain('marina-quince-9')
    await waitFor(() => replyText(newSid).includes('hello from mock-acp'), 'the Codex reply')
    const rec = await getSessionByClaudeId(newSid)
    expect(rec).toMatchObject({ engine: 'codex', host: HOST })
    expect(await activeSession(taskId)).toMatchObject({ id: newSid, engine: 'codex', host: HOST })
    expect((await getSessionByClaudeId(sid))?.archive_reason).toBe('engine_switched:codex')
    expect((await getTask(taskId)).engine_switch?.state).toBe('done')

    // The next message is delivered on Codex.
    const sent = prompts().length
    await sendMessageToSession(newSid, 'and one more thing', { source: 'ui', taskId })
    await waitFor(() => prompts().slice(sent).some((p) => p.text.includes('and one more thing')), 'the follow-up on Codex')
  }, 180_000)
})
