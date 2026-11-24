/**
 * The Codex provider each start carries, captured where the bytes leave the server: the
 * adapter env of the acpStart the daemon receives. `engines.codex.provider` naming this
 * machine's 127.0.0.1 proxy reaches nothing on another host (2026-11-24: every Codex session
 * on a dev host failed that way), so a start there carries the host's own provider
 * (`hosts.<name>.engines.codex.provider`), without the env that named the global one; with none
 * of its own the start is refused, and the session and its task say what to set. A start here
 * keeps the global provider. The config is shaped as the maintainer's primary writes it
 * (engines.codex.env.MODEL_PROVIDER naming the loopback provider).
 *
 * Real server, real session runner, real AcpSession and worker bundle; MockDaemon and the
 * mock ACP agent stand in for the host's daemon and Codex. The host-judged path is off here
 * (WALNUT_HOST_RUNS_SESSIONS=0): this is the path where the leader builds the env, the one an
 * older host's service relies on.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-e2e-codex-host-provider'))
vi.mock('../../src/model/model.js', () => ({
  sendMessage: vi.fn(async () => ({ content: [{ type: 'text', text: 'Codex Task' }], stopReason: 'end_turn' })),
}))

import { WALNUT_HOME } from '../../src/constants.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'
import { bus, EventNames } from '../../src/core/event-bus.js'
import { addTask, getTask } from '../../src/core/task-manager.js'
import { updateConfig } from '../../src/core/config-manager.js'
import { acpWorkerBundle } from '../helpers/acp-worker-bundle.js'
import { getQueue, sendMessageToSession } from '../../src/core/session-message-queue.js'

const REPO = path.resolve(import.meta.dirname, '../..')
const MOCK_CLI = path.join(REPO, 'tests/providers/mock-claude.mjs')
const MOCK_AGENT = path.join(REPO, 'tests/providers/mock-acp-agent.mjs')

const GLOBAL = { base_url: 'http://127.0.0.1:8402/openai/v1', name: 'local-proxy', wire_api: 'responses', model_prefix: 'openai.' }
const GLOBAL_ENV = { MODEL_PROVIDER: 'local-proxy', CODEX_CONFIG: '{"model_context_window": 1000000}' }
const HOST_OWN = { base_url: 'http://127.0.0.1:18402/v1', name: 'host-relay', wire_api: 'responses' }

let server: HttpServer
let port = 0
let daemon: MockDaemon
const savedSwitch = process.env.WALNUT_HOST_RUNS_SESSIONS

async function waitFor<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, what: string, ms = 30_000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

/** Start a Codex session the way the UI's session:start does and return its acpStart's env and CODEX_CONFIG. */
async function codexStartOn(host: string | undefined): Promise<{ env: Record<string, string>; config: Record<string, unknown>; taskId: string }> {
  const before = daemon.getCommandHistoryFor('acpStart').length
  const { task } = await addTask({ title: `Codex on ${host ?? 'this machine'}`, project: 'marina' })
  bus.emit(EventNames.SESSION_START, {
    taskId: task.id, message: 'hello', cwd: os.tmpdir(), engine: 'codex', ...(host ? { host } : {}),
  }, ['session-runner'], { source: 'web-ui' })
  const cmd = await waitFor(() => daemon.getCommandHistoryFor('acpStart')[before], `the acpStart on ${host ?? 'this machine'}`)
  const env = (cmd.payload.env ?? {}) as Record<string, string>
  return { env, config: env.CODEX_CONFIG ? JSON.parse(env.CODEX_CONFIG) as Record<string, unknown> : {}, taskId: task.id }
}

beforeAll(async () => {
  process.env.WALNUT_HOST_RUNS_SESSIONS = '0'
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  daemon = await createMockDaemon()
  sessionRunner.setCliCommand(MOCK_CLI)
  sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemon.port}`)
  sessionRunner.setTestAcpArtifacts({ workerCmd: [process.execPath, acpWorkerBundle()], adapterCmd: [process.execPath, MOCK_AGENT] })
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
  await updateConfig({
    engines: { codex: { provider: GLOBAL, model: 'gpt-6.2-sol', effort: 'xhigh', env: GLOBAL_ENV } },
    hosts: {
      devbox: { hostname: 'devbox.invalid', enabled: true },
      relaybox: { hostname: 'relaybox.invalid', enabled: true, engines: { codex: { provider: HOST_OWN } } },
    },
  } as never)
}, 60_000)

afterAll(async () => {
  sessionRunner.setTestDaemonUrl(undefined)
  sessionRunner.setTestAcpArtifacts(undefined)
  await stopServer()
  await daemon.stop()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
  if (savedSwitch === undefined) delete process.env.WALNUT_HOST_RUNS_SESSIONS
  else process.env.WALNUT_HOST_RUNS_SESSIONS = savedSwitch
}, 30_000)

describe('the Codex provider of a start, by the host it runs on', () => {
  it('a start on this machine carries the global provider', async () => {
    const { env, config } = await codexStartOn(undefined)
    expect(config).toMatchObject({ model_provider: 'local-proxy', model_providers: { 'local-proxy': { base_url: GLOBAL.base_url } } })
    expect(env.MODEL_PROVIDER).toBe('local-proxy')
  }, 60_000)

  it('a start on a host with no provider of its own is refused: nothing reaches the host, its caller and its task say what to set', async () => {
    const before = daemon.getCommandHistoryFor('acpStart').length
    const { task } = await addTask({ title: 'Codex on devbox', project: 'marina' })
    const res = await fetch(`http://localhost:${port}/api/v1/tasks/${task.id}/start`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hello', cwd: '/home/marina/work', host: 'devbox', engine: 'codex' }),
    })
    // The caller (a person's start, an agent's task_start) gets the reason and the fix.
    const answer = JSON.stringify(await res.json())
    // A setting, not a passing failure: 422 with its own code, so a caller does not retry it as is.
    expect(res.status).toBe(422)
    expect(JSON.parse(answer).error?.code ?? JSON.parse(answer).code).toBe('engine_config')
    for (const words of ['engines.codex: provider \\"local-proxy\\"', 'host \\"devbox\\"', 'hosts:\\n  devbox:\\n    engines:\\n      codex:\\n        provider:']) expect(answer).toContain(words)
    // The task keeps it as its failed start, which its status reads (user-status-sync.ts startFailed).
    const stored = await getTask(task.id)
    expect(stored.last_start).toMatchObject({ state: 'failed', engine: 'codex' })
    expect(stored.last_start?.error).toContain('host "devbox"')
    expect(stored.last_start?.error).toContain('hosts.<name>.engines.codex.provider')
    // Nothing went to the host.
    expect(daemon.getCommandHistoryFor('acpStart').length).toBe(before)
  }, 60_000)

  it('a start on a host with its own provider carries that one, without the env that named the global one', async () => {
    const { env, config } = await codexStartOn('relaybox')
    expect(config).toMatchObject({ model_provider: 'host-relay', model_providers: { 'host-relay': { base_url: HOST_OWN.base_url, requires_openai_auth: false } }, model_context_window: 1000000 })
    expect(env.MODEL_PROVIDER).toBeUndefined()
    expect(JSON.stringify(env)).not.toContain(GLOBAL.base_url)
  }, 60_000)

  it('a session whose host lost its provider: its restart and its next message say why in its chat, nothing reaches the host, and once the host has a provider again the message goes out by itself', async () => {
    let hostDaemon: MockDaemon | undefined
    const failed: Array<{ sessionId: string; messageIds: string[]; error: string; parked?: boolean }> = []
    bus.subscribe('test-batch-failed', (e) => { failed.push(e.data as never) }, { global: true, interest: [EventNames.SESSION_BATCH_FAILED] })
    try {
      const { taskId } = await codexStartOn('relaybox')
      const sessionId = await waitFor(async () => (await getTask(taskId)).session_id, 'the session of the task')
      // The host's link, as the pool holds it: the restart asks it before it starts the worker again.
      // Its own daemon process (another instance id than this machine's), so it is another machine.
      const { DaemonConnection, setPooledConnectionForTest } = await import('../../src/providers/daemon-connection.js')
      hostDaemon = await createMockDaemon()
      const conn = new DaemonConnection('relaybox', { hostname: 'relaybox.invalid' })
      const url = `ws://127.0.0.1:${hostDaemon.port}`
      conn.connect = () => conn.connectDirect(url)
      setPooledConnectionForTest('relaybox', conn)
      await conn.connectDirect(url)
      // The host's provider is taken away: the global loopback one is all that is left.
      await updateConfig({ hosts: { relaybox: { hostname: 'relaybox.invalid', enabled: true, engines: { codex: { provider: null } } } } } as never)
      const before = daemon.getCommandHistoryFor('acpStart').length
      const restart = await fetch(`http://localhost:${port}/api/sessions/${sessionId}/restart`, { method: 'POST' })
      const restartText = await restart.text()
      // The restart's own answer is the refusal: a setting, 422, with what to set.
      expect(restart.status, restartText).toBe(422)
      expect(restartText).toContain('hosts.<name>.engines.codex.provider')
      await sendMessageToSession(sessionId, 'are you there', { source: 'ui', taskId })
      // The chat's bubble of that message turns failed with the reason and what to set, and the row keeps it.
      const report = await waitFor(() => failed.find((f) => f.sessionId === sessionId && f.error.includes('host "relaybox"')), 'the failed bubble with its reason')
      expect(report.error).toContain('hosts.<name>.engines.codex.provider')
      expect(report.parked).toBe(true)
      const rows = await getQueue(sessionId)
      const row = rows.find((r) => report.messageIds.includes(r.id))
      expect(row).toMatchObject({ status: 'parked' })
      expect(row?.parkedReason).toContain('host "relaybox"')
      // Nothing was started on the host for it.
      expect(daemon.getCommandHistoryFor('acpStart').length, restartText).toBe(before)

      // The user gives the host its provider again (Settings, PUT /api/config): the held message goes
      // out by itself, once, on that provider, and leaves the queue.
      const put = await fetch(`http://localhost:${port}/api/config`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hosts: { relaybox: { hostname: 'relaybox.invalid', enabled: true, engines: { codex: { provider: HOST_OWN } } } } }),
      })
      expect(put.status, await put.text()).toBeLessThan(300)
      const resent = await waitFor(() => daemon.getCommandHistoryFor('acpStart')[before], 'the held message\'s start on the host')
      const env = (resent.payload.env ?? {}) as Record<string, string>
      expect(JSON.parse(env.CODEX_CONFIG ?? '{}')).toMatchObject({ model_provider: 'host-relay' })
      await waitFor(async () => !(await getQueue(sessionId)).some((r) => r.id === row!.id), 'the held message delivered')
      expect(daemon.getCommandHistoryFor('acpStart').length).toBe(before + 1)
    } finally {
      bus.unsubscribe('test-batch-failed')
      const { setPooledConnectionForTest } = await import('../../src/providers/daemon-connection.js')
      setPooledConnectionForTest('relaybox', null)
      await hostDaemon?.stop()
      await updateConfig({ hosts: { relaybox: { hostname: 'relaybox.invalid', enabled: true, engines: { codex: { provider: HOST_OWN } } } } } as never)
    }
  }, 90_000)
})
