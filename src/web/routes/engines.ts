/**
 * Engines route — the coding-agent engine catalog the web UI renders its engine
 * toggle, model picker and local-only locks from.
 *
 * NOT /api/providers: `/api/config/providers` already means "AI credential
 * status" (bedrock/anthropic keys). This endpoint answers a different question,
 * "which session engines exist and can this host run them".
 *
 * Everything except `availability` is static registry data, so a probe that is
 * slow or throws degrades the availability block only — the catalog still
 * renders. The probe carries its own deadline (see engine-probe.probeEngines),
 * which is what makes it safe on the request path.
 */

import { Router, type Request, type Response } from 'express'
import { ENGINE_REGISTRY, DEFAULT_ENGINE, type EngineCapabilities } from '../../core/agents/engine-registry.js'
import type { SessionEngine } from '../../core/types.js'
import { probeEngines, type EngineAvailability } from '../../core/agents/engine-probe.js'
import { log } from '../../logging/index.js'

export const enginesRouter = Router()

/** Availability used when the probe itself failed: honest, and never a hard error. */
const PROBE_UNKNOWN: EngineAvailability = { installed: false, version: null, reason: 'availability check unavailable' }

function toCatalogEntry(caps: EngineCapabilities, availability: EngineAvailability) {
  return {
    id: caps.id,
    displayName: caps.displayName,
    runtimeKind: caps.runtimeKind,
    isDefault: caps.id === DEFAULT_ENGINE,
    // Every ACP engine runs through the local acp-worker today; remote hosts
    // reject them in claude-code-session. Registry-derived, not a vendor list.
    localOnly: caps.runtimeKind === 'acp',
    capabilities: {
      rewind: caps.rewind !== 'unsupported',
      fork: caps.fork,
      modelCatalog: caps.modelCatalog,
      modeControl: caps.modeControl,
      idProvisioning: caps.idProvisioning,
    },
    availability,
  }
}

// GET /api/engines — full catalog + per-engine availability.
enginesRouter.get('/', async (_req: Request, res: Response) => {
  let availability = new Map<string, EngineAvailability>()
  try {
    availability = await probeEngines()
  } catch (err) {
    // A catalog without availability is still useful; a 500 blanks the UI's
    // engine toggle entirely.
    log.web.warn('engine availability probe failed', { error: err instanceof Error ? err.message : String(err) })
  }
  const engines = [...ENGINE_REGISTRY.values()].map((caps) => toCatalogEntry(caps, availability.get(caps.id) ?? PROBE_UNKNOWN))
  res.json({ engines })
})

// GET /api/engines/:id/models — the engine's provider-advertised model catalog
// for DRAFT surfaces (no session exists yet to ask). One-shot adapter probe
// behind a cache; the probe module owns the deadline, so this route can never
// hang past it. Claude is a deliberate 404: its catalog rides the host-level
// model-catalog pipeline, not ACP.
enginesRouter.get('/:id/models', async (req: Request, res: Response) => {
  const id = String(req.params.id) as SessionEngine
  const caps = ENGINE_REGISTRY.get(id)
  if (!caps || caps.runtimeKind !== 'acp') {
    res.status(404).json({ error: `no provider model catalog for engine '${id}'` })
    return
  }
  // Draft folder: opencode/goose resolve provider+model config per project,
  // so the probe must run where the launch will (nonexistent dir → $HOME).
  const rawCwd = req.query.cwd
  const cwd = typeof rawCwd === 'string' && rawCwd.trim() && rawCwd.length <= 1024
    ? rawCwd.trim()
    : undefined
  try {
    const { getEngineModelCatalog } = await import('../../providers/engine-model-probe.js')
    const catalog = await getEngineModelCatalog(id, { cwd })
    res.json(catalog)
  } catch (err) {
    // Honest degrade: "couldn't list" with the adapter's own words (missing
    // credentials, not installed) beats an empty list pretending to be one.
    const message = err instanceof Error ? err.message : String(err)
    log.web.warn('engine model catalog probe failed', { engine: id, error: message })
    res.status(502).json({ error: message, engine: id })
  }
})
