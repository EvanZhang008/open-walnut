/**
 * /api/plugin-sources — manage git-repo plugin sources (the "plugin store").
 *
 * GET    /                 list sources with discovered plugins + per-plugin status
 * POST   /                 {url, ref?} — clone a new source and soft-reload plugins
 * POST   /:slug/update     git pull the source; soft-reload; reports restartRequired
 * POST   /:slug/check      git fetch + how many commits behind
 * DELETE /:slug            remove source, delete clone
 *
 * The router is a factory: the server passes a softReload callback that
 * re-runs plugin loading additively (new plugins only — already-loaded ids
 * keep their in-memory code until restart).
 */

import { Router } from 'express';
import { registry } from '../../core/integration-registry.js';
import {
  addSource, updateSource, checkSource, removeSource, listSources,
  isValidSlug, parseShareSnippet,
  type PluginSourceView,
} from '../../core/plugin-sources.js';
import {
  getUnconfiguredPlugins, getUnsupportedPlugins, getDuplicatePluginIds,
} from '../../core/integration-loader.js';
import { createSubsystemLogger } from '../../logging/index.js';

const log = createSubsystemLogger('plugin-sources');

export type PluginStatus = 'loaded' | 'needs-config' | 'unsupported' | 'duplicate' | 'error' | 'pending-restart';

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

function withStatuses(view: PluginSourceView) {
  return {
    ...view,
    plugins: view.plugins.map(p => ({ ...p, status: statusFor(p.id, p.error) })),
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
    const body = req.body ?? {};
    const { url, ref } = body;
    // Three accepted forms: {url: "<git url>"}, {url: "<share snippet string>"},
    // or the share snippet itself as the request body ({"walnut_plugin_source": ...})
    // — agents and humans naturally POST the snippet verbatim.
    const bodySnippet = 'walnut_plugin_source' in body ? parseShareSnippet(JSON.stringify(body)) : null;
    if (!bodySnippet && (typeof url !== 'string' || !url.trim())) {
      res.status(400).json({ error: 'url is required (a git URL or a walnut_plugin_source share snippet)' });
      return;
    }
    const snippet = bodySnippet ?? parseShareSnippet(url);
    const effectiveUrl = snippet ? snippet.url : (url as string).trim();
    const effectiveRef = snippet?.ref ?? (typeof ref === 'string' && ref.trim() ? ref.trim() : undefined);
    try {
      const view = await addSource(effectiveUrl, effectiveRef);
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
  });

  router.post('/:slug/check', async (req, res) => {
    const { slug } = req.params;
    if (!isValidSlug(slug)) {
      res.status(400).json({ error: 'invalid slug' });
      return;
    }
    res.json(await checkSource(slug));
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
      const hadLoaded = !!source?.plugins.some(p => p.id && registry.has(p.id));
      await removeSource(slug);
      res.json({ removed: true, restartRequired: hadLoaded });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
