import { APP_PLACEMENTS, type AppPlacement, type RegisteredApp } from './registry'

export const APP_PREFERENCES_KEY = 'open-walnut-app-preferences-v1'

export type AppDisposition = 'pinned' | 'unpinned' | 'hidden'

export interface AppPreferences {
  version: 1
  order: string[]
  unpinned: string[]
  hidden: string[]
  /**
   * Per-app override of WHERE the row lives, keyed by app key. The app's declared
   * `placement` is only the default; this is the user's answer, and it wins.
   *
   * An override is stored even when it matches the declared value: it records a
   * decision, so a plugin author later flipping their own default can NOT silently
   * move a row the user already placed.
   */
  placement: Record<string, AppPlacement>
}

/**
 * The buckets every consumer reads. Two axes, deliberately kept apart:
 *
 * - The USER's preference (pinned / unpinned / hidden, plus an optional placement
 *   override), which is what the App manager in Settings edits.
 * - The APP's declared placement (sidebar / settings), which the app itself owns and
 *   which is only the DEFAULT — see `effectiveAppPlacement`.
 *
 * `sidebar` and `settings` are the two entry-row surfaces, each already filtered by
 * both axes, so neither the Sidebar nor the Settings nav has to know the rules. Hiding
 * an app removes it from both surfaces; unpinning only concerns the Sidebar, since a
 * settings row is not a pin.
 */
export interface ResolvedApps {
  all: RegisteredApp[]
  pinned: RegisteredApp[]
  discoverable: RegisteredApp[]
  hidden: RegisteredApp[]
  sidebar: RegisteredApp[]
  settings: RegisteredApp[]
}

function uniqueStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((item): item is string => typeof item === 'string' && item.length > 0))]
}

/**
 * Keeps only keys whose value is a placement this build understands. A stored value
 * from a future build (or a hand-edited one) would otherwise match no consumer's
 * filter and make the app vanish from BOTH surfaces — the same silent-nowhere
 * failure the registry refuses at contribution time.
 */
function placementOverrides(value: unknown): Record<string, AppPlacement> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const result: Record<string, AppPlacement> = {}
  for (const [key, placement] of Object.entries(value as Record<string, unknown>)) {
    if (!key) continue
    if (APP_PLACEMENTS.includes(placement as AppPlacement)) {
      result[key] = placement as AppPlacement
    }
  }
  return result
}

export function createAppPreferences(): AppPreferences {
  return { version: 1, order: [], unpinned: [], hidden: [], placement: {} }
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
      placement: placementOverrides(value.placement),
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

/**
 * Whether the user may move this app's row at all.
 *
 * Only a native plugin App can be moved. Core screens ARE the Sidebar (letting one
 * hide in Settings is a way to lose Home or Chat), and a legacy webview has no
 * placement concept to override. Enforced here rather than in the UI so a stale or
 * hand-edited override cannot do what the missing button wouldn't.
 */
export function supportsPlacementOverride(app: Pick<RegisteredApp, 'kind'>): boolean {
  return app.kind === 'native'
}

/**
 * WHERE the row actually goes: the user's override if they made one, else what the
 * app declared. Every consumer must ask this rather than reading `app.placement`,
 * or the Sidebar and the Settings nav can disagree about the same row.
 */
export function effectiveAppPlacement(
  app: Pick<RegisteredApp, 'key' | 'kind' | 'placement'>,
  preferences: AppPreferences,
): AppPlacement {
  if (!supportsPlacementOverride(app)) return app.placement
  return preferences.placement[app.key] ?? app.placement
}

export function setAppPlacement(
  preferences: AppPreferences,
  key: string,
  placement: AppPlacement,
): AppPreferences {
  return { ...preferences, placement: { ...preferences.placement, [key]: placement } }
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

  const pinned = all.filter((app) => !isHidden(app) && !isUnpinned(app))
  const discoverable = all.filter((app) => !isHidden(app))
  const placedInSettings = (app: RegisteredApp) => effectiveAppPlacement(app, preferences) === 'settings'

  return {
    all,
    pinned,
    discoverable,
    hidden: all.filter(isHidden),
    sidebar: pinned.filter((app) => !placedInSettings(app)),
    settings: discoverable.filter(placedInSettings),
  }
}
