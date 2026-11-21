/**
 * Experiment apps_stay_open: the apps open on the Sidebar, the recently used and the pinned
 * (web/src/apps/preferences.ts, the record; web/src/apps/store.ts, its storage). Pinned here
 * is the Apps page's own list and never the Sidebar's pin, so the Sidebar preferences are
 * checked to stay exactly as they were.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppPlacement, RegisteredApp } from '../../web/src/apps/registry.js'
import {
  APP_ACTIVITY_KEY,
  APP_PINS_KEY,
  APP_PREFERENCES_KEY,
  APP_RECENT_MAX,
  closeAppActivity,
  createAppActivity,
  createAppPins,
  createAppPreferences,
  findAppByPath,
  openAppActivity,
  parseAppActivity,
  parseAppPins,
  parseAppPreferences,
  resolveAppActivity,
  resolveApps,
  setAppDisposition,
  setAppPinned,
  setAppOnSidebar,
  tracksAppActivity,
  type AppDisposition,
  type SidebarDefault,
} from '../../web/src/apps/preferences.js'

const SIDEBAR_DEFAULTS: SidebarDefault[] = ['declared', 'by-hand']
import { EXPERIMENTAL_FEATURES, experimentalEnabled } from '../../src/core/experimental.js'
import { syncable } from '../../web/src/utils/ui-prefs-sync.js'

function app(key: string, order: number, options: { lock?: boolean; placement?: AppPlacement; path?: string; exactPath?: boolean } = {}): RegisteredApp {
  const [owner, id] = key.split(':')
  return {
    key,
    id,
    owner,
    kind: owner === 'core' ? 'core' : 'native',
    title: id,
    path: options.path ?? (owner === 'core' ? `/${id}` : `/apps/${owner}~${id}`),
    routeId: owner === 'core' ? id : `${owner}~${id}`,
    component: () => null,
    badge: null,
    order,
    fullBleed: true,
    placement: options.placement ?? 'sidebar',
    persistent: false,
    lockVisibility: options.lock ?? false,
    generation: 1,
    ...(options.exactPath ? { exactPath: true } : {}),
  }
}

const HOME = app('core:home', 10, { lock: true, path: '/' })
const NOTES = app('core:notes', 20)
const APPS = app('core:apps', 990, { lock: true, exactPath: true })
const SETTINGS = app('core:settings', 1000, { lock: true })
const TIME = app('walnut-time:main', 500, { placement: 'settings' })
const OTHER = app('other:main', 510, { placement: 'settings' })
const CATALOG = [HOME, NOTES, TIME, OTHER, APPS, SETTINGS]

const keys = (apps: RegisteredApp[]) => apps.map((item) => item.key)
const NO_PINS = createAppPins()

describe('the experiment', () => {
  it('is registered off, so an install that never chose it keeps today\'s rail and page', () => {
    const feature = EXPERIMENTAL_FEATURES.find((f) => f.id === 'apps_stay_open')
    expect(feature?.default).toBe(false)
    expect(experimentalEnabled(undefined, 'apps_stay_open')).toBe(false)
    expect(experimentalEnabled({ apps_stay_open: true }, 'apps_stay_open')).toBe(true)
    expect(EXPERIMENTAL_FEATURES.find((f) => f.id === 'drawing_app')?.default).toBe(false)
  })
})

describe('app activity record', () => {
  it('lives under its own device-local keys, apart from the synced Sidebar preferences', () => {
    expect(new Set([APP_ACTIVITY_KEY, APP_PINS_KEY, APP_PREFERENCES_KEY]).size).toBe(3)
    expect(syncable(APP_ACTIVITY_KEY)).toBe(false)
    expect(syncable(APP_PINS_KEY)).toBe(false)
    expect(syncable(APP_PREFERENCES_KEY)).toBe(true)
  })

  it('reads empty from nothing, junk, a non-object or a version it does not know', () => {
    for (const raw of [null, '', '{not json', 'null', '42', '"text"', '[]', JSON.stringify({ version: 2, open: ['a:b'] }), JSON.stringify({ open: ['a:b'] })]) {
      expect(parseAppActivity(raw)).toEqual(createAppActivity())
      expect(parseAppPins(raw)).toEqual(createAppPins())
    }
  })

  it('keeps the good lists of a half-broken record and drops what is not a key', () => {
    const parsed = parseAppActivity(JSON.stringify({ version: 1, open: ['a:b', 7, '', 'a:b', null, 'c:d'], recent: 'nope', pinned: { x: 1 } }))
    expect(parsed).toEqual({ version: 1, open: ['a:b', 'c:d'], recent: [] })
    expect(parseAppPins(JSON.stringify({ version: 1, pinned: ['a:b', 3, 'a:b', 'e:f'] }))).toEqual({ version: 1, pinned: ['a:b', 'e:f'] })
    expect(parseAppPins(JSON.stringify({ version: 1, pinned: { x: 1 } }))).toEqual(createAppPins())
  })

  it('bounds every list, so a hand-edited record stays small', () => {
    const many = Array.from({ length: 500 }, (_, i) => `p${i}:main`)
    const parsed = parseAppActivity(JSON.stringify({ version: 1, open: many, recent: many }))
    expect(parsed.recent).toHaveLength(APP_RECENT_MAX)
    expect(parsed.open.length).toBeLessThanOrEqual(64)
    expect(parseAppPins(JSON.stringify({ version: 1, pinned: many })).pinned.length).toBeLessThanOrEqual(64)
  })

  it('leaves an older or current Sidebar preferences record exactly as it read before', () => {
    const v1 = JSON.stringify({ version: 1, order: ['core:notes', 'walnut-time:main'], unpinned: ['core:notes'], hidden: [] })
    const v2 = JSON.stringify({ version: 2, order: ['walnut-time:main'], unpinned: [], hidden: ['other:main'], placement: { 'walnut-time:main': 'sidebar' } })
    expect(parseAppPreferences(v1)).toEqual({ version: 2, order: ['walnut-time:main'], unpinned: ['core:notes'], hidden: [], placement: {} })
    expect(parseAppPreferences(v2)).toEqual({ version: 2, order: ['walnut-time:main'], unpinned: [], hidden: ['other:main'], placement: { 'walnut-time:main': 'sidebar' } })
    // The two records never read each other's shape.
    expect(parseAppActivity(v2)).toEqual(createAppActivity())
    expect(parseAppPins(v2)).toEqual(createAppPins())
    expect(parseAppPreferences(JSON.stringify({ version: 1, open: ['a:b'], recent: [] }))).toEqual(createAppPreferences())
  })
})

describe('app activity lifecycle', () => {
  it('opens, stays open on a second open, closes to recent and opens again', () => {
    let activity = openAppActivity(createAppActivity(), TIME.key)
    expect(activity).toMatchObject({ open: [TIME.key], recent: [TIME.key] })
    // Moving inside the app (or a re-render) changes nothing and writes nothing.
    expect(openAppActivity(activity, TIME.key)).toBe(activity)

    activity = openAppActivity(activity, OTHER.key)
    expect(activity).toMatchObject({ open: [TIME.key, OTHER.key], recent: [OTHER.key, TIME.key] })
    // Back to the first: the open order holds, recent moves it to the front.
    activity = openAppActivity(activity, TIME.key)
    expect(activity).toMatchObject({ open: [TIME.key, OTHER.key], recent: [TIME.key, OTHER.key] })

    activity = closeAppActivity(activity, TIME.key)
    expect(activity).toMatchObject({ open: [OTHER.key], recent: [TIME.key, OTHER.key] })
    expect(closeAppActivity(activity, TIME.key)).toBe(activity)

    activity = openAppActivity(activity, TIME.key)
    expect(activity.open).toEqual([OTHER.key, TIME.key])
  })

  it('keeps the newest recently used apps, most recent first', () => {
    let activity = createAppActivity()
    for (let i = 0; i < APP_RECENT_MAX + 5; i++) activity = closeAppActivity(openAppActivity(activity, `p${i}:main`), `p${i}:main`)
    expect(activity.open).toEqual([])
    expect(activity.recent).toHaveLength(APP_RECENT_MAX)
    expect(activity.recent[0]).toBe(`p${APP_RECENT_MAX + 4}:main`)
    expect(activity.recent).not.toContain('p0:main')
  })

  it('pins and unpins on the Apps page without touching the Sidebar preferences', () => {
    const preferences = setAppDisposition(createAppPreferences(), NOTES.key, 'unpinned')
    let pins = setAppPinned(createAppPins(), TIME.key, true)
    expect(setAppPinned(pins, TIME.key, true)).toBe(pins)
    pins = setAppPinned(pins, NOTES.key, true)
    expect(pins.pinned).toEqual([TIME.key, NOTES.key])
    pins = setAppPinned(pins, TIME.key, false)
    expect(pins.pinned).toEqual([NOTES.key])
    expect(setAppPinned(pins, 'never:pinned', false)).toBe(pins)
    // The Sidebar still has exactly what it had: Notes stays off it, Time stays where its plugin put it.
    const resolved = resolveApps(CATALOG, preferences)
    expect(keys(resolved.sidebar)).toEqual(['core:home', 'core:apps', 'core:settings'])
    // Pinned before it was ever opened (the plugin page's Pin on Apps): it is listed all the same.
    expect(keys(resolveAppActivity(createAppActivity(), pins, resolved).pinned)).toEqual([NOTES.key])
  })

  it('never records the locked apps (Home, Apps, Settings)', () => {
    expect([HOME, APPS, SETTINGS].map(tracksAppActivity)).toEqual([false, false, false])
    expect([NOTES, TIME].map(tracksAppActivity)).toEqual([true, true])
  })
})

describe('resolving the activity against the catalogue', () => {
  const opened = [TIME.key, OTHER.key, NOTES.key, 'gone:app', HOME.key].reduce(openAppActivity, createAppActivity())

  it('draws an open row only for an app with no Sidebar row of its own', () => {
    const resolved = resolveApps(CATALOG, createAppPreferences())
    expect(keys(resolveAppActivity(opened, NO_PINS, resolved).open)).toEqual([TIME.key, OTHER.key])
  })

  it('leaves out unknown and locked keys but keeps them in the record', () => {
    const view = resolveAppActivity(opened, NO_PINS, resolveApps(CATALOG, createAppPreferences()))
    expect(keys(view.open)).toEqual([TIME.key, OTHER.key])
    expect(opened.open).toContain('gone:app')
    expect(opened.recent).toContain(HOME.key)
  })

  it('keeps a hidden app the person opened on the Sidebar, and out of what it offers unasked', () => {
    const preferences = setAppDisposition(createAppPreferences(), OTHER.key, 'hidden')
    const view = resolveAppActivity(opened, setAppPinned(createAppPins(), OTHER.key, true), resolveApps(CATALOG, preferences))
    expect(keys(view.open)).toEqual([TIME.key, OTHER.key])
    expect(keys(view.recent)).toEqual([NOTES.key, TIME.key])
    expect(keys(view.pinned)).toEqual([])
    // Hiding closes it (Sidebar.tsx): closed, it has no row anywhere.
    const closed = resolveAppActivity(closeAppActivity(opened, OTHER.key), NO_PINS, resolveApps(CATALOG, preferences))
    expect(keys(closed.open)).toEqual([TIME.key])
  })

  it('brings an app back when its plugin is turned on again', () => {
    const withoutTime = resolveApps(CATALOG.filter((item) => item !== TIME), createAppPreferences())
    expect(keys(resolveAppActivity(opened, NO_PINS, withoutTime).open)).toEqual([OTHER.key])
    expect(keys(resolveAppActivity(opened, NO_PINS, resolveApps(CATALOG, createAppPreferences())).open)).toEqual([TIME.key, OTHER.key])
  })

  it('draws an unpinned core app as open, and drops it from Open once it is on the Sidebar again', () => {
    const off = setAppDisposition(createAppPreferences(), NOTES.key, 'unpinned')
    expect(keys(resolveAppActivity(opened, NO_PINS, resolveApps(CATALOG, off)).open)).toEqual([TIME.key, OTHER.key, NOTES.key])
    const on = setAppDisposition(off, NOTES.key, 'pinned')
    expect(keys(resolveAppActivity(opened, NO_PINS, resolveApps(CATALOG, on)).open)).toEqual([TIME.key, OTHER.key])
  })

  it('lists a pinned app under Pinned only, not again under Recently used', () => {
    const view = resolveAppActivity(opened, setAppPinned(createAppPins(), TIME.key, true), resolveApps(CATALOG, createAppPreferences()))
    expect(keys(view.pinned)).toEqual([TIME.key])
    expect(keys(view.recent)).toEqual([NOTES.key, OTHER.key])
  })
})

describe('which app a path is', () => {
  it('takes the longest match, so Home and the Apps page never claim an App\'s page', () => {
    expect(findAppByPath(CATALOG, '/')?.key).toBe(HOME.key)
    expect(findAppByPath(CATALOG, '/apps')?.key).toBe(APPS.key)
    expect(findAppByPath(CATALOG, '/apps/walnut-time~main')?.key).toBe(TIME.key)
    expect(findAppByPath(CATALOG, '/apps/walnut-time~main/week/2')?.key).toBe(TIME.key)
    expect(findAppByPath(CATALOG, '/notes/some/note.md')?.key).toBe(NOTES.key)
    // A bookmark to an App that is gone is nobody's page.
    expect(findAppByPath(CATALOG, '/apps/gone~app')).toBeUndefined()
    expect(findAppByPath(CATALOG, '/nowhere')).toBeUndefined()
  })

  it('prefers the nested app whatever the catalogue order', () => {
    const parent = app('core:docs', 30, { path: '/docs' })
    const child = app('core:guide', 40, { path: '/docs/guide' })
    expect(findAppByPath([parent, child], '/docs/guide/intro')?.key).toBe(child.key)
    expect(findAppByPath([child, parent], '/docs/guide/intro')?.key).toBe(child.key)
    expect(findAppByPath([child, parent], '/docs/other')?.key).toBe(parent.key)
    expect(findAppByPath([parent, child], '/docsx')).toBeUndefined()
  })
})

describe('app activity storage across tabs', () => {
  class MemoryStorage {
    data = new Map<string, string>()
    getItem(key: string) { return this.data.get(key) ?? null }
    setItem(key: string, value: string) { this.data.set(key, String(value)) }
    removeItem(key: string) { this.data.delete(key) }
  }
  let storage: MemoryStorage
  let storageListeners: Array<(event: { key: string | null; newValue: string | null }) => void>

  beforeEach(() => {
    vi.resetModules()
    storage = new MemoryStorage()
    storageListeners = []
    vi.stubGlobal('localStorage', storage)
    vi.stubGlobal('window', {
      addEventListener: (type: string, listener: (event: { key: string | null; newValue: string | null }) => void) => {
        if (type === 'storage') storageListeners.push(listener)
      },
    })
  })
  afterEach(() => { vi.unstubAllGlobals() })

  const store = () => import('../../web/src/apps/store.js')
  const otherTabWrites = (value: object) => {
    const raw = JSON.stringify(value)
    storage.setItem(APP_ACTIVITY_KEY, raw)
    return raw
  }

  it('persists open, recent and pinned, and a reload reads them back', async () => {
    const tab = await store()
    tab.markAppOpened(TIME.key)
    tab.updateAppPinned(TIME.key, true)
    tab.markAppClosed(TIME.key)
    expect(JSON.parse(storage.getItem(APP_ACTIVITY_KEY)!)).toEqual({ version: 1, open: [], recent: [TIME.key] })
    expect(JSON.parse(storage.getItem(APP_PINS_KEY)!)).toEqual({ version: 1, pinned: [TIME.key] })
    vi.resetModules()
    const reloaded = await store()
    expect(reloaded.getAppActivity()).toEqual({ version: 1, open: [], recent: [TIME.key] })
    expect(reloaded.getAppPins()).toEqual({ version: 1, pinned: [TIME.key] })
  })

  it('applies a change to what storage holds now, so another tab\'s write not yet heard is kept', async () => {
    const tab = await store()
    const seen = vi.fn()
    tab.subscribeAppActivity(seen)
    expect(tab.getAppActivity().open).toEqual([])
    // Another tab opened Other; its storage event has not reached this tab yet.
    otherTabWrites({ version: 1, open: [OTHER.key], recent: [OTHER.key] })
    tab.markAppOpened(TIME.key)
    expect(tab.getAppActivity()).toMatchObject({ open: [OTHER.key, TIME.key], recent: [TIME.key, OTHER.key] })
    expect(JSON.parse(storage.getItem(APP_ACTIVITY_KEY)!).open).toEqual([OTHER.key, TIME.key])
    expect(seen).toHaveBeenCalledTimes(1)
  })

  it('follows another tab\'s change through the storage event, junk included', async () => {
    const tab = await store()
    const seen = vi.fn()
    tab.subscribeAppActivity(seen)
    const raw = otherTabWrites({ version: 1, open: [TIME.key], recent: [TIME.key] })
    for (const listener of storageListeners) listener({ key: APP_ACTIVITY_KEY, newValue: raw })
    expect(tab.getAppActivity().open).toEqual([TIME.key])
    for (const listener of storageListeners) listener({ key: APP_ACTIVITY_KEY, newValue: '{broken' })
    expect(tab.getAppActivity()).toEqual(createAppActivity())
    // Another key is not ours.
    for (const listener of storageListeners) listener({ key: 'something-else', newValue: raw })
    expect(seen).toHaveBeenCalledTimes(2)
  })

  it('writes nothing for an open that changes nothing, and survives a corrupt record', async () => {
    storage.setItem(APP_ACTIVITY_KEY, '{broken')
    const tab = await store()
    expect(tab.getAppActivity()).toEqual(createAppActivity())
    tab.markAppOpened(TIME.key)
    const written = storage.getItem(APP_ACTIVITY_KEY)
    const seen = vi.fn()
    tab.subscribeAppActivity(seen)
    tab.markAppOpened(TIME.key)
    tab.markAppClosed('never:opened')
    tab.updateAppPinned('never:pinned', false)
    expect(storage.getItem(APP_ACTIVITY_KEY)).toBe(written)
    expect(storage.getItem(APP_PINS_KEY)).toBeNull()
    expect(seen).not.toHaveBeenCalled()
  })

  it('never writes the pins on a navigation, so a busy tab cannot undo a pin made in another', async () => {
    const tab = await store()
    tab.markAppOpened(OTHER.key)
    // Another tab pins Time; this tab keeps opening and closing apps before it hears of it.
    storage.setItem(APP_PINS_KEY, JSON.stringify({ version: 1, pinned: [TIME.key] }))
    tab.markAppOpened(TIME.key)
    tab.markAppClosed(OTHER.key)
    expect(JSON.parse(storage.getItem(APP_PINS_KEY)!)).toEqual({ version: 1, pinned: [TIME.key] })
    // And a pin here builds on the stored pins, not this tab's stale copy.
    tab.updateAppPinned(NOTES.key, true)
    expect(JSON.parse(storage.getItem(APP_PINS_KEY)!).pinned).toEqual([TIME.key, NOTES.key])
  })

  it('leaves the Sidebar preferences on their own key, written as before', async () => {
    const tab = await store()
    tab.markAppOpened(TIME.key)
    expect(storage.getItem(APP_PREFERENCES_KEY)).toBeNull()
    tab.updateAppDisposition(NOTES.key, 'unpinned')
    expect(JSON.parse(storage.getItem(APP_PREFERENCES_KEY)!)).toEqual({ ...createAppPreferences(), unpinned: [NOTES.key] })
    expect(tab.getAppPreferences().unpinned).toEqual([NOTES.key])
    expect(JSON.parse(storage.getItem(APP_ACTIVITY_KEY)!).open).toEqual([TIME.key])
  })
})

/**
 * The system rule, for every app there is: one the person opened keeps a Sidebar row after
 * they leave it, until they close it, whatever its kind, its declared placement or the
 * person's earlier pin, unpin, hide or placement choice. Enumerated, so a new kind,
 * placement or disposition that leaves an opened app with no row fails here.
 */
describe('every opened app keeps a Sidebar row after the person switches away', () => {
  const KINDS: RegisteredApp['kind'][] = ['core', 'native', 'webview']
  const DISPOSITIONS = ['pinned', 'unpinned', 'hidden'] as const
  const OVERRIDES: Array<AppPlacement | undefined> = [undefined, ...(['sidebar', 'settings'] as AppPlacement[])]
  const cases: Array<{ name: string; item: RegisteredApp; disposition: typeof DISPOSITIONS[number]; override?: AppPlacement; sidebarDefault: SidebarDefault }> = []
  for (const sidebarDefault of SIDEBAR_DEFAULTS) {
    for (const kind of KINDS) {
      for (const placement of ['sidebar', 'settings'] as AppPlacement[]) {
        for (const disposition of DISPOSITIONS) {
          for (const override of OVERRIDES) {
            const item = { ...app(`${kind}-x:main`, 600, { placement }), kind }
            cases.push({ name: `${sidebarDefault}: ${kind} declared ${placement}, ${disposition}, override ${override ?? 'none'}`, item, disposition, override, sidebarDefault })
          }
        }
      }
    }
  }

  it.each(cases)('$name', ({ item, disposition, override, sidebarDefault }) => {
    let preferences = setAppDisposition(createAppPreferences(), item.key, disposition)
    if (override) preferences = { ...preferences, placement: { ...preferences.placement, [item.key]: override } }
    const catalog = [...CATALOG, item]
    const resolved = resolveApps(catalog, preferences, sidebarDefault)
    // Opened, then the person went Home: the route that recorded it is gone.
    const activity = openAppActivity(openAppActivity(createAppActivity(), item.key), HOME.key)
    const view = resolveAppActivity(activity, NO_PINS, resolved)
    const rows = [...keys(resolved.sidebar), ...keys(view.open)]
    expect(rows.filter((key) => key === item.key)).toHaveLength(1)
  })

  it('covers every disposition the store knows', () => {
    const known: AppDisposition[] = ['pinned', 'unpinned', 'hidden']
    expect([...DISPOSITIONS].sort()).toEqual([...known].sort())
  })
})

/**
 * Only the person pins an App (experiment apps_stay_open, the 'by-hand' default): no plugin
 * App is on the Sidebar because its plugin declared `placement: 'sidebar'`, because it was
 * just installed, or because of any default. Enumerated over every plugin kind, declared
 * placement and disposition, so a new one that pins by itself fails here.
 */
describe('no plugin App is pinned on the Sidebar unless the person pinned it', () => {
  const PLUGIN_KINDS: RegisteredApp['kind'][] = ['native', 'webview']
  const cases: Array<{ name: string; item: RegisteredApp; disposition: AppDisposition }> = []
  for (const kind of PLUGIN_KINDS) {
    for (const placement of ['sidebar', 'settings'] as AppPlacement[]) {
      for (const disposition of ['pinned', 'unpinned', 'hidden'] as AppDisposition[]) {
        cases.push({ name: `${kind} declared ${placement}, ${disposition}`, item: { ...app(`${kind}-y:main`, 600, { placement }), kind }, disposition })
      }
    }
  }

  it.each(cases)('$name: not pinned until the person pins it', ({ item, disposition }) => {
    const preferences = setAppDisposition(createAppPreferences(), item.key, disposition)
    expect(keys(resolveApps([...CATALOG, item], preferences, 'by-hand').sidebar)).not.toContain(item.key)
    // The person's pin (the Apps page switch, the rail's Keep on sidebar) is what pins it.
    const pinned = setAppOnSidebar(preferences, item, true)
    expect(keys(resolveApps([...CATALOG, item], pinned, 'by-hand').sidebar)).toContain(item.key)
    // Unpinned again by the person: off again.
    expect(keys(resolveApps([...CATALOG, item], setAppOnSidebar(pinned, item, false), 'by-hand').sidebar)).not.toContain(item.key)
  })

  it('leaves the built-in screens where they are: they are the Sidebar, never installed', () => {
    expect(keys(resolveApps(CATALOG, createAppPreferences(), 'by-hand').sidebar)).toEqual([HOME.key, NOTES.key, APPS.key, SETTINGS.key])
  })

  it('keeps today\'s rail while the experiment is off: a declared sidebar App has its row', () => {
    const declared = app('decl:main', 600, { placement: 'sidebar' })
    expect(keys(resolveApps([...CATALOG, declared], createAppPreferences(), 'declared').sidebar)).toContain(declared.key)
  })
})

/**
 * Only the person's own Hide may mark an app hidden: no default, install, migration or
 * automatic flow. `hideApp` (store.ts) is the one writer, the Sidebar menu's Hide app its one
 * caller, and every other disposition write names 'pinned' or 'unpinned' outright. A new
 * writer fails here until it is shown to be a person's click.
 */
describe('who may hide an app', () => {
  const root = path.resolve(__dirname, '../../web/src')
  const sources: Array<{ rel: string; text: string }> = []
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.(ts|tsx)$/.test(entry.name)) sources.push({ rel: path.relative(root, full).split(path.sep).join('/'), text: fs.readFileSync(full, 'utf8') })
    }
  }
  walk(root)
  const OWNERS = new Set(['apps/preferences.ts', 'apps/store.ts'])

  it('calls hideApp only from the Sidebar menu', () => {
    const callers = sources.filter(({ rel, text }) => !OWNERS.has(rel) && /\bhideApp\(/.test(text)).map(({ rel }) => rel)
    expect(callers).toEqual(['components/layout/Sidebar.tsx'])
  })

  it('pins an App on the Sidebar only from a person\'s click: the rail\'s Keep on sidebar and the Apps page switch', () => {
    const callers = sources
      .filter(({ rel, text }) => !OWNERS.has(rel) && /\b(?:updateAppOnSidebar|keepAppOnSidebar|setAppOnSidebar|setAppPlacement)\b/.test(text))
      .map(({ rel }) => rel)
    // The Apps page's plugin card carries its App's switch too (2026-11-21), a person's click like the others.
    expect(callers.sort()).toEqual(['components/apps-page/BuiltinAppsGrid.tsx', 'components/apps-page/PluginDetail.tsx', 'components/apps-page/PluginStoreGrid.tsx', 'components/layout/Sidebar.tsx'])
    expect(sources.filter(({ rel, text }) => !OWNERS.has(rel) && /\bplacement:\s*\{\s*\.\.\./.test(text)).map(({ rel }) => rel)).toEqual([])
  })

  it('asks every Sidebar question with the one default, so no surface disagrees with the rail', () => {
    const offenders: string[] = []
    for (const { rel, text } of sources) {
      if (OWNERS.has(rel)) continue
      for (const call of text.matchAll(/\b(?:resolveApps|appOnSidebar|effectiveAppPlacement)\(([^()]*)\)/g)) {
        if (call[1].split(',').length < 3) offenders.push(`${rel}: ${call[0]}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('names pinned or unpinned outright in every other disposition write', () => {
    const offenders: string[] = []
    for (const { rel, text } of sources) {
      if (OWNERS.has(rel)) continue
      for (const call of text.matchAll(/\b(?:updateAppDisposition|setAppDisposition)\(([^()]*)\)/g)) {
        const disposition = call[1].split(',').slice(1).join(',').trim()
        if (!/^(?:[\w.]+ \? )?'(?:pinned|unpinned)'(?: : '(?:pinned|unpinned)')?$/.test(disposition)) offenders.push(`${rel}: ${call[0]}`)
      }
      if (/\.hidden\.push\(|hidden:\s*\[\s*(?:['"`]|\.\.\.)/.test(text)) offenders.push(`${rel}: writes the hidden list`)
    }
    expect(offenders).toEqual([])
  })
})
