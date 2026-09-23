import { apiGet } from '@/api/client'
import { wsClient } from '@/api/ws'
import { PLUGINS_CHANGED_EVENT } from '@/utils/plugin-events'
import { coalesceRefresh } from '@/utils/coalesce-refresh'
import { log } from '@/utils/log'
import { refreshAppsCatalogue } from '@/hooks/useApps'
import {
  isLoaded,
  loadedHash,
  managedPluginIds,
  setGenerationRefreshHandler,
  resetGenerationsForTesting,
  runningModules,
  swapPlugin,
  sweepUnownedRows,
  unload,
  type RefreshError,
} from './generation'
import {
  getWebPluginRuntimeSnapshot,
  publishWebPluginRuntime as publish,
  resetWebPluginRuntime,
  subscribeWebPluginRuntime,
} from './runtime-store'
import type { PluginRuntimeResponse, PluginWebModuleDescriptor } from './types'

// The snapshot itself lives in the leaf store so a consumer that only needs "which plugins are
// active" is not forced to import this module's whole view graph. Re-exported here because the
// loader was the original home and every existing caller (and test) imports it from here.
export { getWebPluginRuntimeSnapshot, subscribeWebPluginRuntime }
export type { WebPluginRuntimeSnapshot } from './runtime-store'
export {
  setWebPluginActivationTimeoutForTesting,
  setWebPluginCleanupBudgetForTesting,
  setWebPluginImporterForTesting,
} from './generation'

let initialized = false
let operationTail: Promise<void> = Promise.resolve()

/**
 * Backoff for a failed refresh, and why every failure retries.
 *
 * The FIRST refresh has nothing to fall back on: publishing `ready: true` with an empty plugin
 * list tells the whole app "no plugins are installed" on the strength of one failed fetch, and
 * every `requiresPlugin` app stays hidden for the life of the page. A boot on a loaded machine
 * really does hit this (a 15 s timeout is reachable).
 *
 * A LATER refresh keeps the last authoritative answer, so its failure looks harmless, but it was
 * triggered by something (a plugin reload, a reconnect) and the window now silently runs the
 * previous bundle until the next unrelated trigger. The 20 s connection-pool queue is the failure
 * that actually happens here, and it clears on its own, so a bounded retry is what turns "reload
 * the page to see the new plugin" back into the hot swap it is meant to be.
 *
 * Bounded on purpose: `ready` gates the app shell, so staying unready forever is an indefinite
 * spinner, which is a worse failure than a wrong empty list. Five tries, then publish whatever we
 * have plus the error and let the UI say so. Only the first refresh shows `loading` while it
 * retries; a later one keeps rendering what it has.
 */
const REFRESH_BACKOFF_MS = [500, 1_000, 2_000, 4_000, 8_000]
let firstRefreshSettled = false
/** Two budgets, because one bad plugin spending the ladder must not disarm the runtime's retry. */
let runtimeRetries = 0
let moduleRetries = 0
let retryTimer: ReturnType<typeof setTimeout> | null = null

function cancelRefreshRetry(): void {
  if (retryTimer === null) return
  clearTimeout(retryTimer)
  retryTimer = null
}

/**
 * Re-enter through `refreshWebPlugins`, never by awaiting `refreshNow` from inside itself:
 * `refreshWebPlugins` appends to `operationTail`, and a refresh that awaited its own retry would
 * be waiting on a promise queued behind itself.
 */
function scheduleRefreshRetry(kind: 'runtime' | 'module'): void {
  const used = kind === 'runtime' ? runtimeRetries : moduleRetries
  const delay = REFRESH_BACKOFF_MS[used] ?? REFRESH_BACKOFF_MS[REFRESH_BACKOFF_MS.length - 1]!
  if (kind === 'runtime') runtimeRetries += 1
  else moduleRetries += 1
  cancelRefreshRetry()
  retryTimer = setTimeout(() => {
    retryTimer = null
    void refreshWebPlugins()
  }, delay)
}

/** Mid-reload states only. `needs-dependency` is a cascade disable, so its UI has to go. */
const RELOADING_STATES = new Set(['activating', 'disposing'])

async function refreshNow(): Promise<void> {
  const previous = getWebPluginRuntimeSnapshot()
  publish({ loading: true })
  const errors: RefreshError[] = []
  // Seeded from the LAST AUTHORITATIVE answer, not from empty. A failed fetch (a 15 s timeout,
  // a WS reconnect blip) must not read as "no plugins are installed": consumers gate on this
  // list, so an empty publish hides a plugin-gated app and can evict someone standing on its
  // route. Everything that mutates these three is inside the try, after the response replaced
  // them, so a failure leaves the snapshot exactly as the last good refresh left it.
  let plugins: Array<{ id: string; state: string }> = previous.plugins
  let tombstones: Array<{ id: string; reason: string }> = previous.tombstones
  let modules: PluginWebModuleDescriptor[] = previous.modules
  let runtimeFailed = false
  let moduleRetryWanted = false
  try {
    const response = await apiGet<PluginRuntimeResponse>('/api/plugin-runtime', undefined, { timeoutMs: 15_000 })
    plugins = response.plugins ?? []
    tombstones = response.tombstones ?? []
    modules = response.modules ?? []
    const moduleErrors = response.moduleErrors ?? []
    errors.push(...moduleErrors)
    const offered = new Set(modules.map((descriptor) => descriptor.id))
    const states = new Map(plugins.map((entry) => [entry.id, entry.state]))
    const failedToBuild = new Set(moduleErrors.map((entry) => entry.id))

    for (const pluginId of managedPluginIds()) {
      if (offered.has(pluginId)) continue
      const state = states.get(pluginId) ?? ''
      // Keep the running UI only while the omission is explained: a reload in flight, or a build
      // that failed. An active plugin offering no module and reporting no error dropped its web
      // entry on purpose, so keeping the old one would pin a UI the plugin no longer ships.
      if (RELOADING_STATES.has(state)) continue
      if (state === 'active' && failedToBuild.has(pluginId)) continue
      await unload(pluginId, errors)
    }

    for (const descriptor of modules) {
      if (loadedHash(descriptor.id) === descriptor.hash) continue
      if (await swapPlugin(descriptor, errors)) moduleRetryWanted = true
    }

    // Nothing is running under these ids, so their web entries go with them.
    for (const descriptor of modules) {
      if (!isLoaded(descriptor.id)) sweepUnownedRows(descriptor.id)
    }
    modules = runningModules(modules)
  } catch (error) {
    runtimeFailed = true
    errors.push({ id: 'runtime', error: error instanceof Error ? error.message : String(error) })
    log.warn('plugins', 'failed to refresh native Web Plugins', { error: errors[errors.length - 1]!.error })
  } finally {
    // The runtime answer landing ends the initial unready window, whatever the modules did with it.
    if (!runtimeFailed) firstRefreshSettled = true
    // Each budget resets only on its own success, or a failure would never run out of tries.
    if (!runtimeFailed) runtimeRetries = 0
    if (!moduleRetryWanted) moduleRetries = 0
    const runtimeRetrying = runtimeFailed && runtimeRetries < REFRESH_BACKOFF_MS.length
    const moduleRetrying = moduleRetryWanted && moduleRetries < REFRESH_BACKOFF_MS.length
    const retrying = runtimeRetrying || moduleRetrying
    if (!retrying) cancelRefreshRetry()
    // `ready` never goes back to false once it has been true: consumers evict on an empty list.
    publish({
      ready: firstRefreshSettled || !retrying,
      loading: retrying && !firstRefreshSettled,
      plugins,
      tombstones,
      modules,
      errors,
    })
    if (retrying) scheduleRefreshRetry(runtimeRetrying ? 'runtime' : 'module')
  }
}

export function refreshWebPlugins(): Promise<void> {
  setGenerationRefreshHandler(() => { void refreshWebPlugins() })
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
 * first load exactly once (initWebPlugins below loads only the plugin catalogue).
 */
async function refreshPluginCommandCatalogue(changedAt?: number): Promise<void> {
  try {
    const [markdown, skills] = await Promise.all([
      import('@/commands/markdown-bridge'),
      import('@/commands/skill-bridge'),
    ])
    await markdown.refreshMarkdownCommands()
    await skills.refreshSkillCommands({ changedAt })
  } catch (error) {
    log.warn('plugins', 'failed to refresh slash commands after a Plugin change', {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/** Catalogue refresh + the slash commands/skills that came with those plugins. */
export async function refreshWebPluginsWithCommands(changedAt?: number): Promise<void> {
  await Promise.all([refreshWebPlugins(), refreshAppsCatalogue()])
  await refreshPluginCommandCatalogue(changedAt)
}

export function initWebPlugins(): Promise<void> {
  if (initialized) return operationTail
  initialized = true
  // A plugin came, went, or reloaded — its commands/skills changed with it. One update
  // announces itself several times within a second (a WS event per reloaded plugin, then
  // the client's own plugins-changed); they collapse into one catalogue read (N2-10).
  //
  // Each signal is stamped with when it arrived, and the run asks the skill bridge
  // for a list that includes changes up to the LATEST stamp it serves: on a page
  // load, the first socket connect then reuses the skill read index.ts already
  // sent after it instead of reading the 1.2MB list again.
  let latestSignalAt = 0
  const coalesced = coalesceRefresh(() => refreshWebPluginsWithCommands(latestSignalAt))
  const refreshWithCommands = () => {
    latestSignalAt = performance.now()
    void coalesced.request()
  }
  window.addEventListener(PLUGINS_CHANGED_EVENT, refreshWithCommands)
  wsClient.onEvent('plugin:runtime-changed', refreshWithCommands)
  wsClient.onConnectionChange((state) => {
    if (state === 'connected') refreshWithCommands()
  })
  // The catalogue only: commands/index.ts owns the first command + skill load.
  // Running the command refresh here too made every page load read the skill
  // list (1.2MB) an extra time, concurrently with index.ts's own read. A first
  // connect still asks (it is how a page loaded while the server was down
  // recovers its palette); the skill bridge answers it from index.ts's read when
  // that read left after the connect.
  return Promise.all([refreshWebPlugins(), refreshAppsCatalogue()]).then(() => undefined)
}

export async function disposeWebPluginsForTesting(): Promise<void> {
  await resetGenerationsForTesting()
  initialized = false
  cancelRefreshRetry()
  firstRefreshSettled = false
  runtimeRetries = 0
  moduleRetries = 0
  resetWebPluginRuntime()
}
