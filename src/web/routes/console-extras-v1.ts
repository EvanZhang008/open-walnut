/**
 * /api/v1 console extras (additive, Wave 3) — usage detail breakdowns,
 * provider status, search-index status and plugin metadata. Semantics
 * identical to the internal routes
 * (usage.ts / config.ts / search-index.ts / integrations.ts) —
 * same shared functions, zero duplicated logic.
 *
 *   GET  /usage/summary | /daily | /by-source | /by-model | /by-agent
 *        | /recent | /pricing                → usage aggregates
 *   GET  /config/providers                   → { providers } (key_hint stripped)
 *   GET  /qmd/status                         → search index health
 *   GET  /integrations                       → [plugin metadata]
 *   GET  /integrations/settings              → [plugin settings, secrets masked]
 *
 * The heartbeat routes (/heartbeat, /heartbeat/trigger, /heartbeat/checklist)
 * went with the heartbeat feature on 2026-10-27 and now answer 404.
 *
 * Replica classes:
 * - usage / qmd status: C — the usage DB and search index live on the
 *   primary → 501 not_supported_cloud.
 * - The Life Tracker timeline (/timeline, /timeline/dates, /timeline/images,
 *   /timeline/toggle) was removed with the feature on 2026-10-31 and now
 *   answers 404.
 * - config/providers: local read describing the ANSWERING box's provider
 *   credentials (the replica's Personal AI uses its own) — served on both boxes,
 *   with `key_hint` (last-4 of a key) STRIPPED: any paired device can call
 *   v1, and even a key fragment doesn't belong on that trust level.
 * - integrations: A — registry runs on both boxes (values masked).
 *
 * Frozen-contract note: everything here is additive (docs/reference/api-v1.md).
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { CLOUD_MODE } from '../../constants.js'
import { log } from '../../logging/index.js'
import { sendV1Error as sendError } from './v1-control-relay.js'
import { isNeedsLeaderError } from '../../core/replication/needs-leader.js'

export const consoleExtrasV1Router = Router()

/** C-class refusal: the backing store/runner lives on the primary box only. */
function primaryOnly(res: Response, what: string): boolean {
  if (!CLOUD_MODE) return false
  sendError(res, 501, 'not_supported_cloud', `${what} lives on the primary box only`)
  return true
}

// ── Usage detail breakdowns (Wave 2 shipped the composite /usage/overview) ──

/** Clamp an integer query param into [min, max] with a default. */
function clampInt(raw: unknown, def: number, min: number, max: number): number {
  return Math.min(Math.max(parseInt(String(raw), 10) || def, min), max)
}

/** today | 7d | 30d | all (default 30d) — same vocabulary as the web route. */
function parsePeriod(raw: unknown): 'today' | '7d' | '30d' | 'all' {
  return raw === 'today' || raw === '7d' || raw === '30d' || raw === 'all' ? raw : '30d'
}

// GET /api/v1/usage/summary — all period summaries.
consoleExtrasV1Router.get('/usage/summary', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    if (primaryOnly(res, 'Usage tracking')) return
    const { usageTracker } = await import('../../core/usage/index.js')
    res.json(usageTracker.getAllSummaries())
  } catch (err) {
    next(err)
  }
})

// GET /api/v1/usage/daily?days=30 — daily cost time series.
consoleExtrasV1Router.get('/usage/daily', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (primaryOnly(res, 'Usage tracking')) return
    const { usageTracker } = await import('../../core/usage/index.js')
    res.json({ daily: usageTracker.getDailyCosts(clampInt(req.query.days, 30, 1, 365)) })
  } catch (err) {
    next(err)
  }
})

// GET /api/v1/usage/by-source?period=30d — breakdown by source.
consoleExtrasV1Router.get('/usage/by-source', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (primaryOnly(res, 'Usage tracking')) return
    const { usageTracker } = await import('../../core/usage/index.js')
    res.json({ sources: usageTracker.getBySource(parsePeriod(req.query.period)) })
  } catch (err) {
    next(err)
  }
})

// GET /api/v1/usage/by-model?period=30d — breakdown by model.
consoleExtrasV1Router.get('/usage/by-model', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (primaryOnly(res, 'Usage tracking')) return
    const { usageTracker } = await import('../../core/usage/index.js')
    res.json({ models: usageTracker.getByModel(parsePeriod(req.query.period)) })
  } catch (err) {
    next(err)
  }
})

// GET /api/v1/usage/by-agent?period=30d — breakdown by the spending agent.
consoleExtrasV1Router.get('/usage/by-agent', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (primaryOnly(res, 'Usage tracking')) return
    const { usageTracker } = await import('../../core/usage/index.js')
    res.json({ agents: usageTracker.getByAgent(parsePeriod(req.query.period)) })
  } catch (err) {
    next(err)
  }
})

// GET /api/v1/usage/recent?limit=50 — recent usage records.
consoleExtrasV1Router.get('/usage/recent', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (primaryOnly(res, 'Usage tracking')) return
    const { usageTracker } = await import('../../core/usage/index.js')
    res.json({ records: usageTracker.getRecentRecords(clampInt(req.query.limit, 50, 1, 500)) })
  } catch (err) {
    next(err)
  }
})

// GET /api/v1/usage/pricing — pricing table (static; works on both boxes).
consoleExtrasV1Router.get('/usage/pricing', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { DEFAULT_PRICING, PRICING_VERSION } = await import('../../core/usage/index.js')
    res.json({ models: DEFAULT_PRICING, version: PRICING_VERSION })
  } catch (err) {
    next(err)
  }
})

// ── Provider status ──────────────────────────────────────────────────────────

// GET /api/v1/config/providers — provider readiness for the ANSWERING box.
// Same shared builder as the web settings screen, minus `key_hint` (a key
// fragment is still a credential hint — it never leaves for a paired device).
consoleExtrasV1Router.get('/config/providers', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { buildProvidersPayload } = await import('./config.js')
    const { providers } = await buildProvidersPayload()
    const stripped = Object.fromEntries(
      Object.entries(providers).map(([name, { key_hint: _hint, ...rest }]) => [name, rest]),
    )
    res.json({ providers: stripped, cloud: CLOUD_MODE })
  } catch (err) {
    next(err)
  }
})

// ── Search index status ──────────────────────────────────────────────────────

// GET /api/v1/qmd/status — semantic-search index health (model, store stats,
// state machine). The index maintenance ACTIONS (download/reindex) stay
// desktop-only (Class D).
consoleExtrasV1Router.get('/qmd/status', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    if (primaryOnly(res, 'The semantic search index')) return
    const { buildSearchIndexStatusPayload } = await import('./search-index.js')
    res.json(await buildSearchIndexStatusPayload())
  } catch (err) {
    next(err)
  }
})

// ── Plugin metadata (read-only) ──────────────────────────────────────────────

// GET /api/v1/integrations — registered plugin display metadata, with whether a project can
// sync to each and who reads it (src/core/plugins/integration-list.ts, the console's list too).
consoleExtrasV1Router.get('/integrations', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { integrationList } = await import('../../core/plugins/integration-list.js')
    res.json(await integrationList())
  } catch (err) {
    next(err)
  }
})

// Secret-shaped config values are masked in the response, at any depth (same rule as the web
// route, core/config-secret-shape.ts), with no tails: the cloud companion can forward a call here,
// and it cannot read this machine's GET /api/config.

// GET /api/v1/integrations/settings — full plugin settings metadata (schema +
// uiHints + masked current values) for a data-driven settings form.
consoleExtrasV1Router.get('/integrations/settings', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { registry } = await import('../../core/integration-registry.js')
    const { getUnconfiguredPlugins } = await import('../../core/integration-loader.js')
    const { getConfig } = await import('../../core/config-manager.js')
    const config = await getConfig()
    const pluginConfigs = (config.plugins ?? {}) as Record<string, Record<string, unknown>>

    const { maskPluginFormValues: maskValues } = await import('../../core/config-secret-shape.js')

    const loaded = registry.getAll()
      .filter((p) => p.id !== 'local')
      .map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        status: 'loaded' as const,
        missing: [] as string[],
        configSchema: p.configSchema ?? null,
        uiHints: p.uiHints ?? null,
        values: maskValues(pluginConfigs[p.id] ?? {}),
      }))

    const unconfigured = getUnconfiguredPlugins().map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      status: 'needs-config' as const,
      missing: p.missing,
      configSchema: p.configSchema ?? null,
      uiHints: p.uiHints ?? null,
      values: maskValues(pluginConfigs[p.id] ?? {}),
    }))

    res.json([...loaded, ...unconfigured])
  } catch (err) {
    next(err)
  }
})

// Router-level error funnel — keeps unexpected failures in the frozen shape.
consoleExtrasV1Router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  // A host replica's refusal of a store it only holds a copy of: the app's error
  // handler answers it 503 needs_leader with its why, never a 500 card.
  if (isNeedsLeaderError(err) && !res.headersSent) { _next(err); return }
  log.web.error('api-v1 console extras route error', {
    error: err instanceof Error ? err.message : String(err),
  })
  if (res.headersSent) {
    res.end()
    return
  }
  sendError(res, 500, 'internal', 'Internal server error')
})
