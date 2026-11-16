import {
  APP_ACTIVITY_KEY,
  APP_PINS_KEY,
  APP_PREFERENCES_KEY,
  closeAppActivity,
  createAppActivity,
  createAppPins,
  createAppPreferences,
  moveApp,
  openAppActivity,
  parseAppActivity,
  parseAppPins,
  parseAppPreferences,
  setAppDisposition,
  setAppOnSidebar,
  setAppPinned,
  type AppActivity,
  type AppDisposition,
  type AppPins,
  type AppPreferences,
} from './preferences'
import type { RegisteredApp } from './registry'

interface StoredValue<T> {
  get(): T
  subscribe(listener: () => void): () => void
  /** Writes `change(current)`; a change that returns its input writes nothing. */
  update(change: (current: T) => T): void
  resetForTesting(): void
}

/**
 * One localStorage record with a snapshot for `useSyncExternalStore`, kept current across
 * tabs by the `storage` event.
 *
 * `freshWrites`: a change is applied to what storage holds at that moment, not to this
 * tab's snapshot, so a write from another tab whose `storage` event has not arrived yet is
 * kept rather than undone. It narrows the window, it does not close it: a read and a write
 * of localStorage are not one transaction across tabs, so two tabs writing in the same
 * instant can still lose one write. That is why the Apps page pins are a record of their
 * own (preferences.ts). The preferences keep the snapshot as the base: their changes (a
 * move, a switch) are computed from what the person sees.
 */
function storedValue<T>(key: string, parse: (raw: string | null) => T, empty: () => T, freshWrites: boolean): StoredValue<T> {
  const listeners = new Set<() => void>()
  let snapshot: T | null = null
  let listening = false
  const read = (): T => {
    if (typeof window === 'undefined') return empty()
    try { return parse(localStorage.getItem(key)) } catch { return empty() }
  }
  const get = (): T => {
    snapshot ??= read()
    return snapshot
  }
  const notify = () => { for (const listener of listeners) listener() }
  return {
    get,
    subscribe(listener) {
      if (!listening && typeof window !== 'undefined') {
        listening = true
        window.addEventListener('storage', (event) => {
          if (event.key !== key) return
          snapshot = parse(event.newValue)
          notify()
        })
      }
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    update(change) {
      const base = freshWrites && typeof window !== 'undefined' ? read() : get()
      const next = change(base)
      if (next === base) return
      snapshot = next
      if (typeof window !== 'undefined') {
        try { localStorage.setItem(key, JSON.stringify(next)) } catch { /* quota */ }
      }
      notify()
    },
    resetForTesting() { snapshot = null },
  }
}

const preferencesStore = storedValue(APP_PREFERENCES_KEY, parseAppPreferences, createAppPreferences, false)
const activityStore = storedValue(APP_ACTIVITY_KEY, parseAppActivity, createAppActivity, true)
const pinsStore = storedValue(APP_PINS_KEY, parseAppPins, createAppPins, true)

function publish(change: (current: AppPreferences) => AppPreferences): void {
  preferencesStore.update(change)
}

export const getAppPreferences = (): AppPreferences => preferencesStore.get()

export function subscribeAppPreferences(listener: () => void): () => void {
  return preferencesStore.subscribe(listener)
}

export function updateAppDisposition(key: string, disposition: AppDisposition): void {
  publish((current) => setAppDisposition(current, key, disposition))
}

/**
 * The person's Hide, the one way an app becomes hidden: no default, install or automatic flow
 * calls it (tests/web/app-activity.test.ts holds that). It closes the app too: an app opened
 * keeps an Open row whether hidden or not (preferences.ts resolveAppActivity), so a Hide that
 * left it open would bring its row straight back.
 */
export function hideApp(key: string): void {
  updateAppDisposition(key, 'hidden')
  markAppClosed(key)
}

/** An Open row made the app's own Sidebar row: it is on the Sidebar now, so no longer "open". */
export function keepAppOnSidebar(app: Pick<RegisteredApp, 'key' | 'kind'>): void {
  updateAppOnSidebar(app, true)
  markAppClosed(app.key)
}

/** The Apps page's switch, as one write (see `setAppOnSidebar`). */
export function updateAppOnSidebar(app: Pick<RegisteredApp, 'key' | 'kind'>, on: boolean): void {
  publish((current) => setAppOnSidebar(current, app, on))
}

export function moveAppPreference(apps: RegisteredApp[], key: string, direction: 'up' | 'down'): void {
  publish((current) => moveApp(current, apps.map((app) => app.key), key, direction))
}

export function resetAppPreferences(): void {
  publish(() => createAppPreferences())
}

/**
 * Forget only the ORDER, keeping hidden/unpinned/placement decisions. Offered in
 * the sidebar's right-click menu: "my rail is in a weird order" should be one
 * click to the product default, not a reset of everything the user configured.
 */
export function resetAppOrder(): void {
  publish((current) => ({ ...current, order: [] }))
}

export function resetAppPreferencesForTesting(): void {
  preferencesStore.resetForTesting()
  activityStore.resetForTesting()
  pinsStore.resetForTesting()
}

export const getAppActivity = (): AppActivity => activityStore.get()

export function subscribeAppActivity(listener: () => void): () => void {
  return activityStore.subscribe(listener)
}

/** An app was opened (any way in: a link, the palette, a deep link, Back). */
export function markAppOpened(key: string): void {
  activityStore.update((current) => openAppActivity(current, key))
}

/** The person closed it: its Sidebar row goes, it stays recently used. */
export function markAppClosed(key: string): void {
  activityStore.update((current) => closeAppActivity(current, key))
}

export const getAppPins = (): AppPins => pinsStore.get()

export function subscribeAppPins(listener: () => void): () => void {
  return pinsStore.subscribe(listener)
}

/** Pin on the Apps page (its own list, never the Sidebar's pin). */
export function updateAppPinned(key: string, pinned: boolean): void {
  pinsStore.update((current) => setAppPinned(current, key, pinned))
}
