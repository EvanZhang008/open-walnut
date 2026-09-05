/**
 * The plugin catalog and the merge that turns it into ONE store list.
 *
 * Two halves, deliberately separate:
 *
 *   - `loadPluginCatalog()` reads the shipped `data/plugin-registry.json` plus an
 *     optional user overlay at `~/.open-walnut/plugin-registry.json`. It NEVER makes
 *     a network call: a store that phones home would be a surprise on a personal
 *     machine, and the useful part (what exists, what it adds) is static text.
 *   - `mergePluginRegistry()` is pure. Every judgement about what a row SAYS — is it
 *     installed, on, off, waiting for config, broken and why — happens here, so the
 *     state mapping is unit-testable without a server, a disk or a plugin.
 *
 * A catalog entry is a description, not an installer. `builtin` entries are already
 * on this machine and only need turning on; `git`/`npm` entries prefill the existing
 * install form (which still demands the per-install trust tick); `example` entries
 * live in this checkout and are installed with `walnut-plugin link`, so they get the
 * command and a docs link instead of a button that would not work.
 *
 * Anything DISCOVERED but absent from the catalog still appears — the catalog is a
 * curated addition to the truth on disk, never a filter on it.
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { MissingDependency } from './plugin-manager.js'
import { satisfiesDependencyRange } from './semver.js'

/** Where a catalog entry comes from. */
export type PluginCatalogSourceKind = 'builtin' | 'git' | 'npm' | 'example'

export interface PluginCatalogSource {
  kind: PluginCatalogSourceKind
  /** git: the clone URL. */
  url?: string
  /** git: a branch/tag/sha. */
  ref?: string
  /** npm: `name`, `name@1.2.3` or `@scope/name`. */
  spec?: string
  /** example: repo-relative directory to `walnut-plugin link`. */
  path?: string
}

export interface PluginCatalogEntry {
  id: string
  name: string
  description?: string
  /** Plain words for what installing this adds ("App", "Agent tools", "Task sync"). */
  adds?: string[]
  source: PluginCatalogSource
  homepage?: string
  /** Repo-relative docs path. */
  docs?: string
  /**
   * Other plugins this one needs, mirroring the manifest `dependencies`
   * (`{ "<pluginId>": "<semver range>" }`).
   *
   * DESCRIPTIVE ONLY. The catalog never installs anything by itself, so this exists to
   * say "also needs alpha" before the user commits, not to pull alpha in. What actually
   * installs is the two-phase consent in the store.
   */
  requires?: Record<string, string>
}

/**
 * How a missing dependency could be brought in, from the store's point of view.
 *
 * `installed` means "it is here, turn it on"; `catalog` means "it can be added from the
 * catalog" (an `example` source still needs a hand-run link command, which is why
 * blockedBy counts those); `none` means the store has nothing to offer and the row may
 * only explain itself.
 *
 * There is deliberately NO `builtin`: a builtin catalog entry that is absent from the
 * lifecycle records is not on this machine, and turning it on throws "not discovered".
 * A resolvable this code cannot make good on is worse than saying nothing.
 */
export type PluginDependencyResolvable = 'installed' | 'catalog' | 'none'

export interface PluginDependencyPlanItem {
  id: string
  range: string
  resolvable: PluginDependencyResolvable
  /** Where it would come from, when the catalog knows. */
  source?: PluginCatalogSource
  /** The version that IS here and does not fit the range. Present only then, so the
   *  store can say "(have 1.0.0)" without implying it for a plugin that is merely off. */
  found?: string
}

/** One unmet requirement to plan for. `reason` is present when the loader already
 *  resolved it for an installed plugin; a catalog `requires` entry has none. */
export interface PluginDependencyNeed {
  id: string
  range: string
  reason?: MissingDependency['reason']
  found?: string
}

/** What the row says, in one word, to whoever is looking at the store. */
export type PluginStoreStatus =
  | 'active'
  | 'disabled'
  | 'needs-config'
  | 'needs-dependency'
  | 'unsupported'
  | 'failed'
  | 'quarantined'
  | 'pending-restart'
  /** In the catalog, not on this machine. */
  | 'available'

/** One discovered plugin, as the server knows it. Input to the pure merge. */
export interface InstalledPluginFacts {
  id: string
  name: string
  /** Lifecycle state from PluginManager. */
  state: string
  builtin: boolean
  version?: string
  description?: string
  capabilities?: string[]
  missingConfig?: string[]
  /** Present when the plugin is held back by another plugin, not by its own config. */
  missingDependencies?: MissingDependency[]
  reason?: string
  error?: string
  /** True when the manifest declares a configSchema the Configure form can render. */
  configurable?: boolean
  /** The plugin-source slug that installed it (external sources only). */
  sourceSlug?: string
  /** git / npm, for an externally-sourced plugin. */
  sourceKind?: 'git' | 'npm'
}

export interface PluginRegistryRow {
  id: string
  name: string
  description?: string
  adds?: string[]
  homepage?: string
  docs?: string
  source: PluginCatalogSource
  installed: boolean
  status: PluginStoreStatus
  /** Raw lifecycle state, present only when installed. */
  state?: string
  version?: string
  builtin: boolean
  capabilities?: string[]
  missingConfig?: string[]
  /** Which dependencies hold this row back, so the store can name them. */
  missingDependencies?: MissingDependency[]
  /** What could be done about each unmet dependency. Absent when there is nothing unmet. */
  dependencyPlan?: PluginDependencyPlanItem[]
  /** The unmet ids the store cannot act on, so a row can say why it is stuck. */
  blockedBy?: string[]
  /** Why it is not active, in the server's own words. */
  reason?: string
  error?: string
  configurable: boolean
  /** True when this id is in the curated catalog (vs discovered only). */
  catalog: boolean
  /** External source slug — what Update/Remove act on. */
  sourceSlug?: string
  /** Can the ON/OFF toggle act on this row at all. */
  toggleable: boolean
}

export interface PluginRegistryResult {
  rows: PluginRegistryRow[]
  installedCount: number
  availableCount: number
}

/** `local` is the fallback task source, not a plugin anyone installs or turns off. */
const HIDDEN_IDS = new Set(['local'])

/**
 * Lifecycle state → the one word the store shows.
 *
 * `discovered` is the interesting case: the plugin was found and is NOT disabled in
 * config, but nothing activated it in this process. Calling that "active" would be a
 * confident wrong answer, so it reads as pending-restart, which is what it is.
 */
export function storeStatusFor(state: string): PluginStoreStatus {
  switch (state) {
    case 'active':
    case 'activating':
      return 'active'
    case 'disabled':
      return 'disabled'
    case 'needs-config':
      return 'needs-config'
    case 'needs-dependency':
      return 'needs-dependency'
    case 'unsupported':
      return 'unsupported'
    case 'quarantined':
      return 'quarantined'
    case 'failed':
      return 'failed'
    case 'disposing':
      return 'active'
    default:
      return 'pending-restart'
  }
}

/**
 * Only a plugin whose OFF/ON actually persists gets a toggle.
 *
 * needs-config, needs-dependency, unsupported and quarantined are refused by
 * PluginManager itself (`activateManaged` throws for all four), so offering a switch
 * there would produce a control that flips back — worse than no control. Those rows
 * point at Configure, at the dependency that is missing, at the version requirement,
 * or at Clear quarantine instead.
 */
export function isToggleable(status: PluginStoreStatus): boolean {
  return status === 'active' || status === 'disabled' || status === 'failed' || status === 'pending-restart'
}

/**
 * Running code AT A VERSION THE RANGE ACCEPTS, so the requirement is already met and
 * never enters a plan.
 *
 * The version half matters: an active dependency at 1.0.0 does not satisfy `^2`, and
 * calling that satisfied would let the store install a dependent that lands straight in
 * needs-dependency the moment it loaded. A dependency with no version satisfies nothing
 * (the same rule the loader applies), so it is reported rather than assumed.
 */
function isSatisfiedBy(facts: InstalledPluginFacts | undefined, range: string): boolean {
  if (!facts || storeStatusFor(facts.state) !== 'active') return false
  return !!facts.version && satisfiesDependencyRange(facts.version, range)
}

/**
 * What the store could do about ONE unmet dependency.
 *
 * A wrong version, an unusable version string or a cycle all come back `none` on
 * purpose: installing from the catalog or flipping a switch fixes none of them (the
 * catalog carries no version, so claiming otherwise would be a confident wrong answer),
 * and the honest answer is copy that names the problem.
 */
function resolveDependencyNeed(
  need: PluginDependencyNeed,
  catalogById: ReadonlyMap<string, PluginCatalogEntry>,
  installedById: ReadonlyMap<string, InstalledPluginFacts>,
): PluginDependencyPlanItem {
  const base = { id: need.id, range: need.range }
  if (need.reason === 'version' || need.reason === 'unversioned') {
    return { ...base, ...(need.found ? { found: need.found } : {}), resolvable: 'none' }
  }
  if (need.reason === 'cycle') return { ...base, resolvable: 'none' }
  const facts = installedById.get(need.id)
  // Installed: a switch only helps where the plugin manager would accept the
  // activation. needs-config, unsupported and quarantined are refused by it, so a
  // "Turn on" there would write `enabled: true`, land the plugin back where it was,
  // and let the caller report a turn-on that never happened.
  if (facts) {
    return { ...base, resolvable: isToggleable(storeStatusFor(facts.state)) ? 'installed' : 'none' }
  }
  const entry = catalogById.get(need.id)
  // A builtin entry that is not in the lifecycle records is not on this machine at all:
  // there is nothing to switch on, and nothing to install either.
  if (!entry || entry.source.kind === 'builtin') return { ...base, resolvable: 'none' }
  return { ...base, resolvable: 'catalog', source: entry.source }
}

/**
 * Pure: unmet requirements → what the store can offer for each, in the order given.
 * One item per id, so a diamond asks once.
 */
export function planPluginDependencies(
  needs: readonly PluginDependencyNeed[],
  catalog: readonly PluginCatalogEntry[],
  installed: readonly InstalledPluginFacts[],
): PluginDependencyPlanItem[] {
  const catalogById = new Map(catalog.filter((entry) => entry?.id).map((entry) => [entry.id, entry]))
  const installedById = new Map<string, InstalledPluginFacts>()
  for (const facts of installed) {
    if (facts?.id && !installedById.has(facts.id)) installedById.set(facts.id, facts)
  }
  return planFrom(needs, catalogById, installedById)
}

function planFrom(
  needs: readonly PluginDependencyNeed[],
  catalogById: ReadonlyMap<string, PluginCatalogEntry>,
  installedById: ReadonlyMap<string, InstalledPluginFacts>,
): PluginDependencyPlanItem[] {
  const plan: PluginDependencyPlanItem[] = []
  const seen = new Set<string>()
  for (const need of needs) {
    if (!need?.id || seen.has(need.id)) continue
    seen.add(need.id)
    plan.push(resolveDependencyNeed(need, catalogById, installedById))
  }
  return plan
}

/**
 * The unmet ids the store has no button for: nothing to install or switch on, or an
 * `example` source that only a hand-run `walnut-plugin link` can bring in.
 */
export function blockedDependencyIds(plan: readonly PluginDependencyPlanItem[]): string[] {
  return plan
    .filter((item) => item.resolvable === 'none'
      || (item.resolvable === 'catalog' && item.source?.kind === 'example'))
    .map((item) => item.id)
}

/**
 * The single place that decides what the store lists.
 *
 * Pure: same inputs, same rows, in a stable order — installed first (so the thing
 * you already run is at the top), then catalog entries you could add, each group
 * alphabetical by display name.
 */
export function mergePluginRegistry(
  catalog: readonly PluginCatalogEntry[],
  installed: readonly InstalledPluginFacts[],
): PluginRegistryResult {
  const catalogById = new Map<string, PluginCatalogEntry>()
  for (const entry of catalog) {
    if (!entry?.id || HIDDEN_IDS.has(entry.id)) continue
    catalogById.set(entry.id, entry)
  }

  const rows: PluginRegistryRow[] = []
  const seen = new Set<string>()
  // First record for an id wins, exactly as the row loop below does, so the plan and
  // the row it belongs to can never disagree about which copy is the real one.
  const installedById = new Map<string, InstalledPluginFacts>()
  for (const plugin of installed) {
    if (plugin?.id && !installedById.has(plugin.id)) installedById.set(plugin.id, plugin)
  }

  for (const plugin of installed) {
    if (!plugin?.id || HIDDEN_IDS.has(plugin.id) || seen.has(plugin.id)) continue
    seen.add(plugin.id)
    const entry = catalogById.get(plugin.id)
    const status = storeStatusFor(plugin.state)
    // The truth on disk beats the catalog for anything the plugin reports about
    // itself; the catalog only fills in what a manifest does not carry (what it
    // adds, where to read about it).
    const source: PluginCatalogSource = plugin.sourceKind
      ? { kind: plugin.sourceKind }
      : entry?.source ?? { kind: plugin.builtin ? 'builtin' : 'git' }
    // A blocked row already names what it is missing; the plan says what can be DONE
    // about it, which is the difference between a dead end and a button.
    const plan = status === 'needs-dependency'
      ? planFrom(
        (plugin.missingDependencies ?? []).map((missing) => ({
          id: missing.id,
          range: missing.range,
          reason: missing.reason,
          ...(missing.found ? { found: missing.found } : {}),
        })),
        catalogById,
        installedById,
      )
      : []
    const blockedBy = blockedDependencyIds(plan)
    rows.push({
      id: plugin.id,
      name: plugin.name || entry?.name || plugin.id,
      ...(plugin.description ?? entry?.description ? { description: plugin.description ?? entry?.description } : {}),
      ...(entry?.adds ? { adds: entry.adds } : {}),
      ...(entry?.homepage ? { homepage: entry.homepage } : {}),
      ...(entry?.docs ? { docs: entry.docs } : {}),
      source,
      installed: true,
      status,
      state: plugin.state,
      ...(plugin.version ? { version: plugin.version } : {}),
      builtin: plugin.builtin,
      ...(plugin.capabilities?.length ? { capabilities: plugin.capabilities } : {}),
      ...(plugin.missingConfig?.length ? { missingConfig: plugin.missingConfig } : {}),
      ...(plugin.missingDependencies?.length ? { missingDependencies: plugin.missingDependencies } : {}),
      ...(plan.length ? { dependencyPlan: plan } : {}),
      ...(blockedBy.length ? { blockedBy } : {}),
      ...(plugin.reason ? { reason: plugin.reason } : {}),
      ...(plugin.error ? { error: plugin.error } : {}),
      configurable: plugin.configurable ?? false,
      catalog: !!entry,
      ...(plugin.sourceSlug ? { sourceSlug: plugin.sourceSlug } : {}),
      toggleable: isToggleable(status),
    })
  }

  for (const entry of catalogById.values()) {
    if (seen.has(entry.id)) continue
    // Only what is NOT already met: a requirement that is on, at a version the range
    // accepts, is not something to tell the user about before they install.
    const plan = planFrom(
      Object.entries(entry.requires ?? {}).flatMap(([id, range]) => {
        const facts = installedById.get(id)
        if (isSatisfiedBy(facts, range)) return []
        // An installed copy that CANNOT match the range is a version problem, not a
        // missing plugin: no button fixes it, and the row has to say which version is
        // in the way instead of quietly installing a dependent that would block.
        const version = facts?.version
        const conflict = !!version && !satisfiesDependencyRange(version, range)
        const reason = conflict ? 'version' as const : facts && !version ? 'unversioned' as const : undefined
        return [{
          id,
          range,
          ...(reason ? { reason } : {}),
          ...(conflict && version ? { found: version } : {}),
        }]
      }),
      catalogById,
      installedById,
    )
    const blockedBy = blockedDependencyIds(plan)
    rows.push({
      id: entry.id,
      name: entry.name || entry.id,
      ...(entry.description ? { description: entry.description } : {}),
      ...(entry.adds ? { adds: entry.adds } : {}),
      ...(entry.homepage ? { homepage: entry.homepage } : {}),
      ...(entry.docs ? { docs: entry.docs } : {}),
      source: entry.source,
      installed: false,
      status: 'available',
      builtin: entry.source.kind === 'builtin',
      ...(plan.length ? { dependencyPlan: plan } : {}),
      ...(blockedBy.length ? { blockedBy } : {}),
      configurable: false,
      catalog: true,
      toggleable: false,
    })
  }

  const byName = (a: PluginRegistryRow, b: PluginRegistryRow) =>
    a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
  const installedRows = rows.filter((row) => row.installed).sort(byName)
  const availableRows = rows.filter((row) => !row.installed).sort(byName)

  return {
    rows: [...installedRows, ...availableRows],
    installedCount: installedRows.length,
    availableCount: availableRows.length,
  }
}

/** `requires`, or nothing at all — an empty map would make every row carry a field the
 *  store then has to ignore. Non-string ranges are dropped, same as `adds`. */
function requiresFrom(raw: unknown): { requires?: Record<string, string> } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const requires: Record<string, string> = {}
  for (const [id, range] of Object.entries(raw as Record<string, unknown>)) {
    if (id.trim() && typeof range === 'string') requires[id] = range
  }
  return Object.keys(requires).length > 0 ? { requires } : {}
}

/** Parse a catalog document defensively: a bad entry is skipped, never fatal. */
export function parsePluginCatalog(raw: unknown): PluginCatalogEntry[] {
  const doc = raw as { plugins?: unknown } | null
  const list = Array.isArray(doc?.plugins) ? doc!.plugins : []
  const out: PluginCatalogEntry[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const entry = item as Record<string, unknown>
    const id = typeof entry.id === 'string' ? entry.id.trim() : ''
    if (!id) continue
    const rawSource = (entry.source && typeof entry.source === 'object' ? entry.source : {}) as Record<string, unknown>
    const kind = rawSource.kind
    const source: PluginCatalogSource = {
      kind: kind === 'builtin' || kind === 'git' || kind === 'npm' || kind === 'example' ? kind : 'git',
      ...(typeof rawSource.url === 'string' ? { url: rawSource.url } : {}),
      ...(typeof rawSource.ref === 'string' ? { ref: rawSource.ref } : {}),
      ...(typeof rawSource.spec === 'string' ? { spec: rawSource.spec } : {}),
      ...(typeof rawSource.path === 'string' ? { path: rawSource.path } : {}),
    }
    out.push({
      id,
      name: typeof entry.name === 'string' && entry.name ? entry.name : id,
      ...(typeof entry.description === 'string' ? { description: entry.description } : {}),
      ...(Array.isArray(entry.adds)
        ? { adds: entry.adds.filter((value): value is string => typeof value === 'string') }
        : {}),
      source,
      ...(typeof entry.homepage === 'string' ? { homepage: entry.homepage } : {}),
      ...(typeof entry.docs === 'string' ? { docs: entry.docs } : {}),
      ...(requiresFrom(entry.requires)),
    })
  }
  return out
}

/** User entries win over shipped ones with the same id, and add new ids. */
export function overlayPluginCatalog(
  shipped: readonly PluginCatalogEntry[],
  user: readonly PluginCatalogEntry[],
): PluginCatalogEntry[] {
  const byId = new Map<string, PluginCatalogEntry>()
  for (const entry of shipped) byId.set(entry.id, entry)
  for (const entry of user) byId.set(entry.id, entry)
  return [...byId.values()]
}

/**
 * Resolve the shipped catalog file. Same walk-up as BUILTIN_SKILLS_DIR: `data/` sits
 * next to the bundle in dist/ and next to the sources under src/.
 */
function shippedCatalogFile(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 5; i += 1) {
    const candidate = path.join(dir, 'data', 'plugin-registry.json')
    try {
      if (fs.statSync(candidate).isFile()) return candidate
    } catch { /* keep walking up */ }
    dir = path.dirname(dir)
  }
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'plugin-registry.json')
}

async function readCatalogFile(file: string): Promise<PluginCatalogEntry[]> {
  try {
    return parsePluginCatalog(JSON.parse(await fsp.readFile(file, 'utf-8')))
  } catch {
    // Absent (the normal case for the overlay) or malformed: an unreadable catalog
    // must never take the store down, it just contributes nothing.
    return []
  }
}

/**
 * Shipped catalog + the user's overlay. Read on every call: the file is a couple of
 * kilobytes, and a cache here would mean editing the overlay does nothing until a
 * restart — exactly the kind of stale-truth bug this repo keeps paying for.
 */
export async function loadPluginCatalog(walnutHome?: string): Promise<PluginCatalogEntry[]> {
  const shipped = await readCatalogFile(shippedCatalogFile())
  const user = walnutHome
    ? await readCatalogFile(path.join(walnutHome, 'plugin-registry.json'))
    : []
  return overlayPluginCatalog(shipped, user)
}
