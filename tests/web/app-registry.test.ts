import { afterEach, describe, expect, it } from 'vitest'
import {
  AppRegistry,
  adaptWebviewApps,
  findHostedAppByRouteId,
  type AppComponentProps,
} from '../../web/src/apps/registry.js'

const Component = (_props: AppComponentProps) => null
const Icon = () => null

let registry = new AppRegistry()

afterEach(() => {
  registry.clear()
  registry = new AppRegistry()
})

describe('App Registry', () => {
  it('keeps Core and Plugin Apps in one stable ordered snapshot', () => {
    registry.registerCore({
      id: 'tasks',
      title: 'Tasks',
      path: '/tasks',
      component: Component,
      icon: Icon,
      order: 20,
    })
    registry.registerCore({
      id: 'home',
      title: 'Home',
      path: '/',
      component: Component,
      icon: Icon,
      order: 10,
      persistent: true,
      lockVisibility: true,
    })
    registry.registerPlugin('plugin-a', 'Plugin A', {
      id: 'main',
      title: 'Plugin A',
      component: Component,
      order: 30,
    })

    expect(registry.getSnapshot().apps.map((app) => [app.key, app.kind, app.path])).toEqual([
      ['core:home', 'core', '/'],
      ['core:tasks', 'core', '/tasks'],
      ['plugin-a:main', 'native', '/apps/plugin-a~main'],
    ])
  })

  it('atomically derives path, updates badges, and disposes a Plugin App', async () => {
    const handle = registry.registerPlugin('plugin-a', 'Plugin A', {
      id: 'main',
      title: 'Plugin A',
      component: Component,
      badge: 'dot',
    })

    expect(handle.path).toBe('/apps/plugin-a~main')
    expect(registry.getSnapshot().apps[0]).toMatchObject({
      key: 'plugin-a:main',
      routeId: 'plugin-a~main',
      badge: 'dot',
      pluginId: 'plugin-a',
    })

    handle.setBadge(7)
    expect(registry.getSnapshot().apps[0].badge).toBe(7)
    expect(() => handle.setBadge(-1)).toThrow('non-negative integer')

    await handle.dispose()
    expect(registry.getSnapshot().apps).toEqual([])
  })

  it('does not let a stale handle remove or mutate a replacement App', async () => {
    const stale = registry.registerPlugin('plugin-a', 'Plugin A', {
      id: 'main', title: 'Before', component: Component,
    })
    registry.removeOwner('plugin-a')
    const current = registry.registerPlugin('plugin-a', 'Plugin A', {
      id: 'main', title: 'After', component: Component,
    })

    stale.setBadge(99)
    await stale.dispose()

    expect(registry.getSnapshot().apps).toHaveLength(1)
    expect(registry.getSnapshot().apps[0]).toMatchObject({ title: 'After', badge: null })
    await current.dispose()
  })

  it('uses App keys rather than activation generation as the order tiebreaker', () => {
    registry.registerPlugin('z-plugin', 'Z', {
      id: 'main', title: 'Z', component: Component, order: 100,
    })
    registry.registerPlugin('a-plugin', 'A', {
      id: 'main', title: 'A', component: Component, order: 100,
    })

    expect(registry.getSnapshot().apps.map((app) => app.key)).toEqual([
      'a-plugin:main',
      'z-plugin:main',
    ])
  })

  it('defaults a Plugin App to the Sidebar and refuses an unknown placement', () => {
    registry.registerPlugin('plugin-a', 'Plugin A', {
      id: 'main', title: 'Sidebar by default', component: Component,
    })
    registry.registerPlugin('plugin-b', 'Plugin B', {
      id: 'main', title: 'Settings row', component: Component, placement: 'settings',
    })
    registry.registerCore({
      id: 'tasks', title: 'Tasks', path: '/tasks', component: Component,
    })

    expect(registry.getSnapshot().apps.map((app) => [app.key, app.placement])).toEqual([
      ['core:tasks', 'sidebar'],
      ['plugin-a:main', 'sidebar'],
      ['plugin-b:main', 'settings'],
    ])

    // An unknown placement matches no consumer's filter, so a typo would register
    // an app that appears nowhere. It has to fail loudly instead.
    expect(() => registry.registerPlugin('plugin-c', 'Plugin C', {
      id: 'main',
      title: 'Nowhere',
      component: Component,
      placement: 'sidebbar' as 'sidebar',
    })).toThrow('App placement must be one of sidebar, settings')
    expect(registry.getSnapshot().apps.map((app) => app.key)).not.toContain('plugin-c:main')
  })

  it('adapts legacy Webviews into the same descriptor contract without claiming Native routes', () => {
    const adapted = adaptWebviewApps([
      {
        id: 'legacy-app',
        pluginId: 'legacy-app',
        title: 'Legacy App',
        icon: '/plugin-apps/legacy/icon.png',
        url: '/plugin-apps/legacy-app/index.html',
      },
    ])

    expect(adapted).toEqual([
      expect.objectContaining({
        key: 'webview:legacy-app',
        kind: 'webview',
        routeId: 'legacy-app',
        path: '/apps/legacy-app',
        title: 'Legacy App',
        placement: 'sidebar',
      }),
    ])
  })

  it('resolves a Webview route even when its id matches a Core App', () => {
    registry.registerCore({
      id: 'calendar',
      title: 'Calendar',
      path: '/calendar',
      component: Component,
    })
    const webviews = adaptWebviewApps([{
      id: 'calendar',
      pluginId: 'calendar',
      title: 'Plugin Calendar',
      icon: null,
      url: '/plugin-apps/calendar/app/index.html',
    }])
    const combined = [...registry.getSnapshot().apps, ...webviews]

    expect(findHostedAppByRouteId(combined, 'calendar')).toMatchObject({
      key: 'webview:calendar',
      kind: 'webview',
    })
  })
})
