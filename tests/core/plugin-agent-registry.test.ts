import { afterEach, describe, expect, it, vi } from 'vitest'

const configAgents = vi.hoisted(() => [] as Array<Record<string, unknown>>)

vi.mock('../../src/core/config-manager.js', () => ({
  getConfig: vi.fn(async () => ({ agent: { agents: configAgents } })),
  updateConfig: vi.fn(async () => undefined),
  _resetWriteLockForTest: vi.fn(),
}))

import {
  _resetForTest,
  deleteAgent,
  getAgent,
  getAllAgents,
  registerOwnedAgent,
  removeOwnedAgents,
  updateAgent,
} from '../../src/core/agent-registry.js'

afterEach(() => {
  configAgents.length = 0
  removeOwnedAgents('plugin-a')
  removeOwnedAgents('plugin-b')
  _resetForTest()
})

describe('owner-scoped Plugin agents', () => {
  it('adds a namespaced runtime agent and removes it through its disposable', async () => {
    const registration = registerOwnedAgent('plugin-a', {
      id: 'plugin-a:helper',
      name: 'Helper',
      runner: 'embedded',
      console: true,
    })

    await expect(getAgent('plugin-a:helper')).resolves.toMatchObject({
      id: 'plugin-a:helper',
      name: 'Helper',
      source: 'plugin',
    })

    registration.dispose()
    await expect(getAgent('plugin-a:helper')).resolves.toBeUndefined()
  })

  it('lets user config override a Plugin agent without mutating the Plugin owner', async () => {
    registerOwnedAgent('plugin-a', {
      id: 'plugin-a:helper',
      name: 'Plugin Helper',
      runner: 'embedded',
    })
    configAgents.push({
      id: 'plugin-a:helper',
      name: 'User Helper',
      runner: 'embedded',
    })

    await expect(getAgent('plugin-a:helper')).resolves.toMatchObject({
      name: 'User Helper',
      source: 'config',
    })
    expect((await getAllAgents()).filter((agent) => agent.id === 'plugin-a:helper')).toHaveLength(1)
  })

  it('protects builtin and Plugin-owned definitions from config mutation', async () => {
    expect(() => registerOwnedAgent('plugin-a', {
      id: 'general',
      name: 'Replacement',
      runner: 'embedded',
    })).toThrow('cannot replace a builtin')

    registerOwnedAgent('plugin-a', {
      id: 'plugin-a:helper',
      name: 'Helper',
      runner: 'embedded',
    })
    await expect(updateAgent('plugin-a:helper', { name: 'Changed' })).rejects.toThrow('plugin-defined')
    await expect(deleteAgent('plugin-a:helper')).rejects.toThrow('plugin-defined')
  })
})
