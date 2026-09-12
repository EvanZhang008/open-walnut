/**
 * Reloading a plugin whose directory became a `walnut-plugin link` AFTER boot.
 *
 * The incident: `~/.open-walnut/plugins/<id>` was a real directory when Walnut started, and
 * was replaced by a symlink into a checkout while it ran. The reload still bundled through
 * the path recorded at boot, so the esbuild rebase (which only rewrites imports whose
 * importer sits under the plugin dir it was given) stopped matching and the reload died on
 * `Could not resolve "../../constants.js"`.
 *
 * The plugin here imports a Walnut source module on purpose: that import is the only thing
 * the rebase exists for, so it is the only thing that proves the reload bundled from the
 * canonical directory.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('linked-reload-test'))

vi.mock('../../../src/core/config-manager.js', () => ({
  getConfig: vi.fn(async () => ({
    version: 1,
    user: { name: 'test' },
    defaults: { priority: 'none' },
    provider: { type: 'bedrock' },
    plugins: {},
  })),
  updatePluginConfig: vi.fn(async (_id: string, patch: Record<string, unknown>) => patch),
}))

import { WALNUT_HOME } from '../../../src/constants.js'
import {
  disposeLoadedPlugins,
  loadPlugins,
  reloadLoadedPlugin,
} from '../../../src/core/integration-loader.js'
import { IntegrationRegistry } from '../../../src/core/integration-registry.js'

const PLUGIN_ID = 'linked-sample'

/** The 15 no-op sync methods every plugin has to register. */
const NOOP_SYNC_SOURCE = `{
  createTask: async () => null,
  deleteTask: async () => {},
  updateTitle: async () => {},
  updateDescription: async () => {},
  updateSummary: async () => {},
  updateNote: async () => {},
  updateConversationLog: async () => {},
  updatePriority: async () => {},
  updatePhase: async () => {},
  updateDueDate: async () => {},
  updateProject: async () => {},
  updateDependencies: async () => {},
  associateSubtask: async () => {},
  disassociateSubtask: async () => {},
  syncPoll: async () => {},
}`

/** A plugin whose entry reaches into the Walnut source tree, like the real ones do. */
async function writePlugin(dir: string, label: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(
    path.join(dir, 'manifest.json'),
    JSON.stringify({ id: PLUGIN_ID, name: label, version: '1.0.0' }),
  )
  await fsp.writeFile(path.join(dir, 'plugin.ts'), `
import { WALNUT_HOME } from '../../constants.js';
export default function register(api) {
  if (typeof WALNUT_HOME !== 'string') throw new Error('source import did not resolve');
  api.registerSync(${NOOP_SYNC_SOURCE});
}
`)
}

let registry: IntegrationRegistry

beforeEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
  registry = new IntegrationRegistry()
})

afterEach(async () => {
  await disposeLoadedPlugins(registry)
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
})

describe('reloading a plugin that became a linked checkout', () => {
  it('bundles from the canonical directory after the dir is replaced by a link', async () => {
    const installedDir = path.join(WALNUT_HOME, 'plugins', PLUGIN_ID)
    await writePlugin(installedDir, 'Before')
    await loadPlugins(registry)
    expect(registry.get(PLUGIN_ID)?.name).toBe('Before')

    // The swap: the plugin moves out to a checkout and the old path becomes a link to it,
    // which is exactly what `walnut-plugin link` leaves behind.
    const checkoutDir = await fsp.realpath(
      await fsp.mkdtemp(path.join(WALNUT_HOME, 'checkout-')),
    )
    const linkedDir = path.join(checkoutDir, PLUGIN_ID)
    await fsp.rm(installedDir, { recursive: true, force: true })
    await writePlugin(linkedDir, 'After')
    await fsp.symlink(linkedDir, installedDir, 'dir')

    const record = await reloadLoadedPlugin(registry, PLUGIN_ID)

    expect(record.state).toBe('active')
    expect(registry.get(PLUGIN_ID)?.name).toBe('After')
    // The recorded dir is now the canonical one, so every later reload keeps working.
    expect(registry.get(PLUGIN_ID)?.pluginDir).toBe(linkedDir)
  })
})
