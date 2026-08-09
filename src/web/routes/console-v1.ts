/**
 * /api/v1 console reads (additive, Wave 2) — config projection, usage
 * overview, composer slash-command palette, and skills read.
 *
 *   GET /config                      → whitelisted read-only projection
 *   GET /usage/overview?start&end&source&model&agent&limit → usage aggregates
 *   GET /slash-commands?cwd&host&fresh=1 → { items, degraded? }
 *   GET /skills                      → { skills } (content stripped)
 *   GET /skills/:dirName             → { skill } (full content)
 *
 * Replica classes:
 * - config: A — the replica serves its own (git-synced) config through the
 *   SAME whitelist projection. The projection is allowlist-only: secrets are
 *   structurally absent, not masked (see buildConfigProjection).
 * - usage: C — the usage DB lives on the primary → 501 not_supported_cloud.
 * - slash-commands: B — relays via the box-level `server.slash-commands`
 *   control action (the palette describes the EXEC hosts' capabilities,
 *   which only the primary can discover).
 * - skills read: A — skill files ride git-sync.
 *
 * Frozen-contract note: everything here is additive (docs/reference/api-v1.md).
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { CLOUD_MODE } from '../../constants.js'
import { log } from '../../logging/index.js'
import { relayControlAction, sendV1Error as sendError } from './v1-control-relay.js'

export const consoleV1Router = Router()

/** Placeholder sessionId for the box-level `server.*` relay actions. */
const SERVER_RELAY_SID = '__server__'

// ─── Config (read-only whitelist projection) ─────────────────────────────────

/**
 * ALLOWLIST projection — the inverse of the internal route's redactConfig
 * (which deep-masks a denylist of secret field names). Only fields named here
 * ever leave the box, so a future config key holding a credential can never
 * leak by default. No write twin exists by design (config write is Class D).
 */
async function buildConfigProjection(): Promise<Record<string, unknown>> {
  const { getConfig } = await import('../../core/config-manager.js')
  const config = await getConfig()
  const hosts: Record<string, unknown> = {}
  for (const [alias, h] of Object.entries(config.hosts ?? {})) {
    hosts[alias] = {
      label: h.label ?? alias,
      enabled: h.enabled !== false,
    }
  }
  const projection: Record<string, unknown> = {
    user: { ...(config.user?.name ? { name: config.user.name } : {}) },
    defaults: {
      priority: config.defaults?.priority,
      ...(config.defaults?.platform ? { platform: config.defaults.platform } : {}),
      ...(config.defaults?.project !== undefined ? { project: config.defaults.project } : {}),
    },
    provider: {
      type: config.provider?.type,
      ...(config.provider?.model ? { model: config.provider.model } : {}),
      ...(config.provider?.bedrock_region ? { bedrock_region: config.provider.bedrock_region } : {}),
    },
    agent: {
      ...(config.agent?.main_model ? { main_model: config.agent.main_model } : {}),
      ...(config.agent?.fast_model ? { fast_model: config.agent.fast_model } : {}),
      ...(config.agent?.session_effort ? { session_effort: config.agent.session_effort } : {}),
      ...(config.agent?.main_provider ? { main_provider: config.agent.main_provider } : {}),
    },
    hosts,
    session: {
      ...(config.session?.idle_timeout_minutes !== undefined ? { idle_timeout_minutes: config.session.idle_timeout_minutes } : {}),
      ...(config.session?.enabled_modes ? { enabled_modes: config.session.enabled_modes } : {}),
    },
  }
  return projection
}

// GET /api/v1/config — read-only projection + box diagnostics. Works on BOTH
// boxes (the replica projects its own git-synced config).
consoleV1Router.get('/config', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const config = await buildConfigProjection()
    // Diagnostics the mobile bug-report flow needs (same rationale as the
    // internal route: visible without shell access).
    let processNice = 0
    try { processNice = (await import('node:os')).getPriority() } catch { /* diagnostics only */ }
    const mem = process.memoryUsage()
    res.json({
      config,
      cloud: CLOUD_MODE,
      processNice,
      memory: {
        rssMb: Math.round(mem.rss / 1048576),
        heapUsedMb: Math.round(mem.heapUsed / 1048576),
        uptimeSec: Math.round(process.uptime()),
      },
    })
  } catch (err) {
    next(err)
  }
})

// ─── Usage overview ──────────────────────────────────────────────────────────

/** Accept only well-formed YYYY-MM-DD; anything else is ignored. */
function parseDate(raw: unknown): string | undefined {
  return typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : undefined
}

/** A non-empty string token, trimmed; empty/absent → undefined. */
function parseTok(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const t = raw.trim()
  return t.length > 0 ? t : undefined
}

// GET /api/v1/usage/overview — every aggregate under one cross-filter, in one
// call (the composite endpoint the web dashboard uses). REPLICA: 501 — the
// usage DB lives on the primary.
consoleV1Router.get('/usage/overview', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (CLOUD_MODE) {
      sendError(res, 501, 'not_supported_cloud', 'Usage tracking lives on the primary box only')
      return
    }
    const { usageTracker } = await import('../../core/usage/index.js')
    const filter = {
      startDate: parseDate(req.query.start),
      endDate: parseDate(req.query.end),
      source: parseTok(req.query.source),
      model: parseTok(req.query.model),
      agentId: parseTok(req.query.agent),
    }
    const limit = Math.min(Math.max(parseInt(String(req.query.limit), 10) || 100, 1), 500)
    res.json(usageTracker.getOverview(filter, limit))
  } catch (err) {
    next(err)
  }
})

// ─── Slash-command palette ───────────────────────────────────────────────────

// GET /api/v1/slash-commands?cwd=&host=&fresh=1 — the composer palette
// (skills + command templates + built-ins; remote hosts discovered over the
// daemon). Same shared builder as the web route, incl. its per-host cache.
consoleV1Router.get('/slash-commands', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const cwd = typeof req.query.cwd === 'string' && req.query.cwd ? req.query.cwd : undefined
    const host = typeof req.query.host === 'string' && req.query.host ? req.query.host : undefined
    const fresh = req.query.fresh === '1' || req.query.fresh === 'true'
    if (CLOUD_MODE) {
      await relayControlAction(res, 'server.slash-commands', SERVER_RELAY_SID, {
        ...(cwd ? { cwd } : {}), ...(host ? { host } : {}), fresh,
      }, 200)
      return
    }
    const { buildSlashCommandItems } = await import('./slash-commands.js')
    res.json(await buildSlashCommandItems({ cwd, host, fresh }))
  } catch (err) {
    next(err)
  }
})

// ─── Skills (read-only; write CRUD is Wave 3) ────────────────────────────────

// GET /api/v1/skills — all skills, content stripped (a full list rides ~100s
// of KB of markdown otherwise; the detail endpoint carries the body).
consoleV1Router.get('/skills', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { listAllSkills } = await import('../../core/skill-store.js')
    const skills = (await listAllSkills()).map(({ content: _content, ...rest }) => rest)
    res.json({ skills })
  } catch (err) {
    next(err)
  }
})

// GET /api/v1/skills/:dirName — one skill with its full content.
consoleV1Router.get('/skills/:dirName', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const dirName = String(req.params.dirName ?? '')
    if (!/^[A-Za-z0-9._-]+$/.test(dirName)) {
      sendError(res, 400, 'bad_request', 'Invalid skill name')
      return
    }
    const { getSkill } = await import('../../core/skill-store.js')
    const skill = await getSkill(dirName)
    if (!skill) {
      sendError(res, 404, 'not_found', `Skill not found: ${dirName}`)
      return
    }
    res.json({ skill })
  } catch (err) {
    next(err)
  }
})

// Router-level error funnel — keeps unexpected failures in the frozen shape.
consoleV1Router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  log.web.error('api-v1 console route error', {
    error: err instanceof Error ? err.message : String(err),
  })
  if (res.headersSent) {
    res.end()
    return
  }
  sendError(res, 500, 'internal', 'Internal server error')
})
