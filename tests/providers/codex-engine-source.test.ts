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
  isHostReplica: () => place === 'host',
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
import { _resetCodexSourceNotesForTesting, codexWalnutConfig, withCopiedEngines } from '../../src/providers/codex-engine-source.js'
import { setRevokedHostResolver } from '../../src/core/session-channel/revoked-hosts.js'

const PROVIDER = { base_url: 'http://llm.example.test:9000/v1', name: 'my-proxy', model_prefix: 'vendor.', env_key: 'MY_PROXY_KEY' }

const LOOPBACK = { base_url: 'http://127.0.0.1:8402/openai/v1', name: 'local-proxy' }
const HOST_OWN = { base_url: 'http://127.0.0.1:18402/v1', name: 'host-relay' }

beforeEach(async () => {
  place = 'mac'
  copy = null
  _resetCodexSourceNotesForTesting()
  _resetForTesting()
  _resetSessionTrackerForTesting()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
})
afterEach(() => {
  vi.restoreAllMocks()
  setRevokedHostResolver(null)
})

/** The leader's links: each group of keys reaches one live daemon process (`__local__` is this machine's). */
function linksReach(...groups: string[][]): void {
  setRevokedHostResolver({
    machineOf: () => null,
    aliasesOf: () => [],
    sameDaemonNow: (key) => groups.find((g) => g.includes(key))?.filter((k) => k !== key) ?? [],
  })
}
const codexOf = (config: Record<string, unknown>) => ((config.engines as Record<string, Record<string, unknown>> | undefined)?.codex ?? {})

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

describe('the copy carries each host\'s own provider and never the leader\'s loopback one', () => {
  it('a loopback global provider is left out of the engines row; the rest of engines.codex stays', () => {
    const { rows } = configCopyRows({ engines: { codex: { provider: LOOPBACK, model: 'gpt-example' }, goose: { model: 'm' } } })
    const row = rows.find((r) => r.key === 'engines')!
    expect(row.value).toEqual({ codex: { model: 'gpt-example' }, goose: { model: 'm' } })
    expect(configRowAdmissible(row)).toBe(true)
  })

  it('hosts.<name>.engines rides its own copy-only row; the hosts row is as an older replica admits it', () => {
    const { rows } = configCopyRows({ hosts: { devbox: { hostname: 'devbox', engines: { codex: { provider: HOST_OWN } } }, plain: { hostname: 'plain' } } })
    const hostsRow = rows.find((r) => r.key === 'hosts')!
    expect(hostsRow.value).toEqual({ devbox: { hostname: 'devbox' }, plain: { hostname: 'plain' } })
    expect(configRowAdmissible(hostsRow)).toBe(true)
    const own = rows.find((r) => r.key === 'host_engines')!
    expect(own.value).toEqual({ devbox: { codex: { provider: HOST_OWN } } })
    expect(configRowAdmissible(own)).toBe(true)
    // No host sets one: no row.
    expect(configCopyRows({ hosts: { plain: { hostname: 'plain' } } }).rows.some((r) => r.key === 'host_engines')).toBe(false)
  })

  it('a host\'s provider written under another name of its machine reaches the copy under each name', () => {
    const config = { hosts: { 'devbox-ssh': { hostname: 'devbox', engines: { codex: { provider: HOST_OWN } } }, devbox: { hostname: 'devbox.walnut-net.invalid' }, other: { hostname: 'other' } } }
    const aliasesOf = (k: string) => (k === 'devbox' ? ['devbox-ssh'] : k === 'devbox-ssh' ? ['devbox'] : [])
    const row = configCopyRows(config, { aliasesOf }).rows.find((r) => r.key === 'host_engines')!
    expect(row.value).toEqual({ 'devbox-ssh': { codex: { provider: HOST_OWN } }, devbox: { codex: { provider: HOST_OWN } } })
    expect(configRowAdmissible(row)).toBe(true)
    // Without the tie only the key it was written under.
    expect(configCopyRows(config).rows.find((r) => r.key === 'host_engines')!.value).toEqual({ 'devbox-ssh': { codex: { provider: HOST_OWN } } })
  })

  it('a host provider holding a credential is withheld for that host only', () => {
    const { rows } = configCopyRows({ hosts: {
      a: { hostname: 'a', engines: { codex: { provider: { base_url: 'https://user:hunter2-secret@llm.example.com/v1' } } } },
      b: { hostname: 'b', engines: { codex: { provider: HOST_OWN } } },
    } })
    const row = rows.find((r) => r.key === 'host_engines')!
    expect(row.value).toEqual({ a: { codex: { provider: { withheld: true } } }, b: { codex: { provider: HOST_OWN } } })
    expect(JSON.stringify(rows)).not.toContain('hunter2')
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

  it('a host\'s server running Codex itself: the leader\'s loopback provider (an older leader\'s copy) is not used there', async () => {
    place = 'host'
    const saved = process.env.WALNUT_HOST_KEY
    process.env.WALNUT_HOST_KEY = 'devbox'
    try {
      copy = { engines: { codex: { provider: LOOPBACK, model: 'gpt-example' } } }
      const config = await codexWalnutConfig({ host: '__local__' })
      expect((config.engines as Record<string, Record<string, unknown>>).codex).toEqual({ model: 'gpt-example' })
      // Its own provider from the leader's copy (host_engines) wins.
      copy = { engines: { codex: { provider: LOOPBACK } }, host_engines: { devbox: { codex: { provider: HOST_OWN } } } }
      const own = await codexWalnutConfig({ host: undefined })
      expect((own.engines as Record<string, Record<string, unknown>>).codex.provider).toEqual(HOST_OWN)
      // Another host's provider is not this one's.
      copy = { engines: { codex: { provider: PROVIDER } }, host_engines: { other: { codex: { provider: HOST_OWN } } } }
      expect(((await codexWalnutConfig({ host: undefined })).engines as Record<string, Record<string, unknown>>).codex.provider).toEqual(PROVIDER)
    } finally {
      if (saved === undefined) delete process.env.WALNUT_HOST_KEY
      else process.env.WALNUT_HOST_KEY = saved
    }
  })

  it('on the leader, a host\'s provider is found under another name of the same machine (one live daemon)', async () => {
    await updateConfig({ engines: { codex: { provider: LOOPBACK } }, hosts: { 'devbox-ssh': { hostname: 'devbox', engines: { codex: { provider: HOST_OWN } } }, devbox: { hostname: 'devbox.example.com' } } } as never)
    linksReach(['devbox', 'devbox-ssh'])
    expect(codexOf(await codexWalnutConfig({ host: 'devbox' })).provider).toEqual(HOST_OWN)
    // A name of another machine does not take it.
    linksReach(['devbox'], ['devbox-ssh'])
    expect(codexOf(await codexWalnutConfig({ host: 'devbox' })).provider).toBeUndefined()
  })

  it('on the leader, a host entry that reaches this machine\'s own daemon is this machine: the loopback provider applies', async () => {
    await updateConfig({ engines: { codex: { provider: LOOPBACK } }, hosts: { 'mac-alias': { hostname: 'mac.example.com' }, devbox: { hostname: 'devbox.example.com' } } } as never)
    linksReach(['__local__', 'mac-alias'])
    expect(codexOf(await codexWalnutConfig({ host: 'mac-alias' })).provider).toEqual(LOOPBACK)
    expect(codexOf(await codexWalnutConfig({ host: 'devbox' })).provider).toBeUndefined()
    // Only the live tie counts: without it the alias is another machine.
    setRevokedHostResolver(null)
    expect(codexOf(await codexWalnutConfig({ host: 'mac-alias' })).provider).toBeUndefined()
  })

  it('on the Mac its own config is read, as before', async () => {
    await updateConfig({ engines: { codex: { provider: PROVIDER } } } as never)
    const { error, env } = await establish()
    expect(error).toBeNull()
    expect(JSON.parse(env!.CODEX_CONFIG)).toMatchObject({ model_provider: 'my-proxy' })
  })
})
