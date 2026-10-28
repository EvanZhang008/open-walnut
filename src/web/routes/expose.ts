/**
 * /api/expose: this server's tunnel (docs/plan/walnut-servers-everywhere.md).
 *
 *   GET  /            → { status, providers, places, settings }
 *   PUT  /            { enabled?, provider?, options?, run_on? } → { status }
 *
 * `run_on` is where the tunnel runs (core/expose/placement.ts): `here`, a host key
 * (that host's Walnut server runs it), or null to follow the provider's always-on
 * host. `places` lists the choices; `settings.placedOn` says where it runs now.
 *   POST /retry       → { status }
 *
 * Reading is for any caller the auth middleware let in. Changing it (turning a
 * tunnel on puts this server one address away from the internet) is for the
 * person at this machine: a request from this machine with no session caller
 * header. A paired device, a session and a replica get 403. Retry changes no
 * setting (it starts again only a tunnel the person turned on), so a session on
 * this machine may press it too (isOnThisMachine).
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { CLOUD_MODE } from '../../constants.js'
import { getConfig, updateConfig } from '../../core/config-manager.js'
import { MaskedValueError, maskSecretShapes, restoreMaskedSecrets } from '../../core/config-secret-shape.js'
import { getExposeProvider, listExposeProviders } from '../../core/expose/registry.js'
import { RUN_ON_HERE, exposePlaces, exposePlacement, validRunOn } from '../../core/expose/placement.js'
import { emitConfigChanged } from '../../core/config-broadcast.js'
import { EXPOSE_PROVIDER_ID } from '../../core/expose/types.js'
import { isLocalOrigin } from '../../lib/caller-origin.js'
import { requestOrigin } from '../middleware/request-origin.js'
import { getExposeRuntime } from '../expose-runtime.js'
import { log } from '../../logging/index.js'

export const exposeRouter = Router()

const MAX_OPTION_LENGTH = 200

/**
 * A caller on this machine, the person or a session it runs: for a button that
 * changes no setting and grants nothing, only redoes what the person chose (a
 * Retry). A paired device, a session on another host and a replica stay out.
 */
export function isOnThisMachine(req: Request): boolean {
  if (CLOUD_MODE) return false
  return isLocalOrigin(requestOrigin(req))
}

/** The person at this machine, not a paired device and not a session acting for one. */
export function isPersonAtThisMachine(req: Request): boolean {
  return !req.get('x-walnut-caller-sid') && isOnThisMachine(req)
}

function refuse(res: Response): void {
  res.status(403).json({ error: 'Only you, at this computer, can change how Walnut is reached from outside (Settings, Phones & Cloud).', code: 'person_at_this_machine' })
}

function offStatus() {
  return { enabled: false, provider: null, state: 'off' as const, since: 0 }
}

exposeRouter.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const config = await getConfig()
    const cfg = config.expose ?? {}
    const providers = listExposeProviders(cfg.command)
    const providerId = cfg.provider ?? providers[0]?.id ?? null
    const def = providerId ? getExposeProvider(providerId, cfg.command) : null
    res.json({
      status: getExposeRuntime()?.status() ?? offStatus(),
      providers,
      // Where it can run (a host the provider names as always on, and here); empty: here only.
      places: exposePlaces(cfg.run_on, def, config.hosts),
      settings: {
        enabled: cfg.enabled === true,
        provider: cfg.provider ?? null,
        runOn: cfg.run_on ?? null,
        // Where it runs now: the pick, else the provider's always-on host, else here.
        placedOn: (() => { const p = exposePlacement(cfg.run_on, def, config.hosts); return p.where === 'host' ? p.hostKey : RUN_ON_HERE })(),
        // A provider's options are a free-form map (a tunnel name, say, or its token):
        // secret-shaped values masked, as in GET /api/config. PUT puts a mask back.
        options: maskSecretShapes(cfg.options ?? {}),
        ...(cfg.port ? { port: cfg.port } : {}),
      },
    })
  } catch (err) {
    next(err)
  }
})

exposeRouter.put('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!isPersonAtThisMachine(req)) return refuse(res)
    const body = (req.body ?? {}) as { enabled?: unknown; provider?: unknown; options?: unknown; run_on?: unknown }
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
      res.status(400).json({ error: 'enabled is true or false' })
      return
    }
    if (body.provider !== undefined && body.provider !== null && (typeof body.provider !== 'string' || !EXPOSE_PROVIDER_ID.test(body.provider))) {
      res.status(400).json({ error: 'provider is a provider id' })
      return
    }
    if (body.run_on !== undefined && !validRunOn(body.run_on, (await getConfig()).hosts)) {
      res.status(400).json({ error: 'run_on is "here", a host in config.yaml, or null' })
      return
    }
    let options: Record<string, string> | undefined
    if (body.options !== undefined) {
      if (!body.options || typeof body.options !== 'object' || Array.isArray(body.options)) {
        res.status(400).json({ error: 'options is an object of strings' })
        return
      }
      options = {}
      for (const [key, value] of Object.entries(body.options as Record<string, unknown>)) {
        if (!/^[a-z][a-z0-9_]*$/i.test(key) || typeof value !== 'string' || value.length > MAX_OPTION_LENGTH) {
          res.status(400).json({ error: `options.${key} must be a string of at most ${MAX_OPTION_LENGTH} characters` })
          return
        }
        options[key] = value
      }
    }
    const before = (await getConfig()).expose ?? {}
    // The form saves every option back, a masked one too: that one keeps its stored value.
    if (options) options = restoreMaskedSecrets(options, before.options ?? {}, 'expose.options')
    const nextExpose = {
      ...before,
      ...(body.run_on !== undefined ? { run_on: (body.run_on as string | null) ?? undefined } : {}),
      ...(body.enabled !== undefined ? { enabled: body.enabled as boolean } : {}),
      ...(body.provider !== undefined ? { provider: (body.provider as string | null) ?? undefined } : {}),
      ...(options ? { options } : {}),
    }
    await updateConfig({ expose: nextExpose })
    log.web.info('expose settings changed', { enabled: nextExpose.enabled === true, provider: nextExpose.provider ?? null, runOn: nextExpose.run_on ?? null })
    const status = await getExposeRuntime()?.reconcile() ?? offStatus()
    // The host servers follow (the one that carries the tunnel starts it), and other tabs see it.
    emitConfigChanged(await getConfig(), ['web-ui'], { source: 'api' })
    res.json({ status })
  } catch (err) {
    if (err instanceof MaskedValueError) {
      res.status(400).json({ error: err.message, code: err.code, field: err.field, reason: err.reason })
      return
    }
    next(err)
  }
})

exposeRouter.post('/retry', (req: Request, res: Response) => {
  if (!isOnThisMachine(req)) return refuse(res)
  const runtime = getExposeRuntime()
  const callerSid = req.get('x-walnut-caller-sid')
  if (callerSid) log.web.info('expose: retry asked by a session', { callerSid })
  runtime?.retry()
  res.json({ status: runtime?.status() ?? offStatus() })
})
