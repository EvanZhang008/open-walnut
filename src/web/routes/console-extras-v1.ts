/**
 * /api/v1 console extras (additive, Wave 3) — usage detail breakdowns,
 * provider status, search-index status, plugin metadata, Life Tracker
 * timeline, and heartbeat. Semantics identical to the internal routes
 * (usage.ts / config.ts / qmd.ts / integrations.ts / timeline.ts /
 * heartbeat.ts) — same shared functions, zero duplicated logic.
 *
 *   GET  /usage/summary | /daily | /by-source | /by-model | /by-agent
 *        | /recent | /pricing                → usage aggregates
 *   GET  /config/providers                   → { providers } (key_hint stripped)
 *   GET  /qmd/status                         → search index health
 *   GET  /integrations                       → [plugin metadata]
 *   GET  /integrations/settings              → [plugin settings, secrets masked]
 *   GET  /timeline?date=                     → day timeline
 *   GET  /timeline/dates                     → { dates }
 *   GET  /timeline/images/:date/:file        → JPEG bytes
 *   POST /timeline/toggle                    → { enabled, jobId }
 *   GET  /heartbeat                          → status
 *   POST /heartbeat/trigger { context? }     → { ok }
 *   GET  /heartbeat/checklist                → { content }
 *   PUT  /heartbeat/checklist { content }    → { ok }
 *
 * Replica classes:
 * - usage / qmd status / timeline / heartbeat status+trigger: C — the usage
 *   DB, search index, timeline captures (gitignored dir) and heartbeat runner
 *   all live on the primary → 501 not_supported_cloud.
 * - config/providers: local read describing the ANSWERING box's provider
 *   credentials (the replica's butler uses its own) — served on both boxes,
 *   with `key_hint` (last-4 of a key) STRIPPED: any paired device can call
 *   v1, and even a key fragment doesn't belong on that trust level.
 * - integrations / heartbeat checklist: A — registry runs on both boxes
 *   (values masked); HEARTBEAT.md rides git-sync.
 *
 * Frozen-contract note: everything here is additive (docs/reference/api-v1.md).
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { CLOUD_MODE } from '../../constants.js'
import { log } from '../../logging/index.js'
import { sendV1Error as sendError } from './v1-control-relay.js'

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
    const { buildQmdStatusPayload } = await import('./qmd.js')
    res.json(await buildQmdStatusPayload())
  } catch (err) {
    next(err)
  }
})

// ── Plugin metadata (read-only) ──────────────────────────────────────────────

// GET /api/v1/integrations — registered plugin display metadata.
consoleExtrasV1Router.get('/integrations', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { registry } = await import('../../core/integration-registry.js')
    const plugins = registry.getAll()
      .filter((p) => p.id !== 'local' && p.display)
      .map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        badge: p.display!.badge,
        badgeColor: p.display!.badgeColor,
        externalLinkLabel: p.display!.externalLinkLabel,
      }))
    res.json(plugins)
  } catch (err) {
    next(err)
  }
})

// Secret-ish config keys are masked in the response (same rule as the web route).
const SENSITIVE_KEY = /token|secret|password|api_key|apikey/i

// GET /api/v1/integrations/settings — full plugin settings metadata (schema +
// uiHints + masked current values) for a data-driven settings form.
consoleExtrasV1Router.get('/integrations/settings', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { registry } = await import('../../core/integration-registry.js')
    const { getUnconfiguredPlugins } = await import('../../core/integration-loader.js')
    const { getConfig } = await import('../../core/config-manager.js')
    const config = await getConfig()
    const pluginConfigs = (config.plugins ?? {}) as Record<string, Record<string, unknown>>

    const maskValues = (values: Record<string, unknown>): Record<string, unknown> =>
      Object.fromEntries(Object.entries(values).map(([k, v]) =>
        [k, SENSITIVE_KEY.test(k) && typeof v === 'string' && v ? '••••••' : v]))

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

// ── Life Tracker timeline ────────────────────────────────────────────────────
// C-class: the capture dir is deliberately gitignored (screenshots of the
// Mac), so a REPLICA has no data — an honest 501 beats an empty 200.

/** Run a timeline op, mapping TimelineOpError onto the frozen v1 shape. */
async function runTimelineOp(res: Response, next: NextFunction, fn: () => Promise<unknown>): Promise<void> {
  const { TimelineOpError } = await import('./timeline.js')
  try {
    res.json(await fn())
  } catch (err) {
    if (err instanceof TimelineOpError) {
      sendError(res, err.statusCode, err.statusCode === 404 ? 'not_found' : err.statusCode >= 500 ? 'internal' : 'bad_request', err.message)
      return
    }
    next(err)
  }
}

// GET /api/v1/timeline?date=YYYY-MM-DD — one day's parsed activity timeline.
consoleExtrasV1Router.get('/timeline', async (req: Request, res: Response, next: NextFunction) => {
  if (primaryOnly(res, 'The Life Tracker timeline')) return
  const { getTimelineForDate } = await import('./timeline.js')
  await runTimelineOp(res, next, () => getTimelineForDate(req.query.date))
})

// GET /api/v1/timeline/dates — dates with capture data, newest first.
consoleExtrasV1Router.get('/timeline/dates', async (_req: Request, res: Response, next: NextFunction) => {
  if (primaryOnly(res, 'The Life Tracker timeline')) return
  const { listTimelineDates } = await import('./timeline.js')
  await runTimelineOp(res, next, () => listTimelineDates())
})

// GET /api/v1/timeline/images/:date/:file — one thumbnail JPG (binary).
consoleExtrasV1Router.get('/timeline/images/:date/:file', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (primaryOnly(res, 'The Life Tracker timeline')) return
    const { readTimelineImage, TimelineOpError } = await import('./timeline.js')
    try {
      const buffer = await readTimelineImage(req.params.date, req.params.file)
      res.setHeader('Content-Type', 'image/jpeg')
      res.setHeader('Cache-Control', 'public, max-age=86400')
      res.setHeader('Content-Length', buffer.length)
      res.send(buffer)
    } catch (err) {
      if (err instanceof TimelineOpError) {
        sendError(res, err.statusCode, err.statusCode === 404 ? 'not_found' : 'bad_request', err.message)
        return
      }
      throw err
    }
  } catch (err) {
    next(err)
  }
})

// POST /api/v1/timeline/toggle — enable/disable the Life Tracker cron job.
consoleExtrasV1Router.post('/timeline/toggle', async (_req: Request, res: Response, next: NextFunction) => {
  if (primaryOnly(res, 'The Life Tracker cron job')) return
  const { toggleLifeTracker } = await import('./timeline.js')
  await runTimelineOp(res, next, () => toggleLifeTracker())
})

// ── Heartbeat ────────────────────────────────────────────────────────────────

// GET /api/v1/heartbeat — heartbeat runner status. C-class: the runner lives
// on the primary; the replica answering `enabled: false` for a heartbeat that
// IS running on the primary would be a lie.
consoleExtrasV1Router.get('/heartbeat', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    if (primaryOnly(res, 'The heartbeat runner')) return
    const { getHeartbeatHandle } = await import('../server.js')
    const handle = getHeartbeatHandle()
    if (!handle) {
      res.json({
        enabled: false,
        state: null,
        message: 'Heartbeat is not enabled. Set heartbeat.enabled: true in config.yaml.',
      })
      return
    }
    const state = handle.getState()
    res.json({
      enabled: true,
      state: {
        running: state.running,
        lastRunAt: state.lastRunAt ? new Date(state.lastRunAt).toISOString() : null,
        nextDueAt: state.nextDueAt ? new Date(state.nextDueAt).toISOString() : null,
        stopped: state.stopped,
      },
    })
  } catch (err) {
    next(err)
  }
})

// POST /api/v1/heartbeat/trigger { context? } — manual heartbeat (debounced).
consoleExtrasV1Router.post('/heartbeat/trigger', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (primaryOnly(res, 'The heartbeat runner')) return
    const { getHeartbeatHandle } = await import('../server.js')
    const handle = getHeartbeatHandle()
    if (!handle) {
      sendError(res, 400, 'bad_request', 'Heartbeat is not enabled. Set heartbeat.enabled: true in config.yaml.')
      return
    }
    const context = typeof req.body?.context === 'string' ? req.body.context : undefined
    handle.requestNow('manual', context)
    res.json({ ok: true, message: 'Heartbeat triggered (debounced, will fire within 250ms).' })
  } catch (err) {
    next(err)
  }
})

// GET /api/v1/heartbeat/checklist — HEARTBEAT.md content (A: git-synced).
consoleExtrasV1Router.get('/heartbeat/checklist', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { readHeartbeatChecklist } = await import('../../heartbeat/checklist-io.js')
    res.json({ content: await readHeartbeatChecklist() })
  } catch (err) {
    next(err)
  }
})

// PUT /api/v1/heartbeat/checklist { content } — write HEARTBEAT.md.
consoleExtrasV1Router.put('/heartbeat/checklist', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { content } = (req.body ?? {}) as Record<string, unknown>
    if (typeof content !== 'string') {
      sendError(res, 400, 'bad_request', 'content (string) is required')
      return
    }
    const { writeHeartbeatChecklist } = await import('../../heartbeat/checklist-io.js')
    await writeHeartbeatChecklist(content)
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

// Router-level error funnel — keeps unexpected failures in the frozen shape.
consoleExtrasV1Router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  log.web.error('api-v1 console extras route error', {
    error: err instanceof Error ? err.message : String(err),
  })
  if (res.headersSent) {
    res.end()
    return
  }
  sendError(res, 500, 'internal', 'Internal server error')
})
