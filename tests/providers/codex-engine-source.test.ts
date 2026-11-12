/**
 * While the cloud companion (or a host's server) starts a Codex session, the Mac's
 * engines.codex reaches it through the config copy, and a server that cannot tell
 * what the Mac set refuses the start: before this, the companion's copy had no
 * `engines` at all, so its Codex starts used the host's own (managed) provider.
 * Real allowlist and copy functions; for the start, only this server's place and
 * its copy of the Mac's config are stand-ins.
 */
import fsp from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-codex-engine-source'))

let place: 'mac' | 'host' | 'cloud' = 'mac'
let copy: Record<string, unknown> | null = null
vi.mock('../../src/core/server-role.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/server-role.js')>()),
  placement: () => place,
  isFollower: () => place !== 'mac',
}))
vi.mock('../../src/core/replication/kinds/config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/replication/kinds/config.js')>()),
  readConfigCopy: async () => copy,
}))

import { WALNUT_HOME } from '../../src/constants.js'
import { _resetSessionTrackerForTesting } from '../../src/core/session-tracker.js'
import { _resetForTesting } from '../../src/core/task-manager.js'
import { updateConfig } from '../../src/core/config-manager.js'
import { configCopyRows, configRowAdmissible } from '../../src/core/replication/config-allowlist.js'
import { AcpSession } from '../../src/providers/acp-session.js'
import { CodexEngineConfigError, resolveCodexEngine } from '../../src/providers/codex-engine-config.js'
import { withCopiedEngines } from '../../src/providers/codex-engine-source.js'

const PROVIDER = { base_url: 'http://127.0.0.1:9000/v1', name: 'my-proxy', model_prefix: 'vendor.', env_key: 'MY_PROXY_KEY' }

beforeEach(async () => {
  place = 'mac'
  copy = null
  _resetForTesting()
  _resetSessionTrackerForTesting()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
})
afterEach(() => vi.restoreAllMocks())

describe('the config copy carries the non-secret part of engines', () => {
  it('provider, model and effort go; env and adapter_cmd never do', () => {
    const { rows } = configCopyRows({
      engines: {
        codex: { provider: PROVIDER, model: 'gpt-example', effort: 'xhigh', env: { CODEX_CONFIG: '{"model_context_window":1000000}', OPENAI_API_KEY: 'sk-test-PLANTED-0000' } },
        goose: { env: { AWS_SECRET_ACCESS_KEY: 'planted-secret-value-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789' } },
        custom: { adapter_cmd: ['/Users/someone/bin/agent'] },
      },
    })
    const row = rows.find((r) => r.key === 'engines')!
    expect(row.value).toEqual({ codex: { provider: PROVIDER, model: 'gpt-example', effort: 'xhigh' }, goose: {}, custom: {} })
    expect(JSON.stringify(rows)).not.toContain('PLANTED')
    expect(JSON.stringify(rows)).not.toContain('planted')
    expect(configRowAdmissible(row)).toBe(true)
  })

  it('a config with no engines still sends an empty engines row, so a reader knows nothing was set', () => {
    const row = configCopyRows({ version: 1 }).rows.find((r) => r.key === 'engines')!
    expect(row.value).toEqual({})
    expect(configRowAdmissible(row)).toBe(true)
  })

  it('a provider holding a credential is withheld, and marked so the reader refuses rather than guess', () => {
    const { rows, refused } = configCopyRows({
      engines: { codex: { provider: { base_url: 'https://user:hunter2-secret@llm.example.com/v1' } }, goose: { model: 'm' } },
    })
    expect(refused.map((r) => r.key)).toEqual(['engines'])
    const row = rows.find((r) => r.key === 'engines')!
    expect(row.value).toEqual({ codex: { provider: { withheld: true } }, goose: { model: 'm' } })
    expect(JSON.stringify(row)).not.toContain('hunter2')
    expect(configRowAdmissible(row)).toBe(true)
  })
})

describe('withCopiedEngines', () => {
  const own = { engines: { codex: { env: { WALNUT_CODEX_PATH: '/opt/codex' }, provider: { base_url: 'http://stale.invalid/v1' } } }, session: { codex_default_mode: 'agent' } }

  it('no copy yet, or a Mac too old to copy engines: refused, never the host default', () => {
    expect(() => withCopiedEngines(own, null)).toThrow(CodexEngineConfigError)
    expect(() => withCopiedEngines(own, { hosts: {} })).toThrow(/older/)
  })

  it('the Mac\'s provider, model and effort over this server\'s own env and settings', () => {
    const merged = withCopiedEngines(own, { engines: { codex: { provider: PROVIDER, effort: 'high' } } })
    expect(merged).toEqual({
      engines: { codex: { env: { WALNUT_CODEX_PATH: '/opt/codex' }, provider: PROVIDER, effort: 'high' } },
      session: { codex_default_mode: 'agent' },
    })
    // The Mac set no provider: none here either, even if this server's own file has one.
    expect((withCopiedEngines(own, { engines: {} }).engines as Record<string, Record<string, unknown>>).codex.provider).toBeUndefined()
  })

  it('a withheld provider refuses the start with the reason', () => {
    const merged = withCopiedEngines(own, { engines: { codex: { provider: { withheld: true } } } })
    expect(() => resolveCodexEngine(merged, undefined)).toThrow(/credential/)
  })
})

describe('a Codex start off the Mac', () => {
  async function establish() {
    const session = new AcpSession({ taskId: '', project: '', cwd: '/tmp', mode: 'default', engine: 'codex', host: 'devbox', artifacts: { workerCmd: ['worker'], adapterCmd: ['adapter'] } })
    const send = vi.fn(async (command: string) => command === 'acpStart'
      ? { ok: true, session: { sessionId: `thread-${Math.random().toString(36).slice(2)}` }, journalPath: '/tmp/x.acp.jsonl' }
      : { ok: true })
    Object.assign(session as object, { conn: { connected: true, send } })
    const result = await session.establish().then(() => null, (e: unknown) => e)
    const start = send.mock.calls.find((c) => c[0] === 'acpStart')?.[1] as { env?: Record<string, string> } | undefined
    return { error: result, env: start?.env }
  }

  it('refuses when this server holds no copy of the Mac\'s settings, and sends nothing to the host', async () => {
    place = 'cloud'
    const { error, env } = await establish()
    expect(error).toBeInstanceOf(CodexEngineConfigError)
    expect(env).toBeUndefined()
  })

  it('carries the Mac\'s provider from the copy, though this server\'s own file has none', async () => {
    place = 'cloud'
    await updateConfig({ engines: { codex: { env: { CODEX_CONFIG: '{"model_context_window":1000000}' } } } } as never)
    copy = { engines: { codex: { provider: PROVIDER, model: 'gpt-example' } } }
    const { error, env } = await establish()
    expect(error).toBeNull()
    expect(JSON.parse(env!.CODEX_CONFIG)).toMatchObject({ model_provider: 'my-proxy', model: 'vendor.gpt-example', model_context_window: 1000000 })
    expect(env!.WALNUT_CODEX_MODEL_PREFIX).toBe('vendor.')
  })

  it('on the Mac its own config is read, as before', async () => {
    await updateConfig({ engines: { codex: { provider: PROVIDER } } } as never)
    const { error, env } = await establish()
    expect(error).toBeNull()
    expect(JSON.parse(env!.CODEX_CONFIG)).toMatchObject({ model_provider: 'my-proxy' })
  })
})
