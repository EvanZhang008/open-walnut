/**
 * How each plugin's App works in the focus the person is in (scope.ts `focusAppMode`, the rule
 * the server's `walnut.focus.current()` follows too): hidden (`off`), Main's own (`inherit`), or
 * fresh, with its views and drafts kept per space (`isolated`). Core apps are Walnut's own and
 * always shown. No focus, or the experiment off: every App as it is (null).
 */
import { useMemo } from 'react'
import { focusAppMode, type FocusAppMode } from '@open-walnut/focus-scope'
import { useFocusSnapshot, type FocusSnapshot } from './focus-store'
import { useFocusOn } from './useFocusView'

/** The mode of `pluginId`'s App in the current focus (module-level, for the hooks below). */
export function appModeIn(snap: FocusSnapshot, pluginId: string): FocusAppMode {
  const space = snap.active?.spaceId ? snap.spaces.find((s) => s.id === snap.active!.spaceId) : undefined
  const declared = snap.apps.find((a) => a.pluginId === pluginId)?.declared
  return focusAppMode(space?.apps[pluginId], declared)
}

/** null = no focus; else the mode of each plugin's App, by plugin id, read on demand. */
export function useFocusAppModes(): ((pluginId: string) => FocusAppMode) | null {
  const on = useFocusOn()
  const snap = useFocusSnapshot()
  return useMemo(() => (on && snap.active ? appModeIn.bind(null, snap) : null), [on, snap])
}

/** The key prefix a plugin's view choices and drafts take in the current focus: `ws.<space>.`
 *  when its App is fresh there, '' everywhere else (the same keys as Main's). */
export function useFocusKeyPrefix(pluginId: string): string {
  const on = useFocusOn()
  const snap = useFocusSnapshot()
  if (!on || !snap.active?.spaceId) return ''
  return appModeIn(snap, pluginId) === 'isolated' ? `ws.${snap.active.spaceId}.` : ''
}
