import { afterEach, describe, expect, it } from 'vitest'
import { pluginUiRegistry } from '../../web/src/plugins/registry.js'

const Component = () => null

afterEach(() => pluginUiRegistry.clear())

describe('Native Web Plugin auxiliary UI registry', () => {
  it('namespaces and disposes pages and settings by owner', () => {
    const page = pluginUiRegistry.registerPage('plugin-a', 'Plugin A', {
      id: 'details', path: '/plugins/plugin-a/details', component: Component,
    })
    pluginUiRegistry.registerSettings('plugin-b', 'Plugin B', {
      id: 'settings', label: 'Plugin B', component: Component,
    })

    expect(pluginUiRegistry.getSnapshot().pages[0].key).toBe('plugin-a:details')
    expect(pluginUiRegistry.getSnapshot().settings[0].key).toBe('plugin-b:settings')

    page.dispose()
    expect(pluginUiRegistry.getSnapshot().pages).toEqual([])
    expect(pluginUiRegistry.removeOwner('plugin-b')).toBe(1)
    expect(pluginUiRegistry.getSnapshot().settings).toEqual([])
  })

  it('does not let a stale disposable remove a later contribution', () => {
    const stale = pluginUiRegistry.registerSettings('plugin-a', 'Plugin A', {
      id: 'settings', label: 'Before', component: Component,
    })
    pluginUiRegistry.removeOwner('plugin-a')
    pluginUiRegistry.registerSettings('plugin-a', 'Plugin A', {
      id: 'settings', label: 'After', component: Component,
    })

    stale.dispose()

    expect(pluginUiRegistry.getSnapshot().settings[0].value.label).toBe('After')
  })

  it('rejects duplicate page paths across Plugin owners', () => {
    pluginUiRegistry.registerPage('plugin-a', 'Plugin A', {
      id: 'page', path: '/plugins/shared', component: Component,
    })
    expect(() => pluginUiRegistry.registerPage('plugin-b', 'Plugin B', {
      id: 'page', path: '/plugins/shared', component: Component,
    })).toThrow('already registered by "plugin-a"')
  })

  it('publishes a stable snapshot only when the registry changes', () => {
    const before = pluginUiRegistry.getSnapshot()
    let notifications = 0
    const unsubscribe = pluginUiRegistry.subscribe(() => { notifications++ })

    pluginUiRegistry.registerPage('plugin-a', 'Plugin A', {
      id: 'page', path: '/plugins/plugin-a/page', component: Component,
    })

    const after = pluginUiRegistry.getSnapshot()
    expect(after).toBe(pluginUiRegistry.getSnapshot())
    expect(after).not.toBe(before)
    expect(notifications).toBe(1)
    unsubscribe()
  })
})
