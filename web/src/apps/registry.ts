import type { ComponentType } from 'react'
import type { PluginApp } from '@/api/apps'
import { disposable } from '@/plugins/disposable'

export type AppBadge = number | 'dot' | null
export type AppKind = 'core' | 'native' | 'webview'

/**
 * WHERE an app's entry row lives. One registry, two consumers: the Sidebar renders
 * `'sidebar'` apps, the Settings "Manage" group renders `'settings'` apps. Everything
 * else about an app is placement-blind — same route, same deep links, same Command
 * Palette entry, same owner lifecycle — so moving an app between surfaces can never
 * change what it can do.
 */
export type AppPlacement = 'sidebar' | 'settings'

export const APP_PLACEMENTS: readonly AppPlacement[] = ['sidebar', 'settings']

export interface AppComponentProps {
  basePath: string
  subpath: string
  search: string
  navigate(path: string, options?: { replace?: boolean }): void
}

export interface AppContribution {
  id: string
  title: string
  icon?: ComponentType<{ size?: number }>
  component: ComponentType<AppComponentProps>
  badge?: AppBadge
  order?: number
  fullBleed?: boolean
  /** Default 'sidebar', so every plugin written before this field keeps its row. */
  placement?: AppPlacement
}

export interface CoreAppContribution {
  id: string
  title: string
  path: string
  icon?: ComponentType<{ size?: number }>
  component: ComponentType<AppComponentProps>
  order?: number
  fullBleed?: boolean
  persistent?: boolean
  lockVisibility?: boolean
}

export interface RegisteredApp {
  key: string
  id: string
  owner: string
  kind: AppKind
  title: string
  path: string
  routeId: string
  icon?: ComponentType<{ size?: number }>
  iconUrl?: string | null
  component?: ComponentType<AppComponentProps>
  badge: AppBadge
  order: number
  fullBleed: boolean
  placement: AppPlacement
  persistent: boolean
  lockVisibility: boolean
  generation: number
  pluginId?: string
  pluginName?: string
  webview?: PluginApp
}

interface AppEntry extends RegisteredApp {
  token: symbol
}

export interface AppSnapshot {
  version: number
  apps: RegisteredApp[]
}

export interface AppHandle {
  readonly path: string
  setBadge(value: AppBadge): void
  dispose(): void | Promise<void>
}

function clean(entry: AppEntry): RegisteredApp {
  const { token: _token, ...app } = entry
  return app
}

function pluginRouteId(pluginId: string, localId: string): string {
  return `${pluginId}~${localId}`
}

function assertBadge(value: AppBadge): void {
  if (value === null || value === 'dot') return
  if (!Number.isInteger(value) || value < 0) {
    throw new Error('App badge must be a non-negative integer, dot, or null')
  }
}

/**
 * A typo here would be silent — an unknown placement matches no consumer's filter, so
 * the app would register successfully and then appear NOWHERE. Refusing the value is
 * the only way the author finds out.
 */
function resolvePlacement(value: AppPlacement | undefined): AppPlacement {
  if (value === undefined) return 'sidebar'
  if (!APP_PLACEMENTS.includes(value)) {
    throw new Error(`App placement must be one of ${APP_PLACEMENTS.join(', ')}`)
  }
  return value
}

export class AppRegistry {
  private readonly entries = new Map<string, AppEntry>()
  private readonly listeners = new Set<() => void>()
  private generation = 0
  private snapshot: AppSnapshot = { version: 0, apps: [] }

  registerCore(contribution: CoreAppContribution): AppHandle {
    const key = `core:${contribution.id}`
    return this.register({
      key,
      id: contribution.id,
      owner: 'core',
      kind: 'core',
      title: contribution.title,
      path: contribution.path,
      routeId: contribution.id,
      icon: contribution.icon,
      component: contribution.component,
      badge: null,
      order: contribution.order ?? 100,
      fullBleed: contribution.fullBleed ?? false,
      // Core screens are the Sidebar; there is no reason for one to opt out, and
      // giving them the choice would only add a way to lose Chat or Home.
      placement: 'sidebar',
      persistent: contribution.persistent ?? false,
      lockVisibility: contribution.lockVisibility ?? false,
    })
  }

  registerPlugin(pluginId: string, pluginName: string, contribution: AppContribution): AppHandle {
    assertBadge(contribution.badge ?? null)
    const placement = resolvePlacement(contribution.placement)
    const routeId = pluginRouteId(pluginId, contribution.id)
    return this.register({
      key: `${pluginId}:${contribution.id}`,
      id: contribution.id,
      owner: pluginId,
      kind: 'native',
      title: contribution.title,
      path: `/apps/${routeId}`,
      routeId,
      icon: contribution.icon,
      component: contribution.component,
      badge: contribution.badge ?? null,
      order: contribution.order ?? 500,
      fullBleed: contribution.fullBleed ?? true,
      placement,
      persistent: false,
      lockVisibility: false,
      pluginId,
      pluginName,
    })
  }

  removeOwner(owner: string): number {
    let removed = 0
    for (const [key, entry] of this.entries) {
      if (entry.owner !== owner) continue
      this.entries.delete(key)
      removed++
    }
    if (removed > 0) this.publish()
    return removed
  }

  findByKey(key: string): RegisteredApp | undefined {
    return this.snapshot.apps.find((app) => app.key === key)
  }

  findByRouteId(routeId: string): RegisteredApp | undefined {
    return this.snapshot.apps.find((app) => app.routeId === routeId)
  }

  findByPath(pathname: string): RegisteredApp | undefined {
    return this.snapshot.apps.find((app) => (
      app.path === '/'
        ? pathname === '/'
        : pathname === app.path || pathname.startsWith(`${app.path}/`)
    ))
  }

  getSnapshot = (): AppSnapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  clear(): void {
    if (this.entries.size === 0) return
    this.entries.clear()
    this.publish()
  }

  private register(value: Omit<AppEntry, 'generation' | 'token'>): AppHandle {
    if (this.entries.has(value.key)) throw new Error(`App "${value.key}" is already registered`)
    const pathCollision = [...this.entries.values()].find((entry) => entry.path === value.path)
    if (pathCollision) throw new Error(`App path "${value.path}" is already registered by "${pathCollision.key}"`)
    const token = Symbol(value.key)
    const entry: AppEntry = {
      ...value,
      generation: ++this.generation,
      token,
    }
    this.entries.set(value.key, entry)
    this.publish()

    const registration = disposable(() => {
      if (this.entries.get(value.key)?.token !== token) return
      this.entries.delete(value.key)
      this.publish()
    })
    return {
      path: value.path,
      setBadge: (badge) => {
        assertBadge(badge)
        const current = this.entries.get(value.key)
        if (current?.token !== token || current.badge === badge) return
        current.badge = badge
        this.publish()
      },
      dispose: () => registration.dispose(),
    }
  }

  private publish(): void {
    this.snapshot = {
      version: this.snapshot.version + 1,
      apps: [...this.entries.values()]
        .sort((a, b) => a.order - b.order || a.key.localeCompare(b.key))
        .map(clean),
    }
    for (const listener of this.listeners) listener()
  }
}

export function findHostedAppByRouteId(
  apps: RegisteredApp[],
  routeId: string,
): RegisteredApp | undefined {
  return apps.find((app) => app.kind !== 'core' && app.routeId === routeId)
}

export function adaptWebviewApps(apps: PluginApp[]): RegisteredApp[] {
  return apps
    .map((webview, index): RegisteredApp => ({
      key: `webview:${webview.id}`,
      id: webview.id,
      owner: webview.pluginId,
      kind: 'webview',
      title: webview.title,
      path: `/apps/${webview.id}`,
      routeId: webview.id,
      iconUrl: webview.icon,
      badge: null,
      order: 500 + index,
      fullBleed: true,
      // A legacy webview has no way to ask for anything else.
      placement: 'sidebar',
      persistent: false,
      lockVisibility: false,
      generation: 0,
      pluginId: webview.pluginId,
      pluginName: webview.title,
      webview,
    }))
    .sort((a, b) => a.order - b.order || a.key.localeCompare(b.key))
}

export const appRegistry = new AppRegistry()
