/**
 * GET /api/integrations — returns metadata for all registered plugins (except local).
 * Used by the frontend for data-driven sync badges, filter chips, and settings.
 *
 * GET /api/integrations/settings — full settings metadata: every discovered plugin
 * (loaded or skipped for missing config) with its configSchema + uiHints + current
 * config values, so the Settings UI can render a data-driven form per plugin.
 */

import { Router } from 'express';
import { registry } from '../../core/integration-registry.js';
import { getUnconfiguredPlugins } from '../../core/integration-loader.js';
import { getConfig } from '../../core/config-manager.js';
import { getSyncHealth } from '../../core/plugin-sync-health.js';
import type { RegisteredPlugin } from '../../core/integration-types.js';
import { log } from '../../logging/index.js';

export const integrationsRouter = Router();

integrationsRouter.get('/', (_req, res) => {
  const plugins = registry.getAll()
    .filter(p => p.id !== 'local' && p.display)
    .map(p => ({
      id: p.id,
      name: p.name,
      description: p.description,
      badge: p.display!.badge,
      badgeColor: p.display!.badgeColor,
      externalLinkLabel: p.display!.externalLinkLabel,
    }));

  res.json(plugins);
});

// GET /api/integrations/task-fields — every enabled plugin's declared per-task
// fields (manifest taskFields). The frontend renders these generically: one
// picker per field in the task kebab menu, options fetched lazily from
// /api/plugins/<pluginId><optionsRoute>.
integrationsRouter.get('/task-fields', (_req, res) => {
  const fields = registry.getAll()
    .filter(p => p.id !== 'local' && p.taskFields?.length)
    .flatMap(p => p.taskFields!.map(f => ({
      pluginId: p.id,
      pluginName: p.name,
      ...f,
      optionsUrl: `/api/plugins/${p.id}${f.optionsRoute}`,
    })));
  res.json({ fields });
});

// Secret-ish config keys are masked in the response (values still editable via config API).
const SENSITIVE_KEY = /token|secret|password|api_key|apikey/i;

integrationsRouter.get('/settings', async (_req, res) => {
  const config = await getConfig();
  const pluginConfigs = (config.plugins ?? {}) as Record<string, Record<string, unknown>>;

  const maskValues = (values: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(Object.entries(values).map(([k, v]) =>
      [k, SENSITIVE_KEY.test(k) && typeof v === 'string' && v ? '••••••' : v]));

  const loaded = registry.getAll()
    .filter(p => p.id !== 'local')
    .map(p => ({
      id: p.id,
      name: p.name,
      description: p.description,
      status: 'loaded' as const,
      missing: [] as string[],
      configSchema: p.configSchema ?? null,
      uiHints: p.uiHints ?? null,
      values: maskValues(pluginConfigs[p.id] ?? {}),
      // What the plugin actually contributes. A deep-capability plugin
      // (ui/tools/skills, no sync) has no display badge and no config schema, so
      // without this it would render as an empty card that looks broken.
      capabilities: p.capabilities ?? ['sync'],
      tools: p.tools?.map(t => t.name) ?? [],
      hasApp: !!p.uiApp,
      hasSkills: !!p.hasSkills,
      // A conventional skills/ dir and a runtime registry.skill() registration are
      // different claims — a plugin can contribute skills with hasSkills false.
      registeredSkills: !!p.registeredSkills,
      // Has an account link the Settings row can show (GET …/:id/connection).
      connection: !!p.connection,
    }));

  const unconfigured = getUnconfiguredPlugins().map(p => ({
    id: p.id,
    name: p.name,
    description: p.description,
    status: 'needs-config' as const,
    missing: p.missing,
    configSchema: p.configSchema ?? null,
    uiHints: p.uiHints ?? null,
    values: maskValues(pluginConfigs[p.id] ?? {}),
  }));

  res.json([...loaded, ...unconfigured]);
});

// ── Account link (PluginConnection) ──────────────────────────────────────────
//
// The plugin says whether its credential is alive (status() never touches the
// network; it reads the cached token and the last renewal outcome) and Walnut
// adds what its own sync loop saw. The Settings row shows both together, so a
// human can tell "signed in, renews on its own" from "the provider is down"
// from "sign in again" without reading logs.

async function connectionReport(p: RegisteredPlugin) {
  const status = await p.connection!.status();
  return {
    pluginId: p.id,
    pluginName: p.name,
    ...status,
    canSignIn: typeof p.connection!.signIn === 'function',
    sync: getSyncHealth(p.id) ?? null,
  };
}

integrationsRouter.get('/connections', async (_req, res) => {
  const withLink = registry.getAll().filter(p => p.id !== 'local' && p.connection);
  const reports = await Promise.all(withLink.map(async (p) => {
    try {
      return await connectionReport(p);
    } catch (err) {
      // One plugin's broken status() must not blank the whole list.
      log.web.warn('plugin connection status failed', { pluginId: p.id, error: err instanceof Error ? err.message : String(err) });
      return { pluginId: p.id, pluginName: p.name, state: 'unreachable' as const, detail: 'Could not read the connection status.', canSignIn: typeof p.connection!.signIn === 'function', sync: getSyncHealth(p.id) ?? null };
    }
  }));
  res.json({ connections: reports });
});

integrationsRouter.get('/:id/connection', async (req, res) => {
  const p = registry.get(req.params.id);
  if (!p || p.id === 'local' || !p.connection) {
    res.status(404).json({ error: 'This plugin has no account link.' });
    return;
  }
  try {
    res.json(await connectionReport(p));
  } catch (err) {
    log.web.warn('plugin connection status failed', { pluginId: p.id, error: err instanceof Error ? err.message : String(err) });
    res.status(502).json({ error: 'Could not read the connection status.' });
  }
});

// Starts (or returns the still-valid) device-code sign-in. 202: the prompt to
// show the human; the plugin finishes the flow in the background and its next
// status() reports 'connected'. The route never waits for the human.
integrationsRouter.post('/:id/connection/sign-in', async (req, res) => {
  const p = registry.get(req.params.id);
  if (!p || p.id === 'local' || !p.connection) {
    res.status(404).json({ error: 'This plugin has no account link.' });
    return;
  }
  if (typeof p.connection.signIn !== 'function') {
    res.status(405).json({ error: `${p.name} does not support signing in from Settings.` });
    return;
  }
  try {
    const prompt = await p.connection.signIn();
    log.web.info('plugin sign-in started', { pluginId: p.id, expiresAt: prompt.expiresAt });
    res.status(202).json({ pluginId: p.id, ...prompt });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.web.warn('plugin sign-in could not start', { pluginId: p.id, error: message });
    res.status(502).json({ error: message });
  }
});
