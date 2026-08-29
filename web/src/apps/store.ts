import {
  APP_PREFERENCES_KEY,
  createAppPreferences,
  moveApp,
  parseAppPreferences,
  setAppDisposition,
  setAppPlacement,
  type AppDisposition,
  type AppPreferences,
} from './preferences'
import type { AppPlacement, RegisteredApp } from './registry'

const listeners = new Set<() => void>()
let snapshot: AppPreferences | null = null
let listening = false

function read(): AppPreferences {
  if (typeof window === 'undefined') return createAppPreferences()
  try {
    return parseAppPreferences(localStorage.getItem(APP_PREFERENCES_KEY))
  } catch {
    return createAppPreferences()
  }
}

function getCurrent(): AppPreferences {
  snapshot ??= read()
  return snapshot
}

function publish(next: AppPreferences): void {
  snapshot = next
  if (typeof window !== 'undefined') {
    try { localStorage.setItem(APP_PREFERENCES_KEY, JSON.stringify(next)) } catch { /* quota */ }
  }
  for (const listener of listeners) listener()
}

function startStorageListener(): void {
  if (listening || typeof window === 'undefined') return
  listening = true
  window.addEventListener('storage', (event) => {
    if (event.key !== APP_PREFERENCES_KEY) return
    snapshot = parseAppPreferences(event.newValue)
    for (const listener of listeners) listener()
  })
}

export const getAppPreferences = (): AppPreferences => getCurrent()

export function subscribeAppPreferences(listener: () => void): () => void {
  startStorageListener()
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function updateAppDisposition(key: string, disposition: AppDisposition): void {
  publish(setAppDisposition(getCurrent(), key, disposition))
}

export function updateAppPlacement(key: string, placement: AppPlacement): void {
  publish(setAppPlacement(getCurrent(), key, placement))
}

export function moveAppPreference(apps: RegisteredApp[], key: string, direction: 'up' | 'down'): void {
  publish(moveApp(getCurrent(), apps.map((app) => app.key), key, direction))
}

export function resetAppPreferences(): void {
  publish(createAppPreferences())
}

/**
 * Forget only the ORDER, keeping hidden/unpinned/placement decisions. Offered in
 * the sidebar's right-click menu: "my rail is in a weird order" should be one
 * click to the product default, not a reset of everything the user configured.
 */
export function resetAppOrder(): void {
  publish({ ...getCurrent(), order: [] })
}

export function resetAppPreferencesForTesting(): void {
  snapshot = null
}
