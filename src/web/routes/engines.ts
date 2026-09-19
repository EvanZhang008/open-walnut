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
import {
  EngineSettingsError,
  readEngineSettings,
  writeEngineSettings,
  type EngineSettingsPatch,
  type SettingsFileTransport,
} from '../../core/agents/engine-settings-service.js'
import { DaemonFileReader, DaemonNeedsUpgradeError } from '../../core/daemon-file-reader.js'
import { getConfig } from '../../core/config-manager.js'
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
      // Whether GET/PATCH /api/engines/:id/settings answers for this engine.
      settings: caps.settings !== undefined,
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
  // ?refresh=1 — the picker's "Retry": a cached failure (45s TTL) must not
  // outlive the operator's fix, so a retry click re-probes immediately.
  const refresh = req.query.refresh === '1'
  try {
    const { getEngineModelCatalog } = await import('../../providers/engine-model-probe.js')
    const catalog = await getEngineModelCatalog(id, { cwd, refresh })
    res.json(catalog)
  } catch (err) {
    // Honest degrade: "couldn't list" with the adapter's own words (missing
    // credentials, not installed) beats an empty list pretending to be one.
    const message = err instanceof Error ? err.message : String(err)
    log.web.warn('engine model catalog probe failed', { engine: id, error: message })
    res.status(502).json({ error: message, engine: id })
  }
})

// ── Engine settings: the engine's OWN config files on a host ──
//
// GET  /api/engines/:id/settings?host=   → EngineSettingsView
// PATCH /api/engines/:id/settings?host=  {set, unset} → EngineSettingsView + changed
//
// The daemon on the host does the file I/O (host-local work belongs to the
// daemon); the service owns parsing and the read-modify-write. This route only
// validates the host, wires the transport and maps errors to honest statuses.

/** Every daemon round trip here is one small file, but a remote connect can stall; the route answers 504, never hangs. */
const ENGINE_SETTINGS_DEADLINE_MS = 20_000

const LOCAL_HOST = '__local__'

async function resolveHostParam(raw: unknown): Promise<string | null> {
  const host = typeof raw === 'string' && raw.trim() ? raw.trim() : LOCAL_HOST
  if (host === LOCAL_HOST) return host
  const config = await getConfig()
  // Own keys only: `hosts['__proto__']` and `hosts['toString']` are truthy too.
  return Object.hasOwn(config.hosts ?? {}, host) ? host : null
}

function daemonTransport(host: string): SettingsFileTransport {
  const reader = new DaemonFileReader(host)
  return {
    read: (p, maxBytes) => reader.readFileBytes(p, maxBytes),
    writeAtomic: (p, text, expectSha256) => reader.writeFileAtomic(p, text, expectSha256),
    // The local daemon inherits this process's environment, so overrides such
    // as DISABLE_AUTOUPDATER can be reported truthfully. A remote host's
    // environment is not visible from here; the view says so (envChecked:false).
    ...(host === LOCAL_HOST ? { env: process.env } : {}),
  }
}

class EngineSettingsTimeout extends Error {}

function withDeadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new EngineSettingsTimeout(`${what} did not answer within ${Math.round(ms / 1000)}s`)), ms)
    p.then((v) => { clearTimeout(timer); resolve(v) }, (e) => { clearTimeout(timer); reject(e) })
  })
}

/**
 * Every failure names its `outcome` so the client can tell "your change was
 * refused" (safe to put the control back) from "the file may have changed
 * anyway" (a deadline that fired after the daemon renamed the file, a read-back
 * that failed after a successful write). Reverting a control on the second kind
 * shows the opposite of what is on disk.
 */
function answerEngineSettingsError(res: Response, err: unknown, ctx: Record<string, unknown>): void {
  if (err instanceof EngineSettingsError) {
    res.status(err.status).json({ error: err.message, outcome: err.outcome })
    return
  }
  if (err instanceof DaemonNeedsUpgradeError) {
    res.status(501).json({ error: err.message, code: 'daemon_needs_upgrade', outcome: 'not-written' })
    return
  }
  if (err instanceof EngineSettingsTimeout) {
    res.status(504).json({ error: err.message, code: 'host_unreachable', outcome: 'unknown' })
    return
  }
  const message = err instanceof Error ? err.message : String(err)
  log.web.warn('engine settings request failed', { ...ctx, error: message })
  res.status(502).json({ error: message, outcome: 'unknown' })
}

enginesRouter.get('/:id/settings', async (req: Request, res: Response) => {
  const engine = String(req.params.id)
  const host = await resolveHostParam(req.query.host)
  if (!host) {
    res.status(400).json({ error: `unknown host '${String(req.query.host)}'` })
    return
  }
  try {
    const view = await withDeadline(readEngineSettings(engine, host, daemonTransport(host)), ENGINE_SETTINGS_DEADLINE_MS, `the daemon on ${host}`)
    res.json(view)
  } catch (err) {
    answerEngineSettingsError(res, err, { engine, host, op: 'read' })
  }
})

enginesRouter.patch('/:id/settings', async (req: Request, res: Response) => {
  const engine = String(req.params.id)
  const host = await resolveHostParam(req.query.host)
  if (!host) {
    res.status(400).json({ error: `unknown host '${String(req.query.host)}'` })
    return
  }
  const body = (req.body ?? {}) as EngineSettingsPatch
  try {
    const view = await withDeadline(writeEngineSettings(engine, host, body, daemonTransport(host)), ENGINE_SETTINGS_DEADLINE_MS, `the daemon on ${host}`)
    log.web.info('engine settings updated', { engine, host, changed: view.changed })
    res.json(view)
  } catch (err) {
    answerEngineSettingsError(res, err, { engine, host, op: 'write' })
  }
})
