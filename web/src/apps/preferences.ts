import { APP_PLACEMENTS, appPathMatches, type AppPlacement, type RegisteredApp } from './registry'

export const APP_PREFERENCES_KEY = 'open-walnut-app-preferences-v1'

export type AppDisposition = 'pinned' | 'unpinned' | 'hidden'

/**
 * Storage schema version. Bumped 1 → 2 when the core rail order changed
 * (Home, Notes, Calendar, Tasks, Routines, Settings): see CORE_ORDER_MIGRATION.
 */
export const APP_PREFERENCES_VERSION = 2

export interface AppPreferences {
  version: typeof APP_PREFERENCES_VERSION
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
 *   override), which the Apps page and the Sidebar's menu edit.
 * - The APP's declared placement (sidebar / settings), which the app itself owns and
 *   which is only the DEFAULT — see `effectiveAppPlacement`.
 *
 * An App is either on the Sidebar or not; one that is not is opened from the Apps page
 * (and the Command Palette, unless hidden). `'settings'` is the stored name of "not on
 * the Sidebar": Apps used to get a row in the Settings nav instead, and the value keeps
 * its name so stored choices, older windows and plugins that declare it keep working.
 */
export interface ResolvedApps {
  all: RegisteredApp[]
  pinned: RegisteredApp[]
  discoverable: RegisteredApp[]
  hidden: RegisteredApp[]
  sidebar: RegisteredApp[]
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
  return { version: APP_PREFERENCES_VERSION, order: [], unpinned: [], hidden: [], placement: {} }
}

/**
 * v1 → v2: forget the stored position of the CORE apps, keep everything else.
 *
 * A stored order is written wholesale (every visible key, core ones included) the
 * first time anything is moved in Settings → Apps, so almost every existing client
 * carries a frozen copy of the OLD core default. Shipping a new default order
 * would then change nothing for exactly the people who already use the app. Only
 * `core:*` entries are dropped: a plugin/webview App the user positioned by hand
 * keeps its slot, and `mergedOrder` re-inserts the core keys at their new default
 * positions relative to the ones that stayed.
 */
function migrateCoreOrder(order: string[]): string[] {
  return order.filter((key) => !key.startsWith('core:'))
}

export function parseAppPreferences(raw: string | null): AppPreferences {
  if (!raw) return createAppPreferences()
  try {
    const value = JSON.parse(raw) as Record<string, unknown>
    if (!value) return createAppPreferences()
    // Unknown/future versions get a clean slate rather than a half-read record.
    if (value.version !== 1 && value.version !== APP_PREFERENCES_VERSION) return createAppPreferences()
    const order = uniqueStrings(value.order)
    return {
      version: APP_PREFERENCES_VERSION,
      order: value.version === 1 ? migrateCoreOrder(order) : order,
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
 * Only a native plugin App can be moved. Core screens ARE the Sidebar (their only
 * switch is pin / unpin, and Home, Apps and Settings are locked), and a legacy webview has no
 * placement concept to override. Enforced here rather than in the UI so a stale or
 * hand-edited override cannot do what the missing button wouldn't.
 */
export function supportsPlacementOverride(app: Pick<RegisteredApp, 'kind'>): boolean {
  return app.kind === 'native'
}

/**
 * WHERE the row actually goes: the user's override if they made one, else what the
 * app declared. Every consumer must ask this rather than reading `app.placement`,
 * or the Sidebar and the Apps page's switch can disagree about the same row.
 */
export function effectiveAppPlacement(
  app: Pick<RegisteredApp, 'key' | 'kind' | 'placement'>,
  preferences: AppPreferences,
): AppPlacement {
  if (!supportsPlacementOverride(app)) return app.placement
  return preferences.placement[app.key] ?? app.placement
}

/**
 * Choosing the Sidebar means the row SHOWS there: an App the user had unpinned is pinned
 * again, or putting it on the Sidebar would move it nowhere. A hidden App stays hidden; the
 * placement is where its Show will put it back.
 */
export function setAppPlacement(
  preferences: AppPreferences,
  key: string,
  placement: AppPlacement,
): AppPreferences {
  const moved = { ...preferences, placement: { ...preferences.placement, [key]: placement } }
  if (placement !== 'sidebar' || preferences.hidden.includes(key) || !preferences.unpinned.includes(key)) return moved
  return { ...moved, unpinned: without(preferences.unpinned, key) }
}

/** Whether this App has a Sidebar row: the same rule `resolveApps` uses for `sidebar`. */
export function appOnSidebar(
  app: Pick<RegisteredApp, 'key' | 'kind' | 'placement' | 'lockVisibility'>,
  preferences: AppPreferences,
): boolean {
  if (app.lockVisibility) return true
  if (preferences.hidden.includes(app.key) || preferences.unpinned.includes(app.key)) return false
  return effectiveAppPlacement(app, preferences) === 'sidebar'
}

/**
 * The Apps page's one switch. On pins the App and, when it may be moved, places it on
 * the Sidebar (an App whose plugin declared `'settings'` would otherwise stay off). Off
 * unpins it: the App stays on the Apps page and in the Command Palette, and an older
 * window reads the same answer, since unpinned has always meant "not on the Sidebar".
 */
export function setAppOnSidebar(
  preferences: AppPreferences,
  app: Pick<RegisteredApp, 'key' | 'kind'>,
  on: boolean,
): AppPreferences {
  if (!on) return setAppDisposition(preferences, app.key, 'unpinned')
  const pinned = setAppDisposition(preferences, app.key, 'pinned')
  return supportsPlacementOverride(app) ? setAppPlacement(pinned, app.key, 'sidebar') : pinned
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
  const offSidebar = (app: RegisteredApp) => effectiveAppPlacement(app, preferences) === 'settings'

  return {
    all,
    pinned,
    discoverable,
    hidden: all.filter(isHidden),
    sidebar: pinned.filter((app) => !offSidebar(app)),
  }
}

/**
 * The app whose page `pathname` is, by the LONGEST matching path: `/apps/<id>` is the
 * App's page, never the Apps page's (`/apps`) or Home's (`/`). Today the exact paths
 * already keep them apart; the longest match keeps that true when a new app nests its
 * path under another's.
 */
export function findAppByPath<T extends Pick<RegisteredApp, 'path' | 'exactPath'>>(apps: readonly T[], pathname: string): T | undefined {
  let best: T | undefined
  for (const app of apps) {
    if (!appPathMatches(app, pathname)) continue
    if (!best || app.path.length > best.path.length) best = app
  }
  return best
}

/* ── App activity: the apps open on the Sidebar, the recently used and the pinned ── */

/**
 * Their own keys, apart from the preferences above: the activity changes on every app
 * opened, and the catalogue re-resolves on every preferences change. Device-local (no
 * `open-walnut-` prefix, see utils/ui-prefs-sync.ts): what is open belongs to this
 * window's device. An older build never reads them, so going back loses nothing it knew.
 *
 * The pins are a record of their own because they are the person's choice and the
 * activity is written on every navigation, in every tab: two tabs writing one record at
 * the same moment can lose one write (localStorage has no cross-tab transaction), and
 * that must never be a pin. Kept apart, a pin is written only by a pin click.
 */
export const APP_ACTIVITY_KEY = 'walnut:app-activity-v1'
export const APP_PINS_KEY = 'walnut:app-pins-v1'
export const APP_ACTIVITY_VERSION = 1
/** How many recently used apps are kept and shown. */
export const APP_RECENT_MAX = 12
/** A bound on every stored list, so a hand-edited or corrupt record stays small. */
const APP_ACTIVITY_LIST_MAX = 64

export interface AppActivity {
  version: typeof APP_ACTIVITY_VERSION
  /** Opened and not closed yet, in the order they were first opened. */
  open: string[]
  /** Most recent first; closing an app keeps it here. */
  recent: string[]
}

/** Pinned on the Apps page, in the order they were pinned. Not the Sidebar's pin. */
export interface AppPins {
  version: typeof APP_ACTIVITY_VERSION
  pinned: string[]
}

export interface ResolvedAppActivity {
  /** Open apps that have no Sidebar row of their own, so the Sidebar draws one for them. */
  open: RegisteredApp[]
  /** Recently used, most recent first, leaving out the pinned ones (they have their own list). */
  recent: RegisteredApp[]
  pinned: RegisteredApp[]
}

export function createAppActivity(): AppActivity {
  return { version: APP_ACTIVITY_VERSION, open: [], recent: [] }
}

export function createAppPins(): AppPins {
  return { version: APP_ACTIVITY_VERSION, pinned: [] }
}

/** The record's object, or null for a malformed or unknown-version one (read as empty). */
function activityRecord(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Record<string, unknown> | null
    return value && typeof value === 'object' && value.version === APP_ACTIVITY_VERSION ? value : null
  } catch {
    return null
  }
}

/** A bad list reads as empty alone; the good ones of the record are kept. */
export function parseAppActivity(raw: string | null): AppActivity {
  const value = activityRecord(raw)
  if (!value) return createAppActivity()
  return {
    version: APP_ACTIVITY_VERSION,
    open: uniqueStrings(value.open).slice(0, APP_ACTIVITY_LIST_MAX),
    recent: uniqueStrings(value.recent).slice(0, APP_RECENT_MAX),
  }
}

export function parseAppPins(raw: string | null): AppPins {
  const value = activityRecord(raw)
  if (!value) return createAppPins()
  return { version: APP_ACTIVITY_VERSION, pinned: uniqueStrings(value.pinned).slice(0, APP_ACTIVITY_LIST_MAX) }
}

/**
 * Home, Apps and Settings (the locked apps) are how you get anywhere; they are always on
 * the Sidebar, so they are never "open" and never fill the recent list.
 */
export function tracksAppActivity(app: Pick<RegisteredApp, 'lockVisibility'>): boolean {
  return !app.lockVisibility
}

/** Opening returns the same record when nothing changes, so a re-render writes nothing. */
export function openAppActivity(activity: AppActivity, key: string): AppActivity {
  if (!key) return activity
  const isOpen = activity.open.includes(key)
  if (isOpen && activity.recent[0] === key) return activity
  return {
    ...activity,
    open: isOpen ? activity.open : [...activity.open, key].slice(-APP_ACTIVITY_LIST_MAX),
    recent: [key, ...without(activity.recent, key)].slice(0, APP_RECENT_MAX),
  }
}

/** Closing only takes the Sidebar row away: the app stays recent. */
export function closeAppActivity(activity: AppActivity, key: string): AppActivity {
  if (!activity.open.includes(key)) return activity
  return { ...activity, open: without(activity.open, key) }
}

export function setAppPinned(pins: AppPins, key: string, pinned: boolean): AppPins {
  if (!key || pins.pinned.includes(key) === pinned) return pins
  return {
    ...pins,
    pinned: pinned ? [...pins.pinned, key].slice(-APP_ACTIVITY_LIST_MAX) : without(pins.pinned, key),
  }
}

/**
 * Keys become apps here, and only apps that can be opened now: an unknown key (a plugin
 * turned off or removed, a webview still loading) is left out of every list but kept in the
 * record, so it comes back when its app does.
 *
 * The one rule for every app, whoever made it (core, a native plugin, a webview): an app the
 * person opened keeps a Sidebar row until they close it. Its own row when it has one, else an
 * Open row here. A hidden app is no exception: hidden keeps an app out of what Walnut OFFERS
 * unasked (its Sidebar row, Recently used, the Command Palette), never out of what the person
 * opened themselves (2026-11-16: a plugin App hidden on this device opened, then vanished from
 * the rail the moment its page was left). Hiding an app also closes it (Sidebar.tsx), so a
 * Hide still takes its row away at once.
 */
export function resolveAppActivity(
  activity: AppActivity,
  pins: AppPins,
  resolved: Pick<ResolvedApps, 'all' | 'discoverable' | 'sidebar'>,
): ResolvedAppActivity {
  const index = (apps: RegisteredApp[]) => new Map(apps.filter(tracksAppActivity).map((app) => [app.key, app]))
  const any = index(resolved.all)
  const offered = index(resolved.discoverable)
  const pick = (keys: string[], byKey: Map<string, RegisteredApp>) =>
    keys.map((key) => byKey.get(key)).filter((app): app is RegisteredApp => Boolean(app))
  const onSidebar = new Set(resolved.sidebar.map((app) => app.key))
  const pinnedKeys = new Set(pins.pinned)
  return {
    open: pick(activity.open, any).filter((app) => !onSidebar.has(app.key)),
    recent: pick(activity.recent, offered).filter((app) => !pinnedKeys.has(app.key)),
    pinned: pick(pins.pinned, offered),
  }
}
