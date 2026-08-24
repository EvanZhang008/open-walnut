import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetAppCommandsForTesting, syncAppCommands } from '../../web/src/apps/commands.js'
import type { RegisteredApp } from '../../web/src/apps/registry.js'
import { getCommand } from '../../web/src/commands/registry.js'

const app: RegisteredApp = {
  key: 'demo:main',
  id: 'main',
  owner: 'demo',
  kind: 'native',
  title: 'Demo App',
  path: '/apps/demo~main',
  routeId: 'demo~main',
  component: () => null,
  badge: null,
  order: 500,
  fullBleed: true,
  persistent: false,
  lockVisibility: false,
  generation: 1,
  pluginId: 'demo',
  pluginName: 'Demo',
}

afterEach(resetAppCommandsForTesting)

describe('App Command Palette bridge', () => {
  it('registers navigation atomically and removes stale Apps', async () => {
    syncAppCommands([app])
    const command = getCommand('app:demo:main')
    const navigate = vi.fn()

    await command?.execute({
      navigate,
      sendMessage: vi.fn(),
      clearMessages: vi.fn(),
      addLocalMessage: vi.fn(),
    })

    expect(command).toMatchObject({ description: 'Open Demo App', source: 'app' })
    expect(navigate).toHaveBeenCalledWith('/apps/demo~main')

    syncAppCommands([])
    expect(getCommand('app:demo:main')).toBeUndefined()
  })
})
