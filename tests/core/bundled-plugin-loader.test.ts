/**
 * The loader half of the bundled plugin store: a folder that ships with Walnut is
 * discovered ONLY when config says `plugins.<id>.enabled: true` (the user pressed
 * Install), is judged like an external plugin (strict engines range), keeps its
 * "bundled" origin across a reload, loses to a linked copy of the same id, and can be
 * forgotten back to "never discovered" once it is off.
 *
 * Real loader, real temp filesystem; only config.yaml is a mock, so each case states the
 * config it depends on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('bundled-loader-test'))

vi.mock('../../src/core/config-manager.js', () => ({
  getConfig: vi.fn(async () => ({ version: 1, plugins: {} })),
  updatePluginConfig: vi.fn(async (_id: string, patch: Record<string, unknown>) => patch),
}))

import { WALNUT_HOME, TASKS_FILE } from '../../src/constants.js'
import { IntegrationRegistry } from '../../src/core/integration-registry.js'
import {
  disableLoadedPlugin,
  disposeLoadedPlugins,
  forgetBundledPlugin,
  getPluginLifecycleRecords,
  loadNewPlugins,
  loadPlugins,
  reloadLoadedPlugin,
} from '../../src/core/integration-loader.js'
import { getConfig } from '../../src/core/config-manager.js'
import { BUNDLED_STORE_DIR_ENV } from '../../src/core/plugins/bundled-store.js'

const storeDir = path.join(WALNUT_HOME, '..', `${path.basename(WALNUT_HOME)}-store`)

function setPluginConfig(plugins: Record<string, Record<string, unknown>>): void {
  vi.mocked(getConfig).mockResolvedValue({ version: 1, plugins } as never)
}

async function writeUnifiedPlugin(
  dir: string,
  id: string,
  manifest: Record<string, unknown> = {},
  { built = true }: { built?: boolean } = {},
): Promise<void> {
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({
    id,
    name: id,
    version: '1.0.0',
    apiVersion: 1,
    engines: { walnut: '>=0.0.0' },
    server: 'dist/server.mjs',
    ...manifest,
  }))
  if (!built) return
  await fsp.mkdir(path.join(dir, 'dist'), { recursive: true })
  await fsp.writeFile(path.join(dir, 'dist', 'server.mjs'), 'export function activate() {}\n')
}

const record = (registry: IntegrationRegistry, id: string) =>
  getPluginLifecycleRecords(registry).find((entry) => entry.id === id)

const registries: IntegrationRegistry[] = []
async function freshLoad(): Promise<IntegrationRegistry> {
  const registry = new IntegrationRegistry()
  registries.push(registry)
  await loadPlugins(registry)
  return registry
}

beforeEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(path.dirname(TASKS_FILE), { recursive: true })
  await fsp.writeFile(TASKS_FILE, JSON.stringify({ version: 1, tasks: [] }))
  await fsp.rm(storeDir, { recursive: true, force: true })
  await writeUnifiedPlugin(path.join(storeDir, 'omega'), 'omega')
  process.env[BUNDLED_STORE_DIR_ENV] = storeDir
  setPluginConfig({})
})

afterEach(async () => {
  for (const registry of registries.splice(0)) await disposeLoadedPlugins(registry)
  delete process.env[BUNDLED_STORE_DIR_ENV]
  await fsp.rm(storeDir, { recursive: true, force: true })
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
})

describe('bundled store discovery', () => {
  it('leaves a shipped folder alone until config says enabled: true', async () => {
    // No key at all: shipped, not installed.
    expect(record(await freshLoad(), 'omega')).toBeUndefined()

    // An explicit off is not an install either.
    setPluginConfig({ omega: { enabled: false } })
    expect(record(await freshLoad(), 'omega')).toBeUndefined()

    // A key with settings but no `enabled` is not an install: only `true` counts.
    setPluginConfig({ omega: { greeting: 'hi' } })
    expect(record(await freshLoad(), 'omega')).toBeUndefined()

    setPluginConfig({ omega: { enabled: true } })
    const installed = record(await freshLoad(), 'omega')
    expect(installed).toMatchObject({ id: 'omega', state: 'active', builtin: false, bundled: true })
  })

  it('picks up a just-installed folder on an additive load, which is what Install runs', async () => {
    const registry = await freshLoad()
    expect(record(registry, 'omega')).toBeUndefined()

    setPluginConfig({ omega: { enabled: true } })
    await loadNewPlugins(registry)

    expect(record(registry, 'omega')).toMatchObject({ state: 'active', bundled: true })
    expect(registry.get('omega')?.pluginDir).toBe(await fsp.realpath(path.join(storeDir, 'omega')))
  })

  it('skips an installed folder whose declared build output is missing', async () => {
    await fsp.rm(path.join(storeDir, 'omega'), { recursive: true })
    await writeUnifiedPlugin(path.join(storeDir, 'omega'), 'omega', {}, { built: false })
    setPluginConfig({ omega: { enabled: true } })

    // Not a `failed` row it could never leave: simply not discovered.
    expect(record(await freshLoad(), 'omega')).toBeUndefined()
  })

  it('enforces engines.walnut strictly, like any external plugin', async () => {
    await writeUnifiedPlugin(path.join(storeDir, 'omega'), 'omega', { engines: { walnut: '>=999.0.0' } })
    setPluginConfig({ omega: { enabled: true } })

    expect(record(await freshLoad(), 'omega')).toMatchObject({ state: 'unsupported', bundled: true })
  })

  it('loses to a linked copy of the same id, which then carries no bundled flag', async () => {
    await writeUnifiedPlugin(path.join(WALNUT_HOME, 'plugins', 'omega'), 'omega', { name: 'Linked Omega' })
    setPluginConfig({ omega: { enabled: true } })

    const registry = await freshLoad()

    expect(record(registry, 'omega')).toMatchObject({ name: 'Linked Omega', state: 'active' })
    expect(record(registry, 'omega')?.bundled).toBeUndefined()
    await expect(forgetBundledPlugin(registry, 'omega')).rejects.toThrow('not a bundled plugin')
  })

  it('keeps the bundled origin through a reload', async () => {
    setPluginConfig({ omega: { enabled: true } })
    const registry = await freshLoad()

    const reloaded = await reloadLoadedPlugin(registry, 'omega')

    expect(reloaded).toMatchObject({ state: 'active', bundled: true })
  })

  it('forgets a disabled bundled plugin entirely, and refuses while one runs on it', async () => {
    await writeUnifiedPlugin(path.join(WALNUT_HOME, 'plugins', 'beta'), 'beta', { dependencies: { omega: '^1' } })
    setPluginConfig({ omega: { enabled: true } })
    const registry = await freshLoad()
    expect(record(registry, 'beta')?.state).toBe('active')

    // A running dependent blocks it, before anything is torn down.
    await expect(forgetBundledPlugin(registry, 'omega')).rejects.toMatchObject({ code: 'has-dependents', dependents: ['beta'] })
    expect(record(registry, 'omega')?.state).toBe('active')

    await disableLoadedPlugin(registry, 'omega', { cascade: true })
    expect(await forgetBundledPlugin(registry, 'omega')).toBe(true)

    expect(record(registry, 'omega')).toBeUndefined()
    expect(registry.has('omega')).toBe(false)
    // Nothing left to forget the second time.
    expect(await forgetBundledPlugin(registry, 'omega')).toBe(false)

    // And a later Install brings it back as a fresh discovery.
    await loadNewPlugins(registry)
    expect(record(registry, 'omega')).toMatchObject({ state: 'active', bundled: true })
  })
})
