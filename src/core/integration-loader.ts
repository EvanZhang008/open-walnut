/**
 * Integration Plugin Loader
 *
 * Discovers and loads plugins from:
 * 1. Built-in dir: src/integrations/ (dev) or dist/integrations/ (prod)
 * 2. External dir: ~/.open-walnut/plugins/
 *
 * For each plugin subdirectory:
 *   - Read manifest.json → validate required fields
 *   - Read config.yaml plugins.{id} → check enabled flag
 *   - Validate config against manifest's configSchema (basic type checking)
 *   - Dynamic import index.ts/index.js → create PluginApi → call default export
 *   - Validate registerSync was called → register into registry
 *
 * The 'local' plugin is always registered and cannot be disabled.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { preparePluginModule, type PluginModuleFunctions } from './plugins/plugin-module.js';
import { readPluginWebModule, retainPluginWebModule, type PluginWebModule } from './plugins/plugin-web-module.js';
import yaml from 'js-yaml';
import { WALNUT_HOME, CONFIG_FILE, IS_EPHEMERAL } from '../constants.js';
import { remoteSyncIsolationReason } from './remote-sync-isolation.js';
import { getVersion, isVersionKnown } from './version.js';
import { createSubsystemLogger } from '../logging/index.js';
import { getConfig, updatePluginConfig } from './config-manager.js';
import { bulkMigrateTasks } from './task-manager.js';
import { ensureExtIndexes } from './task-db.js';
import { setExtIndexes } from './ext-index-registry.js';
import type { IntegrationRegistry } from './integration-registry.js';
import { PluginBootSentinel, pluginSafeModeEnabled } from './plugins/boot-sentinel.js';
import { resolvePluginSourceTree } from './plugins/plugin-source-tree.js';
import { PluginContext } from './plugins/plugin-context.js';
import {
  PluginManager,
  describeMissingDependency,
  type PluginDefinition,
  type PluginLifecycleRecord,
} from './plugins/plugin-manager.js';
import { isValidRange, satisfiesSemVer } from './plugins/semver.js';
import { removePluginOps } from '../ops/registry.js';
import { buildDepGraph, topoSortStable } from './plugins/dep-graph.js';
import {
  PluginDependentsError,
  blockDependents,
  dependentsToTearDown,
  forgetUnmetDependencies,
  getUnmetDependencyPlugins,
  recordUnmetDependencies,
  resetUnmetDependencies,
  resolveMissingDependencies,
  retryUnmetDependents,
  type DependencyGate,
  type DependencyRestore,
} from './plugins/dependency-gate.js';
import { validatePluginId } from './plugins/ids.js';
import { listOwnedSkillDirRecords } from './plugins/skill-registry.js';
import { CORE_SERVICE_OWNER, removeServicesOf } from './plugins/service-registry.js';
// Only for the lifecycle announcement inside createPluginManager's onStateChange hook.
import { bus } from './event-bus.js';
import { createServerPluginApi } from './plugins/server-api.js';
import type {
  PluginManifest,
  PluginApi,
  IntegrationSync,
  ProjectClaimFn,
  DisplayMeta,
  MigrateFn,
  HttpRoute,
  RegisteredPlugin,
  ExtIndexSpec,
  UnconfiguredPlugin,
  TaskFieldSpec,
  PluginToolSpec,
  RegisteredUiApp,
  PluginConnection,
} from './integration-types.js';

const log = createSubsystemLogger('plugin-loader');
// `resolveBuiltinDir` is a hoisted function declaration further down; the constants that
// depend on it live here so the sentinel can be keyed by the running build.
const BUILTIN_DIR = resolveBuiltinDir();
const EXTERNAL_DIR = path.join(WALNUT_HOME, 'plugins');
/** The directory the running code lives in: the source checkout in dev, a staged
 *  copy on the temp volume in production, `node_modules/open-walnut` for an npm
 *  install. Every deploy stages a fresh copy, so this doubles as the build identity. */
const RUNNING_PACKAGE_ROOT = path.dirname(path.dirname(BUILTIN_DIR));
const bootSentinel = new PluginBootSentinel({ buildId: RUNNING_PACKAGE_ROOT });

/** The build identity the boot sentinel keys its records by (diagnostics and tests). */
export function getRunningPackageRoot(): string {
  return RUNNING_PACKAGE_ROOT;
}
let pluginCodeTimeoutMs = 20_000;

// One line per process: an unknown host version refuses every apiVersion 1 plugin,
// so repeating it once per plugin would bury the single fact that matters.
let unknownHostVersionLogged = false;
function logUnknownHostVersionOnce(): void {
  if (unknownHostVersionLogged) return;
  unknownHostVersionLogged = true;
  log.error('Walnut could not determine its own version, so every apiVersion 1 plugin will be refused (Walnut bug, not a plugin problem)');
}

class PluginCodeTimeoutError extends Error {
  constructor(pluginId: string, phase: string, timeoutMs: number) {
    super(`Plugin "${pluginId}" ${phase} timed out after ${timeoutMs}ms`);
    this.name = 'PluginCodeTimeoutError';
  }
}

async function withPluginCodeDeadline<T>(
  pending: Promise<T>,
  pluginId: string,
  phase: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new PluginCodeTimeoutError(pluginId, phase, pluginCodeTimeoutMs)),
          pluginCodeTimeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function setPluginCodeTimeoutForTesting(timeoutMs: number | null): void {
  pluginCodeTimeoutMs = Math.max(1, timeoutMs ?? 20_000);
}
const pluginManagers = new WeakMap<IntegrationRegistry, PluginManager>();
const pluginSources = new WeakMap<IntegrationRegistry, Map<string, { dir: string; isBuiltin: boolean }>>();
const pluginOperationTails = new WeakMap<IntegrationRegistry, Promise<unknown>>();
interface LoadedPluginGeneration {
  manifest: PluginManifest;
  module: PluginModuleFunctions;
  config: Record<string, unknown>;
  web?: PluginWebModule;
  webError?: string;
}
const pluginGenerations = new WeakMap<IntegrationRegistry, Map<string, LoadedPluginGeneration>>();
const pendingRecoveries = new WeakMap<IntegrationRegistry, Map<string, LoadedPluginGeneration>>();

function recoveries(registry: IntegrationRegistry): Map<string, LoadedPluginGeneration> {
  let map = pendingRecoveries.get(registry);
  if (!map) pendingRecoveries.set(registry, map = new Map());
  return map;
}

function generations(registry: IntegrationRegistry): Map<string, LoadedPluginGeneration> {
  let map = pluginGenerations.get(registry);
  if (!map) pluginGenerations.set(registry, map = new Map());
  return map;
}

/**
 * Every manifest this registry has seen, in load order.
 *
 * Kept because dependency resolution needs the VERSION and the declared dependencies
 * of plugins that are not loaded — a disabled dependency, or one held back by its own
 * missing config, still has to answer "which version are you?" for a later single-plugin
 * reload that happens long after the boot walk read the file.
 */
const pluginManifests = new WeakMap<IntegrationRegistry, Map<string, PluginManifest>>();

function manifestMap(registry: IntegrationRegistry): Map<string, PluginManifest> {
  let map = pluginManifests.get(registry);
  if (!map) {
    map = new Map();
    pluginManifests.set(registry, map);
  }
  return map;
}

/** The dependency gate's view of one registry. Rebuilt per operation on purpose: a stale
 *  gate would cascade against a plugin set that no longer exists. */
function dependencyGate(registry: IntegrationRegistry, manager: PluginManager): DependencyGate {
  return { registry, manager, manifests: manifestMap(registry) };
}

/** The gate cannot load a plugin itself, so it calls back into this single-node load. */
function restoreOptions(
  registry: IntegrationRegistry,
  manager: PluginManager,
  pluginConfigs: Record<string, Record<string, unknown> & { enabled?: boolean }>,
): DependencyRestore {
  return {
    sources: pluginSources.get(registry) ?? new Map(),
    loadOne: (source, manifest) => {
      const previous = generations(registry).get(manifest.id);
      const { enabled: _enabled, ...config } = pluginConfigs[manifest.id] ?? {};
      return loadPlugin(source.dir, source.isBuiltin, pluginConfigs, registry, manager, false, manifest, undefined,
        previous ? { ...previous, config } : undefined);
    },
  };
}

function runPluginOperation<T>(
  registry: IntegrationRegistry,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = pluginOperationTails.get(registry) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  pluginOperationTails.set(registry, current);
  void current.finally(() => {
    if (pluginOperationTails.get(registry) === current) pluginOperationTails.delete(registry);
  }).catch(() => undefined);
  return current;
}

export function getPluginLifecycleRecords(registry: IntegrationRegistry): PluginLifecycleRecord[] {
  return pluginManagers.get(registry)?.list() ?? [];
}

export function getPluginReloadIds(registry: IntegrationRegistry, pluginId: string): string[] {
  const manager = pluginManagers.get(registry);
  return manager ? [pluginId, ...dependentsToTearDown(dependencyGate(registry, manager), pluginId).live] : [pluginId];
}

async function refreshPluginDerivedState(registry: IntegrationRegistry): Promise<void> {
  setExtIndexes(registry.getAll().flatMap((plugin) => plugin.extIndex ? [plugin.extIndex] : []));
  try {
    const [{ clearSkillsCache }, { clearPluginWebModuleCache }] = await Promise.all([
      import('./skill-loader.js'),
      import('./plugins/plugin-web-module.js'),
    ]);
    clearSkillsCache();
    clearPluginWebModuleCache();
  } catch { /* best-effort after lifecycle changes */ }
}

export function disposeLoadedPlugins(registry: IntegrationRegistry): Promise<void> {
  return runPluginOperation(registry, async () => {
    const manager = pluginManagers.get(registry);
    if (!manager) return;
    const ids = manager.list().map(record => record.id);
    await manager.dispose();
    pluginManagers.delete(registry);
    pluginSources.delete(registry);
    pluginManifests.delete(registry);
    pluginGenerations.delete(registry);
    pendingRecoveries.delete(registry);
    // Every plugin op and service is registered through context.own(), so a clean dispose
    // already withdrew them. A dispose that threw partway did not, and a survivor would
    // answer with a handler whose plugin is gone.
    for (const id of ids) {
      removePluginOps(id);
      removeServicesOf(id);
    }
    await refreshPluginDerivedState(registry);
  });
}

export function disableLoadedPlugin(
  registry: IntegrationRegistry,
  pluginId: string,
  opts: { cascade?: boolean } = {},
): Promise<PluginLifecycleRecord> {
  return runPluginOperation(registry, async () => {
    if (pluginId === 'local') throw new Error('The local fallback plugin cannot be disabled.');
    const manager = pluginManagers.get(registry);
    if (!manager?.get(pluginId)) throw new Error(`Plugin "${pluginId}" is not discovered`);

    // Dependents are resolved BEFORE any mutation: a refusal has to leave the target
    // running and config untouched, so there is nothing to undo.
    const gate = dependencyGate(registry, manager);
    const { all, live } = dependentsToTearDown(gate, pluginId);
    if (live.length > 0 && !opts.cascade) throw new PluginDependentsError(pluginId, live);

    // Config first, teardown second. The config write is the only reversible half of this
    // operation and the only one that can fail on its own (a full disk, a locked file); if
    // it goes down after the dependents do, they are parked with nothing on disk that will
    // ever bring them back.
    await updatePluginConfig(pluginId, { enabled: false });
    recoveries(registry).delete(pluginId);
    if ((await blockDependents(gate, pluginId, all, live, 'disabled')).length > 0) {
      await refreshPluginDerivedState(registry);
    }
    registry.unregister(pluginId, 'disabled');
    try {
      return await manager.disable(pluginId);
    } finally {
      await refreshPluginDerivedState(registry);
    }
  });
}

export function reloadLoadedPlugins(
  registry: IntegrationRegistry,
  pluginIds: readonly string[],
  beforeTeardown: (ids: string[]) => Promise<void>,
): Promise<{ reloaded: string[]; skipped: string[] }> {
  return runPluginOperation(registry, async () => {
    const manager = pluginManagers.get(registry);
    if (!manager) throw new Error('Plugin manager is unavailable');
    const config = await getConfig();
    const pluginConfigs = config.plugins ?? {};
    const requested = [...new Set(pluginIds)];
    const ids = requested.filter(id => id !== 'local' && manager.get(id)?.state === 'active' && pluginConfigs[id]?.enabled !== false);
    const skipped = requested.filter(id => !ids.includes(id));
    if (!ids.length) return { reloaded: [], skipped };
    const gate = dependencyGate(registry, manager);
    const previousManifests = new Map(gate.manifests);
    const candidates = new Map<string, PluginManifest>();
    const sources = pluginSources.get(registry)!;
    for (const id of ids) {
      const source = sources.get(id)!;
      const unsafe = generations(registry).get(id)?.module.reloadUnsafeReason;
      if (unsafe) throw new Error(unsafe);
      const entry = await readPluginEntry(await fsp.realpath(source.dir), source.isBuiltin);
      if (!entry || entry.manifest.id !== id) throw new Error(`Plugin "${id}" manifest is invalid or changed identity`);
      candidates.set(id, entry.manifest);
    }
    const candidateManifests = new Map([...previousManifests, ...candidates]);
    const candidateGate = { ...gate, manifests: candidateManifests };
    const prepared = new Map<string, LoadedPluginGeneration>();
    for (const [id, manifest] of candidates) {
      const source = sources.get(id)!;
      const { enabled: _enabled, ...settings } = pluginConfigs[id] ?? {};
      preflightReload(manifest, settings, candidateGate, source.isBuiltin);
      prepared.set(id, await prepareGeneration(await fsp.realpath(source.dir), source.isBuiltin, manifest, settings, true));
    }
    const affected = new Set(ids.flatMap(id => getPluginReloadIds(registry, id)));
    const previous = new Map([...generations(registry)].filter(([id]) => affected.has(id)));
    const ordered = (manifests: Map<string, PluginManifest>) => topoSortStable(buildDepGraph(
      [...manifests.values()].map((manifest, index) => ({ id: manifest.id, index, deps: Object.keys(manifest.dependencies ?? {}) })),
    )).order.filter(id => affected.has(id));
    const oldOrder = ordered(previousManifests);
    const newOrder = ordered(candidateManifests);
    await beforeTeardown(oldOrder.slice().reverse());
    let mutated = false;
    try {
      for (const id of oldOrder.slice().reverse()) {
        mutated = true;
        await manager.forget(id);
        registry.unregister(id, 'unloaded');
      }
      for (const [id, manifest] of candidates) gate.manifests.set(id, manifest);
      for (const id of newOrder) {
        const source = sources.get(id)!;
        const generation = prepared.get(id) ?? previous.get(id);
        const { enabled: _enabled, ...settings } = pluginConfigs[id] ?? {};
        await loadPlugin(source.dir, source.isBuiltin, pluginConfigs, registry, manager, false,
          candidateManifests.get(id), undefined, generation ? { ...generation, config: settings } : undefined);
        const record = manager.get(id);
        if (record?.state !== 'active') throw new Error(record?.error ?? record?.reason ?? `Plugin "${id}" did not activate`);
      }
      for (const id of ids) await retryUnmetDependents(gate, id, restoreOptions(registry, manager, pluginConfigs));
      return { reloaded: ids, skipped };
    } catch (error) {
      if (!mutated) throw error;
      const recoveryErrors: string[] = [];
      for (const id of newOrder.slice().reverse()) {
        try { if (manager.get(id) && !manager.isStopping(id)) await manager.forget(id); }
        catch (cleanupError) { recoveryErrors.push(String(cleanupError)); }
      }
      for (const [id, manifest] of previousManifests) gate.manifests.set(id, manifest);
      const waiting = oldOrder.some(id => manager.isStopping(id));
      for (const id of oldOrder) {
        const source = sources.get(id)!;
        const generation = previous.get(id);
        try {
          if (manager.isStopping(id)) throw new Error(`Plugin "${id}" is still stopping`);
          if (manager.get(id)) await manager.forget(id);
          await loadPlugin(source.dir, source.isBuiltin, pluginConfigs, registry, manager, false,
            previousManifests.get(id), undefined, generation ? {
              ...generation, config: Object.fromEntries(Object.entries(pluginConfigs[id] ?? {}).filter(([key]) => key !== 'enabled')),
            } : undefined);
          if (manager.get(id)?.state !== 'active') throw new Error(manager.get(id)?.error ?? `Plugin "${id}" recovery failed`);
        } catch (restoreError) {
          if (waiting && generation) recoveries(registry).set(id, generation);
          recoveryErrors.push(String(restoreError));
        }
      }
      throw new Error(`Plugin update failed; ${recoveryErrors.length ? `recovery incomplete: ${recoveryErrors.join('; ')}` : 'previous versions restored'}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await refreshPluginDerivedState(registry);
      bus.emit('plugin:runtime-changed', { action: 'reloaded' }, ['web-ui'], { source: 'plugin-loader' });
    }
  });
}

export function reloadLoadedPlugin(
  registry: IntegrationRegistry,
  pluginId: string,
): Promise<PluginLifecycleRecord> {
  return runPluginOperation(registry, async () => {
    if (pluginId === 'local') throw new Error('The local fallback plugin cannot be reloaded.');
    const manager = pluginManagers.get(registry);
    const source = pluginSources.get(registry)?.get(pluginId);
    if (!manager?.get(pluginId) || !source) throw new Error(`Plugin "${pluginId}" is not discovered`);

    // CONSTRAINT: a reload must bundle from the CANONICAL directory, because the esbuild
    // rebase in bundleExternalPlugin keys on `importer.startsWith(pluginDir + '/')`. The
    // recorded path can go stale between boot and reload (`~/.open-walnut/plugins/<id>`
    // was a real directory at boot and became a `walnut-plugin link` symlink since), and
    // bundling through the stale path stops matching, so the reload dies on
    // "Could not resolve ../../constants.js". Passing the realpath to loadPlugin also
    // self-heals the recorded dir for every later operation.
    const dir = await fsp.realpath(source.dir).catch(() => source.dir);

    const manifestPath = path.join(dir, 'manifest.json');
    let manifest: PluginManifest | null = null;
    try {
      manifest = validateManifest(JSON.parse(await fsp.readFile(manifestPath, 'utf-8')), manifestPath);
    } catch (error) {
      throw new Error(`Plugin "${pluginId}" manifest cannot be read: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!manifest || manifest.id !== pluginId) {
      throw new Error(`Plugin "${pluginId}" manifest is invalid or changed identity`);
    }
    const gate = dependencyGate(registry, manager);
    const config = await getConfig();
    const pluginConfigs = { ...config.plugins, [pluginId]: { ...config.plugins?.[pluginId], enabled: true } };
    const { enabled: _enabled, ...pluginConfig } = pluginConfigs[pluginId];
    const lastKnown = generations(registry).get(pluginId);
    const previous = manager.get(pluginId)?.state === 'active' ? lastKnown : undefined;
    let prepared: LoadedPluginGeneration | undefined;
    if (lastKnown?.module.reloadUnsafeReason) {
      if (previous) throw new Error(lastKnown.module.reloadUnsafeReason);
      manifest = lastKnown.manifest;
      preflightReload(manifest, pluginConfig, gate, source.isBuiltin);
      prepared = { ...lastKnown, config: pluginConfig };
    } else if (previous) {
      preflightReload(manifest, pluginConfig, gate, source.isBuiltin);
      prepared = await prepareGeneration(dir, source.isBuiltin, manifest, pluginConfig, true);
    }
    if (manager.isStopping(pluginId)) {
      throw new Error(`Plugin "${pluginId}" cannot reload yet: a previous instance is still stopping`);
    }

    // Persist intent before stopping anything; a failed config write leaves the live graph alone.
    await updatePluginConfig(pluginId, { enabled: true });
    const { all, live } = dependentsToTearDown(gate, pluginId);
    let failure: unknown;
    try {
      await blockDependents(gate, pluginId, all, live, 'reloading');
      const stopping = live.find(id => manager.isStopping(id));
      if (stopping) throw new Error(`Dependent plugin "${stopping}" is still stopping`);
      await manager.forget(pluginId);
      registry.unregister(pluginId, 'unloaded');
      manifestMap(registry).set(pluginId, manifest);
      await loadPlugin(dir, source.isBuiltin, pluginConfigs, registry, manager, false, manifest, undefined, prepared);
      const record = manager.get(pluginId);
      if (previous && record?.state !== 'active') throw new Error(record?.error ?? record?.reason ?? 'Replacement did not activate');
    } catch (error) {
      failure = error;
      if (previous && manager.isStopping(pluginId)) {
        manifestMap(registry).set(pluginId, previous.manifest);
        recoveries(registry).set(pluginId, previous);
      }
      if (previous && !manager.isStopping(pluginId) && manager.get(pluginId)?.state !== 'active') {
        try {
          if (manager.get(pluginId)) await manager.forget(pluginId);
          registry.unregister(pluginId, 'unloaded');
          manifestMap(registry).set(pluginId, previous.manifest);
          await loadPlugin(dir, source.isBuiltin, pluginConfigs, registry, manager, false,
            previous.manifest, undefined, { ...previous, config: pluginConfig });
          const restored = manager.get(pluginId);
          if (restored?.state !== 'active') throw new Error(restored?.error ?? restored?.reason ?? 'Recovery did not activate');
          failure = new Error(`Plugin "${pluginId}" update failed; previous version restored: ${error instanceof Error ? error.message : String(error)}`);
        } catch (restoreError) {
          failure = new Error(`Plugin "${pluginId}" update failed: ${error instanceof Error ? error.message : String(error)}; recovery failed: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`);
        }
      }
    } finally {
      try {
        const restored = await retryUnmetDependents(gate, pluginId, restoreOptions(registry, manager, pluginConfigs));
        if (restored > 0) log.info('Dependents restored after reload', { id: pluginId, restored });
      } finally {
        await refreshPluginDerivedState(registry);
        bus.emit('plugin:runtime-changed', { pluginId, action: 'reloaded' }, ['web-ui'], { source: 'plugin-loader' });
      }
    }
    if (failure) throw failure;
    const record = manager.get(pluginId);
    if (!record) throw new Error(`Plugin "${pluginId}" was not found after reload`);
    return record;
  });
}

/**
 * Clear the quarantine flag, on disk and in the manager, inside the loader's lane.
 *
 * Leaves the plugin `disabled`, which is exactly the state the caller's follow-up
 * `reloadLoadedPlugin` expects: that path re-reads the manifest and re-runs the
 * dependency check from scratch, so nothing extra is needed here.
 */
export function clearPluginQuarantine(
  registry: IntegrationRegistry,
  pluginId: string,
): Promise<PluginLifecycleRecord | undefined> {
  return runPluginOperation(registry, async () => {
    await bootSentinel.clearQuarantine(pluginId);
    return pluginManagers.get(registry)?.clearQuarantine(pluginId);
  });
}

async function createPluginManager(registry: IntegrationRegistry): Promise<PluginManager> {
  const previous = pluginManagers.get(registry);
  if (previous) {
    try {
      await previous.dispose();
    } catch (error) {
      log.warn('Plugin cleanup before reload failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const stopping = previous.list().find(record => previous.isStopping(record.id));
    if (stopping) throw new Error(`Plugin "${stopping.id}" is still stopping; cannot replace the plugin manager`);
  }

  const interrupted = await bootSentinel.recoverInterruptedActivations();
  for (const failure of interrupted) {
    log.warn('Plugin activation was interrupted during the previous process', { ...failure });
  }

  const manager = new PluginManager({
    safeMode: pluginSafeModeEnabled(),
    createContext: (definition) => new PluginContext({
      id: definition.id,
      dataDir: path.join(WALNUT_HOME, 'plugin-data', definition.id),
      logger: createSubsystemLogger(`plugin/${definition.id}`),
    }),
    onStateChange: (record) => {
      log.debug('Plugin lifecycle changed', { id: record.id, state: record.state });
      // Announced for EVERY transition, not just the interesting ones. A capability plugin
      // that keyed a registration by the plugin that made it (walnut.services.caller())
      // needs "that owner just left a live state" to drop the row, and it cannot get that
      // from the owner itself: the case it exists for is an activate that threw.
      bus.emit(
        'plugin:lifecycle-changed',
        { pluginId: record.id, state: record.state },
        ['web-ui'],
        { source: 'plugin-loader' },
      );
    },
    onStoppingSettled: (pluginId) => runPluginOperation(registry, async () => {
      if (pluginManagers.get(registry) !== manager) return;
      const pluginConfigs = (await getConfig()).plugins ?? {};
      const gate = dependencyGate(registry, manager);
      const pending = recoveries(registry);
      const order = topoSortStable(buildDepGraph([...gate.manifests.values()].map((manifest, index) => ({
        id: manifest.id, index, deps: Object.keys(manifest.dependencies ?? {}),
      })))).order;
      for (const id of order) {
        const previous = pending.get(id);
        if (!previous || manager.isStopping(id)) continue;
        if (pluginConfigs[id]?.enabled === false || manager.get(id)?.state === 'active') {
          pending.delete(id);
          continue;
        }
        if (resolveMissingDependencies(previous.manifest, gate).length) continue;
        const source = pluginSources.get(registry)?.get(id);
        pending.delete(id);
        if (!source) continue;
        if (manager.get(id)) await manager.forget(id);
        const { enabled: _enabled, ...config } = pluginConfigs[id] ?? {};
        await loadPlugin(source.dir, source.isBuiltin, pluginConfigs, registry, manager, false,
          previous.manifest, undefined, { ...previous, config });
      }
      const roots = new Set([pluginId, ...Object.keys(gate.manifests.get(pluginId)?.dependencies ?? {})]);
      for (const id of roots) await retryUnmetDependents(gate, id, restoreOptions(registry, manager, pluginConfigs));
      await refreshPluginDerivedState(registry);
      bus.emit('plugin:runtime-changed', { pluginId, action: 'recovered' }, ['web-ui'], { source: 'plugin-loader' });
    }),
    onActivationStart: async (pluginId) => {
      try { await bootSentinel.begin(pluginId); }
      catch (error) {
        log.warn('Could not persist plugin activation sentinel', {
          id: pluginId, error: error instanceof Error ? error.message : String(error),
        });
      }
    },
    onActivationEnd: async (pluginId, outcome, detail) => {
      try { await bootSentinel.finish(pluginId, outcome, detail); }
      catch (error) {
        log.warn('Could not clear plugin activation sentinel', {
          id: pluginId, error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  });
  pluginManagers.set(registry, manager);
  return manager;
}

async function discoverManagedPlugin(
  manager: PluginManager,
  definition: PluginDefinition,
): Promise<PluginLifecycleRecord> {
  const persisted = await bootSentinel.getPluginStatus(definition.id);
  return manager.discover({
    ...definition,
    quarantined: definition.quarantined ?? persisted.quarantined,
    failureCount: Math.max(definition.failureCount ?? 0, persisted.failureCount),
    ...(definition.lastError === undefined && persisted.lastFailure?.error
      ? { lastError: persisted.lastFailure.error }
      : {}),
  });
}

// ── On-the-fly bundling for external .ts plugins ──
// External plugins ship as .ts source with relative imports that reference the
// open-walnut src/ tree (e.g. '../../core/config-manager.js'). These paths only
// resolve correctly when the plugin is inside src/integrations/. At runtime,
// plugins live in ~/.open-walnut/plugins/ so the paths break. We use esbuild to
// bundle the plugin on-the-fly, rebasing parent imports to the real src/ tree.

type BundleOutcome = { outfile: string; error?: undefined } | { outfile?: undefined; error: string };

async function bundleExternalPlugin(
  pluginDir: string,
  entryFile: string,
): Promise<BundleOutcome> {
  try {
    const { build } = await import('esbuild');
    const pluginName = path.basename(pluginDir);
    const tree = resolvePluginSourceTree(RUNNING_PACKAGE_ROOT);

    // CRITICAL: write the bundled mjs INSIDE the running package so Node's ESM
    // resolver can walk up from the bundle file to a real node_modules when
    // resolving externals like 'better-sqlite3' (the stage symlinks one in). If we
    // write to os.tmpdir(), Node looks for node_modules in /private/var/folders/...
    // and fails. esbuild's `nodePaths` option only affects build-time resolution —
    // Node ignores it at runtime, so the file's actual on-disk location matters.
    const cacheDir = path.join(tree.nodeModulesRoot, '.plugin-cache');
    await fsp.mkdir(cacheDir, { recursive: true });
    const outfile = path.join(cacheDir, `${pluginName}-${randomUUID()}.mjs`);

    await build({
      entryPoints: [entryFile],
      outfile,
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node22',
      // Mark ALL npm packages external — we only bundle to rebase the plugin's
      // own relative imports onto walnut's src/ tree; npm packages (native ones
      // like better-sqlite3 / node-pty included) resolve at runtime from
      // walnut's node_modules. Listing packages individually was whack-a-mole:
      // any new transitively-reached native dep broke the bundle (better-sqlite3,
      // then node-pty). `packages: 'external'` kills that whole class.
      packages: 'external',
      nodePaths: [path.join(tree.nodeModulesRoot, 'node_modules')],
      banner: { js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
      logLevel: 'warning',
      plugins: [{
        name: 'rebase-open-walnut-imports',
        setup(b) {
          // Rebase parent-directory imports (../../core/, ../../utils/, etc.)
          // to the open-walnut src/ tree so they resolve correctly.
          // Use src/ (not dist/) because tsup bundles everything — dist/ lacks individual module files.
          const rebaseDir = tree.srcIntegrationsDir ?? BUILTIN_DIR;
          b.onResolve({ filter: /^\.\.\// }, (args) => {
            // Only rebase imports originating from the plugin directory itself.
            // Once resolved into the open-walnut src/ tree, let esbuild handle natively.
            if (!args.importer.startsWith(pluginDir + '/')) return undefined;
            const subPath = path.relative(pluginDir, args.importer);
            const assumedImporter = path.join(rebaseDir, pluginName, subPath);
            const resolved = path.resolve(path.dirname(assumedImporter), args.path);
            // Try .ts extension (esbuild resolves .js → .ts naturally in the src tree)
            for (const candidate of [
              resolved.replace(/\.js$/, '.ts'),
              resolved,
              path.join(resolved.replace(/\.js$/, ''), 'index.ts'),
            ]) {
              try { if (fs.statSync(candidate).isFile()) return { path: candidate }; } catch { /* expected: candidate doesn't exist */ }
            }
            return undefined;
          });
        },
      }],
    });

    return { outfile };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    // esbuild's message is "Build failed with N errors:" followed by one line per error;
    // the first error line is the one that explains the failure, and "Could not resolve
    // '../../core/x.js'" additionally means no source checkout is reachable from here.
    const firstError = raw.split('\n').map(l => l.trim()).find(l => l.includes('ERROR:')) ?? raw.split('\n')[0];
    const tree = resolvePluginSourceTree(RUNNING_PACKAGE_ROOT);
    const hint = !tree.srcIntegrationsDir && /Could not resolve "\.\./.test(raw)
      ? ' (this plugin imports Walnut source modules, but no source checkout is reachable from the running package)'
      : '';
    const error = `${firstError}${hint}`;
    log.warn('failed to bundle external plugin', { dir: pluginDir, error: raw, packageRoot: RUNNING_PACKAGE_ROOT, srcIntegrationsDir: tree.srcIntegrationsDir });
    return { error };
  }
}

// ── Built-in integrations dir resolution ──
// Same walk-up pattern used by BUILTIN_COMMANDS_DIR in constants.ts.
// In dev (tsx): import.meta.url → src/core/integration-loader.ts → walk up to find src/integrations/
// In prod (tsup bundle): import.meta.url → dist/... → walk up to find dist/integrations/ or src/integrations/

function resolveBuiltinDir(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    // Check both direct child and dist/ child (handles prod bundles)
    for (const candidate of [
      path.join(dir, 'integrations'),
      path.join(dir, 'dist', 'integrations'),
    ]) {
      try {
        if (fs.statSync(candidate).isDirectory()) return candidate;
      } catch { /* expected: candidate doesn't exist, keep walking */ }
    }
    dir = path.dirname(dir);
  }
  // Fallback: sibling of this file's parent (src/core/ → src/integrations/)
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'integrations');
}

// Plugins discovered on disk but skipped for missing required config.
// Reset on each loadPlugins() run; served via /api/integrations for the Settings UI.
const unconfiguredPlugins: UnconfiguredPlugin[] = [];

/** Plugins that were found but not loaded because required config is missing. */
export function getUnconfiguredPlugins(): UnconfiguredPlugin[] {
  return unconfiguredPlugins;
}

/** Plugins skipped because their manifest declares only capabilities this
 *  Walnut version doesn't implement yet (manifest v2 forward-compat). */
export interface UnsupportedPluginDiagnostic {
  id: string;
  name: string;
  capabilities: string[];
  reason?: string;
  apiVersion?: number;
}

const unsupportedPlugins: UnsupportedPluginDiagnostic[] = [];

function removePluginDiagnostics(pluginId: string): void {
  for (const diagnostics of [unconfiguredPlugins, unsupportedPlugins]) {
    for (let index = diagnostics.length - 1; index >= 0; index--) {
      if (diagnostics[index].id === pluginId) diagnostics.splice(index, 1);
    }
  }
  // The unmet-dependency list lives with the gate that produces it.
  forgetUnmetDependencies(pluginId);
}

export function getUnsupportedPlugins(): UnsupportedPluginDiagnostic[] {
  return unsupportedPlugins;
}

// The dependency gate owns these; re-exported here so every caller keeps one import.
export { PluginDependentsError, getUnmetDependencyPlugins };
export type { UnmetDependencyPlugin } from './plugins/dependency-gate.js';

/** Plugin ids skipped because another plugin with the same id loaded first
 *  (built-in > ~/.open-walnut/plugins/ > store clones). */
const duplicatePluginIds: string[] = [];

export function getDuplicatePluginIds(): string[] {
  return duplicatePluginIds;
}

/** Capability types this Walnut version can load. Everything else is reserved
 *  (`hooks`, `routines`): a manifest declaring only those is recorded as
 *  unsupported and its code is never imported. */
const SUPPORTED_CAPABILITIES = new Set(['sync', 'ui', 'tools', 'skills']);

/** Longest a plugin tool's description may be. Tool schemas ride the prompt-cache
 *  prefix on EVERY turn, so an essay here is billed forever. */
const MAX_TOOL_DESCRIPTION = 1024;
/** Most tools one plugin may contribute (a runaway registerTool loop is a bug). */
const MAX_TOOLS_PER_PLUGIN = 24;
const MAX_UI_TITLE = 64;

/**
 * Validate a plugin-relative asset path (ui app entry / icon).
 *
 * Rules, in the order that matters: reject absolute paths and Windows drive
 * prefixes, normalize separators, then check for `..` SEGMENT-wise (a substring
 * test would reject an ordinary name like `v1..2/index.html`). An explicit
 * leading `app/` is accepted and stripped, since the served root IS `app/` — a
 * plugin author writing either form gets the same file.
 */
export function validatePluginAssetPath(raw: unknown): { ok: true; rel: string } | { ok: false; error: string } {
  if (typeof raw !== 'string' || raw.trim() === '') return { ok: false, error: 'must be a non-empty string' };
  const value = raw.trim().replace(/\\/g, '/');
  if (value.startsWith('/') || /^[a-zA-Z]:/.test(value)) return { ok: false, error: 'must be a relative path' };
  // A URL is not a file path. `http://…` and `javascript:…` can never resolve to
  // an asset (the route always prefixes /plugin-apps/<id>/), so refusing them at
  // load time tells the author what is wrong instead of serving a 404 later.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) return { ok: false, error: 'must be a file path, not a URL' };
  if (/["'<>]/.test(value)) return { ok: false, error: 'must not contain quotes or angle brackets' };
  const segments = value.split('/').filter(s => s !== '' && s !== '.');
  if (segments.length === 0) return { ok: false, error: 'must name a file' };
  if (segments.some(s => s === '..')) return { ok: false, error: 'must not contain ".." segments' };
  if (segments.some(s => s.includes('\0'))) return { ok: false, error: 'must not contain null bytes' };
  // Accept both `index.html` and `app/index.html`; the served root is `app/`.
  const rel = segments[0] === 'app' ? segments.slice(1).join('/') : segments.join('/');
  if (!rel) return { ok: false, error: 'must name a file inside app/' };
  return { ok: true, rel };
}

export function validatePluginEntryPath(raw: unknown): { ok: true; rel: string } | { ok: false; error: string } {
  if (typeof raw !== 'string' || raw.trim() === '') return { ok: false, error: 'must be a non-empty string' };
  const value = raw.trim().replace(/\\/g, '/');
  if (value.startsWith('/') || /^[a-zA-Z]:/.test(value)) return { ok: false, error: 'must be a relative path' };
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) return { ok: false, error: 'must be a file path, not a URL' };
  if (/["'<>\0]/.test(value)) return { ok: false, error: 'contains unsafe characters' };
  const segments = value.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.length === 0) return { ok: false, error: 'must name a file' };
  if (segments.some((segment) => segment === '..')) return { ok: false, error: 'must not contain ".." segments' };
  return { ok: true, rel: segments.join('/') };
}

// ── Basic JSON Schema validation (type-only, no ajv needed) ──

function validateConfigValue(value: unknown, schema: Record<string, unknown>, fieldPath: string): string[] {
  const errors: string[] = [];
  const schemaType = schema.type as string | undefined;

  if (schemaType) {
    const actualType = Array.isArray(value) ? 'array' : typeof value;
    if (schemaType === 'integer') {
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        errors.push(`${fieldPath}: expected integer, got ${typeof value}`);
      }
    } else if (actualType !== schemaType) {
      errors.push(`${fieldPath}: expected ${schemaType}, got ${actualType}`);
    }
  }

  // Validate object properties
  if (schemaType === 'object' && typeof value === 'object' && value !== null) {
    const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
    const required = schema.required as string[] | undefined;

    if (required) {
      for (const key of required) {
        if (!(key in (value as Record<string, unknown>))) {
          errors.push(`${fieldPath}.${key}: required field missing`);
        }
      }
    }

    if (properties) {
      for (const [key, propSchema] of Object.entries(properties)) {
        const propValue = (value as Record<string, unknown>)[key];
        if (propValue !== undefined) {
          errors.push(...validateConfigValue(propValue, propSchema, `${fieldPath}.${key}`));
        }
      }
    }
  }

  // Validate array items
  if (schemaType === 'array' && Array.isArray(value)) {
    const itemSchema = schema.items as Record<string, unknown> | undefined;
    if (itemSchema) {
      for (let i = 0; i < value.length; i++) {
        errors.push(...validateConfigValue(value[i], itemSchema, `${fieldPath}[${i}]`));
      }
    }
  }

  // Enum validation
  const enumValues = schema.enum as unknown[] | undefined;
  if (enumValues && !enumValues.includes(value)) {
    errors.push(`${fieldPath}: value must be one of [${enumValues.join(', ')}]`);
  }

  return errors;
}

/**
 * Inert sync for a plugin without the `sync` capability (ui/tools/skills only).
 *
 * Exists purely so `RegisteredPlugin.sync` stays non-optional and the ~20
 * existing `registry.get(task.source)!.sync.method()` call sites keep compiling
 * and never see undefined. Nothing routes work here: `hasSync: false` keeps the
 * plugin out of sync polling, and it registers no source claim, so no task can
 * carry it as `source`.
 */
function inertSync(): IntegrationSync {
  const noop = async () => {};
  return {
    createTask: async () => null,
    deleteTask: noop,
    updateTitle: noop,
    updateDescription: noop,
    updateSummary: noop,
    updateNote: noop,
    updateConversationLog: noop,
    updatePriority: noop,
    updatePhase: noop,
    updateDueDate: noop,
    updateProject: noop,
    updateDependencies: noop,
    associateSubtask: noop,
    disassociateSubtask: noop,
    pushTask: async () => ({ serverTimestamp: new Date().toISOString() }),
    syncPoll: noop,
  };
}

// ── PluginApi builder: creates a mutable PluginApi that collects registrations ──

interface PluginApiBuilder {
  api: PluginApi;
  collected: {
    sync: IntegrationSync | null;
    claim: { fn: ProjectClaimFn; priority: number } | null;
    display: DisplayMeta | null;
    connection: PluginConnection | null;
    agentContext: string | null;
    migrations: MigrateFn[];
    httpRoutes: HttpRoute[];
    extIndex: ExtIndexSpec | null;
    tools: PluginToolSpec[];
  };
}

/**
 * Namespace a plugin tool name: `<pluginId>_<name>`, hyphens folded to
 * underscores so the result matches the Anthropic tool-name charset. Already
 * prefixed names are left alone, so a plugin may spell out the full name itself.
 */
export function pluginToolName(pluginId: string, name: string): string {
  const prefix = `${pluginId.replace(/[^a-z0-9_]/gi, '_').toLowerCase()}_`;
  return name.startsWith(prefix) ? name : `${prefix}${name}`;
}

/** Plugins already warned about agentContext — once each, not once per load. */
const agentContextWarned = new Set<string>();

/** Say it in the plugin's own log channel: the text it just handed us is collected
 *  and then read by nothing, and the author is the only one who can fix that. */
function warnAgentContextDeprecated(pluginId: string, logger: { warn: (msg: string, meta?: Record<string, unknown>) => void }): void {
  if (agentContextWarned.has(pluginId)) return;
  agentContextWarned.add(pluginId);
  logger.warn('registerAgentContext is deprecated and reaches no model — register a skill instead', { plugin: pluginId });
}

function createPluginApiBuilder(manifest: PluginManifest, pluginConfig: Record<string, unknown>): PluginApiBuilder {
  const pluginLogger = createSubsystemLogger(`plugin/${manifest.id}`);

  const collected: PluginApiBuilder['collected'] = {
    sync: null,
    claim: null,
    display: null,
    connection: null,
    agentContext: null,
    migrations: [],
    httpRoutes: [],
    extIndex: null,
    tools: [],
  };

  const api: PluginApi = {
    id: manifest.id,
    name: manifest.name,
    config: pluginConfig,
    logger: pluginLogger,

    registerSync(sync: IntegrationSync) {
      if (collected.sync) {
        throw new Error(`Plugin "${manifest.id}" called registerSync() more than once.`);
      }
      collected.sync = sync;
    },

    registerSourceClaim(fn: ProjectClaimFn, opts?: { priority?: number }) {
      collected.claim = { fn, priority: opts?.priority ?? 0 };
    },

    registerDisplay(meta: DisplayMeta) {
      collected.display = meta;
    },

    registerConnection(connection: PluginConnection) {
      if (collected.connection) {
        throw new Error(`Plugin "${manifest.id}" called registerConnection() more than once.`);
      }
      if (!connection || typeof connection.status !== 'function') {
        throw new Error(`Plugin "${manifest.id}" registerConnection: expected an object with a status() function.`);
      }
      collected.connection = connection;
    },

    registerAgentContext(snippet: string) {
      warnAgentContextDeprecated(manifest.id, pluginLogger);
      collected.agentContext = snippet;
    },

    registerMigration(fn: MigrateFn) {
      collected.migrations.push(fn);
    },

    registerHttpRoute(route: HttpRoute) {
      collected.httpRoutes.push(route);
    },

    registerTool(tool: PluginToolSpec) {
      if (!tool || typeof tool !== 'object') {
        throw new Error(`Plugin "${manifest.id}" registerTool: expected a tool object.`);
      }
      if (typeof tool.name !== 'string' || !/^[a-z0-9_]+$/.test(tool.name)) {
        throw new Error(`Plugin "${manifest.id}" tool name "${String(tool.name)}" must match /^[a-z0-9_]+$/.`);
      }
      if (typeof tool.description !== 'string' || !tool.description.trim()) {
        throw new Error(`Plugin "${manifest.id}" tool "${tool.name}": description is required.`);
      }
      if (typeof tool.execute !== 'function') {
        throw new Error(`Plugin "${manifest.id}" tool "${tool.name}": execute must be a function.`);
      }
      if (collected.tools.length >= MAX_TOOLS_PER_PLUGIN) {
        throw new Error(`Plugin "${manifest.id}" registered more than ${MAX_TOOLS_PER_PLUGIN} tools.`);
      }
      const name = pluginToolName(manifest.id, tool.name);
      if (collected.tools.some(t => t.name === name)) {
        throw new Error(`Plugin "${manifest.id}" registered tool "${name}" twice.`);
      }
      const schema = (tool.input_schema && typeof tool.input_schema === 'object' && !Array.isArray(tool.input_schema))
        ? tool.input_schema
        : { type: 'object', properties: {} };
      collected.tools.push({
        name,
        description: tool.description.slice(0, MAX_TOOL_DESCRIPTION),
        input_schema: schema,
        execute: tool.execute.bind(tool),
      });
    },

    registerExtIndex(spec: ExtIndexSpec) {
      if (collected.extIndex) {
        throw new Error(`Plugin "${manifest.id}" called registerExtIndex() more than once.`);
      }
      if (spec.source !== manifest.id) {
        throw new Error(
          `Plugin "${manifest.id}" tried to register ext-index for source "${spec.source}". ` +
          `spec.source must equal the plugin id.`,
        );
      }
      if (!Array.isArray(spec.paths) || spec.paths.length === 0) {
        throw new Error(`Plugin "${manifest.id}" registerExtIndex: paths must be a non-empty array.`);
      }
      for (const p of spec.paths) {
        if (!/^[a-z0-9_]+$/.test(p.key)) {
          throw new Error(`Plugin "${manifest.id}" ext-index path key "${p.key}" must match /^[a-z0-9_]+$/.`);
        }
        if (!p.json.startsWith('$.') && !p.json.startsWith('$[')) {
          throw new Error(`Plugin "${manifest.id}" ext-index path json "${p.json}" must start with '$.' or '$['.`);
        }
      }
      collected.extIndex = spec;
    },
  };

  return { api, collected };
}

// ── Plugin directory scanner ──

async function discoverPluginDirs(): Promise<Array<{ dir: string; isBuiltin: boolean }>> {
  const results: Array<{ dir: string; isBuiltin: boolean }> = [];
  const seenRealDirs = new Set<string>();

  const addCandidate = async (candidate: string, isBuiltin: boolean): Promise<void> => {
    try {
      const realDir = await fsp.realpath(candidate);
      if (!(await fsp.stat(realDir)).isDirectory() || seenRealDirs.has(realDir)) return;
      await fsp.access(path.join(realDir, 'manifest.json'), fs.constants.R_OK);
      seenRealDirs.add(realDir);
      results.push({ dir: realDir, isBuiltin });
    } catch { /* expected: broken link, non-directory, or no readable manifest */ }
  };

  const scanRoot = async (root: string, isBuiltin: boolean, followLinks: boolean): Promise<void> => {
    const entries = await fsp.readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() && !(followLinks && entry.isSymbolicLink())) continue;
      await addCandidate(path.join(root, entry.name), isBuiltin);
    }
  };

  try {
    await scanRoot(BUILTIN_DIR, true, false);
  } catch (err) {
    log.debug('Built-in integrations dir not found', {
      dir: BUILTIN_DIR,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    // Local development links are intentionally followed. Installing the link is
    // the trust decision; canonicalizing the target also prevents duplicate loads.
    await scanRoot(EXTERNAL_DIR, false, true);
  } catch (err) {
    log.debug('external plugins dir not accessible', {
      dir: EXTERNAL_DIR,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    const { getStorePluginDirs } = await import('./plugin-sources.js');
    for (const dir of await getStorePluginDirs()) await addCandidate(dir, false);
  } catch (err) {
    log.debug('plugin-source scan failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return results;
}

// ── Manifest validation ──

/**
 * Validate `capabilities.ui` → the app spec, or null (with a warn) when the
 * block is unusable. Never throws: a bad ui block must not unload the plugin.
 */
function parseUiApp(uiCap: Record<string, unknown>, filePath: string): RegisteredUiApp | null {
  const drop = (reason: string) => {
    log.warn('Manifest capabilities.ui.app dropped', { filePath, reason });
    return null;
  };
  const rawApp = uiCap.app;
  if (rawApp === undefined) return null; // `ui: {}` is legal — just declares no app
  if (!rawApp || typeof rawApp !== 'object' || Array.isArray(rawApp)) return drop('app must be an object');
  const app = rawApp as Record<string, unknown>;

  if (typeof app.title !== 'string' || !app.title.trim()) return drop('title is required');
  const title = app.title.trim();
  if (title.length > MAX_UI_TITLE) return drop(`title longer than ${MAX_UI_TITLE} chars`);

  let entry = 'index.html';
  if (app.entry !== undefined) {
    const checked = validatePluginAssetPath(app.entry);
    if (!checked.ok) return drop(`entry ${checked.error}`);
    entry = checked.rel;
  }

  let icon: string | undefined;
  if (app.icon !== undefined) {
    const checked = validatePluginAssetPath(app.icon);
    // An unusable icon is not worth losing the app over — drop just the icon.
    if (!checked.ok) log.warn('Manifest capabilities.ui.app.icon dropped', { filePath, reason: checked.error });
    else icon = `app/${checked.rel}`;
  }

  return { title, entry: `app/${entry}`, ...(icon ? { icon } : {}) };
}

function validateManifest(raw: unknown, filePath: string): PluginManifest | null {
  if (!raw || typeof raw !== 'object') {
    log.warn('Invalid manifest: not an object', { filePath });
    return null;
  }

  const obj = raw as Record<string, unknown>;
  if (typeof obj.id !== 'string' || !obj.id) {
    log.warn('Invalid manifest: missing or empty "id"', { filePath });
    return null;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(obj.id)) {
    log.warn('Invalid manifest: unsafe "id"', { filePath });
    return null;
  }
  // `core` is the owner of the host's own services, which every plugin may use without
  // declaring a dependency. A plugin holding that id could publish a key others trust
  // unconditionally, and its teardown sweep would withdraw the host's services.
  if (obj.id.toLowerCase() === CORE_SERVICE_OWNER) {
    log.warn('Invalid manifest: the plugin id "core" is reserved for the host', { filePath });
    return null;
  }
  if (typeof obj.name !== 'string' || !obj.name) {
    log.warn('Invalid manifest: missing or empty "name"', { filePath });
    return null;
  }
  if (obj.apiVersion !== undefined && (!Number.isInteger(obj.apiVersion) || (obj.apiVersion as number) < 1)) {
    log.warn('Invalid manifest: apiVersion must be a positive integer', { filePath });
    return null;
  }
  if (obj.apiVersion === 1) {
    try { validatePluginId(obj.id); }
    catch (error) {
      log.warn('Invalid unified plugin id', { filePath, error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  }

  // Manifest v2: capabilities. Parsed leniently — unknown keys warn (they may
  // be from a newer Walnut), invalid shapes are dropped.
  let capabilities: Record<string, Record<string, unknown>> | undefined;
  if (obj.capabilities && typeof obj.capabilities === 'object' && !Array.isArray(obj.capabilities)) {
    capabilities = {};
    for (const [key, val] of Object.entries(obj.capabilities as Record<string, unknown>)) {
      capabilities[key] = (val && typeof val === 'object' && !Array.isArray(val))
        ? val as Record<string, unknown> : {};
      if (!SUPPORTED_CAPABILITIES.has(key)) {
        log.warn('Manifest declares a capability this Walnut version does not support', {
          filePath, capability: key,
        });
      }
    }
    // capabilities.ui.app — validated here so a malformed block costs the plugin
    // its APP, not its whole load (same leniency as taskFields below). The `ui`
    // key itself is kept either way: it is a capability this version supports, so
    // dropping it could flip a ui-only plugin to "needs a newer Walnut" — a
    // misleading diagnosis for what is really a typo in one field.
    if (capabilities.ui) {
      const parsed = parseUiApp(capabilities.ui, filePath);
      capabilities.ui = parsed ? { app: parsed } : {};
    }
  }

  // taskFields: per-task fields the console renders generically. Invalid
  // entries are dropped with a warn (a bad field must not unload the plugin).
  let taskFields: TaskFieldSpec[] | undefined;
  if (Array.isArray(obj.taskFields)) {
    taskFields = [];
    const seenKeys = new Set<string>();
    for (const raw of obj.taskFields) {
      const f = raw as Record<string, unknown>;
      const drop = (reason: string) =>
        log.warn('Manifest taskFields entry dropped', { filePath, reason, entry: JSON.stringify(raw).slice(0, 200) });
      if (!f || typeof f !== 'object') { drop('not an object'); continue; }
      if (typeof f.key !== 'string' || !/^[a-z0-9_]+$/.test(f.key)) { drop('key must match [a-z0-9_]+'); continue; }
      if (seenKeys.has(f.key)) { drop(`duplicate key "${f.key}"`); continue; }
      if (typeof f.label !== 'string' || !f.label) { drop('label required'); continue; }
      if (f.type !== 'enum') { drop(`type "${String(f.type)}" not supported (v1: enum only)`); continue; }
      if (typeof f.optionsRoute !== 'string' || !f.optionsRoute.startsWith('/')) { drop('optionsRoute must start with /'); continue; }
      if (f.coreField !== undefined && f.coreField !== 'sprint') { drop(`coreField "${String(f.coreField)}" not honored`); continue; }
      seenKeys.add(f.key);
      taskFields.push({
        key: f.key,
        label: f.label,
        type: 'enum',
        optionsRoute: f.optionsRoute,
        clearable: typeof f.clearable === 'boolean' ? f.clearable : undefined,
        coreField: f.coreField as 'sprint' | undefined,
      });
    }
    if (taskFields.length === 0) taskFields = undefined;
  }

  // `dependencies`: { "<pluginId>": "<semver range>" }. Parsed as leniently as
  // taskFields above — a bad entry costs that entry, never the plugin — because an
  // unloadable plugin tells the author far less than a warning that names the typo.
  // `local` is the fallback task source and is never gated on anything, so a
  // dependency block there is dropped outright rather than honoured.
  let dependencies: Record<string, string> | undefined;
  if (obj.dependencies !== undefined) {
    const dropAll = (reason: string) => log.warn('Manifest dependencies dropped', { filePath, reason });
    if (!obj.dependencies || typeof obj.dependencies !== 'object' || Array.isArray(obj.dependencies)) {
      dropAll('must be an object of plugin id → semver range');
    } else if (obj.id === 'local') {
      dropAll('the local fallback plugin is never gated on a dependency');
    } else {
      const parsed: Record<string, string> = {};
      for (const [depId, range] of Object.entries(obj.dependencies as Record<string, unknown>)) {
        const drop = (reason: string) =>
          log.warn('Manifest dependencies entry dropped', { filePath, dependency: depId, reason });
        if (typeof range !== 'string' || !range.trim()) { drop('range must be a non-empty string'); continue; }
        if (depId === obj.id) { drop('a plugin cannot depend on itself'); continue; }
        // `local` is always present and always active, so an edge to it can only ever be
        // satisfied. Keeping it would put the fallback task source into a cascade.
        if (depId === 'local') { drop('the local fallback plugin is not a dependency anyone declares'); continue; }
        try { validatePluginId(depId); }
        catch (error) { drop(error instanceof Error ? error.message : String(error)); continue; }
        if (!isValidRange(range)) { drop(`"${range}" is not a semver range`); continue; }
        parsed[depId] = range.trim();
      }
      if (Object.keys(parsed).length > 0) dependencies = parsed;
    }
  }

  let invalidEntry = false;
  const parseEntry = (field: 'server' | 'web'): string | undefined => {
    if (obj[field] === undefined) return undefined;
    const checked = validatePluginEntryPath(obj[field]);
    if (!checked.ok) {
      invalidEntry = true;
      log.warn(`Invalid manifest ${field} entry`, { filePath, error: checked.error });
      return undefined;
    }
    return checked.rel;
  };
  const server = parseEntry('server');
  const web = parseEntry('web');
  const webview = obj.webview && typeof obj.webview === 'object' && !Array.isArray(obj.webview)
    ? parseUiApp({ app: obj.webview }, filePath) ?? undefined
    : undefined;
  if (invalidEntry) return null;

  return {
    id: obj.id,
    name: obj.name,
    description: typeof obj.description === 'string' ? obj.description : undefined,
    version: typeof obj.version === 'string' ? obj.version : undefined,
    apiVersion: typeof obj.apiVersion === 'number' ? obj.apiVersion : undefined,
    engines: obj.engines && typeof obj.engines === 'object'
      ? obj.engines as { walnut?: string }
      : undefined,
    dependencies,
    server,
    web,
    webview,
    capabilities,
    configSchema: obj.configSchema && typeof obj.configSchema === 'object'
      ? obj.configSchema as Record<string, unknown>
      : undefined,
    uiHints: obj.uiHints && typeof obj.uiHints === 'object'
      ? obj.uiHints as Record<string, { label?: string; help?: string }>
      : undefined,
    taskFields,
  };
}

// ── Single plugin loader ──

async function prepareGeneration(
  dir: string,
  builtin: boolean,
  manifest: PluginManifest,
  config: Record<string, unknown>,
  strictWeb = false,
): Promise<LoadedPluginGeneration> {
  const module = await preparePluginModule({
    dir, builtin, manifest, bundle: bundleExternalPlugin, deadline: withPluginCodeDeadline, replacement: strictWeb,
  });
  const artifactDir = module.sourceRoot ?? dir;
  if (module.sourceRoot) {
    const copied = await readPluginEntry(artifactDir, builtin);
    if (!copied || JSON.stringify(copied.manifest) !== JSON.stringify(manifest)) {
      await module.dispose?.();
      throw new Error(`Plugin "${manifest.id}" changed while preparing its update`);
    }
  }
  let web: PluginWebModule | undefined;
  let webError: string | undefined;
  try {
    if (manifest.apiVersion === 1 && manifest.web) {
      web = await readPluginWebModule({
        id: manifest.id, name: manifest.name, version: manifest.version,
        apiVersion: 1, webEntry: manifest.web, pluginDir: artifactDir,
      } as RegisteredPlugin);
      const { transform } = await import('esbuild');
      await transform(web.content.toString('utf8'), { loader: 'js', format: 'esm', logLevel: 'silent' });
    }
  } catch (error) {
    if (strictWeb) {
      await module.dispose?.();
      throw error;
    }
    web = undefined;
    webError = error instanceof Error ? error.message : String(error);
  }
  return { manifest, module, config, web, webError };
}

function preflightReload(
  manifest: PluginManifest,
  config: Record<string, unknown>,
  gate: DependencyGate,
  builtin: boolean,
): void {
  if (manifest.apiVersion !== undefined && manifest.apiVersion !== 1) {
    throw new Error(`Unsupported Plugin API version ${manifest.apiVersion}`);
  }
  if (manifest.apiVersion === 1) {
    const range = manifest.engines?.walnut;
    if (!range || (!isVersionKnown() && !builtin) || (isVersionKnown() && !satisfiesSemVer(getVersion(), range))) {
      throw new Error(`Plugin "${manifest.id}" requires Walnut ${range ?? '(unspecified)'}`);
    }
  }
  const manifests = new Map(gate.manifests).set(manifest.id, manifest);
  const graph = buildDepGraph([...manifests.values()].map((entry, index) => ({
    id: entry.id, index, deps: Object.keys(entry.dependencies ?? {}),
  })));
  const missing = resolveMissingDependencies(manifest, { ...gate, manifests }, new Set(topoSortStable(graph).residue));
  if (missing.length) throw new Error(`Missing dependencies: ${missing.map(describeMissingDependency).join(', ')}`);
  for (const dependentId of dependentsToTearDown(gate, manifest.id).live) {
    const dependent = manifests.get(dependentId)!;
    const broken = resolveMissingDependencies(dependent, { ...gate, manifests }).filter(entry => entry.id === manifest.id);
    if (broken.length) throw new Error(`Plugin "${dependentId}" would lose its dependency: ${broken.map(describeMissingDependency).join(', ')}`);
  }
  const required = (manifest.configSchema as { required?: string[] } | undefined)?.required ?? [];
  const missingConfig = required.filter(field => !(field in config));
  if (missingConfig.length) throw new Error(`Missing configuration: ${missingConfig.join(', ')}`);
}

/** A discovered plugin dir whose manifest reads and validates. No plugin code is imported. */
interface PluginEntry {
  dir: string;
  isBuiltin: boolean;
  manifest: PluginManifest;
}

/** Read + validate one plugin's manifest. null when unreadable or invalid (already warned). */
async function readPluginEntry(dir: string, isBuiltin: boolean): Promise<PluginEntry | null> {
  const manifestPath = path.join(dir, 'manifest.json');
  let manifestRaw: unknown;
  try {
    manifestRaw = JSON.parse(await fsp.readFile(manifestPath, 'utf-8'));
  } catch (err) {
    log.warn('Failed to read manifest.json', { dir, error: String(err) });
    return null;
  }
  const manifest = validateManifest(manifestRaw, manifestPath);
  return manifest ? { dir, isBuiltin, manifest } : null;
}

async function loadPlugin(
  pluginDir: string,
  isBuiltin: boolean,
  pluginConfigs: Record<string, Record<string, unknown> & { enabled?: boolean }>,
  registry: IntegrationRegistry,
  manager: PluginManager,
  additive = false,
  // Supplied by the pre-scan so the manifest is read once per load, not twice.
  prereadManifest?: PluginManifest,
  // Ids the topological sort could not order. A member is loaded anyway so it lands as
  // a visible `needs-dependency` row instead of vanishing from the list.
  cycleMembers?: ReadonlySet<string>,
  prepared?: LoadedPluginGeneration,
): Promise<void> {
  const manifest = prereadManifest ?? (await readPluginEntry(pluginDir, isBuiltin))?.manifest;
  if (!manifest) return;

  const pluginId = manifest.id;
  const isLocal = pluginId === 'local';

  // Built-ins and earlier discovery roots always win, including when the losing
  // copy targets a newer API version. An additive scan sees every existing source
  // again; that same path is a no-op, while a different path is a real duplicate.
  let sources = pluginSources.get(registry);
  if (!sources) {
    sources = new Map();
    pluginSources.set(registry, sources);
  }
  const existingSource = sources.get(pluginId);
  if ((!isLocal && registry.has(pluginId)) || manager.get(pluginId)) {
    log.debug('Skipping duplicate plugin', { id: pluginId, dir: pluginDir });
    if ((!additive || existingSource?.dir !== pluginDir) && !duplicatePluginIds.includes(pluginId)) {
      duplicatePluginIds.push(pluginId);
    }
    return;
  }
  removePluginDiagnostics(pluginId);
  sources.set(pluginId, { dir: pluginDir, isBuiltin });

  if (manifest.apiVersion !== undefined && manifest.apiVersion !== 1) {
    const reason = `Unsupported Plugin API version ${manifest.apiVersion}`;
    unsupportedPlugins.push({
      id: pluginId,
      name: manifest.name,
      capabilities: Object.keys(manifest.capabilities ?? {}),
      reason,
      apiVersion: manifest.apiVersion,
    });
    await discoverManagedPlugin(manager, {
      id: pluginId,
      name: manifest.name,
      builtin: isBuiltin,
      unsupportedReason: reason,
      activate: () => undefined,
    });
    return;
  }

  if (manifest.apiVersion === 1) {
    const requiredRange = manifest.engines?.walnut;
    const currentVersion = getVersion();
    const hostVersionKnown = isVersionKnown();
    let reason: string | undefined;
    if (!requiredRange) {
      reason = 'apiVersion 1 requires engines.walnut';
    } else if (!hostVersionKnown) {
      logUnknownHostVersionOnce();
      // An external plugin is refused (never load one against a host you can't
      // identify), but the message must not blame it: '0.0.0' fails every range, so
      // a Walnut bug would otherwise read as a plugin bug. A BUILT-IN ships inside
      // the host, so it can never be a genuine mismatch, and refusing it turns an
      // unknown version into a total outage (`local` gone means zero task sources).
      if (!isBuiltin) {
        reason = `Walnut could not determine its own version (this is a Walnut bug, not a problem with this plugin); this plugin requires Walnut ${requiredRange}`;
      }
    } else if (!satisfiesSemVer(currentVersion, requiredRange)) {
      reason = `Requires Walnut ${requiredRange}; current version is ${currentVersion}`;
    }
    if (reason) {
      unsupportedPlugins.push({
        id: pluginId,
        name: manifest.name,
        capabilities: Object.keys(manifest.capabilities ?? {}),
        reason,
        apiVersion: manifest.apiVersion,
      });
      await discoverManagedPlugin(manager, {
        id: pluginId,
        name: manifest.name,
        builtin: isBuiltin,
        unsupportedReason: reason,
        activate: () => undefined,
      });
      return;
    }
  }

  // Dependency gate. Before the enabled check so a single-plugin reload honours
  // dependencies too, and before any import so a plugin whose dependency is not running
  // never evaluates its module (same rule as `unsupported`). `local` is exempt twice
  // over — validateManifest drops its dependencies, and losing it would leave the
  // machine with no task source at all.
  if (!isLocal) {
    const missing = resolveMissingDependencies(manifest, dependencyGate(registry, manager), cycleMembers);
    if (missing.length > 0) {
      log.warn('Plugin not loaded — unmet dependencies', {
        id: pluginId,
        missing: missing.map(describeMissingDependency),
      });
      recordUnmetDependencies(pluginId, manifest.name, missing);
      await discoverManagedPlugin(manager, {
        id: pluginId,
        name: manifest.name,
        builtin: isBuiltin,
        missingDependencies: missing,
        activate: () => undefined,
      });
      return;
    }
  }

  // Check enabled flag from config (local plugin cannot be disabled)
  const configEntry = pluginConfigs[pluginId] ?? {};
  if (!isLocal && configEntry.enabled === false) {
    await discoverManagedPlugin(manager, {
      id: pluginId,
      name: manifest.name,
      builtin: isBuiltin,
      enabled: false,
      activate: () => undefined,
    });
    log.debug('Plugin disabled in config', { id: pluginId });
    return;
  }

  // Legacy manifests use capabilities as gates. apiVersion 1 is full-trust: the
  // block is descriptive only, and an empty block is a valid Server/Web Plugin.
  const unified = manifest.apiVersion === 1;
  const declaredCapabilities = manifest.capabilities
    ? Object.keys(manifest.capabilities)
    : unified ? [] : ['sync'];
  const effectiveCapabilities = unified
    ? declaredCapabilities
    : declaredCapabilities.filter(c => SUPPORTED_CAPABILITIES.has(c));
  if (!unified && effectiveCapabilities.length === 0) {
    log.warn('Plugin not loaded — requires capabilities this Walnut version does not support', {
      id: pluginId, capabilities: declaredCapabilities,
    });
    unsupportedPlugins.push({ id: pluginId, name: manifest.name, capabilities: declaredCapabilities });
    await discoverManagedPlugin(manager, {
      id: pluginId,
      name: manifest.name,
      builtin: isBuiltin,
      unsupportedReason: `Unsupported capabilities: ${declaredCapabilities.join(', ')}`,
      activate: () => undefined,
    });
    return;
  }
  // `sync` is what makes a plugin a TASK SOURCE — required only when declared
  // (or implied by an absent capabilities block).
  const expectsSync = !unified && effectiveCapabilities.includes('sync');

  // Validate config against configSchema
  const { enabled: _enabled, ...pluginConfig } = configEntry;

  // Skip plugin if required config fields are missing.
  // Record it as unconfigured so the Settings UI can show what to fill in,
  // and log per-field guidance from the manifest's uiHints.
  const requiredFields = (manifest.configSchema as any)?.required as string[] | undefined;
  if (requiredFields?.length) {
    const missing = requiredFields.filter(f => !(f in pluginConfig));
    if (missing.length > 0) {
      const fieldHints = missing.map(f => {
        const hint = manifest.uiHints?.[f];
        return hint?.help ? `${f} (${hint.help})` : f;
      });
      log.warn('Plugin not loaded — missing required config', {
        id: pluginId,
        missing,
        hint: `Set plugins.${pluginId}.{${missing.join(', ')}} in config.yaml or Settings → Integrations. ${fieldHints.join('; ')}`,
      });
      unconfiguredPlugins.push({
        id: pluginId,
        name: manifest.name,
        description: manifest.description,
        missing,
        configSchema: manifest.configSchema,
        uiHints: manifest.uiHints,
      });
      await discoverManagedPlugin(manager, {
        id: pluginId,
        name: manifest.name,
        builtin: isBuiltin,
        missingConfig: missing,
        activate: () => undefined,
      });
      return;
    }
  }

  if (manifest.configSchema && Object.keys(pluginConfig).length > 0) {
    const errors = validateConfigValue(pluginConfig, manifest.configSchema, `plugins.${pluginId}`);
    if (errors.length > 0) {
      log.warn('Plugin config validation errors', { id: pluginId, errors });
      // Continue anyway — log warning but don't block plugin load
    }
  }

  const lifecycle = await discoverManagedPlugin(manager, {
    id: pluginId,
    name: manifest.name,
    builtin: isBuiltin,
    activate: async (context) => {
  const generation = prepared ?? await prepareGeneration(pluginDir, isBuiltin, manifest, pluginConfig);
  const { activate: registerFn, deactivate: deactivateFn } = generation.module;
  const builder = createPluginApiBuilder(manifest, generation.config);

  try {
    if (registerFn) {
      const injectedApi = unified
        ? createServerPluginApi({
            context,
            pluginName: manifest.name,
            legacyApi: builder.api,
            contributions: builder.collected,
            integrationRegistry: registry,
            // The service seam: what this plugin declared decides which other plugins'
            // services it may ask for, and the manager answers why one is unavailable.
            dependencies: manifest.dependencies,
            lookupPluginState: (id) => manager.get(id)?.state,
          })
        : builder.api;
      if (deactivateFn) context.onDispose(deactivateFn);
      const activation = Promise.resolve()
        .then(() => registerFn!(injectedApi))
        .then((value) => {
          if (value && typeof value === 'object' && typeof (value as { dispose?: unknown }).dispose === 'function') {
            context.own(value as { dispose(): void | Promise<void> });
          }
          return value;
        });
      await withPluginCodeDeadline(context.trackActivation(activation), pluginId, 'activation');
      context.signal.throwIfAborted();
    }
  } catch (err) {
    log.error('Plugin registration threw an error', { id: pluginId, pluginId, error: String(err) });
    throw err;
  }

  // registerSync is required only of a SYNC plugin. A ui/tools/skills-only
  // plugin has nothing to sync, so demanding a 16-method no-op object from it
  // would be pure ceremony.
  if (expectsSync && !builder.collected.sync) {
    log.error('Plugin did not call registerSync()', { id: pluginId, capabilities: effectiveCapabilities });
    throw new Error(`Plugin "${pluginId}" did not call registerSync()`);
  }

  // TEST/EPHEMERAL ISOLATION — a throwaway server must never write to the
  // user's real provider account. The 2026-09-02 leak: a temp-home test server
  // copied the real config.yaml for its `hosts` block, so its ms-todo plugin held
  // live credentials, pushed a fixture task to the user's account, and created a
  // remote list there; production later pulled that list back and resurrected a
  // deleted project around it. Only SHIPPED integrations are gated (a test's own
  // fixture plugin, written into the temp home's plugins/ dir, is not the leak and
  // stays fully functional). Dropping `sync` makes the plugin not a task source
  // (hasSync false → never polled, never claimed), while its routes/UI still load.
  // An ephemeral server gates EVERY plugin: its plugins/ dir is a copy of the
  // user's real one (installed sync plugins and their settings included), so
  // "not shipped" no longer means "a test's own fixture".
  const isolationReason = builder.collected.sync && !isLocal && (isBuiltin || IS_EPHEMERAL)
    ? remoteSyncIsolationReason()
    : null;
  if (isolationReason) {
    log.warn('Plugin sync DISABLED — this server must not write to a real account', {
      id: pluginId,
      reason: isolationReason,
      hint: 'set WALNUT_ALLOW_REMOTE_SYNC_IN_TEST=1 to opt in deliberately',
    });
    builder.collected.sync = null;
    builder.collected.claim = null;
  }

  // A non-sync plugin still gets an inert sync stub so the many
  // `registry.get(source)!.sync.x()` call sites stay total; `hasSync: false` is
  // the signal that it must never be polled or offered as a task source.
  const initialHasSync = !!builder.collected.sync;
  if (!initialHasSync && builder.collected.claim) {
    // A source claim without sync would make the plugin selectable as a task
    // source and then silently drop every push. Refuse the claim, keep the plugin.
    log.warn('Plugin registered a source claim without the sync capability — claim ignored', {
      id: pluginId, capabilities: effectiveCapabilities,
    });
    builder.collected.claim = null;
  }

  // Capability-gated collections: a plugin must DECLARE what it contributes, so
  // the manifest stays an honest description of what the plugin does.
  const uiApp = unified
    ? manifest.webview
    : effectiveCapabilities.includes('ui')
      ? (manifest.capabilities?.ui as { app?: RegisteredUiApp } | undefined)?.app
      : undefined;

  let tools = builder.collected.tools;
  if (!unified && tools.length > 0 && !effectiveCapabilities.includes('tools')) {
    log.warn('Plugin called registerTool without declaring the "tools" capability — tools ignored', {
      id: pluginId, tools: tools.map(t => t.name),
    });
    tools = [];
  }

  const declaresSkills = unified || effectiveCapabilities.includes('skills');
  const hasSkills = declaresSkills
    && await fsp.stat(path.join(pluginDir, 'skills')).then(s => s.isDirectory()).catch(() => false);
  if (!unified && effectiveCapabilities.includes('skills') && !hasSkills) {
    log.warn('Plugin declares the "skills" capability but has no skills/ directory', { id: pluginId, dir: pluginDir });
  }

  // Build RegisteredPlugin and register. Singleton contributions stay live so
  // their Disposable handles detach immediately without requiring a full reload.
  const fallbackSync = inertSync();
  const registered: RegisteredPlugin = {
    id: manifest.id,
    name: manifest.name,
    description: manifest.description,
    version: manifest.version,
    apiVersion: manifest.apiVersion,
    serverEntry: manifest.server,
    webEntry: manifest.web,
    config: generation.config,
    get sync() { return builder.collected.sync ?? fallbackSync; },
    get hasSync() { return !!builder.collected.sync; },
    capabilities: effectiveCapabilities,
    get claim() { return builder.collected.claim ?? undefined; },
    get display() { return builder.collected.display ?? undefined; },
    get connection() { return builder.collected.connection ?? undefined; },
    get agentContext() { return builder.collected.agentContext ?? undefined; },
    migrations: builder.collected.migrations,
    httpRoutes: builder.collected.httpRoutes,
    get extIndex() { return builder.collected.extIndex ?? undefined; },
    configSchema: manifest.configSchema,
    uiHints: manifest.uiHints,
    taskFields: manifest.taskFields,
    tools: unified || effectiveCapabilities.includes('tools') ? tools : undefined,
    uiApp,
    pluginDir,
    hasSkills,
    // Live, not a snapshot: a plugin can register a skill dir after activate and
    // dispose it when its capability goes away. Distinct from hasSkills on purpose.
    get registeredSkills() { return listOwnedSkillDirRecords().some(r => r.owner === pluginId); },
  };

  context.signal.throwIfAborted();
  if (generation.web) retainPluginWebModule(registered, generation.web);
  else if (generation.webError) retainPluginWebModule(registered, new Error(generation.webError));
  if (isLocal) registry.replace(pluginId, registered);
  else {
    registry.register(pluginId, registered);
    context.onDispose(() => {
      if (registry.get(pluginId) === registered) registry.unregister(pluginId, 'unloaded');
    });
  }
  generations(registry).set(pluginId, generation);
  log.info('Plugin loaded', {
    id: pluginId,
    name: manifest.name,
    version: manifest.version ?? 'n/a',
    builtin: isBuiltin,
    capabilities: effectiveCapabilities,
    hasSync: initialHasSync,
    hasClaim: !!registered.claim,
    hasDisplay: !!registered.display,
    hasConnection: !!registered.connection,
    migrations: registered.migrations.length,
    httpRoutes: registered.httpRoutes.length,
    extIndexPaths: registered.extIndex?.paths.length ?? 0,
    tools: tools.map(t => t.name),
    uiApp: uiApp?.entry,
    hasSkills,
    registeredSkillDirs: listOwnedSkillDirRecords().filter(r => r.owner === pluginId).length,
  });
    },
  });

  if (lifecycle.state !== 'discovered') {
    if (lifecycle.state === 'quarantined') {
      // Error level on purpose: the log-error bridge turns this into a notification card
      // keyed `plugin:<id>`, which retires itself on the plugin's next successful sync. A
      // quarantined plugin used to log at info and stay dark for weeks.
      log.error('Plugin activation skipped: quarantined', {
        id: pluginId, pluginId, reason: lifecycle.reason, error: lifecycle.error,
      });
      return;
    }
    log.info('Plugin activation skipped', { id: pluginId, state: lifecycle.state, reason: lifecycle.reason });
    return;
  }
  try {
    await manager.activate(pluginId);
  } catch (error) {
    // pluginId is what gives the notification card its `plugin:<id>` lifecycle.
    log.error('Plugin activation failed', {
      id: pluginId, pluginId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}


// ── Main entry: load all plugins ──

async function loadPluginsUnlocked(registry: IntegrationRegistry, additive = false): Promise<void> {
  log.info('Loading plugins', { builtinDir: BUILTIN_DIR, externalDir: EXTERNAL_DIR, additive });
  const existingManager = pluginManagers.get(registry);
  const manager = additive && existingManager
    ? existingManager
    : await createPluginManager(registry);
  if (!additive) {
    pluginSources.set(registry, new Map());
    pluginManifests.set(registry, new Map());
    pluginGenerations.set(registry, new Map());
    pendingRecoveries.delete(registry);
    unconfiguredPlugins.length = 0;
    unsupportedPlugins.length = 0;
    resetUnmetDependencies();
    duplicatePluginIds.length = 0;
  } else if (!pluginSources.has(registry)) {
    pluginSources.set(registry, new Map());
  }

  // Read plugin configs from config.yaml
  const config = await getConfig();
  const pluginConfigs = config.plugins ?? {};

  // Discover plugin directories
  const pluginDirs = await discoverPluginDirs();
  log.debug('Discovered plugin dirs', { count: pluginDirs.length, dirs: pluginDirs.map(d => d.dir) });

  // Built-in plugins take precedence over external, and `local` must always come
  // first. That candidate order is the tie-break the dependency sort falls back on.
  const builtins = pluginDirs.filter(d => d.isBuiltin);
  const externals = pluginDirs.filter(d => !d.isBuiltin);
  const localIdx = builtins.findIndex(d => path.basename(d.dir) === 'local');
  if (localIdx < 0) log.error('Local plugin not found in built-in integrations directory', { dir: BUILTIN_DIR });
  const candidates = localIdx >= 0
    ? [builtins[localIdx], ...builtins.filter((_, index) => index !== localIdx), ...externals]
    : [...builtins, ...externals];

  // Pass 1: read every manifest, in candidate order. No plugin code is imported.
  const entries: PluginEntry[] = [];
  for (const candidate of candidates) {
    const entry = await readPluginEntry(candidate.dir, candidate.isBuiltin);
    if (entry) entries.push(entry);
  }

  // Pass 2: first-wins on duplicate ids (earlier candidate keeps the id), then order by
  // dependency. A plugin that declares nothing is edge-free, and the stable sort hands
  // those back in exactly the candidate order.
  const winners: PluginEntry[] = [];
  const claimedIds = new Map<string, PluginEntry>();
  for (const entry of entries) {
    if (claimedIds.has(entry.manifest.id)) {
      log.debug('Skipping duplicate plugin', { id: entry.manifest.id, dir: entry.dir });
      if (!duplicatePluginIds.includes(entry.manifest.id)) duplicatePluginIds.push(entry.manifest.id);
      continue;
    }
    claimedIds.set(entry.manifest.id, entry);
    winners.push(entry);
  }
  // The manifest map is filled BEFORE any load, so the first plugin in the walk can
  // already be told the version of a dependency that has not been reached yet — the
  // difference between "not installed" and "wrong version" is decided from the manifests,
  // never from load progress. First-wins here too: in an additive scan the copy already
  // running keeps the entry, matching the duplicate-id rule.
  const manifests = manifestMap(registry);
  for (const entry of winners) {
    if (!manifests.has(entry.manifest.id)) manifests.set(entry.manifest.id, entry.manifest);
  }

  const graph = buildDepGraph(winners.map((entry, index) => ({
    id: entry.manifest.id,
    index,
    deps: Object.keys(entry.manifest.dependencies ?? {}),
  })));
  const { order, residue } = topoSortStable(graph);
  // No order satisfies a cycle, so its members are loaded anyway and land as
  // `needs-dependency` rows: a plugin that silently disappeared from the list would be
  // the one failure nobody could diagnose.
  const cycleMembers = new Set(residue);
  if (residue.length > 0) log.warn('Plugin dependency cycle; members blocked as needs-dependency', { ids: residue });

  // Pass 3: load in sorted order, reusing the manifest read in pass 1.
  for (const id of [...order, ...residue]) {
    const entry = claimedIds.get(id);
    if (!entry) continue;
    await loadPlugin(
      entry.dir, entry.isBuiltin, pluginConfigs, registry, manager, additive, entry.manifest, cycleMembers,
    );
  }

  // An additive load is how a newly INSTALLED dependency arrives, and the plugin that
  // was waiting for it is already discovered, so pass 3 skips it as a duplicate. One
  // bounded restore pass per plugin is what keeps "install the missing dependency" from
  // needing a restart to take effect — and it also rewrites the reason on a dependent
  // that is still blocked, so a wrong-version install stops claiming "not installed".
  // A non-additive load rebuilds every record from scratch and needs none of this.
  if (additive) {
    const gate = dependencyGate(registry, manager);
    const restore = restoreOptions(registry, manager, pluginConfigs);
    let restored = 0;
    for (const id of order) restored += await retryUnmetDependents(gate, id, restore);
    if (restored > 0) log.info('Dependents restored after additive load', { restored });
  }

  const loaded = registry.getAll();

  // Collect ext-index specs from registered plugins, publish them to the
  // shared registry, and open the corresponding SQLite indexes. Idempotent
  // (CREATE INDEX IF NOT EXISTS).
  const specs: ExtIndexSpec[] = [];
  for (const p of loaded) {
    if (p.extIndex) specs.push(p.extIndex);
  }
  setExtIndexes(specs);
  if (specs.length > 0) {
    try {
      ensureExtIndexes(specs);
    } catch (err) {
      log.error('failed to open plugin ext-indexes', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Plugin skills are a discovery SOURCE for the skills index (see
  // skill-loader.getPluginSkillDirs). The index is cached, so a load that
  // brought a `skills/` dir in — or dropped one — has to invalidate it, or a
  // freshly installed plugin's skills stay invisible until a restart.
  // Unconditional: the source LIST changes with the plugin set, not just with
  // whether any plugin currently has skills.
  try {
    const { clearSkillsCache } = await import('./skill-loader.js');
    clearSkillsCache();
  } catch (err) {
    log.debug('could not clear the skills cache after plugin load', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  log.info('Plugin loading complete', {
    total: loaded.length,
    ids: loaded.map(p => p.id),
    extIndexes: specs.length,
    tools: loaded.flatMap(p => p.tools?.map(t => t.name) ?? []),
    apps: loaded.filter(p => p.uiApp).map(p => p.id),
    skillDirs: loaded.filter(p => p.hasSkills).map(p => p.id),
    registeredSkillDirs: [...new Set(listOwnedSkillDirRecords().map(r => r.owner))],
  });
}

export function loadPlugins(registry: IntegrationRegistry): Promise<void> {
  return runPluginOperation(registry, () => loadPluginsUnlocked(registry));
}

/** Discover and activate only Plugins not already owned by this registry. */
export function loadNewPlugins(registry: IntegrationRegistry): Promise<void> {
  return runPluginOperation(registry, () => loadPluginsUnlocked(registry, true));
}

// ── Deep-capability accessors (tools / apps / skill dirs) ──
// Read the registry LIVE on every call so the plugin-store soft reload is picked
// up without a restart — nothing here is cached.

/** Plugins with a validated ui app, in registration order. */
export function getPluginApps(registry: IntegrationRegistry): Array<{
  id: string; pluginId: string; title: string; entry: string; icon?: string; pluginDir: string;
}> {
  const out: Array<{ id: string; pluginId: string; title: string; entry: string; icon?: string; pluginDir: string }> = [];
  for (const p of registry.getAll()) {
    if (!p.uiApp || !p.pluginDir) continue;
    out.push({
      // One app per plugin in v1, so the plugin id IS the app id. Keeping them
      // separate fields leaves room for `<pluginId>/<appKey>` later without
      // changing the route shape.
      id: p.id,
      pluginId: p.id,
      title: p.uiApp.title,
      entry: p.uiApp.entry,
      icon: p.uiApp.icon,
      pluginDir: p.pluginDir,
    });
  }
  return out;
}

/** Every loaded plugin's contributed Personal AI tools, flattened.
 *  (Plugin skill dirs are read straight off the registry by
 *  skill-loader.getPluginSkillDirs — this module is too heavy to import there.) */
export function getPluginToolSpecs(registry: IntegrationRegistry): PluginToolSpec[] {
  return registry.getAll().flatMap(p => p.tools ?? []);
}

// ── Config migration: move top-level legacy integration keys to plugins.* ──

/**
 * Legacy top-level integration keys to move even when no plugin by that name is
 * installed — i.e. config left behind by an integration that has since been
 * uninstalled. Supplements the primary test (an actual plugin directory exists;
 * see `migrateConfigToPlugins`), it does not replace it: a privately-installed
 * plugin can't be named in this public repo, so the on-disk evidence has to be
 * what drives the decision.
 *
 * ⚠️ NEVER go back to matching "everything not in a known-config-keys list".
 * That inverted the open and closed sets: config sections grow with the product,
 * legacy integration keys never do. Every new top-level section (`ui`, `audio`,
 * `developer`, …) was then one forgotten allowlist edit away from being silently
 * swept into plugins.* on the next boot — where its real reader
 * (`config.ui.session_panels`) no longer finds it, so the feature quietly
 * reverted to defaults with nothing in the logs. It bit twice: `providers` (left
 * the Personal AI unable to authenticate) and `ui` (session_panels kept resetting).
 */
const LEGACY_INTEGRATION_KEYS = new Set([
  'ms_todo',
  'apple_reminders',
  'google_calendar',
]);

/** Plugin ids with a real plugin dir on disk (manifest.json), as `key` would spell them. */
async function getInstalledPluginIds(): Promise<Set<string>> {
  try {
    const dirs = await discoverPluginDirs();
    return new Set(dirs.map(d => path.basename(d.dir)));
  } catch (err) {
    // Can't enumerate — fall back to the legacy list alone. Migrating nothing is
    // safe (the key stays readable at the top level); a wrong move is not.
    log.debug('config migration: plugin discovery failed, using legacy key list only', {
      error: err instanceof Error ? err.message : String(err),
    });
    return new Set();
  }
}

/**
 * First-class config sections the OLD inverted allowlist swept into plugins.*
 * on some machine, somewhere. Listed here so an affected config repairs itself
 * on the next boot instead of needing a hand-edit. Append a name here if another
 * section turns up under `plugins.` — that is now a strictly historical event,
 * since the sweep above can no longer reach a non-legacy key.
 */
const MIS_MIGRATED_CONFIG_KEYS = ['providers', 'ui', 'audio', 'developer'] as const;

/**
 * Sections the generic MOVE loop below must not touch.
 *
 * `calendar` is here even though the calendar IS a plugin, because its config is COPIED
 * rather than moved for one release (see the copy block inside migrateConfigToPlugins): a
 * rollback to a Walnut whose calendar still read the top-level key has to find it there.
 * Drop the entry, the copy block and the plugin's legacy fallback together.
 */
const COPIED_NOT_MOVED_CONFIG_KEYS = new Set(['calendar']);

/**
 * One-time migration: move legacy top-level integration config keys
 * into the new plugins.{id} section.
 *
 * A key is migrated only on POSITIVE evidence that it configures a plugin:
 * either a plugin directory of that name exists on disk (manifest.json), or it
 * is a known-legacy name whose plugin is no longer installed. An unrecognised
 * section is left alone — see LEGACY_INTEGRATION_KEYS for why the old
 * "everything unknown is a plugin" rule was the bug, not the feature.
 *
 * Converts underscores to hyphens for the plugin ID. Reads raw config.yaml,
 * moves what qualifies, writes back. Safe to call repeatedly — no-ops once done.
 */
export async function migrateConfigToPlugins(): Promise<boolean> {
  let raw: Record<string, unknown>;
  try {
    const content = await fsp.readFile(CONFIG_FILE, 'utf-8');
    raw = (yaml.load(content) as Record<string, unknown>) ?? {};
  } catch (err) {
    log.debug('config file not readable for migration', {
      error: err instanceof Error ? err.message : String(err),
    });
    return false; // No config file — nothing to migrate
  }

  let changed = false;
  const plugins = (raw.plugins ?? {}) as Record<string, Record<string, unknown>>;

  // Self-heal the damage the old inverted allowlist did (see
  // LEGACY_INTEGRATION_KEYS): first-class config sections that were swept into
  // plugins.* get moved back to the top level, dropping the `enabled` flag the
  // migration injected. Reversing the sweep is not optional — the readers look
  // at the top level only, so until the key moves back the feature stays
  // silently broken (`providers` → Personal AI could not authenticate; `ui` →
  // session_panels reset to its default on every boot).
  //
  // Only reverses keys that no longer exist at the top level, so a real plugin
  // that happens to share a name with a config section is never clobbered.
  for (const key of MIS_MIGRATED_CONFIG_KEYS) {
    if (!plugins[key] || raw[key] != null) continue;
    const { enabled: _enabled, ...entries } = plugins[key];
    raw[key] = entries;
    delete plugins[key];
    log.info(`config migration: restored plugins.${key} → top-level ${key}`);
    changed = true;
  }

  const installedPluginIds = await getInstalledPluginIds();

  for (const [key, val] of Object.entries(raw)) {
    // `plugins` is the destination, not a candidate: a plugin dir literally named
    // "plugins" would otherwise fold the whole section into itself.
    if (key === 'plugins' || COPIED_NOT_MOVED_CONFIG_KEYS.has(key)) continue;
    const pluginId = key.replace(/_/g, '-'); // ms_todo → ms-todo
    // Positive evidence only: a plugin dir of that name exists, or the plugin is
    // gone but the key is known-legacy. Everything else is a config section.
    if (!installedPluginIds.has(pluginId) && !LEGACY_INTEGRATION_KEYS.has(key)) continue;
    if (typeof val === 'object' && val !== null) {
      if (!plugins[pluginId]) {
        plugins[pluginId] = { enabled: true, ...(val as Record<string, unknown>) };
        log.info(`config migration: moved ${key} → plugins.${pluginId}`);
        changed = true;
      }
      delete raw[key];
      changed = true;
    }
  }

  // One-time COPY of the legacy top-level `calendar` section into the calendar plugin's own
  // namespace. A copy, not a move (which is why the key is in
  // COPIED_NOT_MOVED_CONFIG_KEYS): for one release, rolling back to a Walnut whose
  // CalendarService read `config.calendar` still has to work.
  //
  // The source toggle is RENAMED on the way in. `plugins.<id>.enabled` is the plugin
  // lifecycle switch the store writes, so copying the calendar's own on/off flag straight
  // across would turn the whole plugin off and take its routes with it — including the
  // route the Settings toggle would need to turn it back on.
  //
  // Delete this block, the entry above, the top-level `calendar` key (`Config.calendar` in
  // src/core/types.ts) and the plugin's mergeCalendarConfig fallback
  // (src/integrations/calendar/service.ts) together once 0.4.6 has shipped.
  const legacyCalendar = raw.calendar;
  if (!plugins.calendar && legacyCalendar && typeof legacyCalendar === 'object' && !Array.isArray(legacyCalendar)) {
    const { enabled, ...rest } = legacyCalendar as Record<string, unknown>;
    plugins.calendar = {
      ...rest,
      ...(enabled !== undefined ? { source_enabled: !!enabled } : {}),
    };
    log.info('config migration: copied calendar → plugins.calendar (top-level key kept for one release)');
    changed = true;
  }

  if (changed) {
    raw.plugins = plugins;
    let content = yaml.dump(raw, { indent: 2, lineWidth: 120 });
    // Preserve the available_models comment (same as config-manager.ts)
    content = content.replace(
      /^(\s+)available_models:/m,
      '$1# Predefined Bedrock model IDs for the agent form dropdown.\n$1# Edit this list to add or remove models.\n$1available_models:',
    );
    await fsp.writeFile(CONFIG_FILE, content, 'utf-8');
    log.info('config migration complete: legacy integration keys moved to plugins section');
  }

  return changed;
}

// ── Plugin task data migrations ──

/**
 * Run all registered plugin migrations against the task store.
 * Called once after plugins are loaded. Each plugin's MigrateFn receives
 * the full task array and returns the (possibly mutated) array.
 * Writes back to disk only if any migration modified the data.
 */
export async function runPluginMigrations(registry: IntegrationRegistry): Promise<void> {
  const plugins = registry.getAll();
  const migrationsToRun = plugins.flatMap(p =>
    p.migrations.map(fn => ({ pluginId: p.id, fn }))
  );

  if (migrationsToRun.length === 0) {
    log.debug('No plugin migrations to run');
    return;
  }

  let finalTasks: readonly unknown[] = [];
  const changed = await bulkMigrateTasks(async (tasks) => {
    let next = tasks;
    for (const { pluginId, fn } of migrationsToRun) {
      try {
        next = await fn(next);
      } catch (err) {
        log.error('Plugin migration failed', {
          pluginId,
          error: err instanceof Error ? err.message : String(err),
        });
        // Continue with other migrations — don't block on one failure
      }
    }
    finalTasks = next;
    return next;
  });

  if (changed) {
    const extCounts: Record<string, number> = {};
    for (const t of finalTasks as { ext?: Record<string, unknown> }[]) {
      if (t.ext) {
        for (const key of Object.keys(t.ext)) {
          extCounts[key] = (extCounts[key] ?? 0) + 1;
        }
      }
    }
    log.info('Plugin migrations applied and saved', {
      plugins: migrationsToRun.map(m => m.pluginId),
      totalTasks: finalTasks.length,
      extCounts,
    });
  } else {
    log.debug('Plugin migrations ran but no changes detected');
  }
}
