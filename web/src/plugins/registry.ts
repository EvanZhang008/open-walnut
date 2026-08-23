import type {
  Disposable,
  PluginNavContribution,
  PluginPageContribution,
  PluginPanelContribution,
  PluginSettingsContribution,
  PluginUiSnapshot,
  RegisteredUiContribution,
} from './types'
import { disposable } from './disposable'

type Contribution =
  | PluginNavContribution
  | PluginPageContribution
  | PluginPanelContribution
  | PluginSettingsContribution

type Kind = 'nav' | 'pages' | 'panels' | 'settings'

type Entry<T extends Contribution> = RegisteredUiContribution<T> & { token: symbol }

class PluginUiRegistry {
  private readonly maps = {
    nav: new Map<string, Entry<PluginNavContribution>>(),
    pages: new Map<string, Entry<PluginPageContribution>>(),
    panels: new Map<string, Entry<PluginPanelContribution>>(),
    settings: new Map<string, Entry<PluginSettingsContribution>>(),
  }
  private readonly listeners = new Set<() => void>()
  private generation = 0
  private snapshot: PluginUiSnapshot = {
    version: 0,
    nav: [],
    pages: [],
    panels: [],
    settings: [],
  }

  registerNav(pluginId: string, pluginName: string, value: PluginNavContribution): Disposable {
    return this.register('nav', pluginId, pluginName, value)
  }

  registerPage(pluginId: string, pluginName: string, value: PluginPageContribution): Disposable {
    const collision = [...this.maps.pages.values()].find((entry) => entry.value.path === value.path)
    if (collision) {
      throw new Error(`Plugin page path "${value.path}" is already registered by "${collision.pluginId}"`)
    }
    return this.register('pages', pluginId, pluginName, value)
  }

  registerPanel(pluginId: string, pluginName: string, value: PluginPanelContribution): Disposable {
    return this.register('panels', pluginId, pluginName, value)
  }

  registerSettings(pluginId: string, pluginName: string, value: PluginSettingsContribution): Disposable {
    return this.register('settings', pluginId, pluginName, value)
  }

  removeOwner(pluginId: string): number {
    let removed = 0
    for (const map of Object.values(this.maps)) {
      for (const [key, entry] of map) {
        if (entry.pluginId !== pluginId) continue
        map.delete(key)
        removed++
      }
    }
    if (removed > 0) this.publish()
    return removed
  }

  getSnapshot = (): PluginUiSnapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  clear(): void {
    for (const map of Object.values(this.maps)) map.clear()
    this.publish()
  }

  private register<K extends Kind>(
    kind: K,
    pluginId: string,
    pluginName: string,
    value: Contribution,
  ): Disposable {
    const key = `${pluginId}:${value.id}`
    const map = this.maps[kind] as Map<string, Entry<Contribution>>
    if (map.has(key)) throw new Error(`Plugin UI contribution "${key}" is already registered`)
    const token = Symbol(key)
    map.set(key, {
      key,
      pluginId,
      pluginName,
      generation: ++this.generation,
      value,
      token,
    })
    this.publish()
    return disposable(() => {
      if (map.get(key)?.token !== token) return
      map.delete(key)
      this.publish()
    })
  }

  private publish(): void {
    const clean = <T extends Contribution>(entry: Entry<T>): RegisteredUiContribution<T> => ({
      key: entry.key,
      pluginId: entry.pluginId,
      pluginName: entry.pluginName,
      generation: entry.generation,
      value: entry.value,
    })
    const nav = [...this.maps.nav.values()]
      .sort((a, b) => (a.value.order ?? 100) - (b.value.order ?? 100) || a.generation - b.generation)
      .map(clean)
    this.snapshot = {
      version: this.snapshot.version + 1,
      nav,
      pages: [...this.maps.pages.values()].map(clean),
      panels: [...this.maps.panels.values()]
        .sort((a, b) => (a.value.order ?? 100) - (b.value.order ?? 100) || a.generation - b.generation)
        .map(clean),
      settings: [...this.maps.settings.values()].map(clean),
    }
    for (const listener of this.listeners) listener()
  }
}

export const pluginUiRegistry = new PluginUiRegistry()
