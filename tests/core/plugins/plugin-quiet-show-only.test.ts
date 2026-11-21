/**
 * A plugin's focus block on a task (quiet.set with allowTasks and showOnly) also shows only that
 * task in the person's windows: a focus space of its own (`by: 'block'`) that ends with the hold,
 * and never takes the place of a focus space the person chose.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('plugin-quiet-show-only'))
const flags = { focus_workspace: true }
vi.mock('../../../src/core/config-manager.js', () => ({ getConfig: async () => ({ experimental: { ...flags } }) }))
vi.mock('../../../src/core/task-manager.js', () => ({
  getTask: async (id: string) => ({ id, title: id === 'task-a' ? 'Question bank practice' : 'Other' }),
  scopeTaskLookup: () => () => undefined,
}))

import { WALNUT_HOME } from '../../../src/constants.js'
import { createPluginNotifications } from '../../../src/core/plugins/plugin-notifications.js'
import { enterFocus, getActiveFocus, resetActiveFocus } from '../../../src/core/focus-spaces/active.js'
import { getQuiet, stopQuiet } from '../../../src/core/quiet/quiet-state.js'

function plugin() {
  return createPluginNotifications({ pluginId: 'walnut-rhythm', own: (r) => r, assertLive: () => {} })
}

beforeEach(async () => {
  flags.focus_workspace = true
  stopQuiet()
  resetActiveFocus()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
})
afterEach(async () => {
  stopQuiet()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
})

describe('quiet.set showOnly', () => {
  it('enters a focus on the block\'s task, named after it, until the block ends; clear leaves it', async () => {
    const until = Date.now() + 25 * 60_000
    const p = plugin()
    await p.quiet.set({ reason: 'Focus block', until, allowTasks: ['task-a'], showOnly: true })
    expect(await getActiveFocus()).toMatchObject({ name: 'Question bank practice', scope: { tasks: ['task-a'] }, until, by: 'block' })
    expect((await getQuiet()).holds.map((h) => h.source).sort()).toEqual(['focus-space', 'plugin:walnut-rhythm'])
    await p.quiet.clear()
    expect(await getActiveFocus()).toBeNull()
    expect((await getQuiet()).holds).toEqual([])
  })

  it('never replaces a focus the person chose, and its end leaves that focus alone', async () => {
    await enterFocus({ scope: { projects: ['Walnut'] }, name: 'Walnut' })
    const p = plugin()
    await p.quiet.set({ reason: 'Focus block', allowTasks: ['task-a'], showOnly: true })
    expect(await getActiveFocus()).toMatchObject({ name: 'Walnut', by: 'person' })
    await p.quiet.clear()
    expect(await getActiveFocus()).toMatchObject({ name: 'Walnut', by: 'person' })
  })

  it('does nothing to the view while focus spaces are off', async () => {
    flags.focus_workspace = false
    await plugin().quiet.set({ reason: 'Focus block', allowTasks: ['task-a'], showOnly: true })
    expect(await getActiveFocus()).toBeNull()
    const holds = (await getQuiet()).holds
    expect(holds).toHaveLength(1)
    expect(holds[0].scope).toBeUndefined()
  })

  it('a hold without showOnly lets the task through but leaves the view as it is', async () => {
    await plugin().quiet.set({ reason: 'Focus block', allowTasks: ['task-a'] })
    expect(await getActiveFocus()).toBeNull()
    expect((await getQuiet()).holds[0].scope).toEqual({ tasks: ['task-a'] })
  })
})
