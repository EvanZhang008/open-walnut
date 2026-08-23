import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PluginBootSentinel, pluginSafeModeEnabled } from '../../src/core/plugins/boot-sentinel.js'
import { namespacePluginId, validatePluginId } from '../../src/core/plugins/ids.js'

let tempDir: string
let stateFile: string

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-plugin-sentinel-'))
  stateFile = path.join(tempDir, 'state.json')
})

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true })
})

describe('PluginBootSentinel', () => {
  it('turns an interrupted activation into a persisted failure', async () => {
    const sentinel = new PluginBootSentinel(stateFile, 2, () => new Date('2026-08-22T12:00:00Z'))
    await sentinel.begin('plugin-a')

    expect(await sentinel.recoverInterruptedActivations()).toEqual([
      { pluginId: 'plugin-a', failureCount: 1, quarantined: false },
    ])
    expect(await sentinel.recoverInterruptedActivations()).toEqual([])
  })

  it('quarantines a plugin after repeated activation failures', async () => {
    const sentinel = new PluginBootSentinel(stateFile, 2)
    await sentinel.begin('plugin-a')
    await sentinel.finish('plugin-a', 'failed')
    expect(await sentinel.isQuarantined('plugin-a')).toBe(false)

    await sentinel.begin('plugin-a')
    await sentinel.finish('plugin-a', 'failed')

    expect(await sentinel.isQuarantined('plugin-a')).toBe(true)
  })

  it('clears a cancelled activation without recording a failure', async () => {
    const sentinel = new PluginBootSentinel(stateFile, 1)
    await sentinel.begin('plugin-a')
    await sentinel.finish('plugin-a', 'cancelled')

    expect(await sentinel.getPluginStatus('plugin-a')).toEqual({
      failureCount: 0,
      quarantined: false,
    })
    expect(await sentinel.recoverInterruptedActivations()).toEqual([])
  })

  it('tracks concurrent activations independently', async () => {
    const sentinel = new PluginBootSentinel(stateFile, 1)
    await Promise.all([sentinel.begin('plugin-a'), sentinel.begin('plugin-b')])

    const recovered = await sentinel.recoverInterruptedActivations()

    expect(recovered).toEqual(expect.arrayContaining([
      { pluginId: 'plugin-a', failureCount: 1, quarantined: true },
      { pluginId: 'plugin-b', failureCount: 1, quarantined: true },
    ]))
  })

  it('a successful activation and explicit clear remove quarantine', async () => {
    const sentinel = new PluginBootSentinel(stateFile, 1)
    await sentinel.begin('plugin-a')
    await sentinel.finish('plugin-a', 'failed')
    expect(await sentinel.isQuarantined('plugin-a')).toBe(true)

    await sentinel.clearQuarantine('plugin-a')
    expect(await sentinel.isQuarantined('plugin-a')).toBe(false)

    await sentinel.begin('plugin-a')
    await sentinel.finish('plugin-a', 'active')
    expect(await sentinel.isQuarantined('plugin-a')).toBe(false)
  })
})

describe('Plugin Safe Mode and ids', () => {
  it('accepts the environment variable or dedicated CLI flag', () => {
    expect(pluginSafeModeEnabled({ WALNUT_PLUGIN_SAFE_MODE: '1' }, ['node'])).toBe(true)
    expect(pluginSafeModeEnabled({}, ['node', '--plugin-safe-mode'])).toBe(true)
    expect(pluginSafeModeEnabled({}, ['node'])).toBe(false)
  })

  it('builds unambiguous owner-scoped contribution ids', () => {
    expect(validatePluginId('project-tools')).toBe('project-tools')
    expect(namespacePluginId('project-tools', 'dashboard/main')).toBe('project-tools:dashboard/main')
    expect(() => namespacePluginId('project-tools', '../escape')).toThrow('Invalid plugin contribution id')
    expect(() => validatePluginId('Bad Plugin')).toThrow('Invalid plugin id')
  })
})
