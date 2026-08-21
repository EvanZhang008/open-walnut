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
