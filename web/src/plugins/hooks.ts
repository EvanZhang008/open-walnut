import { useSyncExternalStore } from 'react'
import { pluginUiRegistry } from './registry'

export function usePluginUi() {
  return useSyncExternalStore(
    pluginUiRegistry.subscribe,
    pluginUiRegistry.getSnapshot,
    pluginUiRegistry.getSnapshot,
  )
}

// Defined on the leaf store, so a consumer can gate on the runtime without importing this
// module (which pulls the plugin UI registry, and through it the loader's view graph).
export { useWebPluginRuntime } from './runtime-store'
