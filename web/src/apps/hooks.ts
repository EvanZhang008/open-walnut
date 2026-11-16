import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { useApps } from '@/hooks/useApps'
import { useExperimental } from '@/hooks/useExperimental'
// The LEAF store, deliberately not '@/plugins/hooks': that module reaches the plugin loader,
// and through it every view a plugin may mount. Importing it here would drag that graph into
// everything that reads the app catalogue, which is nearly the whole app.
import { useWebPluginRuntime } from '@/plugins/runtime-store'
import {
  findAppByPath,
  resolveAppActivity,
  resolveApps,
  tracksAppActivity,
  type ResolvedAppActivity,
  type ResolvedApps,
} from './preferences'
import {
  activePluginKey,
  adaptWebviewApps,
  appRegistry,
  filterAppsByPlugin,
  findHostedAppByRouteId,
  type RegisteredApp,
} from './registry'
import {
  getAppActivity,
  getAppPins,
  getAppPreferences,
  markAppOpened,
  subscribeAppActivity,
  subscribeAppPins,
  subscribeAppPreferences,
} from './store'

export interface AppCatalog extends ResolvedApps {
  loadingWebviews: boolean
  findByPath(pathname: string): RegisteredApp | undefined
  findByRouteId(routeId: string): RegisteredApp | undefined
}

export function useAppCatalog(): AppCatalog {
  const registrySnapshot = useSyncExternalStore(
    appRegistry.subscribe,
    appRegistry.getSnapshot,
    appRegistry.getSnapshot,
  )
  const preferences = useSyncExternalStore(
    subscribeAppPreferences,
    getAppPreferences,
    getAppPreferences,
  )
  const webviews = useApps()
  // The plugin gate belongs HERE, not in a surface: Sidebar, the Settings "Manage" group and
  // the Command Palette all read this catalogue, so filtering once is what keeps them agreed.
  const activeKey = activePluginKey(useWebPluginRuntime())

  return useMemo(() => {
    const combined = filterAppsByPlugin(
      [...registrySnapshot.apps, ...adaptWebviewApps(webviews.apps)],
      activeKey,
    ).sort((a, b) => a.order - b.order || a.key.localeCompare(b.key))
    const resolved = resolveApps(combined, preferences)
    return {
      ...resolved,
      loadingWebviews: webviews.loading,
      findByPath: (pathname: string) => findAppByPath(resolved.all, pathname),
      findByRouteId: (routeId: string) => findHostedAppByRouteId(resolved.all, routeId),
    }
  }, [preferences, registrySnapshot, webviews.apps, webviews.loading, activeKey])
}

/** The keys pinned on the Apps page, or null while the experiment `apps_stay_open` is off. */
export function useAppPagePins(): readonly string[] | null {
  const on = useExperimental('apps_stay_open')
  const pins = useSyncExternalStore(subscribeAppPins, getAppPins, getAppPins)
  return on ? pins.pinned : null
}

const NO_ACTIVITY: ResolvedAppActivity = { open: [], recent: [], pinned: [] }

/**
 * The open, recently used and pinned apps (experiment `apps_stay_open`), resolved against
 * the catalogue the caller already reads. Empty while the experiment is off, so every
 * surface draws exactly what it drew before it.
 */
export function useAppActivity(catalog: Pick<ResolvedApps, 'discoverable' | 'sidebar'>): ResolvedAppActivity {
  const on = useExperimental('apps_stay_open')
  const activity = useSyncExternalStore(subscribeAppActivity, getAppActivity, getAppActivity)
  const pins = useSyncExternalStore(subscribeAppPins, getAppPins, getAppPins)
  const { discoverable, sidebar } = catalog
  return useMemo(
    () => (on ? resolveAppActivity(activity, pins, { discoverable, sidebar }) : NO_ACTIVITY),
    [on, activity, pins, discoverable, sidebar],
  )
}

/**
 * Records the app on screen as opened, whichever way the person got there: the route is
 * the one thing every way in (a rail link, a card, the palette, a deep link, Back, a
 * reload) has in common. Keyed by the app, not the path, so moving inside an app or a
 * catalogue refresh writes nothing. Closing the app on screen leaves its page (Sidebar.tsx),
 * so the next visit is a new key and records it again; a way in that may land on the page
 * already on screen calls `markAppOpened` itself (AppQuickOpen.tsx). A hidden or locked
 * app is never recorded.
 */
export function useTrackOpenedApp(app: RegisteredApp | undefined, hidden: readonly RegisteredApp[]): void {
  const on = useExperimental('apps_stay_open')
  const key = app && tracksAppActivity(app) && !hidden.some((item) => item.key === app.key) ? app.key : ''
  useEffect(() => {
    if (on && key) markAppOpened(key)
  }, [on, key])
}
