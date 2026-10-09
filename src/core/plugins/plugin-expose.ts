/**
 * `walnut.expose` for plugins: contribute a tunnel provider definition
 * (src/core/expose/). The definition belongs to the plugin, so its dispose
 * (disable, reload, uninstall) removes it, and a tunnel running it stops.
 */
import { toDisposable, type Disposable } from './disposable.js'
import { registerExposeProvider } from '../expose/registry.js'
import { currentExposeStatus } from '../expose/status.js'
import type { ExposeProviderDefinition, ExposeStatus } from '../expose/types.js'

export interface PluginExposeOptions {
  pluginId: string
  own: <T extends Disposable>(registration: T) => T
  assertLive: (registration: string) => void
}

export function createPluginExpose({ pluginId, own, assertLive }: PluginExposeOptions) {
  return {
    register(def: ExposeProviderDefinition): Disposable {
      assertLive(`expose.register(${String(def?.id)})`)
      const registration = registerExposeProvider(pluginId, def)
      return own(toDisposable(() => registration.dispose()))
    },
    status(): ExposeStatus {
      return currentExposeStatus()
    },
  }
}
