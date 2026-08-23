/**
 * /api/plugin-sources — manage plugin sources (the "plugin store").
 *
 * GET    /                 list sources with discovered plugins + per-plugin status
 * POST   /                 {url, ref?} | share snippet | {spec} — install a new
 *                          source (git clone or npm package) and soft-reload plugins
 * POST   /:slug/update     git pull / npm re-resolve+reinstall; reports restartRequired
 * POST   /:slug/check      is anything newer available (git commits behind / npm version)
 * DELETE /:slug            remove source, delete the installed tree
 *
 * The router is a factory: the server passes a softReload callback that
 * re-runs plugin loading additively (new plugins only — already-loaded ids
 * keep their in-memory code until restart).
 */

import { Router } from 'express';
import { registry } from '../../core/integration-registry.js';
import {
  addSource, addNpmSource, updateSource, checkSource, removeSource, listSources,
  isValidSlug, parseShareSnippet, isValidSourceUrl,
  type PluginSourceView,
} from '../../core/plugin-sources.js';
import { isValidNpmSpec } from '../../core/plugin-npm-install.js';
import {
  getUnconfiguredPlugins, getUnsupportedPlugins, getDuplicatePluginIds,
} from '../../core/integration-loader.js';
import { createSubsystemLogger } from '../../logging/index.js';

const log = createSubsystemLogger('plugin-sources');

export type PluginStatus = 'loaded' | 'needs-config' | 'unsupported' | 'duplicate' | 'error' | 'pending-restart';

/**
 * A LOADED plugin is 'loaded' whatever its capability mix — the registry check
 * comes first on purpose. `unsupported` is now reserved for a plugin whose
 * manifest declares NO capability this version implements (only `hooks` /
 * `routines`), which is the only case the loader records there; a plugin that is
 * ui-, tools- or skills-only loads normally and must never be labelled as
 * needing a newer Walnut.
 */
function statusFor(pluginId: string | null, error?: string): PluginStatus {
  if (error || !pluginId) return 'error';
  if (registry.has(pluginId)) return 'loaded';
  if (getUnconfiguredPlugins().some(p => p.id === pluginId)) return 'needs-config';
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

export function createPluginSourcesRouter(softReload: () => Promise<void>): Router {
  const router = Router();

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
      res.status(201).json(withStatuses(refreshed));
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
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
      const result = await updateSource(slug);
      if (result.error) {
        res.status(502).json({ ...result, restartRequired: false });
        return;
      }
      if (result.updated) {
        try {
          await softReload();
        } catch (err) {
          log.warn('soft reload after update failed', { error: String(err) });
        }
      }
      const restartRequired = result.updated && loadedBefore.length > 0;
      res.json({ ...result, restartRequired });
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
      if (!sources.some((source) => source.slug === slug)) {
        res.status(404).json({ error: 'source not found' });
        return;
      }
      res.json(await checkSource(slug));
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
