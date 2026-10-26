import { useSyncExternalStore } from 'react'
import type { AppPreferences } from './preferences'
import { getAppPreferences, subscribeAppPreferences } from './store'

/**
 * The rail's built-in entries that are NOT registry apps: the Home group's panel
 * toggles and the Org page button. The Apps page lets the user hide them like any
 * app, so their show/hide answer lives in the same app preferences (`unpinned`),
 * under keys no registry app can take (`rail:` is never an app key prefix).
 *
 * An older build that reads these preferences keeps the unknown keys (they are plain
 * strings) and simply shows every entry, so going back never loses the choice.
 */
export type RailItemId = 'home-todo' | 'home-chat' | 'org' | 'home-agenda' | 'home-scratchpad'

export const RAIL_ITEM_IDS: readonly RailItemId[] = ['home-todo', 'home-chat', 'org', 'home-agenda', 'home-scratchpad']

export function railItemKey(id: RailItemId): string {
  return `rail:${id}`
}

/** Shown unless the user took it off the rail (unpinned or hidden, either counts). */
export function railItemShown(preferences: AppPreferences, id: RailItemId): boolean {
  const key = railItemKey(id)
  return !preferences.unpinned.includes(key) && !preferences.hidden.includes(key)
}

export function useRailItemsShown(): Readonly<Record<RailItemId, boolean>> {
  const preferences = useSyncExternalStore(subscribeAppPreferences, getAppPreferences, getAppPreferences)
  return railItemsShownFor(preferences)
}

const cache = new WeakMap<AppPreferences, Readonly<Record<RailItemId, boolean>>>()

/** One stable object per preferences snapshot, so a consumer's memo deps hold still. */
export function railItemsShownFor(preferences: AppPreferences): Readonly<Record<RailItemId, boolean>> {
  let shown = cache.get(preferences)
  if (!shown) {
    shown = Object.fromEntries(RAIL_ITEM_IDS.map((id) => [id, railItemShown(preferences, id)])) as Record<RailItemId, boolean>
    cache.set(preferences, shown)
  }
  return shown
}
