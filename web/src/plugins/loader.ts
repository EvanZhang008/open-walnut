import { apiGet, apiGetText } from '@/api/client'
import { wsClient } from '@/api/ws'
import { PLUGINS_CHANGED_EVENT } from '@/utils/plugin-events'
import { log } from '@/utils/log'
import { createWebPluginApi } from './host-api'
import { WebPluginContext, disposable } from './disposable'
import { pluginUiRegistry } from './registry'
import type {
  Disposable,
  PluginRuntimeResponse,
  PluginWebModuleDescriptor,
  WalnutWebApiHost,
} from './types'

interface WebPluginModule {
  activate?: (api: WalnutWebApiHost) => void | Disposable | Promise<void | Disposable>
  deactivate?: () => void | Promise<void>
  default?:
    | ((api: WalnutWebApiHost) => void | Disposable | Promise<void | Disposable>)
    | {
        activate(api: WalnutWebApiHost): void | Disposable | Promise<void | Disposable>
        deactivate?(): void | Promise<void>
      }
}

interface LoadedPlugin {
  descriptor: PluginWebModuleDescriptor
  context: WebPluginContext
}

export interface WebPluginRuntimeSnapshot {
  ready: boolean
  loading: boolean
  plugins: Array<{ id: string; state: string }>
  tombstones: Array<{ id: string; reason: string }>
  modules: PluginWebModuleDescriptor[]
  errors: Array<{ id: string; error: string }>
  version: number
}

type ModuleImporter = (
  source: string,
  descriptor: PluginWebModuleDescriptor,
) => Promise<WebPluginModule>

const loaded = new Map<string, LoadedPlugin>()
const listeners = new Set<() => void>()
let snapshot: WebPluginRuntimeSnapshot = {
  ready: false,
  loading: false,
  plugins: [],
  tombstones: [],
  modules: [],
  errors: [],
  version: 0,
}
let initialized = false
let operationTail: Promise<void> = Promise.resolve()
let activationTimeoutMs = 10_000

const browserImporter: ModuleImporter = async (source, descriptor) => {
  const blob = new Blob([
    source,
    `\n//# sourceURL=walnut-plugin://${descriptor.id}/${descriptor.hash}.mjs\n`,
  ], { type: 'text/javascript' })
  const url = URL.createObjectURL(blob)
  try {
    return await import(/* @vite-ignore */ url) as WebPluginModule
  } finally {
    URL.revokeObjectURL(url)
  }
}

let moduleImporter: ModuleImporter = browserImporter

function publish(patch: Partial<WebPluginRuntimeSnapshot>): void {
  snapshot = { ...snapshot, ...patch, version: snapshot.version + 1 }
  for (const listener of listeners) listener()
}

function functionsFrom(module: WebPluginModule): {
  activate: ((api: WalnutWebApiHost) => void | Disposable | Promise<void | Disposable>) | null
  deactivate: (() => void | Promise<void>) | null
} {
  if (typeof module.activate === 'function') {
    return {
      activate: module.activate,
      deactivate: typeof module.deactivate === 'function' ? module.deactivate : null,
    }
  }
  if (typeof module.default === 'function') {
    return { activate: module.default, deactivate: null }
  }
  if (module.default && typeof module.default.activate === 'function') {
    return {
      activate: module.default.activate.bind(module.default),
      deactivate: typeof module.default.deactivate === 'function'
        ? module.default.deactivate.bind(module.default)
        : null,
    }
  }
  return { activate: null, deactivate: null }
}

async function unload(pluginId: string): Promise<void> {
  const current = loaded.get(pluginId)
  if (!current) {
    pluginUiRegistry.removeOwner(pluginId)
    return
  }
  loaded.delete(pluginId)
  try {
    await current.context.dispose()
  } finally {
    pluginUiRegistry.removeOwner(pluginId)
  }
}

async function activateWithDeadline(
  activate: (api: WalnutWebApiHost) => void | Disposable | Promise<void | Disposable>,
  api: WalnutWebApiHost,
  pluginId: string,
): Promise<void | Disposable> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.resolve(activate(api)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(
          `Web Plugin "${pluginId}" activation timed out after ${activationTimeoutMs}ms`,
        )), activationTimeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function load(descriptor: PluginWebModuleDescriptor): Promise<void> {
  const context = new WebPluginContext()
  try {
    const source = await apiGetText(descriptor.url, undefined, { timeoutMs: 15_000 })
    const module = await moduleImporter(source, descriptor)
    const functions = functionsFrom(module)
    if (!functions.activate) throw new Error('Web Plugin module must export activate(walnut)')
    const activation = await activateWithDeadline(
      functions.activate,
      createWebPluginApi(descriptor.id, descriptor.name, context),
      descriptor.id,
    )
    if (activation) context.own(activation)
    if (functions.deactivate) context.own(disposable(functions.deactivate))
    loaded.set(descriptor.id, { descriptor, context })
  } catch (error) {
    await context.dispose().catch(() => undefined)
    pluginUiRegistry.removeOwner(descriptor.id)
    throw error
  }
}

async function refreshNow(): Promise<void> {
  publish({ loading: true })
  const errors: Array<{ id: string; error: string }> = []
  let plugins: Array<{ id: string; state: string }> = []
  let tombstones: Array<{ id: string; reason: string }> = []
  let modules: PluginWebModuleDescriptor[] = []
  try {
    const response = await apiGet<PluginRuntimeResponse>('/api/plugin-runtime', undefined, { timeoutMs: 15_000 })
    plugins = response.plugins ?? []
    tombstones = response.tombstones ?? []
    modules = response.modules ?? []
    errors.push(...(response.moduleErrors ?? []))
    const expected = new Map(modules.map((descriptor) => [descriptor.id, descriptor]))

    for (const [pluginId, current] of [...loaded]) {
      const next = expected.get(pluginId)
      if (next && next.hash === current.descriptor.hash) continue
      try {
        await unload(pluginId)
      } catch (error) {
        errors.push({
          id: pluginId,
          error: error instanceof Error ? error.message : String(error),
        })
        log.error('plugins', 'native Web Plugin cleanup failed', {
          pluginId,
          error: errors[errors.length - 1].error,
        })
      }
    }

    for (const descriptor of modules) {
      if (loaded.get(descriptor.id)?.descriptor.hash === descriptor.hash) continue
      try {
        await load(descriptor)
      } catch (error) {
        errors.push({
          id: descriptor.id,
          error: error instanceof Error ? error.message : String(error),
        })
        log.error('plugins', 'native Web Plugin activation failed', {
          pluginId: descriptor.id,
          error: errors[errors.length - 1].error,
        })
      }
    }
  } catch (error) {
    errors.push({ id: 'runtime', error: error instanceof Error ? error.message : String(error) })
    log.warn('plugins', 'failed to refresh native Web Plugins', { error: errors[0].error })
  } finally {
    publish({ ready: true, loading: false, plugins, tombstones, modules, errors })
  }
}

export function refreshWebPlugins(): Promise<void> {
  operationTail = operationTail.catch(() => undefined).then(refreshNow)
  return operationTail
}

/**
 * A server plugin can contribute slash commands and skills, so the same reload that
 * swaps web modules also changes the "/" palette. Refreshed here, AFTER the catalogue
 * refresh settles, in a fixed order: markdown commands, then skills. Owner tiers in the
 * command registry make the outcome order-independent anyway (commands always outrank
 * skills, and neither refresh can touch the core commands), but a deterministic order
 * keeps the network calls predictable.
 *
 * Imported dynamically: the command bridges reach into the API layer, and a static
 * import would tie the plugin loader to that graph (and risk a cycle) for a path that
 * only runs on a plugin change. Initial startup is untouched — index.ts still does the
 * first load exactly once.
 */
async function refreshPluginCommandCatalogue(): Promise<void> {
  try {
    const [markdown, skills] = await Promise.all([
      import('@/commands/markdown-bridge'),
      import('@/commands/skill-bridge'),
    ])
    await markdown.refreshMarkdownCommands()
    await skills.refreshSkillCommands()
  } catch (error) {
    log.warn('plugins', 'failed to refresh slash commands after a Plugin change', {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/** Catalogue refresh + the slash commands/skills that came with those plugins. */
export function refreshWebPluginsWithCommands(): Promise<void> {
  return refreshWebPlugins().then(refreshPluginCommandCatalogue)
}

export function initWebPlugins(): Promise<void> {
  if (initialized) return operationTail
  initialized = true
  const refresh = () => { void refreshWebPlugins() }
  // A plugin came, went, or reloaded — its commands/skills changed with it.
  const refreshWithCommands = () => { void refreshWebPluginsWithCommands() }
  window.addEventListener(PLUGINS_CHANGED_EVENT, refreshWithCommands)
  wsClient.onEvent('plugin:runtime-changed', refreshWithCommands)
  wsClient.onConnectionChange((state) => {
    if (state === 'connected') refreshWithCommands()
  })
  return refreshWebPluginsWithCommands()
}

export function getWebPluginRuntimeSnapshot(): WebPluginRuntimeSnapshot {
  return snapshot
}

export function subscribeWebPluginRuntime(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export async function disposeWebPluginsForTesting(): Promise<void> {
  for (const pluginId of [...loaded.keys()]) await unload(pluginId)
  initialized = false
  moduleImporter = browserImporter
  activationTimeoutMs = 10_000
  snapshot = {
    ready: false,
    loading: false,
    plugins: [],
    tombstones: [],
    modules: [],
    errors: [],
    version: snapshot.version + 1,
  }
}

export function setWebPluginImporterForTesting(importer: ModuleImporter): void {
  moduleImporter = importer
}

export function setWebPluginActivationTimeoutForTesting(timeoutMs: number): void {
  activationTimeoutMs = timeoutMs
}
