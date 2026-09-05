import { useMemo, useSyncExternalStore } from 'react'
import { useApps } from '@/hooks/useApps'
// The LEAF store, deliberately not '@/plugins/hooks': that module reaches the plugin loader,
// and through it every view a plugin may mount. Importing it here would drag that graph into
// everything that reads the app catalogue, which is nearly the whole app.
import { useWebPluginRuntime } from '@/plugins/runtime-store'
import { resolveApps, type ResolvedApps } from './preferences'
import {
  activePluginKey,
  adaptWebviewApps,
  appRegistry,
  filterAppsByPlugin,
  findHostedAppByRouteId,
  type RegisteredApp,
} from './registry'
import { getAppPreferences, subscribeAppPreferences } from './store'

export interface AppCatalog extends ResolvedApps {
  loadingWebviews: boolean
  findByPath(pathname: string): RegisteredApp | undefined
  findByRouteId(routeId: string): RegisteredApp | undefined
}

function matchesPath(app: RegisteredApp, pathname: string): boolean {
  if (app.path === '/') return pathname === '/'
  return pathname === app.path || pathname.startsWith(`${app.path}/`)
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
      findByPath: (pathname: string) => resolved.all.find((app) => matchesPath(app, pathname)),
      findByRouteId: (routeId: string) => findHostedAppByRouteId(resolved.all, routeId),
    }
  }, [preferences, registrySnapshot, webviews.apps, webviews.loading, activeKey])
}
