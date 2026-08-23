import { useSyncExternalStore } from 'react'
import {
  getWebPluginRuntimeSnapshot,
  subscribeWebPluginRuntime,
} from './loader'
import { pluginUiRegistry } from './registry'

export function usePluginUi() {
  return useSyncExternalStore(
    pluginUiRegistry.subscribe,
    pluginUiRegistry.getSnapshot,
    pluginUiRegistry.getSnapshot,
  )
}

export function useWebPluginRuntime() {
  return useSyncExternalStore(
    subscribeWebPluginRuntime,
    getWebPluginRuntimeSnapshot,
    getWebPluginRuntimeSnapshot,
  )
}
