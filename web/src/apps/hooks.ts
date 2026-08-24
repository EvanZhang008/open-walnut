import { useMemo, useSyncExternalStore } from 'react'
import { useApps } from '@/hooks/useApps'
import { resolveApps, type ResolvedApps } from './preferences'
import {
  adaptWebviewApps,
  appRegistry,
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

  return useMemo(() => {
    const combined = [...registrySnapshot.apps, ...adaptWebviewApps(webviews.apps)]
      .sort((a, b) => a.order - b.order || a.key.localeCompare(b.key))
    const resolved = resolveApps(combined, preferences)
    return {
      ...resolved,
      loadingWebviews: webviews.loading,
      findByPath: (pathname: string) => resolved.all.find((app) => matchesPath(app, pathname)),
      findByRouteId: (routeId: string) => findHostedAppByRouteId(resolved.all, routeId),
    }
  }, [preferences, registrySnapshot, webviews.apps, webviews.loading])
}
