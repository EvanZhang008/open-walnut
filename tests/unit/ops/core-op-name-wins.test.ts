/**
 * A core op name outranks a plugin that got there first.
 *
 * Production order is PLUGIN FIRST: plugins activate during boot, and the op
 * modules are pulled in lazily on first use. So a plugin with `id: "task"`
 * declaring op `get` registers `task_get` BEFORE core declares it, and a throw at
 * that moment would be worse than the squatting — ESM caches a failed module
 * evaluation, so every later `import('src/ops/index.js')` rethrows and the actions
 * route, the gateway `walnut tools` path, and the plugin op routes all stay dead
 * until the process restarts.
 *
 * This file exercises that real order: a fresh module graph per test
 * (`vi.resetModules()`) plus dynamic imports, so the registration genuinely
 * precedes the import. Its own file on purpose — resetting modules would
 * otherwise leak into the loader-backed tests in tests/core/.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WalnutOp } from '../../../src/ops/registry.js'

function squatter(name: string): WalnutOp {
  return {
    name,
    title: 'Squatter',
    description: 'Squatter',
    input: {},
    handler: async () => ({}),
    tags: { readonly: true, remote: 'allow' },
  }
}

beforeEach(() => { vi.resetModules() })
afterEach(() => { vi.restoreAllMocks(); vi.resetModules() })

describe('core wins an op name whatever the load order', () => {
  it('evicts a plugin squatter instead of poisoning the op module', async () => {
    const registry = await import('../../../src/ops/registry.js')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    registry.definePluginOp('task', squatter('task_get'))
    expect(registry.getOp('task_get')?.title).toBe('Squatter')

    // The real production trigger: something needs an op for the first time.
    await expect(import('../../../src/ops/index.js')).resolves.toBeDefined()

    const entry = registry.listOpEntries().find((item) => item.op.name === 'task_get')
    expect(entry?.owner).toBe('core')
    expect(entry?.op.title).not.toBe('Squatter')
    // The evicted plugin gets its budget back, because the count is derived.
    expect(registry.countOwnerOps('task')).toBe(0)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('evicted op "task_get"'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"task"'))
  })

  it('leaves every other core op loadable after an eviction', async () => {
    const registry = await import('../../../src/ops/registry.js')
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    registry.definePluginOp('task', squatter('task_get'))
    await import('../../../src/ops/index.js')

    // A poisoned module would have registered nothing at all.
    for (const name of ['task_list', 'task_create', 'session_send', 'walnut_status']) {
      expect(registry.getOp(name), name).toBeDefined()
    }
    const { executeOp } = await import('../../../src/ops/index.js')
    expect(typeof executeOp).toBe('function')
  })

  it('still throws when core declares the same name twice', async () => {
    const registry = await import('../../../src/ops/registry.js')
    await import('../../../src/ops/index.js')

    expect(() => registry.defineOp(squatter('task_get'))).toThrow('duplicate op name: task_get')
    expect(registry.getOp('task_get')?.title).not.toBe('Squatter')
  })
})
