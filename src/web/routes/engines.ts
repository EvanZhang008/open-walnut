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
