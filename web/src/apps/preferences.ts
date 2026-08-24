import type { RegisteredApp } from './registry'

export const APP_PREFERENCES_KEY = 'open-walnut-app-preferences-v1'

export type AppDisposition = 'pinned' | 'unpinned' | 'hidden'

export interface AppPreferences {
  version: 1
  order: string[]
  unpinned: string[]
  hidden: string[]
}

export interface ResolvedApps {
  all: RegisteredApp[]
  pinned: RegisteredApp[]
  discoverable: RegisteredApp[]
  hidden: RegisteredApp[]
}

function uniqueStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((item): item is string => typeof item === 'string' && item.length > 0))]
}

export function createAppPreferences(): AppPreferences {
  return { version: 1, order: [], unpinned: [], hidden: [] }
}

export function parseAppPreferences(raw: string | null): AppPreferences {
  if (!raw) return createAppPreferences()
  try {
    const value = JSON.parse(raw) as Record<string, unknown>
    if (!value || value.version !== 1) return createAppPreferences()
    return {
      version: 1,
      order: uniqueStrings(value.order),
      unpinned: uniqueStrings(value.unpinned),
      hidden: uniqueStrings(value.hidden),
    }
  } catch {
    return createAppPreferences()
  }
}

function addUnique(values: string[], key: string): string[] {
  return values.includes(key) ? values : [...values, key]
}

function without(values: string[], key: string): string[] {
  return values.filter((value) => value !== key)
}

export function setAppDisposition(
  preferences: AppPreferences,
  key: string,
  disposition: AppDisposition,
): AppPreferences {
  if (disposition === 'pinned') {
    return {
      ...preferences,
      unpinned: without(preferences.unpinned, key),
      hidden: without(preferences.hidden, key),
    }
  }
  if (disposition === 'unpinned') {
    return {
      ...preferences,
      unpinned: addUnique(preferences.unpinned, key),
      hidden: without(preferences.hidden, key),
    }
  }
  return {
    ...preferences,
    unpinned: without(preferences.unpinned, key),
    hidden: addUnique(preferences.hidden, key),
  }
}

function mergedOrder(
  apps: Array<Pick<RegisteredApp, 'key'>>,
  storedOrder: string[],
  preserveUnavailable = false,
): string[] {
  const current = apps.map((app) => app.key)
  const currentSet = new Set(current)
  const stored = uniqueStrings(storedOrder)
  const ordered = preserveUnavailable ? stored : stored.filter((key) => currentSet.has(key))
  const orderedSet = new Set(ordered.filter((key) => currentSet.has(key)))

  for (let defaultIndex = 0; defaultIndex < current.length; defaultIndex++) {
    const key = current[defaultIndex]
    if (orderedSet.has(key)) continue
    const previousAnchor = current.slice(0, defaultIndex).reverse()
      .find((candidate) => orderedSet.has(candidate))
    const nextAnchor = current.slice(defaultIndex + 1)
      .find((candidate) => orderedSet.has(candidate))
    const previousIndex = previousAnchor ? ordered.indexOf(previousAnchor) : -1
    const nextIndex = nextAnchor ? ordered.indexOf(nextAnchor) : -1
    let insertionIndex = ordered.length
    if (previousIndex >= 0 && nextIndex >= 0) {
      insertionIndex = previousIndex < nextIndex ? nextIndex : previousIndex + 1
    } else if (previousIndex >= 0) {
      insertionIndex = previousIndex + 1
    } else if (nextIndex >= 0) {
      insertionIndex = nextIndex
    }
    ordered.splice(insertionIndex, 0, key)
    orderedSet.add(key)
  }
  return ordered
}

export function moveApp(
  preferences: AppPreferences,
  currentKeys: string[],
  key: string,
  direction: 'up' | 'down',
): AppPreferences {
  const known = new Set(currentKeys)
  const currentApps = currentKeys.map((appKey) => ({ key: appKey }))
  const order = mergedOrder(currentApps, preferences.order, true)
  const visibleOrder = order.filter((item) => known.has(item))
  const index = visibleOrder.indexOf(key)
  if (index === -1) return preferences
  const target = direction === 'up' ? index - 1 : index + 1
  if (target < 0 || target >= visibleOrder.length) return preferences
  const targetKey = visibleOrder[target]
  const sourceIndex = order.indexOf(key)
  const targetIndex = order.indexOf(targetKey)
  ;[order[sourceIndex], order[targetIndex]] = [order[targetIndex], order[sourceIndex]]
  return { ...preferences, order }
}

export function resolveApps(apps: RegisteredApp[], preferences: AppPreferences): ResolvedApps {
  const defaultOrder = [...apps].sort((a, b) => a.order - b.order || a.key.localeCompare(b.key))
  const byKey = new Map(defaultOrder.map((app) => [app.key, app]))
  const all = mergedOrder(defaultOrder, preferences.order)
    .map((key) => byKey.get(key))
    .filter((app): app is RegisteredApp => Boolean(app))
  const hiddenKeys = new Set(preferences.hidden)
  const unpinnedKeys = new Set(preferences.unpinned)
  const isHidden = (app: RegisteredApp) => !app.lockVisibility && hiddenKeys.has(app.key)
  const isUnpinned = (app: RegisteredApp) => !app.lockVisibility && unpinnedKeys.has(app.key)

  return {
    all,
    pinned: all.filter((app) => !isHidden(app) && !isUnpinned(app)),
    discoverable: all.filter((app) => !isHidden(app)),
    hidden: all.filter(isHidden),
  }
}
