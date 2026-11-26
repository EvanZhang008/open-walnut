import { describe, expect, it } from 'vitest'
import { AppRegistry, appPathMatches, type RegisteredApp } from '../../web/src/apps/registry.js'
import { createAppPreferences, parseAppPreferences, setAppDisposition, setAppOnSidebar } from '../../web/src/apps/preferences.js'
import { RAIL_ITEM_IDS, railItemKey, railItemShown, railItemsShownFor } from '../../web/src/apps/rail-items.js'
import { CORE_APPS } from '../../web/src/apps/core-app-list.js'
import { RAIL_ITEM_OWNER, builtinEntries, builtinMatches, builtinParts, builtinsMatching, builtinsShown, partsStatus, type BuiltinEntry, type HeldPlugin } from '../../web/src/components/apps-page/builtin-apps.js'
import { categoryOf, pluginMatches } from '../../web/src/components/apps-page/categories.js'

const Empty = () => null

/** The core apps as core-apps.tsx registers them, in rail order. */
function coreApps(): RegisteredApp[] {
  const registry = new AppRegistry()
  registry.registerCore({ id: 'home', title: 'Home', path: '/', component: Empty, order: 10, persistent: true, lockVisibility: true })
  registry.registerCore({ id: 'notes', title: 'Notes', path: '/notes', component: Empty, order: 20 })
  registry.registerCore({ id: 'calendar', title: 'Calendar', path: '/calendar', component: Empty, order: 30 })
  registry.registerCore({ id: 'tasks', title: 'Tasks', path: '/tasks', component: Empty, order: 40 })
  registry.registerCore({ id: 'apps', title: 'Apps', path: '/apps', component: Empty, order: 990, lockVisibility: true, exactPath: true })
  registry.registerCore({ id: 'settings', title: 'Settings', path: '/settings', component: Empty, order: 1000, lockVisibility: true })
  return [...registry.getSnapshot().apps].sort((a, b) => a.order - b.order)
}

/** Every core app the console registers (core-app-list.ts), as the registry holds them. */
function everyCoreApp(): RegisteredApp[] {
  const registry = new AppRegistry()
  for (const app of CORE_APPS) registry.registerCore({ ...app, component: Empty })
  return [...registry.getSnapshot().apps].sort((a, b) => a.order - b.order)
}

const partIds = (entry: BuiltinEntry) => entry.parts.map((part) => part.id)

describe('Apps page: one card per app, with its parts', () => {
  it('lists Org, Home, then the registry apps in rail order; a side bar is a part of its app', () => {
    const entries = builtinEntries(coreApps(), createAppPreferences())
    expect(entries.map((entry) => entry.id)).toEqual(['org', 'home', 'notes', 'calendar', 'tasks', 'apps', 'settings'])
    const byId = new Map(entries.map((entry) => [entry.id, entry]))
    // Evan 2026-11-21: Agenda is Calendar's side bar and Scratchpad is Notes', not apps of their own.
    expect(partIds(byId.get('calendar')!)).toEqual(['calendar', 'home-agenda'])
    expect(partIds(byId.get('notes')!)).toEqual(['notes', 'home-scratchpad'])
    expect(partIds(byId.get('home')!)).toEqual(['home', 'home-todo', 'home-chat'])
    expect(byId.get('calendar')!.parts.map((part) => part.kind)).toEqual(['page', 'side-bar'])
    expect(byId.get('home')!.parts.map((part) => part.kind)).toEqual(['page', 'home-panel', 'home-panel'])
    expect(entries.every((entry) => entry.shown)).toBe(true)
  })

  it('names the plugin that carries an app (Calendar, and Mail through requiresPlugin)', () => {
    const byId = new Map(builtinEntries(everyCoreApp(), createAppPreferences()).map((entry) => [entry.id, entry]))
    expect(byId.get('calendar')!.plugin).toBe('calendar')
    expect(byId.get('mail')!.plugin).toBe('mail')
    expect(byId.get('notes')!.plugin).toBeUndefined()
  })

  it('a phone has no side bars, so Calendar and Notes are their page alone there', () => {
    const byId = new Map(builtinEntries(coreApps(), createAppPreferences(), { phone: true }).map((entry) => [entry.id, entry]))
    expect(partIds(byId.get('calendar')!)).toEqual(['calendar'])
    expect(partIds(byId.get('notes')!)).toEqual(['notes'])
    expect(partIds(byId.get('home')!)).toEqual(['home', 'home-todo', 'home-chat'])
  })

  it('locks exactly the pages of Home, Apps and Settings, each with its reason; Home\'s panels stay switchable', () => {
    const entries = builtinEntries(coreApps(), createAppPreferences())
    expect(entries.filter((entry) => entry.lock).map((entry) => entry.id)).toEqual(['home', 'apps', 'settings'])
    const lockedParts = builtinParts(entries).filter((part) => part.lock)
    expect(lockedParts.map((part) => part.id)).toEqual(['home', 'apps', 'settings'])
    expect(lockedParts.every((part) => (part.lock ?? '').length > 0)).toBe(true)
  })

  it('reads each part off when unpinned or hidden, under the keys the rail always used', () => {
    let prefs = setAppDisposition(createAppPreferences(), 'core:tasks', 'unpinned')
    prefs = setAppDisposition(prefs, railItemKey('org'), 'hidden')
    prefs = setAppDisposition(prefs, railItemKey('home-agenda'), 'unpinned')
    prefs = setAppDisposition(prefs, 'core:settings', 'hidden')
    const entries = builtinEntries(coreApps(), prefs)
    const byId = new Map(entries.map((entry) => [entry.id, entry]))
    const parts = new Map(builtinParts(entries).map((part) => [part.id, part]))
    expect(byId.get('tasks')!.shown).toBe(false)
    expect(byId.get('org')!.shown).toBe(false)
    expect(parts.get('home-agenda')!.shown).toBe(false)
    expect(parts.get('home-agenda')!.key).toBe('rail:home-agenda')
    expect(parts.get('calendar')!.shown).toBe(true)
    // The card is on the sidebar while any part is, and says how many.
    expect(byId.get('calendar')!.shown).toBe(true)
    expect(partsStatus(byId.get('calendar')!)).toEqual({ text: '1 of 2 on the sidebar', tone: 'on' })
    expect(partsStatus(byId.get('tasks')!)).toEqual({ text: 'Only in Apps', tone: 'off' })
    expect(partsStatus(byId.get('settings')!)).toEqual({ text: 'Always on the sidebar', tone: 'fixed' })
    // Home's page is locked but its panels can go: it reads on, never fixed.
    expect(partsStatus(byId.get('home')!)).toEqual({ text: 'On the sidebar', tone: 'on' })
    expect(parts.get('settings')!.shown).toBe(true)
    const back = setAppDisposition(prefs, railItemKey('org'), 'pinned')
    expect(railItemShown(back, 'org')).toBe(true)
  })

  it('reads a quiet_rail app as off until switched on, while the experiment is on', () => {
    const quiet = coreApps().map((app) => (app.id === 'tasks' ? { ...app, quietRail: true } : app))
    const byId = (prefs = createAppPreferences(), quietRail = true) =>
      new Map(builtinEntries(quiet, prefs, { quietRail }).map((entry) => [entry.id, entry]))
    expect(byId().get('tasks')!.shown).toBe(false)
    expect(byId().get('notes')!.shown).toBe(true)
    expect(byId(createAppPreferences(), false).get('tasks')!.shown).toBe(true)
    const on = setAppOnSidebar(createAppPreferences(), quiet.find((app) => app.id === 'tasks')!, true, true)
    expect(byId(on).get('tasks')!.shown).toBe(true)
  })

  it('matches the search on the name, the line, a part and what the held plugin adds', () => {
    const entries = builtinEntries(coreApps(), createAppPreferences())
    expect(entries.filter((entry) => builtinMatches(entry, 'TASK')).map((entry) => entry.id)).toEqual(['home', 'tasks'])
    expect(entries.filter((entry) => builtinMatches(entry, 'agenda')).map((entry) => entry.id)).toEqual(['calendar'])
    expect(entries.filter((entry) => builtinMatches(entry, 'scratch')).map((entry) => entry.id)).toEqual(['notes'])
    // A part's old line still finds its app ("quick note pad" found the Scratchpad card before).
    expect(entries.filter((entry) => builtinMatches(entry, 'quick note pad')).map((entry) => entry.id)).toEqual(['notes'])
    const calendar = entries.find((entry) => entry.id === 'calendar')!
    expect(builtinMatches(calendar, 'eventkit')).toBe(false)
    expect(builtinMatches(calendar, 'eventkit', ['Reads the Mac calendars through EventKit'])).toBe(true)
    expect(entries.filter((entry) => builtinMatches(entry, '  ')).length).toBe(entries.length)
  })
})

/**
 * The class guard (2026-11-21: Calendar, its plugin and Agenda were three cards, and the
 * plugin card had no Open): every built-in page and every rail item is a part of exactly one
 * card, every card opens, and every part that may leave the sidebar has a switch. A new core
 * app or rail item that breaks this fails here.
 */
describe('Apps page: every app opens, and every part has its sidebar answer', () => {
  for (const phone of [false, true]) {
    it(`holds every core app and rail item once, each card opens${phone ? ' (phone)' : ''}`, () => {
      const entries = builtinEntries(everyCoreApp(), createAppPreferences(), { phone })
      const keys = builtinParts(entries).map((part) => part.key)
      expect(new Set(keys).size).toBe(keys.length)
      const expected = [
        ...CORE_APPS.map((app) => `core:${app.id}`),
        // A phone draws no side bar, whichever rail items are side bars.
        ...RAIL_ITEM_IDS.filter((id) => !phone || builtinParts(builtinEntries(everyCoreApp(), createAppPreferences())).find((part) => part.id === id)?.kind !== 'side-bar').map(railItemKey),
      ]
      expect([...keys].sort()).toEqual([...expected].sort())
      for (const entry of entries) {
        expect(entry.parts.length, entry.id).toBeGreaterThan(0)
        expect(entry.openPath, entry.id).toMatch(/^\//)
        expect(entry.parts[0].kind, entry.id).toBe('page')
        for (const part of entry.parts) {
          // Either a lock with its reason, or the part answers on/off from the preferences.
          expect(part.lock === undefined || part.lock.length > 0, part.id).toBe(true)
          expect(typeof part.shown, part.id).toBe('boolean')
          expect(part.path, part.id).toMatch(/^\//)
        }
      }
    })
  }

  it('gives every rail item an owner that is a core app, or makes it an app of its own', () => {
    const coreIds = new Set(CORE_APPS.map((app) => app.id as string))
    for (const id of RAIL_ITEM_IDS) {
      const owner = RAIL_ITEM_OWNER[id]
      if (owner !== undefined) expect(coreIds.has(owner), id).toBe(true)
    }
  })

  it('keeps a part whose app is not registered here as a card of its own, never losing it', () => {
    const noCalendar = coreApps().filter((app) => app.id !== 'calendar')
    const entries = builtinEntries(noCalendar, createAppPreferences())
    expect(entries.find((entry) => entry.id === 'home-agenda')?.parts.map((part) => part.id)).toEqual(['home-agenda'])
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
    // As the router matches: any case, a trailing slash (the phone bar names the page from this).
    expect(appPathMatches(apps, '/APPS')).toBe(true)
    expect(appPathMatches(apps, '/apps/')).toBe(true)
    expect(appPathMatches(apps, '/%61pps')).toBe(true)
    expect(appPathMatches({ path: '/routines' }, '/Routines')).toBe(true)
    expect(appPathMatches({ path: '/' }, '/')).toBe(true)
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

describe('Apps page: the cards a held plugin shapes', () => {
  const mailOff = () => builtinEntries(everyCoreApp(), createAppPreferences(), { activePlugins: new Set(['calendar']) })
  it('keeps Mail\'s card while its plugin is off, when the plugin row is there to turn it on', () => {
    const entries = mailOff()
    expect(entries.find((entry) => entry.id === 'mail')?.pluginOff).toBe(true)
    expect(entries.find((entry) => entry.id === 'calendar')?.pluginOff).toBeUndefined()
    const held = new Map<string, HeldPlugin>([['core:mail', { category: 'communication', text: ['Mail'] }]])
    expect(builtinsShown(entries, held).map((entry) => entry.id)).toContain('mail')
    // No installed row: nothing could turn it on, so no card.
    expect(builtinsShown(entries, new Map()).map((entry) => entry.id)).not.toContain('mail')
  })
  it('narrows by the held plugin\'s category and its text', () => {
    const entries = builtinEntries(everyCoreApp(), createAppPreferences())
    const held = new Map<string, HeldPlugin>([
      ['core:calendar', { category: 'time', text: ['Calendar', 'Reads the Mac calendars'] }],
      ['core:mail', { category: 'communication', text: ['Mail', 'IMAP Mail'] }],
    ])
    expect(builtinsMatching(entries, held, '', 'time').map((entry) => entry.id)).toEqual(['calendar'])
    expect(builtinsMatching(entries, held, 'imap').map((entry) => entry.id)).toEqual(['mail'])
    expect(builtinsMatching(entries, held, '').length).toBe(entries.length)
  })
})
