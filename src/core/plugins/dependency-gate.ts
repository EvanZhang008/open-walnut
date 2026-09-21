/**
 * The dependency gate: whether a plugin may run given the OTHER plugins on this machine,
 * and what happens to its dependents when it stops.
 *
 * Split out of the loader because none of it needs the loader: given a registry, a plugin
 * manager and the manifests read at load time, every answer here is computable. The two
 * things it genuinely cannot do itself are injected — loading a single plugin (the
 * loader's job) and clearing the loader's own caches.
 *
 * Rules this file encodes, each of which cost a real design argument:
 *
 * - Resolution reads LIVE manager state, never a snapshot. A single-plugin reload happens
 *   long after the boot walk, so "is my dependency running right now" is the only honest
 *   question.
 * - A dependent is BLOCKED, never disabled. Blocking records no human decision, so the
 *   caller must not write `enabled: false` for it: a plugin parked because its dependency
 *   went away has to come back when the dependency does, and an off-switch on disk would
 *   leave it lying down forever.
 * - A blocked plugin's stated reason is refreshed on every restore pass, including the
 *   passes that fail. A row that still says "not installed" after the user installed the
 *   thing (at the wrong version) is worse than no row at all.
 * - A restore pass visits transitive dependents in LOAD order, never outward from the
 *   changed plugin: see `retryUnmetDependents`.
 */

import type { IntegrationRegistry } from '../integration-registry.js'
import type { PluginManifest } from '../integration-types.js'
import { bus } from '../event-bus.js'
import {
  buildDepGraph,
  dependentsTeardownOrder,
  topoSortStable,
  type DepGraph,
} from './dep-graph.js'
import { isFullVersion, satisfiesDependencyRange } from './semver.js'
import type { MissingDependency, PluginManager } from './plugin-manager.js'

/** Where a plugin was discovered. Mirrors the loader's per-registry source record. */
export interface PluginSourceRef {
  dir: string
  isBuiltin: boolean
}

/** Everything the gate needs to answer a question about one registry. */
export interface DependencyGate {
  registry: IntegrationRegistry
  manager: PluginManager
  /** pluginId → manifest, in load order. Insertion order IS the loader's walk order,
   *  so index ties in the sort below break exactly the way loading did. */
  manifests: Map<string, PluginManifest>
}

/** What `retryUnmetDependents` needs in order to actually bring a plugin back. */
export interface DependencyRestore {
  sources: Map<string, PluginSourceRef>
  /** The loader's single-node load, injected so the gate never imports the loader. */
  loadOne(source: PluginSourceRef, manifest: PluginManifest): Promise<void>
}

/** A plugin held back because a declared dependency is missing, wrong-version,
 *  not running, or part of a cycle. Its code was never imported. */
export interface UnmetDependencyPlugin {
  id: string
  name: string
  missing: MissingDependency[]
}

const unmetDependencyPlugins: UnmetDependencyPlugin[] = []

/** Plugins whose declared dependencies are not satisfied right now. */
export function getUnmetDependencyPlugins(): UnmetDependencyPlugin[] {
  return unmetDependencyPlugins
}

export function forgetUnmetDependencies(pluginId: string): void {
  for (let index = unmetDependencyPlugins.length - 1; index >= 0; index--) {
    if (unmetDependencyPlugins[index].id === pluginId) unmetDependencyPlugins.splice(index, 1)
  }
}

export function resetUnmetDependencies(): void {
  unmetDependencyPlugins.length = 0
}

/** Replace this plugin's entry, so a plugin can never hold two. */
export function recordUnmetDependencies(
  pluginId: string,
  name: string,
  missing: MissingDependency[],
): void {
  forgetUnmetDependencies(pluginId)
  unmetDependencyPlugins.push({ id: pluginId, name, missing })
}

/** Refusal from a disable that would pull the floor out from under a running plugin. */
export class PluginDependentsError extends Error {
  readonly code = 'has-dependents'
  constructor(readonly pluginId: string, readonly dependents: string[]) {
    super(
      `Plugin "${pluginId}" cannot be turned off while `
      + `${dependents.map((id) => `"${id}"`).join(', ')} depend${dependents.length === 1 ? 's' : ''} on it`,
    )
    this.name = 'PluginDependentsError'
  }
}

/** Running code, from a dependent's point of view. */
function isLiveState(state: string | undefined): boolean {
  return state === 'active' || state === 'activating'
}

function buildRegistryDepGraph(manifests: Map<string, PluginManifest>): DepGraph {
  return buildDepGraph([...manifests.values()].map((manifest, index) => ({
    id: manifest.id,
    index,
    deps: Object.keys(manifest.dependencies ?? {}),
  })))
}

/**
 * Resolve one plugin's declared dependencies against live manager state.
 *
 * `cycleMembers` comes from the topological sort. A member of a cycle can never be
 * ordered, so its own edges are reported as `cycle` instead of being probed — probing
 * would report the arbitrary "not active yet" of whichever member happened to be tried
 * first, and hide the real problem.
 */
export function resolveMissingDependencies(
  manifest: PluginManifest,
  gate: DependencyGate,
  cycleMembers?: ReadonlySet<string>,
): MissingDependency[] {
  const declared = Object.entries(manifest.dependencies ?? {})
  if (declared.length === 0) return []
  const missing: MissingDependency[] = []
  for (const [depId, range] of declared) {
    if (cycleMembers?.has(manifest.id) && cycleMembers.has(depId)) {
      missing.push({
        id: depId,
        range,
        reason: 'cycle',
        note: `"${depId}" is in a dependency cycle, so "${manifest.id}" can never activate`,
      })
      continue
    }
    const dependency = gate.manifests.get(depId)
    if (!dependency) {
      missing.push({ id: depId, range, reason: 'absent', note: `"${depId}" is not installed` })
      continue
    }
    // A version no range can be matched against is the same problem as no version at all,
    // and it is the DEPENDENCY's manifest that has to change either way. Reporting it as a
    // range mismatch would send the wrong author looking at the wrong file.
    if (!dependency.version || !isFullVersion(dependency.version)) {
      missing.push({
        id: depId,
        range,
        ...(dependency.version ? { found: dependency.version } : {}),
        reason: 'unversioned',
        note: dependency.version
          ? `"${depId}" declares version "${dependency.version}", which is not a full x.y.z version; a plugin others depend on must declare one`
          : `"${depId}" has no "version" in its manifest; a plugin others depend on must declare a full x.y.z version`,
      })
      continue
    }
    if (!satisfiesDependencyRange(dependency.version, range)) {
      missing.push({
        id: depId,
        range,
        found: dependency.version,
        reason: 'version',
        note: `"${depId}" is at ${dependency.version}, which does not satisfy ${range}`,
      })
      continue
    }
    const state = gate.manager.get(depId)?.state
    if (!isLiveState(state)) {
      missing.push({
        id: depId,
        range,
        found: dependency.version,
        reason: 'inactive',
        note: `"${depId}" is installed but ${state ?? 'not discovered'}`,
      })
    }
  }
  return missing
}

/**
 * Everything that would break if `pluginId` stopped: `all` is the full transitive set in
 * teardown order (deepest first), `live` is the running part of it.
 *
 * Both, because the two answer different questions: `live` is what to refuse or tear down,
 * while `all` is what a dependent's reason may name.
 */
export function dependentsToTearDown(
  gate: DependencyGate,
  pluginId: string,
): { all: string[]; live: string[] } {
  const all = dependentsTeardownOrder(buildRegistryDepGraph(gate.manifests), pluginId)
  return { all, live: all.filter((id) => isLiveState(gate.manager.get(id)?.state)) }
}

function emitDependencyChanged(
  pluginId: string,
  dependencyId: string,
  action: 'blocked' | 'restored',
): void {
  bus.emit(
    'plugin:dependency-changed',
    { pluginId, dependencyId, action },
    ['web-ui'],
    { source: 'plugin-loader' },
  )
}

/**
 * Park the live dependents of `changedId` in `needs-dependency`, deepest first.
 *
 * `action` is what is ABOUT to happen to `changedId`, and it is a parameter because the
 * state cannot be read: at this point the target is still running (it is torn down after
 * its dependents, so their handles are released first). Wording it as a fact from the
 * disable path made a reload say "was turned off", which was a lie in the one case that
 * mattered, a reload whose new code fails to activate.
 *
 * Returns the ids it blocked, so the caller can clear its derived caches once.
 */
export async function blockDependents(
  gate: DependencyGate,
  changedId: string,
  goingDown: readonly string[],
  live: readonly string[],
  action: 'disabled' | 'reloading',
): Promise<string[]> {
  const blocked: string[] = []
  if (live.length === 0) return blocked
  const doomed = new Set([changedId, ...goingDown])
  const becoming = action === 'disabled' ? 'was turned off' : 'is reloading'
  for (const dependentId of live) {
    // `local` is the fallback task source: it can never declare a dependency (manifest
    // validation drops the field), and unregistering it throws by design.
    if (dependentId === 'local') continue
    const missing: MissingDependency[] = Object.entries(gate.manifests.get(dependentId)?.dependencies ?? {})
      .filter(([depId]) => doomed.has(depId))
      .map(([depId, range]) => ({
        id: depId,
        range,
        ...(gate.manifests.get(depId)?.version ? { found: gate.manifests.get(depId)!.version } : {}),
        reason: 'inactive' as const,
        note: depId === changedId
          ? `"${depId}" ${becoming}`
          : `"${depId}" is blocked because it depends on "${changedId}"`,
      }))
    const record = await gate.manager.block(dependentId, missing)
    gate.registry.unregister(dependentId, 'disabled')
    recordUnmetDependencies(dependentId, record.name, missing)
    emitDependencyChanged(dependentId, changedId, 'blocked')
    blocked.push(dependentId)
  }
  return blocked
}

/**
 * One bounded pass over what was waiting on `changedId`.
 *
 * Two jobs, and the second is the one that is easy to forget: a dependent whose
 * dependencies are now satisfied is brought back, and a dependent that is STILL blocked
 * has its reason rewritten from the current facts. Without that rewrite, installing the
 * dependency at the wrong version leaves the row saying "not installed", and a reload
 * whose activate throws leaves it saying the dependency is reloading, forever.
 *
 * Only ever upgrades `needs-dependency` → active: a plugin that is off, broken or
 * unconfigured is left exactly where it is, so this can never grow into a cascade that
 * restarts half the process. The walk is ORDERED, not outward: taken breadth-first from
 * `changedId`, a shortcut edge (a dependent of both `alpha` and the `gamma` between them)
 * makes a deep dependent a first-level one, so its single attempt is spent while `gamma` is
 * still down and it is never reconsidered — and descendants of a dependent that did not come
 * back keep naming `alpha` when the thing in their way is now `gamma`'s own state.
 */
export async function retryUnmetDependents(
  gate: DependencyGate,
  changedId: string,
  restore: DependencyRestore,
): Promise<number> {
  const graph = buildRegistryDepGraph(gate.manifests)
  // Teardown order reversed: the same transitive set, ancestors before descendants.
  const ids = dependentsTeardownOrder(graph, changedId).reverse()
  if (ids.length === 0) return 0
  // A cycle member has to be told it is in a cycle, exactly as at boot.
  const cycleMembers = new Set(topoSortStable(graph).residue)
  let restored = 0

  for (const dependentId of ids) {
    if (gate.manager.get(dependentId)?.state !== 'needs-dependency') continue
    const manifest = gate.manifests.get(dependentId)
    if (!manifest) continue
    const stillMissing = resolveMissingDependencies(manifest, gate, cycleMembers)
    if (stillMissing.length > 0) {
      // Re-block rather than skip: the plugin stays exactly where it is, but its reason
      // now describes what is true. `block` skips teardown for a plugin that is not
      // running, so this costs one state notification.
      const record = await gate.manager.block(dependentId, stillMissing)
      recordUnmetDependencies(dependentId, record.name, stillMissing)
      continue
    }
    // Satisfied but unloadable from here: leave it parked rather than forget it.
    const source = restore.sources.get(dependentId)
    if (!source) continue
    if (gate.manager.isStopping(dependentId)) continue
    await gate.manager.forget(dependentId)
    await restore.loadOne(source, manifest)
    if (gate.manager.get(dependentId)?.state !== 'active') continue
    restored++
    // Keyed by the plugin whose change started this, matching `blockDependents`.
    emitDependencyChanged(dependentId, changedId, 'restored')
  }
  return restored
}
