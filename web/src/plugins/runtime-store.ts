import { useSyncExternalStore } from 'react'
import type { PluginWebModuleDescriptor } from './types'

/**
 * The web plugin runtime snapshot, as a LEAF module.
 *
 * It lives apart from `loader.ts` on purpose. The loader reaches `host-api.ts`, which reaches
 * `views.tsx`, which reaches every view a plugin may mount (NotesPage, CalendarPage, the
 * session panel); one of those runs `addHook` on a shared DOMPurify instance at module scope.
 * Anything that only needs to know WHICH PLUGINS ARE ACTIVE (the app catalogue's gate, the
 * settings registry) must be able to ask without dragging that graph in, so this file imports
 * nothing but React and a type.
 */

export interface WebPluginRuntimeSnapshot {
  ready: boolean
  loading: boolean
  plugins: Array<{ id: string; state: string }>
  tombstones: Array<{ id: string; reason: string }>
  modules: PluginWebModuleDescriptor[]
  errors: Array<{ id: string; error: string }>
  version: number
}

function emptySnapshot(version: number): WebPluginRuntimeSnapshot {
  return {
    ready: false,
    loading: false,
    plugins: [],
    tombstones: [],
    modules: [],
    errors: [],
    version,
  }
}

const listeners = new Set<() => void>()
let snapshot: WebPluginRuntimeSnapshot = emptySnapshot(0)

/** Only the loader calls this. */
export function publishWebPluginRuntime(patch: Partial<WebPluginRuntimeSnapshot>): void {
  snapshot = { ...snapshot, ...patch, version: snapshot.version + 1 }
  for (const listener of listeners) listener()
}

export function getWebPluginRuntimeSnapshot(): WebPluginRuntimeSnapshot {
  return snapshot
}

export function subscribeWebPluginRuntime(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function resetWebPluginRuntime(): void {
  snapshot = emptySnapshot(snapshot.version + 1)
  for (const listener of listeners) listener()
}

export function useWebPluginRuntime(): WebPluginRuntimeSnapshot {
  return useSyncExternalStore(
    subscribeWebPluginRuntime,
    getWebPluginRuntimeSnapshot,
    getWebPluginRuntimeSnapshot,
  )
}
