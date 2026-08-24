import { describe, expect, it } from 'vitest'
import type { AppPlacement, RegisteredApp } from '../../web/src/apps/registry.js'
import {
  APP_PREFERENCES_KEY,
  createAppPreferences,
  effectiveAppPlacement,
  moveApp,
  parseAppPreferences,
  resolveApps,
  setAppDisposition,
  setAppPlacement,
  supportsPlacementOverride,
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

  it('lets a user override the declared placement in both directions', () => {
    const withSettingsApp = [...apps, app('plugin-time:main', 500, false, 'settings')]

    // Declared 'settings', user drags it out to the sidebar.
    const toSidebar = setAppPlacement(createAppPreferences(), 'plugin-time:main', 'sidebar')
    const pulledOut = resolveApps(withSettingsApp, toSidebar)
    expect(pulledOut.sidebar.map((item) => item.key)).toContain('plugin-time:main')
    expect(pulledOut.settings).toEqual([])

    // Declared 'sidebar', user files it away in Settings.
    const toSettings = setAppPlacement(createAppPreferences(), 'plugin-a:main', 'settings')
    const filedAway = resolveApps(withSettingsApp, toSettings)
    expect(filedAway.settings.map((item) => item.key)).toEqual(['plugin-a:main', 'plugin-time:main'])
    expect(filedAway.sidebar.map((item) => item.key)).not.toContain('plugin-a:main')
    // Placement is not visibility: the palette and the App manager still list it.
    expect(filedAway.discoverable.map((item) => item.key)).toContain('plugin-a:main')
  })

  it('returns an overridden App to the Sidebar pin rules, and Restore defaults undoes the move', () => {
    const moved = setAppPlacement(createAppPreferences(), 'plugin-a:main', 'settings')
    // Unpinned only concerns the Sidebar, so the settings row survives it...
    const unpinnedInSettings = setAppDisposition(moved, 'plugin-a:main', 'unpinned')
    expect(resolveApps(apps, unpinnedInSettings).settings.map((item) => item.key)).toEqual(['plugin-a:main'])

    // ...and once it is back on the Sidebar the same unpinned flag bites again.
    const backToSidebar = setAppPlacement(unpinnedInSettings, 'plugin-a:main', 'sidebar')
    const resolved = resolveApps(apps, backToSidebar)
    expect(resolved.settings).toEqual([])
    expect(resolved.sidebar.map((item) => item.key)).not.toContain('plugin-a:main')
    expect(resolved.discoverable.map((item) => item.key)).toContain('plugin-a:main')

    // Restore defaults drops overrides along with everything else.
    expect(createAppPreferences().placement).toEqual({})
    expect(resolveApps(apps, createAppPreferences()).sidebar.map((item) => item.key))
      .toContain('plugin-a:main')
  })

  it('keeps hidden winning over any placement override', () => {
    let preferences = setAppPlacement(createAppPreferences(), 'plugin-a:main', 'settings')
    preferences = setAppDisposition(preferences, 'plugin-a:main', 'hidden')

    const resolved = resolveApps(apps, preferences)
    expect(resolved.settings).toEqual([])
    expect(resolved.sidebar.map((item) => item.key)).not.toContain('plugin-a:main')
    expect(resolved.hidden.map((item) => item.key)).toEqual(['plugin-a:main'])
  })

  it('ignores a placement override for Apps that cannot honour one', () => {
    const webview = { ...app('webview:legacy', 600), kind: 'webview' as const }
    const catalog = [...apps, webview]
    let preferences = setAppPlacement(createAppPreferences(), 'core:tasks', 'settings')
    preferences = setAppPlacement(preferences, 'webview:legacy', 'settings')

    expect(supportsPlacementOverride(webview)).toBe(false)
    expect(supportsPlacementOverride(app('core:tasks', 20))).toBe(false)
    expect(supportsPlacementOverride(app('plugin-a:main', 30))).toBe(true)

    const resolved = resolveApps(catalog, preferences)
    expect(resolved.settings).toEqual([])
    expect(resolved.sidebar.map((item) => item.key)).toEqual([
      'core:home',
      'core:tasks',
      'plugin-a:main',
      'webview:legacy',
      'core:settings',
    ])
  })

  it('survives a round trip and shrugs off an override for an App that is gone', () => {
    const stored = setAppPlacement(createAppPreferences(), 'plugin-time:main', 'sidebar')
    const parsed = parseAppPreferences(JSON.stringify(stored))
    expect(parsed.placement).toEqual({ 'plugin-time:main': 'sidebar' })

    // The plugin is uninstalled: the override must neither resurrect it nor throw,
    // and it is kept so a reinstall lands back where the user put it.
    expect(() => resolveApps(apps, parsed)).not.toThrow()
    expect(resolveApps(apps, parsed).all.map((item) => item.key)).not.toContain('plugin-time:main')
    expect(parseAppPreferences(JSON.stringify(parsed)).placement['plugin-time:main']).toBe('sidebar')
  })

  it('drops a placement value this build cannot render, rather than hiding the App nowhere', () => {
    const parsed = parseAppPreferences(JSON.stringify({
      version: 1,
      order: [],
      unpinned: [],
      hidden: [],
      placement: { 'plugin-a:main': 'sidebbar', 'plugin-b:main': 'settings', '': 'settings' },
    }))

    expect(parsed.placement).toEqual({ 'plugin-b:main': 'settings' })
    expect(effectiveAppPlacement(app('plugin-a:main', 30), parsed)).toBe('sidebar')
    expect(resolveApps(apps, parsed).sidebar.map((item) => item.key)).toContain('plugin-a:main')
  })

  it('reads a legacy stored preference with no placement map at all', () => {
    const parsed = parseAppPreferences(JSON.stringify({
      version: 1,
      order: ['core:home'],
      unpinned: [],
      hidden: [],
    }))

    expect(parsed.placement).toEqual({})
    const withSettingsApp = [...apps, app('plugin-time:main', 500, false, 'settings')]
    expect(resolveApps(withSettingsApp, parsed).settings.map((item) => item.key))
      .toEqual(['plugin-time:main'])
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
