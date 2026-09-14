/**
 * /api/plugin-sources — manage plugin sources (the "plugin store").
 *
 * GET    /                 list sources with discovered plugins + per-plugin status
 * POST   /                 {url, ref?} | share snippet | {spec} — install a new
 *                          source (git clone or npm package) and soft-reload plugins
 * POST   /:slug/dependencies  install what the source's plugins are still waiting for,
 *                          after the user has seen the list (two-phase consent)
 * POST   /:slug/update     git pull / npm re-resolve+reinstall; reports restartRequired
 * POST   /:slug/check      is anything newer available (git commits behind / npm version)
 * DELETE /:slug            remove source, delete the installed tree
 *
 * The router is a factory: the server passes a softReload callback that
 * re-runs plugin loading additively (new plugins only — already-loaded ids
 * keep their in-memory code until restart).
 *
 * Installing a source installs THAT source and nothing else. When the soft reload leaves
 * one of its plugins waiting on another plugin, the 201 says so (`pendingDependencies`)
 * and stops there; the /dependencies route is the second half, and the consent it needs
 * is the list the store showed, which is why it names every source it would add.
 */

import { Router } from 'express';
import { WALNUT_HOME } from '../../constants.js';
import { registry } from '../../core/integration-registry.js';
import {
  addSource, addNpmSource, updateSource, checkSource, removeSource, listSources,
  isValidSlug, parseShareSnippet, isValidSourceUrl,
  type PluginSourceView,
} from '../../core/plugin-sources.js';
import { isValidNpmSpec } from '../../core/plugin-npm-install.js';
import {
  loadPluginCatalog, planPluginDependencies,
  type InstalledPluginFacts, type PluginCatalogEntry, type PluginDependencyPlanItem,
} from '../../core/plugins/plugin-catalog.js';
import {
  getUnconfiguredPlugins, getUnsupportedPlugins, getDuplicatePluginIds, getUnmetDependencyPlugins,
  getPluginLifecycleRecords,
} from '../../core/integration-loader.js';
import type { UpdateStatusCache } from '../../core/plugins/update-status-cache.js';
import {
  ROW_CHECK_DEADLINE_MS, ROW_TIMEOUT_REASON, describeGitFailure, fetchEnv, maskCredentials, sourceRowKey, withDeadline,
} from '../../core/plugins/update-status.js';
import { isRestartPending, markRestartPending } from '../../core/plugins/restart-pending.js';
import { createSubsystemLogger } from '../../logging/index.js';
import { markHandledFailure } from '../middleware/handled-failure.js';

const log = createSubsystemLogger('plugin-sources');

/** An update that outlives this many ms answers 504; git or npm may still finish on its own. */
export const SOURCE_UPDATE_DEADLINE_MS = 60_000;
export const SOURCE_UPDATE_TIMEOUT_MESSAGE = 'Update timed out after 60 s. The checkout was not changed unless git finished on its own; check again.';

/** A dependency's own dependencies are followed through the catalog, never deeper: past
 *  three hops an "install this one plugin" click stops being something a user agreed to. */
const MAX_DEPENDENCY_DEPTH = 3;

export interface InstalledDependencyResult {
  id: string;
  /** `installed`: a source was added. `turned-on`: it was already here and now runs.
   *  `already-added`: the source that carries it went in for an earlier id in this same
   *  batch, so it is satisfied without a second clone. */
  action: 'installed' | 'turned-on' | 'already-added';
  kind?: 'git' | 'npm';
  slug?: string;
  url?: string;
  spec?: string;
}

export interface SkippedDependencyResult {
  id: string;
  /** example: only `walnut-plugin link` can install it. unresolvable: nothing offers it.
   *  depth: past MAX_DEPENDENCY_DEPTH. unavailable: this build cannot turn plugins on.
   *  not-active: the turn-on ran and the plugin did not come up. */
  reason: 'example' | 'unresolvable' | 'depth' | 'error' | 'unavailable' | 'not-active';
  /** The command to run by hand, for an example source. */
  command?: string;
  /** Where a turn-on actually landed, so a notice never claims one that did not happen. */
  state?: string;
  error?: string;
}

export interface PluginSourcesRouterDeps {
  /** Turn a plugin that is already on this machine back on. The server passes the same
   *  closure the plugin-runtime router uses, so a dependency comes up through exactly
   *  the path a manual switch takes (config write, loader lane, dependent restore).
   *  The lifecycle record it returns is CHECKED: activation can be refused. */
  reloadPlugin?(pluginId: string): Promise<{ state?: string } | undefined>;
  /** Overridable so a test can point the catalog overlay at a temp home. */
  walnutHome?: string;
  /** The update-status cache check/update write into (shared with /api/plugin-updates). */
  cache?: UpdateStatusCache;
  /** Override for the 60 s update deadline (tests only). */
  updateDeadlineMs?: number;
}

export type PluginStatus = 'loaded' | 'needs-config' | 'needs-dependency' | 'unsupported' | 'duplicate' | 'error' | 'pending-restart';

/**
 * A LOADED plugin is 'loaded' whatever its capability mix — the registry check
 * comes first on purpose. `unsupported` is now reserved for a plugin whose
 * manifest declares NO capability this version implements (only `hooks` /
 * `routines`), which is the only case the loader records there; a plugin that is
 * ui-, tools- or skills-only loads normally and must never be labelled as
 * needing a newer Walnut.
 *
 * `needs-dependency` is checked ahead of `unsupported` because the two can both be
 * true of one row: a plugin held back by a missing dependency was never imported, so
 * "needs a newer Walnut" would be a guess, while the dependency is a fact.
 */
function statusFor(pluginId: string | null, error?: string): PluginStatus {
  if (error || !pluginId) return 'error';
  // Updated on disk while loaded: the running code is the OLD one until a restart.
  if (isRestartPending(pluginId)) return 'pending-restart';
  if (registry.has(pluginId)) return 'loaded';
  if (getUnconfiguredPlugins().some(p => p.id === pluginId)) return 'needs-config';
  if (getUnmetDependencyPlugins().some(p => p.id === pluginId)) return 'needs-dependency';
  if (getUnsupportedPlugins().some(p => p.id === pluginId)) return 'unsupported';
  if (getDuplicatePluginIds().includes(pluginId)) return 'duplicate';
  // Discovered on disk but absent from every loader outcome — code changed
  // since the last (re)load, so only a restart will pick it up.
  return 'pending-restart';
}

/** What a loaded plugin actually contributes — so the store can say "app + 2 tools"
 *  instead of leaving a non-sync plugin looking like it does nothing. */
function capabilitiesFor(pluginId: string | null): string[] | undefined {
  if (!pluginId) return undefined;
  const plugin = registry.get(pluginId);
  if (!plugin) {
    return getUnsupportedPlugins().find(p => p.id === pluginId)?.capabilities;
  }
  return plugin.capabilities ?? ['sync'];
}

function withStatuses(view: PluginSourceView) {
  return {
    ...view,
    plugins: view.plugins.map(p => ({
      ...p,
      status: statusFor(p.id, p.error),
      capabilities: capabilitiesFor(p.id),
    })),
  };
}

/** What the dependency planner needs to know about this machine. A plugin that is
 *  installed but off still counts as installed, which is what makes "turn it on" a
 *  different answer from "install it". */
function installedFacts(): InstalledPluginFacts[] {
  return getPluginLifecycleRecords(registry).map((record) => ({
    id: record.id,
    name: record.name,
    state: record.state,
    builtin: record.builtin,
  }));
}

/**
 * What the plugins of ONE source are still waiting for, planned against the catalog.
 *
 * Read from the loader's live unmet list rather than from anything the client sent: the
 * consent is for a list the SERVER computed, so a request can never widen it.
 */
function pendingDependenciesFor(
  view: PluginSourceView,
  catalog: readonly PluginCatalogEntry[],
): PluginDependencyPlanItem[] {
  const ids = new Set(view.plugins.map((plugin) => plugin.id).filter((id): id is string => !!id));
  const needs = getUnmetDependencyPlugins()
    .filter((plugin) => ids.has(plugin.id))
    .flatMap((plugin) => plugin.missing.map((missing) => ({
      id: missing.id,
      range: missing.range,
      reason: missing.reason,
    })));
  return planPluginDependencies(needs, catalog, installedFacts());
}

/**
 * The plan for what a catalog entry itself declares, one hop further out. Anything
 * already running is not a hop: it is done.
 *
 * Reads live lifecycle state on every call rather than a snapshot taken before the walk:
 * a turn-on earlier in the same batch really did change what is running, and planning the
 * next hop against a stale picture is how a plugin gets turned on twice.
 */
function nextHopFor(
  pluginId: string,
  catalog: readonly PluginCatalogEntry[],
): PluginDependencyPlanItem[] {
  const requires = catalog.find((entry) => entry.id === pluginId)?.requires;
  if (!requires) return [];
  const facts = installedFacts();
  const running = new Set(facts
    .filter((plugin) => plugin.state === 'active' || plugin.state === 'activating')
    .map((plugin) => plugin.id));
  return planPluginDependencies(
    Object.entries(requires).filter(([id]) => !running.has(id)).map(([id, range]) => ({ id, range })),
    catalog,
    facts,
  );
}

export function createPluginSourcesRouter(
  softReload: () => Promise<void>,
  deps: PluginSourcesRouterDeps = {},
): Router {
  const router = Router();
  const catalogHome = deps.walnutHome ?? WALNUT_HOME;

  router.get('/', async (_req, res) => {
    try {
      const sources = await listSources();
      res.json(sources.map(withStatuses));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/', async (req, res) => {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
      ? req.body as Record<string, unknown>
      : {};
    const { url, ref, spec } = body;
    // Accepted forms: {url: "<git url>"}, {url: "<share snippet string>"},
    // the share snippet itself as the request body ({"walnut_plugin_source": ...})
    // — agents and humans naturally POST the snippet verbatim — or {spec: "<npm
    // package>"}. A bare {url} that is neither a git URL nor a snippet but IS a
    // valid registry spec is treated as npm, so one input box serves both.
    const bodySnippet = Object.hasOwn(body, 'walnut_plugin_source')
      ? parseShareSnippet(JSON.stringify(body))
      : null;
    const hasSpec = typeof spec === 'string' && spec.trim().length > 0;
    const hasUrl = typeof url === 'string' && url.trim().length > 0;
    if (hasSpec && (bodySnippet || hasUrl || (typeof ref === 'string' && ref.trim()))) {
      res.status(400).json({ error: 'provide exactly one source form: url/share snippet or spec' });
      return;
    }
    if (!bodySnippet && !hasSpec && !hasUrl) {
      res.status(400).json({ error: 'url or spec is required (a git URL, an npm package spec, or a walnut_plugin_source share snippet)' });
      return;
    }

    const snippet = bodySnippet ?? (hasSpec ? null : parseShareSnippet(typeof url === 'string' ? url : ''));
    const effectiveUrl = snippet ? snippet.url : (typeof url === 'string' ? url.trim() : '');
    const effectiveRef = snippet?.ref ?? (typeof ref === 'string' && ref.trim() ? ref.trim() : undefined);

    // npm when asked explicitly, or when a bare {url} is not a git URL / snippet
    // but IS a valid registry spec — one input box serves both kinds.
    const install = hasSpec
      ? () => addNpmSource((spec as string).trim())
      : (!snippet && !isValidSourceUrl(effectiveUrl) && isValidNpmSpec(effectiveUrl))
        ? () => addNpmSource(effectiveUrl)
        : () => addSource(effectiveUrl, effectiveRef);

    try {
      const view = await install();
      // Load the new plugins without a restart (additive — existing ids untouched)
      try {
        await softReload();
      } catch (err) {
        log.warn('soft reload after add failed', { error: String(err) });
      }
      const refreshed = (await listSources()).find(s => s.slug === view.slug) ?? view;
      // Nothing else was installed. If a plugin from this source is waiting on another
      // plugin, the answer names what would fix it and waits for a second, explicit yes.
      let pendingDependencies: PluginDependencyPlanItem[] = [];
      try {
        pendingDependencies = pendingDependenciesFor(refreshed, await loadPluginCatalog(catalogHome));
      } catch (err) {
        log.warn('dependency plan after add failed', { error: String(err) });
      }
      res.status(201).json({
        ...withStatuses(refreshed),
        ...(pendingDependencies.length ? { pendingDependencies } : {}),
      });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * POST /:slug/dependencies — install what this source's plugins are still waiting for.
   *
   * The plan is recomputed here from the loader's live state, so the request carries no
   * list and cannot widen one. Each catalog entry goes in through the same installer the
   * store's own Add uses; an `example` entry is never installed, because only a hand-run
   * `walnut-plugin link` can, and it comes back with that command instead of a button
   * that could not work.
   */
  router.post('/:slug/dependencies', async (req, res) => {
    const { slug } = req.params;
    if (!isValidSlug(slug)) {
      res.status(400).json({ error: 'invalid slug' });
      return;
    }
    try {
      const source = (await listSources()).find(s => s.slug === slug);
      if (!source) {
        res.status(404).json({ error: 'source not found' });
        return;
      }
      const catalog = await loadPluginCatalog(catalogHome);
      const queue = pendingDependenciesFor(source, catalog).map((item) => ({ item, depth: 1 }));
      const seen = new Set(queue.map((entry) => entry.item.id));
      const installed: InstalledDependencyResult[] = [];
      const skipped: SkippedDependencyResult[] = [];
      // One repo can carry several plugins, so two unmet ids often name the SAME source.
      // Tracking what is already there (before this call, and after each add) turns the
      // second one into "satisfied by that source" instead of a duplicate-add error.
      const providedBy = new Map<string, string>();
      for (const existing of await listSources()) {
        const key = existing.url ?? existing.spec;
        if (key) providedBy.set(key, existing.slug);
      }

      while (queue.length > 0) {
        const { item, depth } = queue.shift()!;
        const sourceKey = item.source?.kind === 'npm' ? item.source.spec : item.source?.url;
        const alreadyFrom = sourceKey ? providedBy.get(sourceKey) : undefined;
        let added = false;
        try {
          if (item.resolvable === 'catalog' && sourceKey && alreadyFrom) {
            installed.push({
              id: item.id,
              action: 'already-added',
              kind: item.source!.kind === 'npm' ? 'npm' : 'git',
              slug: alreadyFrom,
              ...(item.source!.kind === 'npm' ? { spec: sourceKey } : { url: sourceKey }),
            });
            added = true;
          } else if (item.resolvable === 'catalog' && item.source?.kind === 'git' && item.source.url) {
            const view = await addSource(item.source.url, item.source.ref);
            providedBy.set(item.source.url, view.slug);
            installed.push({ id: item.id, action: 'installed', kind: 'git', slug: view.slug, url: item.source.url });
            added = true;
          } else if (item.resolvable === 'catalog' && item.source?.kind === 'npm' && item.source.spec) {
            const view = await addNpmSource(item.source.spec);
            providedBy.set(item.source.spec, view.slug);
            installed.push({ id: item.id, action: 'installed', kind: 'npm', slug: view.slug, spec: item.source.spec });
            added = true;
          } else if (item.resolvable === 'catalog' && item.source?.kind === 'example') {
            skipped.push({
              id: item.id,
              reason: 'example',
              command: `walnut-plugin link ${item.source.path ?? item.id}`,
            });
          } else if (item.resolvable === 'installed') {
            if (!deps.reloadPlugin) skipped.push({ id: item.id, reason: 'unavailable' });
            else {
              // Believe the record, not the call: activation can be refused (missing
              // config, an unsupported build, a quarantine), and reporting a turn-on
              // that did not happen is how a notice ends up lying to the user.
              const record = await deps.reloadPlugin(item.id);
              const state = record?.state;
              if (state && state !== 'active' && state !== 'activating') {
                skipped.push({ id: item.id, reason: 'not-active', state });
              } else {
                installed.push({ id: item.id, action: 'turned-on' });
                added = true;
              }
            }
          } else {
            skipped.push({ id: item.id, reason: 'unresolvable' });
          }
        } catch (err) {
          skipped.push({ id: item.id, reason: 'error', error: err instanceof Error ? err.message : String(err) });
        }
        if (!added) continue;
        const nextHop = nextHopFor(item.id, catalog).filter((next) => !seen.has(next.id));
        for (const next of nextHop) {
          seen.add(next.id);
          if (depth >= MAX_DEPENDENCY_DEPTH) skipped.push({ id: next.id, reason: 'depth' });
          else queue.push({ item: next, depth: depth + 1 });
        }
      }

      // One reload for the whole batch: the additive load path brings the dependents that
      // were waiting back up on its own, so a per-install reload would only cost time.
      if (installed.length > 0) {
        try {
          await softReload();
        } catch (err) {
          log.warn('soft reload after dependency install failed', { error: String(err) });
        }
      }
      const refreshed = (await listSources()).find(s => s.slug === slug) ?? source;
      res.json({ installed, skipped, plugins: withStatuses(refreshed) });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/:slug/update', async (req, res) => {
    const { slug } = req.params;
    if (!isValidSlug(slug)) {
      res.status(400).json({ error: 'invalid slug' });
      return;
    }
    try {
      const sources = await listSources();
      const source = sources.find(s => s.slug === slug);
      if (!source) {
        res.status(404).json({ error: 'source not found' });
        return;
      }
      // Ids loaded from this source BEFORE the pull — if the pull changed their
      // code, the in-memory version is now stale and only a restart refreshes it.
      const loadedBefore = source.plugins.filter(p => p.id && registry.has(p.id)).map(p => p.id);
      const rowKey = sourceRowKey(slug);
      const cache = deps.cache;
      cache?.setBusy(rowKey, true);
      const TIMED_OUT = Symbol('timeout');
      let result: Awaited<ReturnType<typeof updateSource>>;
      try {
        const outcome = await withDeadline<typeof result | typeof TIMED_OUT>(updateSource(slug), deps.updateDeadlineMs ?? SOURCE_UPDATE_DEADLINE_MS, () => TIMED_OUT);
        if (outcome === TIMED_OUT) {
          // The row reports this itself; no incident card for a slow remote (N3-1).
          markHandledFailure(res).status(504).json({ error: SOURCE_UPDATE_TIMEOUT_MESSAGE });
          return;
        }
        result = outcome;
      } finally {
        cache?.setBusy(rowKey, false);
      }
      if (result.error) {
        // One scrubbed sentence for the row (no path, no host, no `fatal:`), the cause for
        // the client's copy, and the raw masked text for the Details disclosure.
        const raw = maskCredentials(result.error);
        const { cause, sentence } = describeGitFailure(raw);
        // Expected and already reported on the row: honest 502, but no red card (N3-1).
        markHandledFailure(res).status(502).json({ ...result, error: sentence, cause, detail: raw, restartRequired: false });
        return;
      }
      // The row is current at what landed: a git sha, an npm `name@version`, or (a pull
      // that found nothing new) whatever the source already recorded.
      const row = cache?.recordUpdated(rowKey, result.toSha ?? result.resolved ?? source.lastSha ?? source.resolved ?? '');
      if (result.updated) {
        try {
          await softReload();
        } catch (err) {
          log.warn('soft reload after update failed', { error: String(err) });
        }
      }
      const restartRequired = result.updated && loadedBefore.length > 0;
      // The row badge says RESTART TO ACTIVATE from here on (registry + sources list), so the
      // feedback line is not the only place that says it.
      if (restartRequired) markRestartPending(loadedBefore.filter((id): id is string => !!id));
      res.json({ ...result, restartRequired, ...(row ? { state: row.state, checkedAt: row.checkedAt } : {}) });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/:slug/check', async (req, res) => {
    const { slug } = req.params;
    if (!isValidSlug(slug)) {
      res.status(400).json({ error: 'invalid slug' });
      return;
    }
    try {
      const sources = await listSources();
      const source = sources.find((candidate) => candidate.slug === slug);
      if (!source) {
        res.status(404).json({ error: 'source not found' });
        return;
      }
      // Unattended fetch env (no prompt, no askpass window, ssh batch mode), bounded: past
      // the row deadline the answer is an error result, never a hung request.
      const result = await withDeadline(
        checkSource(slug, { env: fetchEnv() }),
        ROW_CHECK_DEADLINE_MS,
        () => ({ behind: 0, updateAvailable: false, error: ROW_TIMEOUT_REASON, detail: ROW_TIMEOUT_REASON }),
      );
      const row = deps.cache?.recordCheck(sourceRowKey(slug), { kind: source.kind === 'npm' ? 'npm' : 'git', result, cloned: source.cloned });
      res.json({ ...result, ...(row ? { state: row.state, checkedAt: row.checkedAt } : {}) });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.delete('/:slug', async (req, res) => {
    const { slug } = req.params;
    if (!isValidSlug(slug)) {
      res.status(400).json({ error: 'invalid slug' });
      return;
    }
    try {
      const sources = await listSources();
      const source = sources.find(s => s.slug === slug);
      if (!source) {
        res.status(404).json({ error: 'source not found' });
        return;
      }
      const hadLoaded = source.plugins.some(p => p.id && registry.has(p.id));
      await removeSource(slug);
      res.json({ removed: true, restartRequired: hadLoaded });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
