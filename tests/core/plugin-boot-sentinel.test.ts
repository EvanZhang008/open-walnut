import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PluginBootSentinel, pluginSafeModeEnabled } from '../../src/core/plugins/boot-sentinel.js'
import { namespacePluginId, validatePluginId } from '../../src/core/plugins/ids.js'

let tempDir: string
let stateFile: string

const BUILD_A = '/tmp/walnut-stage.aaaa'
const BUILD_B = '/tmp/walnut-stage.bbbb'

function sentinel(overrides: { buildId?: string; quarantineAfter?: number; now?: () => Date } = {}) {
  return new PluginBootSentinel({
    filePath: stateFile,
    quarantineAfter: overrides.quarantineAfter ?? 2,
    buildId: overrides.buildId ?? BUILD_A,
    ...(overrides.now ? { now: overrides.now } : {}),
  })
}

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-plugin-sentinel-'))
  stateFile = path.join(tempDir, 'state.json')
})

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true })
})

describe('PluginBootSentinel: interrupted activations (the crash-loop guard)', () => {
  it('turns an interrupted activation into a persisted crash record', async () => {
    const s = sentinel({ now: () => new Date('2026-08-22T12:00:00Z') })
    await s.begin('plugin-a')

    expect(await s.recoverInterruptedActivations()).toEqual([
      { pluginId: 'plugin-a', failureCount: 1, quarantined: false },
    ])
    expect(await s.recoverInterruptedActivations()).toEqual([])
    expect(await s.getPluginStatus('plugin-a')).toMatchObject({
      failureCount: 1,
      quarantined: false,
      lastFailure: { kind: 'interrupted', buildId: BUILD_A },
    })
  })

  it('quarantines after repeated interruptions of the same build', async () => {
    const s = sentinel()
    await s.begin('plugin-a')
    await s.recoverInterruptedActivations()
    await s.begin('plugin-a')
    expect(await s.recoverInterruptedActivations()).toEqual([
      { pluginId: 'plugin-a', failureCount: 2, quarantined: true },
    ])
    expect(await s.isQuarantined('plugin-a')).toBe(true)
  })

  it('leaves another build\'s in-flight activation alone and does not count its crashes', async () => {
    // A dev server and the production server share ~/.open-walnut. The dev process
    // dying mid-activation is not evidence against production's copy of the plugin,
    // and production booting while dev is mid-activation must not "recover" it.
    await sentinel({ buildId: BUILD_B }).begin('plugin-a')
    const prod = sentinel({ buildId: BUILD_A })

    expect(await prod.recoverInterruptedActivations()).toEqual([])
    expect(await prod.getPluginStatus('plugin-a')).toEqual({ failureCount: 0, quarantined: false })

    // The owning build still sees its own in-flight entry.
    expect(await sentinel({ buildId: BUILD_B }).recoverInterruptedActivations()).toEqual([
      { pluginId: 'plugin-a', failureCount: 1, quarantined: false },
    ])
  })

  it('a new build starts with a clean slate even when the old build quarantined the plugin', async () => {
    const old = sentinel({ buildId: BUILD_A })
    await old.begin('plugin-a')
    await old.recoverInterruptedActivations()
    await old.begin('plugin-a')
    await old.recoverInterruptedActivations()
    expect(await old.isQuarantined('plugin-a')).toBe(true)

    const fresh = sentinel({ buildId: BUILD_B })
    expect(await fresh.getPluginStatus('plugin-a')).toEqual({ failureCount: 0, quarantined: false })
    // And its first crash counts from one, not three.
    await fresh.begin('plugin-a')
    expect(await fresh.recoverInterruptedActivations()).toEqual([
      { pluginId: 'plugin-a', failureCount: 1, quarantined: false },
    ])
  })

  it('tracks concurrent activations independently', async () => {
    const s = sentinel({ quarantineAfter: 1 })
    await Promise.all([s.begin('plugin-a'), s.begin('plugin-b')])

    const recovered = await s.recoverInterruptedActivations()

    expect(recovered).toEqual(expect.arrayContaining([
      { pluginId: 'plugin-a', failureCount: 1, quarantined: true },
      { pluginId: 'plugin-b', failureCount: 1, quarantined: true },
    ]))
  })
})

describe('PluginBootSentinel: caught failures never quarantine across restarts', () => {
  it('records the error for display but keeps the plugin eligible for the next boot', async () => {
    const s = sentinel({ now: () => new Date('2026-09-11T22:41:30Z') })
    for (let i = 0; i < 5; i++) {
      await s.begin('plugin-a')
      await s.finish('plugin-a', 'failed', { error: 'Plugin "plugin-a" could not be bundled: index.ts: Could not resolve "../../core/x.js"' })
    }
    expect(await s.getPluginStatus('plugin-a')).toEqual({
      failureCount: 0,
      quarantined: false,
      lastFailure: {
        at: '2026-09-11T22:41:30.000Z',
        kind: 'error',
        error: 'Plugin "plugin-a" could not be bundled: index.ts: Could not resolve "../../core/x.js"',
        buildId: BUILD_A,
      },
    })
    expect(await s.recoverInterruptedActivations()).toEqual([])
  })

  it('does not report another build\'s failure reason as this build\'s', async () => {
    const dev = sentinel({ buildId: BUILD_B })
    await dev.begin('plugin-a')
    await dev.finish('plugin-a', 'failed', { error: 'Service "core:x" is unavailable' })

    expect(await sentinel({ buildId: BUILD_A }).getPluginStatus('plugin-a')).toEqual({
      failureCount: 0,
      quarantined: false,
    })
  })

  it('clears a cancelled activation without recording a failure', async () => {
    const s = sentinel({ quarantineAfter: 1 })
    await s.begin('plugin-a')
    await s.finish('plugin-a', 'cancelled')

    expect(await s.getPluginStatus('plugin-a')).toEqual({ failureCount: 0, quarantined: false })
    expect(await s.recoverInterruptedActivations()).toEqual([])
  })
})

describe('PluginBootSentinel: recovery and clearing', () => {
  it('a successful activation wipes crashes and the last failure', async () => {
    const s = sentinel({ quarantineAfter: 1 })
    await s.begin('plugin-a')
    await s.recoverInterruptedActivations()
    expect(await s.isQuarantined('plugin-a')).toBe(true)

    await s.clearQuarantine('plugin-a')
    expect(await s.getPluginStatus('plugin-a')).toEqual({ failureCount: 0, quarantined: false })

    await s.begin('plugin-a')
    await s.finish('plugin-a', 'failed', { error: 'boom' })
    expect((await s.getPluginStatus('plugin-a')).lastFailure?.error).toBe('boom')
    await s.begin('plugin-a')
    await s.finish('plugin-a', 'active')
    expect(await s.getPluginStatus('plugin-a')).toEqual({ failureCount: 0, quarantined: false })
  })

  it('drops a version 1 state file instead of inheriting its verdicts', async () => {
    // The v1 shape is exactly the record that kept a plugin quarantined for two weeks:
    // caught failures counted, no build identity, no reason. Upgrading must retry.
    await fs.writeFile(stateFile, JSON.stringify({
      version: 1,
      activating: {},
      failures: { 'plugin-a': { count: 2, lastAt: '2026-08-27T01:33:31.851Z' } },
      quarantined: ['plugin-a'],
    }))
    const s = sentinel()
    expect(await s.getPluginStatus('plugin-a')).toEqual({ failureCount: 0, quarantined: false })
    expect(await s.recoverInterruptedActivations()).toEqual([])
    const onDisk = JSON.parse(await fs.readFile(stateFile, 'utf8'))
    expect(onDisk.version).toBe(2)
    expect(onDisk.quarantined).toBeUndefined()
  })

  it('a successful activation leaves another build\'s crash record alone', async () => {
    const other = sentinel({ buildId: BUILD_B, quarantineAfter: 1 })
    await other.begin('plugin-a')
    await other.recoverInterruptedActivations()
    expect(await other.isQuarantined('plugin-a')).toBe(true)

    const mine = sentinel({ buildId: BUILD_A })
    await mine.begin('plugin-a')
    await mine.finish('plugin-a', 'active')
    expect(await other.isQuarantined('plugin-a')).toBe(true)
  })

  it('treats a file that is not JSON as empty rather than blocking plugin loading', async () => {
    await fs.writeFile(stateFile, '{ this is not json')
    const s = sentinel()
    expect(await s.getPluginStatus('plugin-a')).toEqual({ failureCount: 0, quarantined: false })
    expect(await s.recoverInterruptedActivations()).toEqual([])
    // And the next write replaces the garbage with a valid v2 file.
    await s.begin('plugin-a')
    expect(JSON.parse(await fs.readFile(stateFile, 'utf8')).version).toBe(2)
  })

  it('ignores malformed entries', async () => {
    await fs.writeFile(stateFile, JSON.stringify({
      version: 2,
      activating: { junk: 'not-an-object', 'plugin-b': { startedAt: 'x', buildId: BUILD_A } },
      crashes: { 'plugin-a': { count: 'two', buildId: BUILD_A } },
      lastFailure: { 'plugin-a': { kind: 'weird', buildId: BUILD_A } },
    }))
    const s = sentinel()
    expect(await s.getPluginStatus('plugin-a')).toEqual({ failureCount: 0, quarantined: false })
    expect(await s.recoverInterruptedActivations()).toEqual([
      { pluginId: 'plugin-b', failureCount: 1, quarantined: false },
    ])
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
