/**
 * GET /api/integrations — returns metadata for all registered plugins (except local).
 * Used by the frontend for data-driven sync badges, filter chips, and settings.
 */

import { Router } from 'express';
import { registry } from '../../core/integration-registry.js';

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
