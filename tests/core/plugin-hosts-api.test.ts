/**
 * The additions to `walnut.hosts` as a plugin sees them (src/core/plugins/server-api.ts,
 * plugin-hosts.ts): the manifest's `hubPorts` reach the api (only those ports may be granted, and
 * only while this generation lives), `platform` on every host from what Walnut already knows, and
 * `onConnect` for a host in Settings whose link came up (never this machine, never a direct pool
 * key), released with the plugin.
 */
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('plugin-hosts-api-test'))
vi.mock('../../src/core/config-manager.js', () => ({
  getConfig: vi.fn(async () => ({ hosts: { 'home-pc': { hostname: 'home-pc.walnut-net.invalid' }, lab: { hostname: 'lab.example.test' } }, defaults: {} })),
  updatePluginConfig: vi.fn(async (_id: string, patch: Record<string, unknown>) => patch),
  patchPluginConfig: vi.fn(async (_id: string, patch: Record<string, unknown>) => ({ config: patch, changed: true })),
  seedConfigDefaults: vi.fn(async () => undefined),
}))
const connected = vi.hoisted(() => ({ listeners: new Set<(hostKey: string) => void>() }))
vi.mock('../../src/providers/daemon-connection.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/providers/daemon-connection.js')>(),
  addOnDaemonHostConnected: (cb: (hostKey: string) => void) => { connected.listeners.add(cb); return () => { connected.listeners.delete(cb) } },
}))

import { WALNUT_HOME } from '../../src/constants.js'
import { IntegrationRegistry } from '../../src/core/integration-registry.js'
import { validateManifest } from '../../src/core/integration-loader.js'
import { PluginContext, type PluginLogger } from '../../src/core/plugins/plugin-context.js'
import { createServerPluginApi } from '../../src/core/plugins/server-api.js'
import { hubPortGrantRules, listHubPortGrants, resetHubPortGrantsForTest } from '../../src/core/hosts/hub-port-grants.js'
import { recordProbedFacts } from '../../src/core/hosts/host-profile.js'
import { listPluginHosts, platformOf } from '../../src/core/plugins/plugin-hosts.js'
import type { HubPortDeclaration } from '../../src/core/hosts/hub-port-manifest.js'
import { createTestPluginApi } from './plugin-test-utils.js'

const logger: PluginLogger = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(), child: vi.fn(() => logger) }
const contexts: PluginContext[] = []

afterEach(async () => {
  for (const context of contexts.splice(0)) await context.dispose().catch(() => undefined)
  resetHubPortGrantsForTest()
})

function setup(pluginId: string, hubPorts?: HubPortDeclaration[]) {
  const context = new PluginContext({ id: pluginId, dataDir: path.join(WALNUT_HOME, 'plugin-data', pluginId), logger })
  contexts.push(context)
  const { api: legacyApi, collected } = createTestPluginApi({ id: pluginId, name: pluginId })
  const api = createServerPluginApi({ context, pluginName: pluginId, legacyApi, contributions: collected, integrationRegistry: new IntegrationRegistry(), ...(hubPorts ? { hubPorts } : {}) })
  return { api, context }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5))
}

describe('manifest hubPorts reach the plugin api', () => {
  it('the loader keeps hubPorts (dropping a bad entry, never the plugin)', () => {
    const m = validateManifest({ id: 'coderelay', name: 'Model proxy', apiVersion: 1, engines: { walnut: '*' }, hubPorts: [{ port: 18403, why: 'spokes reach the hub' }, { port: 'x' }] }, '/x/manifest.json')
    expect(m?.hubPorts).toEqual([{ port: 18403, why: 'spokes reach the hub' }])
    expect(validateManifest({ id: 'plain', name: 'Plain', apiVersion: 1, engines: { walnut: '*' } }, '/x/manifest.json')?.hubPorts).toBeUndefined()
  })

  it('only a declared port is granted, and only while this generation lives; a stop leaves the grant stored', async () => {
    const { api, context } = setup('coderelay', [{ port: 18403, why: 'spokes reach the hub' }])
    await expect(api.hosts.allowHubPort('home-pc', 18404)).rejects.toMatchObject({ code: 'undeclared_port' })
    expect(await api.hosts.allowHubPort('home-pc', 18403)).toEqual({ added: true })
    expect(await hubPortGrantRules()).toEqual([{ port: 18403, hosts: ['home-pc'], pluginId: 'coderelay' }])
    // A plugin with no hubPorts grants nothing.
    const other = setup('other')
    await expect(other.api.hosts.allowHubPort('home-pc', 18403)).rejects.toMatchObject({ code: 'undeclared_port' })
    await context.dispose()
    expect(await hubPortGrantRules()).toEqual([])
    expect((await listHubPortGrants()).map((g) => g.pluginId)).toEqual(['coderelay'])
  })
})

describe('walnut.hosts.onConnect', () => {
  it('hears a host in Settings whose link came up; never this machine, a direct key or an unknown host; released with the plugin', async () => {
    const { api, context } = setup('coderelay')
    const heard: string[] = []
    api.hosts.onConnect(({ alias }: { alias: string }) => { heard.push(alias) })
    // The subscription lands once the link module loaded (a lazy import).
    for (let i = 0; i < 500 && connected.listeners.size === 0; i++) await new Promise((r) => setTimeout(r, 10))
    expect(connected.listeners.size).toBe(1)
    for (const l of connected.listeners) { l('home-pc'); l('__local__'); l('direct:ws://127.0.0.1:1'); l('stranger'); l('lab') }
    await settle()
    expect(heard).toEqual(['home-pc', 'lab'])
    // A throwing handler is logged, never thrown into the connect.
    api.hosts.onConnect(() => { throw new Error('boom') })
    for (let i = 0; i < 500 && connected.listeners.size < 2; i++) await new Promise((r) => setTimeout(r, 10))
    for (const l of connected.listeners) expect(() => l('home-pc')).not.toThrow()
    await settle()
    expect(logger.error).toHaveBeenCalledWith('Plugin host connect handler failed', expect.objectContaining({ host: 'home-pc' }))
    await context.dispose()
    expect(connected.listeners.size).toBe(0)
  })
})

describe('platform on walnut.hosts', () => {
  it('names os and arch the way release builds do', () => {
    expect(platformOf('darwin', 'arm64')).toEqual({ os: 'darwin', arch: 'arm64' })
    expect(platformOf('linux', 'x64')).toEqual({ os: 'linux', arch: 'amd64' })
    expect(platformOf('win32', 'x64')).toEqual({ os: 'windows', arch: 'amd64' })
    expect(platformOf('linux', 'aarch64')).toEqual({ os: 'linux', arch: 'arm64' })
    expect(platformOf('freebsd', 'riscv64')).toEqual({ os: 'freebsd', arch: 'riscv64' })
    expect(platformOf(undefined, 'x64')).toBeNull()
  })

  it('this machine by its own, a probed host by its probe, a host never heard from is null', async () => {
    await recordProbedFacts('home-pc', { os: { platform: 'linux', release: '6.1' }, arch: 'x64', cpus: 4, memBytes: 1, home: '/home/me', proxyEnv: {}, cloud: null, internet: null, tools: {} } as never)
    const rows = await listPluginHosts()
    expect(rows.find((r) => r.alias === '__local__')?.platform).toEqual(platformOf(process.platform, process.arch))
    expect(rows.find((r) => r.alias === 'home-pc')?.platform).toEqual({ os: 'linux', arch: 'amd64' })
    expect(rows.find((r) => r.alias === 'lab')?.platform).toBeNull()
  })
})
