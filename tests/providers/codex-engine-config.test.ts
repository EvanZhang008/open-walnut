/**
 * engines.codex (provider, default model and effort) reaches every Codex spawn
 * through resolveCodexAdapterConfig: a start on this machine, a start on another
 * host, and the codex-acp adapter's own app-server command line. Real functions
 * and a real AcpSession; only the daemon connection and the codex binary are fakes.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-codex-engine-config'))

import { WALNUT_HOME } from '../../src/constants.js'
import { _resetSessionTrackerForTesting } from '../../src/core/session-tracker.js'
import { _resetForTesting } from '../../src/core/task-manager.js'
import { updateConfig } from '../../src/core/config-manager.js'
import { AcpSession } from '../../src/providers/acp-session.js'
import {
  CodexEngineConfigError,
  codexPickForProvider,
  mapCodexCatalog,
  readCodexEngineSettings,
  resolveCodexAdapterConfig,
  resolveCodexEngine,
} from '../../src/providers/codex-engine-config.js'
import { guardedPath } from '../setup/exec-guard.js'

const ARTIFACTS = { workerCmd: ['worker'], adapterCmd: ['adapter'] }
const PROXY = { base_url: 'http://127.0.0.1:9000/v1', name: 'my-proxy' }
const OVERRIDE = {
  model_provider: 'my-proxy',
  model_providers: { 'my-proxy': { name: 'my-proxy', base_url: 'http://127.0.0.1:9000/v1', wire_api: 'responses', requires_openai_auth: false } },
}

beforeEach(async () => {
  _resetForTesting()
  _resetSessionTrackerForTesting()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
})

afterEach(() => {
  vi.restoreAllMocks()
})

/** Establish a codex session against a fake daemon and return the env acpStart carried. */
async function startEnv(options: { host?: string; acpConfig?: Record<string, string> } = {}): Promise<Record<string, string>> {
  const session = new AcpSession({
    taskId: '', project: '', cwd: '/tmp', mode: 'default', engine: 'codex',
    runtimeId: `acp-codex-${Math.random().toString(36).slice(2)}`, artifacts: ARTIFACTS,
    ...(options.host ? { host: options.host } : {}),
    ...(options.acpConfig ? { acpConfig: options.acpConfig } : {}),
  })
  const send = vi.fn(async (command: string) => command === 'acpStart'
    ? { ok: true, session: { sessionId: `thread-${Math.random().toString(36).slice(2)}` }, journalPath: '/tmp/x.acp.jsonl' }
    : { ok: true })
  Object.assign(session as object, { conn: { connected: true, send } })
  await session.establish()
  const start = send.mock.calls.find((call) => call[0] === 'acpStart')?.[1] as { env?: Record<string, string> }
  return start.env ?? {}
}

const codexConfigOf = (env: Record<string, string>) => (env.CODEX_CONFIG ? JSON.parse(env.CODEX_CONFIG) as Record<string, unknown> : undefined)

describe('resolveCodexAdapterConfig', () => {
  it('no engines.codex settings: a generic install gets no override, and an old CODEX_CONFIG passes through unchanged', () => {
    expect(resolveCodexAdapterConfig({}, undefined)).toBeUndefined()
    expect(resolveCodexAdapterConfig({ engines: { codex: { env: {} } } }, undefined)).toBeUndefined()
    const old = { ...OVERRIDE, model_context_window: 1000000 }
    expect(resolveCodexAdapterConfig({ engines: { codex: { env: { CODEX_CONFIG: JSON.stringify(old) } } } }, JSON.stringify(old))).toEqual(old)
    // A pick never rides the thread config without a provider: the adapter's own switch applies it.
    expect(resolveCodexAdapterConfig({}, undefined, { pick: { model: 'gpt-example' } })).toBeUndefined()
  })

  it('a provider becomes model_provider and its model_providers entry', () => {
    expect(resolveCodexAdapterConfig({ engines: { codex: { provider: PROXY } } }, undefined)).toEqual(OVERRIDE)
    const keyed = resolveCodexAdapterConfig({ engines: { codex: { provider: { base_url: 'https://llm.example.com/v1', env_key: 'MY_PROXY_KEY', wire_api: 'chat' } } } }, undefined)
    expect(keyed).toEqual({
      model_provider: 'walnut-provider',
      model_providers: { 'walnut-provider': { name: 'walnut-provider', base_url: 'https://llm.example.com/v1', wire_api: 'chat', env_key: 'MY_PROXY_KEY' } },
    })
  })

  it('explicit CODEX_CONFIG keys win, other providers and keys are kept', () => {
    const explicit = {
      model_provider: 'old-proxy',
      model_context_window: 1000000,
      model_providers: { 'old-proxy': { base_url: 'http://127.0.0.1:9001/v1' }, 'my-proxy': { base_url: 'http://127.0.0.1:9002/v1' } },
    }
    const merged = resolveCodexAdapterConfig({ engines: { codex: { provider: PROXY, model: 'gpt-example' } } }, JSON.stringify(explicit))
    expect(merged).toEqual({
      model_provider: 'old-proxy',
      model: 'gpt-example',
      model_context_window: 1000000,
      model_providers: { 'old-proxy': { base_url: 'http://127.0.0.1:9001/v1' }, 'my-proxy': { base_url: 'http://127.0.0.1:9002/v1' } },
    })
  })

  it('default model and effort apply only when the session names none', () => {
    const config = { engines: { codex: { model: 'gpt-example', effort: 'xhigh' } } }
    expect(resolveCodexAdapterConfig(config, undefined)).toEqual({ model: 'gpt-example', model_reasoning_effort: 'xhigh' })
    // A qualified default carries its effort.
    expect(resolveCodexAdapterConfig({ engines: { codex: { model: 'gpt-example[high]' } } }, undefined)).toEqual({ model: 'gpt-example', model_reasoning_effort: 'high' })
    // With a provider, a session's own pick replaces the default on the thread.
    const withProvider = { engines: { codex: { provider: PROXY, model: 'gpt-example', effort: 'xhigh' } } }
    expect(resolveCodexAdapterConfig(withProvider, undefined, { pick: { model: 'gpt-other', reasoning_effort: 'low' } }))
      .toMatchObject({ model: 'gpt-other', model_reasoning_effort: 'low' })
    expect(resolveCodexAdapterConfig(withProvider, undefined, { pick: { model: 'gpt-other[medium]' } }))
      .toMatchObject({ model: 'gpt-other', model_reasoning_effort: 'medium' })
    expect(resolveCodexAdapterConfig(withProvider, undefined, { pick: undefined }))
      .toMatchObject({ model: 'gpt-example', model_reasoning_effort: 'xhigh' })
  })

  it('a model_prefix maps bare ids, and leaves prefixed ones', () => {
    const config = { engines: { codex: { provider: { ...PROXY, model_prefix: 'vendor.' }, model: 'gpt-example' } } }
    expect(resolveCodexAdapterConfig(config, undefined)).toMatchObject({ model: 'vendor.gpt-example' })
    const { settings } = resolveCodexEngine(config, undefined)
    expect(codexPickForProvider({ model: 'gpt-other[xhigh]' }, settings)).toEqual({ model: 'vendor.gpt-other', reasoning_effort: 'xhigh' })
    expect(codexPickForProvider({ model: 'vendor.gpt-other' }, settings)).toEqual({ model: 'vendor.gpt-other' })
  })

  it('the prefix follows the provider the thread goes to', () => {
    const prefixed = { ...PROXY, model_prefix: 'vendor.' }
    // A bare model the user's CODEX_CONFIG names, sent to this provider, gets its prefix.
    expect(resolveCodexAdapterConfig({ engines: { codex: { provider: prefixed } } }, JSON.stringify({ model: 'gpt-x' })))
      .toMatchObject({ model_provider: 'my-proxy', model: 'vendor.gpt-x' })
    // A CODEX_CONFIG that routes to another provider: that provider's ids, no prefix on the model or a pick.
    const other = JSON.stringify({ model_provider: 'other', model: 'gpt-x' })
    const config = { engines: { codex: { provider: prefixed, env: { CODEX_CONFIG: other } } } }
    expect(resolveCodexAdapterConfig(config, other, { pick: { model: 'gpt-y' } })).toMatchObject({ model_provider: 'other', model: 'gpt-y' })
    expect(codexPickForProvider({ model: 'gpt-y' }, resolveCodexEngine(config, other).settings)).toEqual({ model: 'gpt-y' })
  })

  it('one effective provider drives every use of the prefix, wherever the routing CODEX_CONFIG comes from', () => {
    // This server's own env selects provider `other` (engines.codex.env holds no CODEX_CONFIG).
    const config = { engines: { codex: { provider: { ...PROXY, model_prefix: 'vendor.' }, model: 'gpt-x' } } }
    const other = JSON.stringify({ model_provider: 'other', model_providers: { other: { base_url: 'http://127.0.0.1:9003/v1' } } })
    const r = resolveCodexEngine(config, other, { pick: { model: 'gpt-y' } })
    expect(r.prefix).toBeUndefined()
    expect(r.baseConfig).toMatchObject({ model_provider: 'other', model: 'gpt-y' })
    expect(r.settings.provider?.model_prefix).toBeUndefined()
    // The menu and the replay read the same settings: no prefix for `other`.
    const menu = { models: [{ modelId: 'gpt-y[low]', name: 'Y' }], currentModelId: 'gpt-y[low]' }
    expect(mapCodexCatalog(menu, r.settings)).toBe(menu)
    expect(codexPickForProvider({ model: 'gpt-y' }, r.settings)).toEqual({ model: 'gpt-y' })
    // Without the routing CODEX_CONFIG everything takes the prefix.
    const ours = resolveCodexEngine(config, undefined, { pick: { model: 'gpt-y' } })
    expect([ours.prefix, ours.baseConfig?.model]).toEqual(['vendor.', 'vendor.gpt-y'])
    expect(resolveCodexEngine(config, undefined).baseConfig?.model).toBe('vendor.gpt-x')
  })

  it('a wrong setting fails loudly instead of routing to another provider', () => {
    const bad = (provider: unknown) => () => resolveCodexAdapterConfig({ engines: { codex: { provider } } }, undefined)
    expect(bad({})).toThrow(CodexEngineConfigError)
    expect(bad({ base_url: 'ftp://x' })).toThrow(/http/)
    expect(bad({ base_url: 'http://x/v1', name: 'my proxy' })).toThrow(/name/)
    expect(bad({ base_url: 'http://x/v1', name: 'openai' })).toThrow(/built-in/)
    expect(bad({ base_url: 'http://x/v1', wire_api: 'grpc' })).toThrow(/wire_api/)
    expect(bad({ base_url: 'http://x/v1', env_key: 'sk-not-a-name' })).toThrow(/NAME/)
    expect(() => resolveCodexAdapterConfig({ engines: { codex: { effort: 'Very High' } } }, undefined)).toThrow(/effort/)
  })
})

describe('mapCodexCatalog: the menu offers the ids the endpoint answers to', () => {
  const catalog = {
    models: [
      { modelId: 'gpt-example[low]', name: 'GPT Example (low)' },
      { modelId: 'gpt-example[xhigh]', name: 'GPT Example (xhigh)' },
      { modelId: 'vendor.gpt-example[low]', name: 'GPT Example (low)' },
    ],
    currentModelId: 'gpt-example[xhigh]',
  }
  it('prefixes bare ids, drops the duplicates that makes, and keeps names', () => {
    const mapped = mapCodexCatalog(catalog, resolveCodexEngine({ engines: { codex: { provider: { ...PROXY, model_prefix: 'vendor.' } } } }, undefined).settings)
    expect(mapped.models).toEqual([
      { modelId: 'vendor.gpt-example[low]', name: 'GPT Example (low)' },
      { modelId: 'vendor.gpt-example[xhigh]', name: 'GPT Example (xhigh)' },
    ])
    expect(mapped.currentModelId).toBe('vendor.gpt-example[xhigh]')
  })
  it('without a prefix the catalog is untouched', () => {
    expect(mapCodexCatalog(catalog, readCodexEngineSettings({ engines: { codex: { provider: PROXY } } }))).toBe(catalog)
    expect(mapCodexCatalog(catalog, {})).toBe(catalog)
  })
})

describe('AcpSession: every Codex start carries the provider', () => {
  it('a start on this machine carries it in CODEX_CONFIG', async () => {
    await updateConfig({ engines: { codex: { provider: PROXY } } } as never)
    expect(codexConfigOf(await startEnv())).toMatchObject(OVERRIDE)
  })

  it('a start on another host carries it too (the server builds the env and sends it with acpStart)', async () => {
    await updateConfig({ engines: { codex: { provider: PROXY } } } as never)
    const env = await startEnv({ host: 'devbox' })
    expect(codexConfigOf(env)).toMatchObject(OVERRIDE)
    // This machine's paths stay home; the provider is not one of them.
    expect(env.CODEX_PATH).toBeUndefined()
  })

  it('no provider configured: the start carries no provider override', async () => {
    for (const host of [undefined, 'devbox']) {
      const env = await startEnv({ host })
      expect(env.WALNUT_CODEX_MODEL_PREFIX).toBeUndefined()
      const config = codexConfigOf(env)
      expect(config?.model_provider).toBeUndefined()
      expect(config?.model_providers).toBeUndefined()
    }
  })

  it('an old CODEX_CONFIG-only config reaches both starts unchanged', async () => {
    const old = { ...OVERRIDE, model_context_window: 1000000 }
    await updateConfig({ engines: { codex: { env: { CODEX_CONFIG: JSON.stringify(old), MODEL_PROVIDER: 'my-proxy' } } } } as never)
    for (const host of [undefined, 'devbox']) {
      const env = await startEnv({ host })
      expect(codexConfigOf(env)).toMatchObject(old)
      expect(env.MODEL_PROVIDER).toBe('my-proxy')
    }
  })

  it('default model and effort ride a start that names none; a pick wins and gets the endpoint prefix', async () => {
    await updateConfig({ engines: { codex: { provider: { ...PROXY, model_prefix: 'vendor.' }, model: 'gpt-example', effort: 'xhigh' } } } as never)
    const local = await startEnv()
    expect(codexConfigOf(local)).toMatchObject({ model: 'vendor.gpt-example', model_reasoning_effort: 'xhigh' })
    // The patched adapter builds Codex a catalog under the prefixed ids from this.
    expect(local.WALNUT_CODEX_MODEL_PREFIX).toBe('vendor.')
    expect((await startEnv({ host: 'devbox' })).WALNUT_CODEX_MODEL_PREFIX).toBe('vendor.')
    // A bare pick (the id codex lists, which on this endpoint starts a session with no tools)
    // reaches the adapter as the prefixed id, here and on another host.
    for (const host of [undefined, 'devbox']) {
      const config = codexConfigOf(await startEnv({ host, acpConfig: { model: 'gpt-other', reasoning_effort: 'low' } }))
      expect(config).toMatchObject({ model: 'vendor.gpt-other', model_reasoning_effort: 'low', model_provider: 'my-proxy' })
    }
  })

  it('a CODEX_CONFIG in this server\'s own env that routes elsewhere turns the prefix off for the start', async () => {
    await updateConfig({ engines: { codex: { provider: { ...PROXY, model_prefix: 'vendor.' } } } } as never)
    const saved = process.env.CODEX_CONFIG
    process.env.CODEX_CONFIG = JSON.stringify({ model_provider: 'other', model_providers: { other: { base_url: 'http://127.0.0.1:9003/v1' } } })
    try {
      const env = await startEnv({ acpConfig: { model: 'gpt-y' } })
      expect(env.WALNUT_CODEX_MODEL_PREFIX).toBeUndefined()
      expect(codexConfigOf(env)).toMatchObject({ model_provider: 'other', model: 'gpt-y' })
    } finally {
      if (saved === undefined) delete process.env.CODEX_CONFIG
      else process.env.CODEX_CONFIG = saved
    }
  })

  it('a stored bare pick is replayed as the id the thread started on, never switched back to the bare one', async () => {
    await updateConfig({ engines: { codex: { provider: { ...PROXY, model_prefix: 'vendor.' } } } } as never)
    const session = new AcpSession({ taskId: '', project: '', cwd: '/tmp', mode: 'default', engine: 'codex', artifacts: ARTIFACTS })
    const asStarted = (session as unknown as { codexPickAsStarted(s: Record<string, string>): Promise<Record<string, string>> }).codexPickAsStarted.bind(session)
    expect(await asStarted({ model: 'gpt-other', mode: 'agent' })).toEqual({ model: 'vendor.gpt-other', mode: 'agent' })
    expect(await asStarted({ mode: 'agent' })).toEqual({ mode: 'agent' })
  })
})

describe('a running session never switches onto an id that has no tools on the endpoint', () => {
  it('with a model_prefix, a bare pick codex lists is refused instead of switched to', async () => {
    await updateConfig({ engines: { codex: { provider: { ...PROXY, model_prefix: 'vendor.' } } } } as never)
    const session = new AcpSession({ taskId: '', project: '', cwd: '/tmp', mode: 'default', engine: 'codex', artifacts: ARTIFACTS })
    Object.assign(session as object, { _configOptions: [{ id: 'model', currentValue: 'gpt-x', options: [{ value: 'gpt-x' }, { value: 'gpt-y' }] }] })
    const setOption = vi.spyOn(session, 'setConfigOption').mockResolvedValue(true)
    expect(await session.setModel('gpt-y[high]')).toBe(false)
    expect(setOption).not.toHaveBeenCalled()
  })

  it('without a provider the switch goes through as before', async () => {
    const session = new AcpSession({ taskId: '', project: '', cwd: '/tmp', mode: 'default', engine: 'codex', artifacts: ARTIFACTS })
    Object.assign(session as object, { _configOptions: [{ id: 'model', currentValue: 'gpt-x', options: [{ value: 'gpt-x' }, { value: 'gpt-y' }] }] })
    const setOption = vi.spyOn(session, 'setConfigOption').mockResolvedValue(true)
    expect(await session.setModel('gpt-y[high]')).toBe(true)
    expect(setOption.mock.calls.map((c) => c.slice(0, 2))).toEqual([['model', 'gpt-y'], ['reasoning_effort', 'high']])
  })
})

describe('codex-acp puts the override on the app-server command line', () => {
  const adapterEntry = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../node_modules/@agentclientprotocol/codex-acp/dist/index.js')
  let dir: string
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-acp-argv-')) })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  /** Run the real adapter against a stand-in codex; returns each codex argv (the app-server's last), its log and exit. */
  async function runAdapterFull(codexConfig: unknown, extraEnv: Record<string, string> = {}, opts: { configToml?: string; listFails?: boolean } = {}) {
    // A home whose config.toml names another provider, as a managed one would.
    const home = path.join(dir, 'home')
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true })
    fs.writeFileSync(path.join(home, '.codex', 'config.toml'), opts.configToml ?? 'model_provider = "managed"\n[model_providers.managed]\nbase_url = "https://managed.invalid/v1"\n')
    // A stand-in codex: logs its argv; `debug models` prints a catalog, `app-server` reads stdin until it closes.
    const log = path.join(dir, 'argv.jsonl')
    const logs = path.join(dir, 'logs')
    fs.rmSync(log, { force: true })
    fs.rmSync(logs, { recursive: true, force: true })
    const catalog = { models: [
      { slug: 'gpt-example', display_name: 'GPT Example', tool_mode: 'code_mode_only', use_responses_lite: true, apply_patch_tool_type: 'freeform', context_window: 272000, priority: 2, visibility: 'list' },
      { slug: 'vendor.gpt-other', display_name: 'GPT Other', priority: 1, visibility: 'list' },
      { slug: 'gpt-hidden', display_name: 'Hidden', priority: 0, visibility: 'hide' },
    ] }
    const codex = path.join(dir, 'codex')
    fs.writeFileSync(codex, `#!${process.execPath}
const fs = require('fs'); const argv = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(argv) + '\\n')
if (argv.slice(-2).join(' ') === 'debug models') { if (${opts.listFails ? 'true' : 'false'}) process.exit(2); process.stdout.write(${JSON.stringify(JSON.stringify(catalog))}); process.exit(0) }
process.stdin.resume(); process.stdin.on('end', () => process.exit(0))
`, { mode: 0o755 })
    let stderr = ''
    const adapter = spawn(process.execPath, [adapterEntry], {
      env: { PATH: guardedPath([], '/usr/bin:/bin'), HOME: home, TMPDIR: dir, APP_SERVER_LOGS: logs, CODEX_PATH: codex, CODEX_CONFIG: JSON.stringify(codexConfig), ...extraEnv },
      stdio: ['pipe', 'ignore', 'pipe'],
    })
    adapter.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    let exitCode: number | null = null
    const exited = new Promise<void>((resolve) => adapter.once('exit', (code) => { exitCode = code; resolve() }))
    const read = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[]) : [])
    try {
      const until = Date.now() + 15_000
      while (!read().some((a) => a.at(-1) === 'app-server') && exitCode === null && Date.now() < until) await new Promise((r) => setTimeout(r, 50))
    } finally {
      adapter.stdin.end()
      await Promise.race([exited, new Promise<void>((resolve) => setTimeout(() => { adapter.kill('SIGTERM'); resolve() }, 5_000))])
    }
    const appLog = fs.existsSync(path.join(logs, 'app-server.log')) ? fs.readFileSync(path.join(logs, 'app-server.log'), 'utf8') : ''
    return { runs: read(), exitCode, stderr, appLog }
  }
  const runAdapter = async (codexConfig: unknown, extraEnv: Record<string, string> = {}) => (await runAdapterFull(codexConfig, extraEnv)).runs
  /** The model the adapter put on its thread config, from its own log line. */
  const prefixedModelOf = (appLog: string) => /Walnut model for the prefixed provider \{"model":"([^"]+)"\}/.exec(appLog)?.[1]
  const appServer = (runs: string[][]) => runs.find((a) => a.at(-1) === 'app-server')!

  it('model_provider and model_providers.<id> reach codex as -c overrides, which rank above ~/.codex/config.toml', async () => {
    const argv = appServer(await runAdapter(resolveCodexAdapterConfig({ engines: { codex: { provider: { ...PROXY, env_key: 'MY_PROXY_KEY' } } } }, undefined)))
    expect(argv).toContain('model_provider="my-proxy"')
    expect(argv.find((a) => a.startsWith('model_providers.my-proxy='))).toContain('base_url = "http://127.0.0.1:9000/v1"')
    expect(argv.find((a) => a.startsWith('model_providers.my-proxy='))).toContain('env_key = "MY_PROXY_KEY"')
    // No prefix and no catalog named: Codex's own catalog, untouched.
    expect(argv.some((a) => a.startsWith('model_catalog_json='))).toBe(false)
  }, 30_000)

  it('WALNUT_CODEX_CATALOG_DIR names where the catalog lives', async () => {
    const place = path.join(dir, 'catalogs')
    const argv = appServer(await runAdapter(resolveCodexAdapterConfig({ engines: { codex: { provider: { ...PROXY, model_prefix: 'vendor.' } } } }, undefined), { WALNUT_CODEX_MODEL_PREFIX: 'vendor.', WALNUT_CODEX_CATALOG_DIR: place }))
    const file = JSON.parse(argv.find((a) => a.startsWith('model_catalog_json='))!.slice('model_catalog_json='.length)) as string
    expect(path.dirname(file)).toBe(place)
    expect(fs.existsSync(file)).toBe(true)
  }, 30_000)

  it('with a model prefix, Codex gets a catalog of its own models under the prefixed ids, so no fallback metadata', async () => {
    const runs = await runAdapter(resolveCodexAdapterConfig({ engines: { codex: { provider: { ...PROXY, model_prefix: 'vendor.' } } } }, undefined), { WALNUT_CODEX_MODEL_PREFIX: 'vendor.' })
    // The catalog is read through the same provider the sessions use.
    const listing = runs.find((a) => a.slice(-2).join(' ') === 'debug models')!
    expect(listing).toContain('model_provider="my-proxy"')
    const argv = appServer(runs)
    const arg = argv.find((a) => a.startsWith('model_catalog_json='))!
    const file = JSON.parse(arg.slice('model_catalog_json='.length)) as string
    // A state dir, never the OS temp dir: the app-server rereads it on every turn, and macOS
    // purges its temp dir (2026-11-10: every Codex turn failed "failed to load configuration").
    expect(path.dirname(fs.realpathSync(file))).toBe(fs.realpathSync(path.join(dir, 'home', '.local', 'state', 'open-walnut', 'codex-models')))
    const written = JSON.parse(fs.readFileSync(file, 'utf8')) as { models: Array<Record<string, unknown>> }
    expect(written.models.map((m) => m.slug)).toEqual(['vendor.gpt-example', 'vendor.gpt-other', 'vendor.gpt-hidden'])
    // Tools sent as tools (no tool mode, no responses-lite), the rest of the metadata kept.
    expect(written.models[0]).toMatchObject({ use_responses_lite: false, apply_patch_tool_type: 'freeform', context_window: 272000 })
    expect(written.models[0]).not.toHaveProperty('tool_mode')
    // It was tried on this Codex before use: a catalog it cannot read would end its app-server.
    expect(runs.filter((a) => a.slice(-2).join(' ') === 'debug models').some((a) => a.some((x) => x.startsWith('model_catalog_json=')))).toBe(true)
  }, 30_000)

  it('a prefix with no model named takes the host config.toml model, prefixed, so a plain host model never stays', async () => {
    const config = resolveCodexAdapterConfig({ engines: { codex: { provider: { ...PROXY, model_prefix: 'vendor.' } } } }, undefined)
    expect(config).not.toHaveProperty('model')
    const fromToml = await runAdapterFull(config, { WALNUT_CODEX_MODEL_PREFIX: 'vendor.' }, { configToml: 'model = "gpt-example"\nmodel_provider = "managed"\n[model_providers.managed]\nbase_url = "https://managed.invalid/v1"\n' })
    expect(prefixedModelOf(fromToml.appLog)).toBe('vendor.gpt-example')
    // No model in config.toml: the catalog's first listed model (by priority, hidden ones skipped).
    const fromCatalog = await runAdapterFull(config, { WALNUT_CODEX_MODEL_PREFIX: 'vendor.' })
    expect(prefixedModelOf(fromCatalog.appLog)).toBe('vendor.gpt-other')
    // A model the start names is left alone.
    const named = await runAdapterFull({ ...(config as object), model: 'vendor.gpt-x' }, { WALNUT_CODEX_MODEL_PREFIX: 'vendor.' })
    expect(prefixedModelOf(named.appLog)).toBeUndefined()
  }, 60_000)

  it('a prefix with no model to be found stops the adapter with the reason, before any app-server', async () => {
    const config = resolveCodexAdapterConfig({ engines: { codex: { provider: { ...PROXY, model_prefix: 'vendor.' } } } }, undefined)
    const run = await runAdapterFull(config, { WALNUT_CODEX_MODEL_PREFIX: 'vendor.' }, { listFails: true })
    expect(run.exitCode).toBe(1)
    expect(run.stderr).toContain('engines.codex.model')
    expect(run.runs.some((a) => a.at(-1) === 'app-server')).toBe(false)
  }, 30_000)

  it('a catalog CODEX_CONFIG names goes on the command line, the one place Codex reads it', async () => {
    const argv = appServer(await runAdapter({ ...OVERRIDE, model_catalog_json: '/opt/catalog.json' }))
    expect(argv).toContain('model_catalog_json="/opt/catalog.json"')
  }, 30_000)
})
