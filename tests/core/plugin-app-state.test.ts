/**
 * `walnut.appState` on the server side of a plugin: each plugin generation owns
 * what it published. A reload activates the new generation before the old one
 * is disposed, so the old one's teardown must take only its own state, and a
 * publish from a disposed generation must be refused rather than land.
 *
 * Real PluginContext and createServerPluginApi, and the real task store and
 * session registry in an isolated home; the session reads through readAppState.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('plugin-app-state-test'))

import { WALNUT_HOME } from '../../src/constants.js'
import { addTask } from '../../src/core/task-manager.js'
import { createSessionRecord } from '../../src/core/session-tracker.js'
import { IntegrationRegistry } from '../../src/core/integration-registry.js'
import { PluginContext, type PluginLogger } from '../../src/core/plugins/plugin-context.js'
import { createServerPluginApi } from '../../src/core/plugins/server-api.js'
import { readAppState, resetAppStateForTesting } from '../../src/core/sessions/app-state.js'
import { createTestPluginApi } from './plugin-test-utils.js'

const logger: PluginLogger = {
  trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(),
  child: vi.fn(() => logger),
}

function generation(pluginId: string) {
  const context = new PluginContext({ id: pluginId, dataDir: path.join(WALNUT_HOME, 'plugin-data', pluginId), logger })
  const { api: legacyApi, collected } = createTestPluginApi({ id: pluginId, name: pluginId })
  const api = createServerPluginApi({ context, pluginName: 'Practice', legacyApi, contributions: collected, integrationRegistry: new IntegrationRegistry() })
  return { context, api }
}

let seq = 0
async function seedSession() {
  seq += 1
  const { task } = await addTask({ title: `Practice ${seq}`, project: 'Interview Practice' })
  const sid = `44444444-5555-6666-7777-${String(seq).padStart(12, '0')}`
  await createSessionRecord(sid, task.id, 'Interview Practice', '/tmp/ws', { title: task.title })
  return { taskId: task.id, sid }
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  resetAppStateForTesting()
})

describe('walnut.appState on the server', () => {
  it('publishes under the plugin name, and clear takes it away', async () => {
    const { api } = generation('practice')
    const a = await seedSession()
    expect(await api.appState.publish(a.taskId, { level: 1 })).toMatchObject({ kept: true })
    expect((await readAppState(a.sid)).states).toEqual([expect.objectContaining({ plugin: 'practice', label: 'Practice', state: { level: 1 } })])
    await api.appState.clear(a.taskId)
    expect((await readAppState(a.sid)).states).toEqual([])
  })

  it('a reload: the old generation going away takes its own state and leaves the new one', async () => {
    const a = await seedSession()
    const b = await seedSession()
    const c = await seedSession()
    const old = generation('practice')
    await old.api.appState.publish(a.taskId, { from: 'old' })
    await old.api.appState.publish(c.taskId, { from: 'old' })
    const next = generation('practice')
    await next.api.appState.publish(b.taskId, { from: 'new' })
    // The new generation published again for c before the old one went: c is the new one's now.
    await next.api.appState.publish(c.taskId, { from: 'new again' })

    await old.context.dispose()
    expect((await readAppState(a.sid)).states).toEqual([])
    expect((await readAppState(b.sid)).states).toEqual([expect.objectContaining({ state: { from: 'new' } })])
    expect((await readAppState(c.sid)).states).toEqual([expect.objectContaining({ state: { from: 'new again' } })])

    // A late publish from the disposed generation is refused, not stored.
    await expect(old.api.appState.publish(a.taskId, { from: 'late' })).rejects.toThrow()
    expect((await readAppState(a.sid)).states).toEqual([])
    await next.context.dispose()
  })
})
