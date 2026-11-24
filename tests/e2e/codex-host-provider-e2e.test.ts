/**
 * The Codex provider each start carries, captured where the bytes leave the server: the
 * adapter env of the acpStart the daemon receives. `engines.codex.provider` naming this
 * machine's 127.0.0.1 proxy reaches nothing on another host (2026-11-24: every Codex session
 * on a dev host failed that way), so a start there carries the host's own provider
 * (`hosts.<name>.engines.codex.provider`) or none, and Codex reads that host's own
 * ~/.codex/config.toml. A start here keeps the global provider.
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
import { addTask } from '../../src/core/task-manager.js'
import { updateConfig } from '../../src/core/config-manager.js'
import { acpWorkerBundle } from '../helpers/acp-worker-bundle.js'

const REPO = path.resolve(import.meta.dirname, '../..')
const MOCK_CLI = path.join(REPO, 'tests/providers/mock-claude.mjs')
const MOCK_AGENT = path.join(REPO, 'tests/providers/mock-acp-agent.mjs')

const GLOBAL = { base_url: 'http://127.0.0.1:8402/openai/v1', name: 'local-proxy', wire_api: 'responses' }
const HOST_OWN = { base_url: 'http://127.0.0.1:18402/v1', name: 'host-relay', wire_api: 'responses' }

let server: HttpServer
let daemon: MockDaemon
const savedSwitch = process.env.WALNUT_HOST_RUNS_SESSIONS

async function waitFor<T>(fn: () => T | undefined | false, what: string, ms = 30_000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

/** Start a Codex session the way the UI's session:start does and return the CODEX_CONFIG its acpStart carried. */
async function codexConfigOfStart(host: string | undefined): Promise<Record<string, unknown>> {
  const before = daemon.getCommandHistoryFor('acpStart').length
  const { task } = await addTask({ title: `Codex on ${host ?? 'this machine'}`, project: 'marina' })
  bus.emit(EventNames.SESSION_START, {
    taskId: task.id, message: 'hello', cwd: os.tmpdir(), engine: 'codex', ...(host ? { host } : {}),
  }, ['session-runner'], { source: 'web-ui' })
  const cmd = await waitFor(() => daemon.getCommandHistoryFor('acpStart')[before], `the acpStart on ${host ?? 'this machine'}`)
  const env = (cmd.payload.env ?? {}) as Record<string, string>
  return env.CODEX_CONFIG ? JSON.parse(env.CODEX_CONFIG) as Record<string, unknown> : {}
}

beforeAll(async () => {
  process.env.WALNUT_HOST_RUNS_SESSIONS = '0'
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  daemon = await createMockDaemon()
  sessionRunner.setCliCommand(MOCK_CLI)
  sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemon.port}`)
  sessionRunner.setTestAcpArtifacts({ workerCmd: [process.execPath, acpWorkerBundle()], adapterCmd: [process.execPath, MOCK_AGENT] })
  server = await startServer({ port: 0, dev: true })
  await updateConfig({
    engines: { codex: { provider: GLOBAL } },
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
    const config = await codexConfigOfStart(undefined)
    expect(config).toMatchObject({ model_provider: 'local-proxy', model_providers: { 'local-proxy': { base_url: GLOBAL.base_url } } })
  }, 60_000)

  it('a start on a host with no provider of its own carries none: the global one names this machine', async () => {
    const config = await codexConfigOfStart('devbox')
    expect(config.model_provider).toBeUndefined()
    expect(config.model_providers).toBeUndefined()
    // The rest of the start's config still rides it.
    expect(typeof config.developer_instructions).toBe('string')
  }, 60_000)

  it('a start on a host with its own provider carries that one', async () => {
    const config = await codexConfigOfStart('relaybox')
    expect(config).toMatchObject({ model_provider: 'host-relay', model_providers: { 'host-relay': { base_url: HOST_OWN.base_url, requires_openai_auth: false } } })
    expect(JSON.stringify(config)).not.toContain(GLOBAL.base_url)
  }, 60_000)
})
