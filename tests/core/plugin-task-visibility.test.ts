/**
 * Which plugins keep their tasks to their own view (src/core/plugins/plugin-task-visibility.ts),
 * and the manifest field behind it (`taskVisibility`, validated by `walnut-plugin validate`).
 * The server path end to end is tests/e2e/plugin-only-tasks.test.ts.
 */
import { afterEach, describe, expect, it } from 'vitest'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  parseTaskVisibility, pluginKeepsTasks, pluginOnlyForCaller, registerPluginKeepsTasks, resetPluginTaskVisibilityForTesting,
} from '../../src/core/plugins/plugin-task-visibility.js'
import { validatePlugin } from '../../packages/plugin-cli/src/manifest.js'

const roots: string[] = []
afterEach(async () => {
  resetPluginTaskVisibilityForTesting()
  await Promise.all(roots.splice(0).map((root) => fsp.rm(root, { recursive: true, force: true })))
})

describe('plugin task visibility', () => {
  it('reads only "plugin" from the manifest; anything else is the default', () => {
    expect(parseTaskVisibility('plugin')).toBe('plugin')
    for (const raw of ['everywhere', 'Plugin', true, 1, null, undefined, {}]) expect(parseTaskVisibility(raw)).toBeUndefined()
  })

  it('answers for a plugin caller only, and only while its generation is registered', () => {
    expect(pluginOnlyForCaller('plugin:practice')).toBeUndefined()
    const undo = registerPluginKeepsTasks('practice')
    expect(pluginKeepsTasks('practice')).toBe(true)
    expect(pluginOnlyForCaller('plugin:practice')).toBe('practice')
    expect(pluginOnlyForCaller(' plugin:practice ')).toBe('practice')
    // A session's sid, an unknown plugin, an empty id, nothing at all.
    for (const sid of ['c0ffee-session', 'plugin:other', 'plugin:', '', undefined, null]) expect(pluginOnlyForCaller(sid)).toBeUndefined()
    undo()
    expect(pluginOnlyForCaller('plugin:practice')).toBeUndefined()
  })

  it('a reload\'s new generation survives the old generation\'s dispose', () => {
    const undoOld = registerPluginKeepsTasks('practice')
    const undoNew = registerPluginKeepsTasks('practice')
    undoOld()
    expect(pluginKeepsTasks('practice')).toBe(true)
    undoNew()
    expect(pluginKeepsTasks('practice')).toBe(false)
  })
})

describe('walnut-plugin validate: taskVisibility', () => {
  async function pluginDir(extra: Record<string, unknown>): Promise<string> {
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'plugin-visibility-'))
    roots.push(base)
    await fsp.writeFile(path.join(base, 'manifest.json'), JSON.stringify({
      id: 'acme-practice', name: 'Acme Practice', version: '1.0.0', apiVersion: 1, engines: { walnut: '>=0.0.0' }, ...extra,
    }))
    return base
  }

  it.each(['plugin', 'everywhere', undefined])('accepts %j', async (value) => {
    expect((await validatePlugin(await pluginDir(value === undefined ? {} : { taskVisibility: value }))).errors).toEqual([])
  })

  it.each(['hidden', true, 'Plugin'])('rejects %j', async (value) => {
    expect((await validatePlugin(await pluginDir({ taskVisibility: value }))).errors)
      .toEqual(["manifest.taskVisibility must be 'everywhere' or 'plugin'"])
  })
})
