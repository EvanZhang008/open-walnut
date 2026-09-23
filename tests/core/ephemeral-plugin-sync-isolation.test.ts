/**
 * On an ephemeral server EVERY plugin loses its sync, not only shipped ones.
 *
 * The snapshot copies the user's plugins/ dir: an installed two-way sync plugin
 * (often a symlink to its source checkout) and its settings arrive intact. The
 * loader's "only shipped plugins" rule assumed a non-shipped plugin in a temp
 * home is a test's own fixture; in an ephemeral snapshot it is the user's real
 * integration, and it would sync test tasks into the user's real account.
 * Companion to remote-sync-isolation.test.ts, which pins the non-ephemeral rule
 * (a test fixture plugin stays fully functional there).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => ({
  ...createMockConstants('walnut-ephemeral-plugin-sync'),
  IS_EPHEMERAL: true,
}))

vi.mock('../../src/core/config-manager.js', () => ({
  getConfig: vi.fn(async () => ({
    version: 1,
    user: { name: 'test' },
    defaults: { priority: 'none' },
    provider: { type: 'bedrock' },
    plugins: {},
  })),
  seedConfigDefaults: vi.fn(async () => {}),
  updatePluginConfig: vi.fn(async () => {}),
}))

import { WALNUT_HOME } from '../../src/constants.js'
import { registry } from '../../src/core/integration-registry.js'
import { loadPlugins, disposeLoadedPlugins } from '../../src/core/integration-loader.js'

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
  pushTask: async () => ({ serverTimestamp: new Date().toISOString() }),
  syncPoll: async () => {},
}`

/** An installed (non-shipped) sync plugin, as the snapshot copy carries it. */
async function writeInstalledSyncPlugin(id: string): Promise<void> {
  const dir = path.join(WALNUT_HOME, 'plugins', id)
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ id, name: `Installed ${id}`, version: '1.0.0' }))
  await fsp.writeFile(path.join(dir, 'index.mjs'),
    `export default function register(api) {\n  api.registerSync(${NOOP_SYNC_SOURCE});\n  api.registerSourceClaim(() => true, { priority: 5 });\n}\n`)
}

beforeEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
  registry.clear()
})

afterEach(async () => {
  delete process.env.WALNUT_ALLOW_REMOTE_SYNC_IN_TEST
  await disposeLoadedPlugins(registry).catch(() => {})
  registry.clear()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
})

describe('ephemeral server plugin sync', () => {
  it('an installed sync plugin loads but is no task source', async () => {
    await writeInstalledSyncPlugin('installed-sync')
    await loadPlugins(registry)

    const plugin = registry.get('installed-sync')
    expect(plugin, 'the plugin still loads: routes and UI stay testable').toBeDefined()
    expect(plugin!.hasSync).toBe(false)
    expect(plugin!.claim).toBeUndefined()
    expect(registry.isTaskSource('installed-sync')).toBe(false)
  })

  it('the explicit opt-in still restores it', async () => {
    process.env.WALNUT_ALLOW_REMOTE_SYNC_IN_TEST = '1'
    await writeInstalledSyncPlugin('installed-sync')
    await loadPlugins(registry)

    expect(registry.get('installed-sync')?.hasSync).toBe(true)
    expect(registry.isTaskSource('installed-sync')).toBe(true)
  })
})
