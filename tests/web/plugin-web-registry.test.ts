import { afterEach, describe, expect, it } from 'vitest'
import { pluginUiRegistry } from '../../web/src/plugins/registry.js'

const Component = () => null

afterEach(() => pluginUiRegistry.clear())

describe('native Web Plugin UI registry', () => {
  it('namespaces, orders, and disposes contributions by owner', () => {
    const later = pluginUiRegistry.registerNav('plugin-a', 'Plugin A', {
      id: 'later', label: 'Later', path: '/later', order: 20,
    })
    pluginUiRegistry.registerNav('plugin-b', 'Plugin B', {
      id: 'first', label: 'First', path: '/first', order: 10,
    })
    pluginUiRegistry.registerPage('plugin-a', 'Plugin A', {
      id: 'page', path: '/page', component: Component,
    })

    expect(pluginUiRegistry.getSnapshot().nav.map((entry) => entry.key)).toEqual([
      'plugin-b:first',
      'plugin-a:later',
    ])
    expect(pluginUiRegistry.getSnapshot().pages[0].key).toBe('plugin-a:page')

    later.dispose()
    expect(pluginUiRegistry.getSnapshot().nav.map((entry) => entry.key)).toEqual(['plugin-b:first'])
    expect(pluginUiRegistry.removeOwner('plugin-a')).toBe(1)
    expect(pluginUiRegistry.getSnapshot().pages).toEqual([])
    expect(pluginUiRegistry.getSnapshot().nav).toHaveLength(1)
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

    pluginUiRegistry.registerPanel('plugin-a', 'Plugin A', {
      id: 'panel', title: 'Panel', component: Component,
    })

    const after = pluginUiRegistry.getSnapshot()
    expect(after).toBe(pluginUiRegistry.getSnapshot())
    expect(after).not.toBe(before)
    expect(notifications).toBe(1)
    unsubscribe()
  })
})
