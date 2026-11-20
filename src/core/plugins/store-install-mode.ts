/**
 * Which plugins of a Plugin Store source load: each plugin's manifest says `install`.
 *
 *   - `auto` (also a manifest that says nothing): loads as soon as its source is on the
 *     machine, the way every store plugin did before the field existed.
 *   - `optional`: the source carries it, but it waits under its source on the Apps page
 *     until the user presses Install.
 *
 * The user's choice lives where a bundled plugin's does: `plugins.<id>.enabled` in
 * config.yaml. Present (true or false) means installed (on or off); absent means not
 * installed. So a store plugin that loads is pinned `enabled: true` the first time, and
 * from then on a store that later marks it `optional` never takes it away from someone
 * who had it. Switching an `auto` plugin off writes `false`, which keeps it off.
 *
 * Each source also keeps the ids this machine installed from it (`kept` in sources.json):
 * a write that replaces the whole `plugins` section from an older snapshot (an old Settings
 * tab, a script) can drop a pin, and the kept list puts it back at the next discovery.
 * Remove takes an id out of both.
 *
 * Upgrade: a Walnut older than this loaded every plugin of a source, whatever its manifest
 * said. A source that no Walnut with install modes has sorted yet (`installModes` absent in
 * sources.json) therefore keeps every plugin it has on disk: the first sort pins and keeps
 * them all, then marks the source. A source added from here on starts marked, so its
 * optional plugins stay out until asked for. Going back to an older Walnut loads them all
 * again (that version's behaviour); nothing it reads changed shape.
 *
 * A replica (the cloud companion) writes nothing here: config.yaml is the Mac's to write, so
 * it plans from what it has and loads an unsorted source whole.
 */

import { editPluginConfig, getConfig } from '../config-manager.js'
import { isHostReplicaProgram } from '../server-role.js'
import {
  cloneDirFor,
  maskSourceUrl,
  readState,
  recordSourceSort,
  scanStorePlugins,
  slugForSource,
  STORE_INSTALL_MODES_VERSION,
  type DiscoveredStorePlugin,
  type PluginSourceConfig,
  type PluginSourceView,
  type StoreInstallMode,
} from '../plugin-sources.js'
import type { PluginCatalogEntry } from './plugin-catalog.js'
import { parsePluginCategory } from './plugin-category.js'
import { createSubsystemLogger } from '../../logging/index.js'

const log = createSubsystemLogger('plugin-sources')

type PluginConfigs = Readonly<Record<string, { enabled?: unknown } | undefined>>

/** One enabled, installed source as the planner sees it. */
export interface StoreSourceScan {
  slug: string
  /** A Walnut that knows install modes sorted this source before. */
  settled: boolean
  /** Ids this machine installed from it (sources.json `kept`). */
  kept?: readonly string[]
  plugins: ReadonlyArray<Pick<DiscoveredStorePlugin, 'dir' | 'id' | 'install'>>
}

export interface StorePluginPlan {
  /** Plugin directories discovery loads. */
  dirs: string[]
  /** Ids that load with no `enabled` key: written `enabled: true`. */
  pin: string[]
  /** Loaded plugins their source does not keep yet. */
  keep: Array<{ slug: string; id: string }>
  /** Sources to mark sorted once their pins are written. */
  settle: string[]
  /** Optional plugins nobody installed: the Apps page offers them. */
  available: Array<{ slug: string; dir: string; id: string }>
}

/** Installed (on or off) is the key being there; its value is the switch. */
export function hasInstallChoice(pluginConfigs: PluginConfigs, id: string): boolean {
  return pluginConfigs[id]?.enabled !== undefined
}

/** Pure: which store plugins load, which get pinned and kept, which wait for an Install. */
export function planStorePlugins(sources: readonly StoreSourceScan[], pluginConfigs: PluginConfigs): StorePluginPlan {
  const plan: StorePluginPlan = { dirs: [], pin: [], keep: [], settle: [], available: [] }
  const pinned = new Set<string>()
  for (const source of sources) {
    for (const plugin of source.plugins) {
      // A manifest with no id loads as before, so the loader can say what is wrong with it.
      if (!plugin.id) { plan.dirs.push(plugin.dir); continue }
      const chosen = hasInstallChoice(pluginConfigs, plugin.id)
      const kept = source.kept?.includes(plugin.id) ?? false
      if (!chosen && !kept && source.settled && plugin.install === 'optional') {
        plan.available.push({ slug: source.slug, dir: plugin.dir, id: plugin.id })
        continue
      }
      plan.dirs.push(plugin.dir)
      if (!chosen && !pinned.has(plugin.id)) { pinned.add(plugin.id); plan.pin.push(plugin.id) }
      if (!kept) plan.keep.push({ slug: source.slug, id: plugin.id })
    }
    if (!source.settled) plan.settle.push(source.slug)
  }
  return plan
}

/** Every enabled source whose files are on disk, with its plugins, in config order. */
async function scanSources(): Promise<StoreSourceScan[]> {
  const [config, states] = await Promise.all([getConfig(), readState()])
  const out: StoreSourceScan[] = []
  for (const source of (config.plugin_sources ?? []) as PluginSourceConfig[]) {
    if (source.enabled === false) continue
    const slug = slugForSource(source)
    const plugins = await scanStorePlugins(cloneDirFor(slug))
    if (plugins.length === 0) continue
    out.push({
      slug,
      settled: (states[slug]?.installModes ?? 0) >= STORE_INSTALL_MODES_VERSION,
      ...(states[slug]?.kept ? { kept: states[slug].kept } : {}),
      plugins,
    })
  }
  return out
}

/**
 * The store plugin directories discovery loads (integration-loader discoverPluginDirs), after
 * writing the pins, kept ids and marks the plan asks for. A pin that fails leaves its source
 * unmarked, so the next discovery sorts it again: nothing is ever dropped for a failed write.
 */
export async function resolveStorePluginDirs(pluginConfigs: PluginConfigs): Promise<string[]> {
  const plan = planStorePlugins(await scanSources(), pluginConfigs)
  if (isHostReplicaProgram()) return plan.dirs
  let pinsWritten = true
  for (const id of plan.pin) {
    try {
      await editPluginConfig(id, (current) => (current.enabled === undefined ? { ...current, enabled: true } : null))
    } catch (error) {
      pinsWritten = false
      log.warn('could not record a store plugin as installed', { id, error: String(error) })
    }
  }
  const settle = pinsWritten ? plan.settle : []
  await recordSourceSort({ settle, keep: plan.keep }).catch((error) => {
    log.warn('could not record the plugin sources sort', { slugs: settle, error: String(error) })
  })
  if (settle.length > 0) log.info('plugin sources sorted by install mode', { slugs: settle, pinned: plan.pin.length })
  return plan.dirs
}

/** The enabled source on disk that carries this plugin id, and the plugin's mode, or null. */
export async function findStorePlugin(id: string): Promise<{ slug: string; install: StoreInstallMode } | null> {
  for (const source of await scanSources()) {
    const plugin = source.plugins.find((entry) => entry.id === id)
    if (plugin) return { slug: source.slug, install: plugin.install }
  }
  return null
}

/**
 * Catalog rows for the optional plugins of each listed source that nobody installed, so the
 * Apps page shows them under their source with an Install button. Pure over what it is given.
 */
export function availableStoreEntries(
  sources: readonly PluginSourceView[],
  pluginConfigs: PluginConfigs,
  loadedIds: ReadonlySet<string>,
): PluginCatalogEntry[] {
  const out: PluginCatalogEntry[] = []
  const seen = new Set<string>()
  for (const source of sources) {
    if (!source.enabled || !source.cloned) continue
    for (const plugin of source.plugins) {
      if (!plugin.id || plugin.install !== 'optional' || seen.has(plugin.id)) continue
      if (loadedIds.has(plugin.id) || hasInstallChoice(pluginConfigs, plugin.id)) continue
      seen.add(plugin.id)
      const category = parsePluginCategory(plugin.category)
      out.push({
        id: plugin.id,
        name: plugin.name ?? plugin.id,
        ...(plugin.description ? { description: plugin.description } : {}),
        ...(plugin.version ? { version: plugin.version } : {}),
        ...(category ? { category } : {}),
        source: source.kind === 'npm'
          ? { kind: 'npm', ...(source.spec ? { spec: source.spec } : {}) }
          : { kind: 'git', ...(source.url ? { url: maskSourceUrl(source.url) } : {}), ...(source.ref ? { ref: source.ref } : {}) },
        sourceSlug: source.slug,
        install: 'optional',
      })
    }
  }
  return out
}
