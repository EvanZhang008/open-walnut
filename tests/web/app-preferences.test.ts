import { describe, expect, it } from 'vitest'
import type { AppPlacement, RegisteredApp } from '../../web/src/apps/registry.js'
import {
  APP_PREFERENCES_KEY,
  createAppPreferences,
  moveApp,
  parseAppPreferences,
  resolveApps,
  setAppDisposition,
} from '../../web/src/apps/preferences.js'
import { syncable } from '../../web/src/utils/ui-prefs-sync.js'

function app(
  key: string,
  order: number,
  lockVisibility = false,
  placement: AppPlacement = 'sidebar',
): RegisteredApp {
  const [owner, id] = key.split(':')
  return {
    key,
    id,
    owner,
    kind: owner === 'core' ? 'core' : 'native',
    title: id,
    path: owner === 'core' ? `/${id}` : `/apps/${owner}~${id}`,
    routeId: owner === 'core' ? id : `${owner}~${id}`,
    component: () => null,
    badge: null,
    order,
    fullBleed: true,
    placement,
    persistent: false,
    lockVisibility,
    generation: 1,
  }
}

describe('App preferences', () => {
  const apps = [
    app('core:home', 10, true),
    app('core:tasks', 20),
    app('plugin-a:main', 30),
    app('core:settings', 1000, true),
  ]

  it('uses a cross-device syncable preference key', () => {
    expect(syncable(APP_PREFERENCES_KEY)).toBe(true)
  })

  it('defaults every current App to pinned in registry order', () => {
    const resolved = resolveApps(apps, createAppPreferences())

    expect(resolved.pinned.map((item) => item.key)).toEqual([
      'core:home',
      'core:tasks',
      'plugin-a:main',
      'core:settings',
    ])
    expect(resolved.discoverable.map((item) => item.key)).toEqual(resolved.pinned.map((item) => item.key))
    expect(resolved.hidden).toEqual([])
  })

  it('keeps unpinned Apps discoverable and removes hidden Apps from launchers', () => {
    let preferences = createAppPreferences()
    preferences = setAppDisposition(preferences, 'plugin-a:main', 'unpinned')
    preferences = setAppDisposition(preferences, 'core:tasks', 'hidden')

    const resolved = resolveApps(apps, preferences)
    expect(resolved.pinned.map((item) => item.key)).toEqual(['core:home', 'core:settings'])
    expect(resolved.discoverable.map((item) => item.key)).toEqual([
      'core:home',
      'plugin-a:main',
      'core:settings',
    ])
    expect(resolved.hidden.map((item) => item.key)).toEqual(['core:tasks'])
  })

  it('routes a settings-placed App to the Settings surface and never to the Sidebar', () => {
    const withSettingsApp = [...apps, app('plugin-time:main', 500, false, 'settings')]
    const resolved = resolveApps(withSettingsApp, createAppPreferences())

    expect(resolved.sidebar.map((item) => item.key)).toEqual([
      'core:home',
      'core:tasks',
      'plugin-a:main',
      'core:settings',
    ])
    expect(resolved.settings.map((item) => item.key)).toEqual(['plugin-time:main'])
    // The Command Palette reads `discoverable`, so placement must not cost the app
    // its keyboard entry, and the App manager reads `all`.
    expect(resolved.discoverable.map((item) => item.key)).toContain('plugin-time:main')
    expect(resolved.all.map((item) => item.key)).toContain('plugin-time:main')
  })

  it('lets hidden remove a settings-placed App while unpinned leaves it alone', () => {
    const withSettingsApp = [...apps, app('plugin-time:main', 500, false, 'settings')]

    // Unpinning is a Sidebar-only idea: a settings row is not a pin, so it stays.
    const unpinned = resolveApps(
      withSettingsApp,
      setAppDisposition(createAppPreferences(), 'plugin-time:main', 'unpinned'),
    )
    expect(unpinned.settings.map((item) => item.key)).toEqual(['plugin-time:main'])
    expect(unpinned.sidebar.map((item) => item.key)).not.toContain('plugin-time:main')

    // Hidden means gone from every launcher, whichever surface the row was on.
    const hidden = resolveApps(
      withSettingsApp,
      setAppDisposition(createAppPreferences(), 'plugin-time:main', 'hidden'),
    )
    expect(hidden.settings).toEqual([])
    expect(hidden.sidebar.map((item) => item.key)).not.toContain('plugin-time:main')
    expect(hidden.hidden.map((item) => item.key)).toEqual(['plugin-time:main'])
  })

  it('never hides or unpins recovery Apps', () => {
    let preferences = createAppPreferences()
    preferences = setAppDisposition(preferences, 'core:home', 'hidden')
    preferences = setAppDisposition(preferences, 'core:settings', 'unpinned')

    const resolved = resolveApps(apps, preferences)
    expect(resolved.pinned.map((item) => item.key)).toContain('core:home')
    expect(resolved.pinned.map((item) => item.key)).toContain('core:settings')
  })

  it('persists explicit order while appending newly installed Apps deterministically', () => {
    let preferences = createAppPreferences()
    preferences = moveApp(preferences, apps.map((item) => item.key), 'plugin-a:main', 'up')
    preferences = moveApp(preferences, apps.map((item) => item.key), 'plugin-a:main', 'up')
    const withNewApp = [...apps, app('plugin-b:main', 40)]

    expect(resolveApps(withNewApp, preferences).pinned.map((item) => item.key)).toEqual([
      'plugin-a:main',
      'core:home',
      'core:tasks',
      'plugin-b:main',
      'core:settings',
    ])
  })

  it('preserves an unavailable App slot while current Apps are reordered', () => {
    const preferences = {
      ...createAppPreferences(),
      order: ['core:home', 'plugin-a:main', 'core:tasks', 'core:settings'],
    }
    const currentKeys = ['core:home', 'core:tasks', 'core:settings']
    const moved = moveApp(preferences, currentKeys, 'core:tasks', 'down')

    expect(moved.order).toEqual([
      'core:home',
      'plugin-a:main',
      'core:settings',
      'core:tasks',
    ])
    expect(resolveApps(apps, moved).all.map((item) => item.key)).toEqual(moved.order)
  })

  it('never inserts a newly installed App above inverted default-order anchors', () => {
    const preferences = {
      ...createAppPreferences(),
      order: ['core:settings', 'core:home', 'core:tasks'],
    }

    expect(resolveApps(apps, preferences).all.map((item) => item.key)).toEqual([
      'core:settings',
      'core:home',
      'core:tasks',
      'plugin-a:main',
    ])
  })

  it('recovers from malformed storage and preserves absent App keys for reinstall', () => {
    expect(parseAppPreferences('{bad json')).toEqual(createAppPreferences())
    const parsed = parseAppPreferences(JSON.stringify({
      version: 1,
      order: ['missing:app', 'plugin-a:main'],
      unpinned: ['missing:app'],
      hidden: ['also-missing:app'],
    }))

    expect(parsed.order).toContain('missing:app')
    expect(parsed.unpinned).toContain('missing:app')
    expect(parsed.hidden).toContain('also-missing:app')
  })
})
