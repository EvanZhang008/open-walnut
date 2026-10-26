import { describe, expect, it } from 'vitest'
import { AppRegistry, appPathMatches, type RegisteredApp } from '../../web/src/apps/registry.js'
import { createAppPreferences, parseAppPreferences, setAppDisposition } from '../../web/src/apps/preferences.js'
import { railItemKey, railItemShown, railItemsShownFor } from '../../web/src/apps/rail-items.js'
import { builtinEntries, builtinMatches } from '../../web/src/components/apps-page/builtin-apps.js'
import { categoryOf, pluginMatches } from '../../web/src/components/apps-page/categories.js'

const Empty = () => null

/** The core apps as core-apps.tsx registers them, in rail order. */
function coreApps(): RegisteredApp[] {
  const registry = new AppRegistry()
  registry.registerCore({ id: 'home', title: 'Home', path: '/', component: Empty, order: 10, persistent: true, lockVisibility: true })
  registry.registerCore({ id: 'notes', title: 'Notes', path: '/notes', component: Empty, order: 20 })
  registry.registerCore({ id: 'tasks', title: 'Tasks', path: '/tasks', component: Empty, order: 40 })
  registry.registerCore({ id: 'apps', title: 'Apps', path: '/apps', component: Empty, order: 990, lockVisibility: true, exactPath: true })
  registry.registerCore({ id: 'settings', title: 'Settings', path: '/settings', component: Empty, order: 1000, lockVisibility: true })
  return [...registry.getSnapshot().apps].sort((a, b) => a.order - b.order)
}

describe('Apps page: built-in entries', () => {
  it('lists Home, its panels, Org, then the registry apps, in rail order', () => {
    const entries = builtinEntries(coreApps(), createAppPreferences())
    expect(entries.map((entry) => entry.id)).toEqual([
      'home', 'home-todo', 'home-chat', 'home-agenda', 'home-scratchpad', 'org', 'notes', 'tasks', 'apps', 'settings',
    ])
    expect(entries.every((entry) => entry.shown)).toBe(true)
  })

  it('locks exactly Home, Apps and Settings, each with its reason', () => {
    const locked = builtinEntries(coreApps(), createAppPreferences()).filter((entry) => entry.lock)
    expect(locked.map((entry) => entry.id)).toEqual(['home', 'apps', 'settings'])
    expect(locked.every((entry) => (entry.lock ?? '').length > 0)).toBe(true)
  })

  it('reads an app or a rail item as off when unpinned or hidden, and a lock ignores both', () => {
    let prefs = setAppDisposition(createAppPreferences(), 'core:tasks', 'unpinned')
    prefs = setAppDisposition(prefs, railItemKey('org'), 'hidden')
    prefs = setAppDisposition(prefs, 'core:settings', 'hidden')
    const byId = new Map(builtinEntries(coreApps(), prefs).map((entry) => [entry.id, entry]))
    expect(byId.get('tasks')!.shown).toBe(false)
    expect(byId.get('org')!.shown).toBe(false)
    expect(byId.get('notes')!.shown).toBe(true)
    expect(byId.get('settings')!.shown).toBe(true)
    // Back on: `pinned` clears both lists.
    const back = setAppDisposition(prefs, railItemKey('org'), 'pinned')
    expect(railItemShown(back, 'org')).toBe(true)
  })

  it('matches the search on the name and the line', () => {
    const entries = builtinEntries(coreApps(), createAppPreferences())
    expect(entries.filter((entry) => builtinMatches(entry, 'TASK')).map((entry) => entry.id)).toEqual(['home', 'home-todo', 'home-agenda', 'tasks'])
    expect(entries.filter((entry) => builtinMatches(entry, '  ')).length).toBe(entries.length)
  })
})

describe('rail items in app preferences', () => {
  it('survives a round trip through storage, so an older build keeps the keys', () => {
    const prefs = setAppDisposition(createAppPreferences(), railItemKey('home-chat'), 'unpinned')
    const parsed = parseAppPreferences(JSON.stringify(prefs))
    expect(parsed.unpinned).toContain('rail:home-chat')
    expect(railItemShown(parsed, 'home-chat')).toBe(false)
  })

  it('hands back one stable object per preferences snapshot', () => {
    const prefs = createAppPreferences()
    expect(railItemsShownFor(prefs)).toBe(railItemsShownFor(prefs))
    expect(railItemsShownFor(prefs).org).toBe(true)
  })
})

describe('exact app paths', () => {
  it('keeps plugin App pages under /apps from counting as the Apps page', () => {
    const apps = { path: '/apps', exactPath: true }
    expect(appPathMatches(apps, '/apps')).toBe(true)
    expect(appPathMatches(apps, '/apps/walnut-time~main')).toBe(false)
    expect(appPathMatches({ path: '/notes' }, '/notes/a/b')).toBe(true)
    expect(appPathMatches({ path: '/' }, '/notes')).toBe(false)
  })

  it('finds the plugin App, not Apps, for a plugin App path', () => {
    const registry = new AppRegistry()
    registry.registerCore({ id: 'apps', title: 'Apps', path: '/apps', component: Empty, exactPath: true })
    expect(registry.findByPath('/apps')?.id).toBe('apps')
    expect(registry.findByPath('/apps/walnut-time~main')).toBeUndefined()
  })
})

describe('plugin categories on the page', () => {
  it('reads a missing or unknown category as More', () => {
    expect(categoryOf({ category: 'time' })).toBe('time')
    expect(categoryOf({})).toBe('other')
    expect(categoryOf({ category: 'games' })).toBe('other')
  })

  it('matches the name, the id and the description', () => {
    const row = { id: 'ms-todo', name: 'Microsoft To-Do', description: 'Two-way sync' }
    expect(pluginMatches(row, 'to-do')).toBe(true)
    expect(pluginMatches(row, 'MS-TODO')).toBe(true)
    expect(pluginMatches(row, 'two-way')).toBe(true)
    expect(pluginMatches(row, 'slack')).toBe(false)
  })
})
