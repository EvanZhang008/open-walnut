/**
 * /api/expose: this server's tunnel (docs/plan/walnut-servers-everywhere.md).
 *
 *   GET  /            → { status, providers, settings }
 *   PUT  /            { enabled?, provider?, options? } → { status }
 *   POST /retry       → { status }
 *
 * Reading is for any caller the auth middleware let in. Changing it (turning a
 * tunnel on puts this server one address away from the internet) is for the
 * person at this machine: a request from this machine with no session caller
 * header. A paired device, a session and a replica get 403.
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { CLOUD_MODE } from '../../constants.js'
import { getConfig, updateConfig } from '../../core/config-manager.js'
import { listExposeProviders } from '../../core/expose/registry.js'
import { EXPOSE_PROVIDER_ID } from '../../core/expose/types.js'
import { isLocalOrigin } from '../../lib/caller-origin.js'
import { requestOrigin } from '../middleware/request-origin.js'
import { getExposeRuntime } from '../expose-runtime.js'
import { log } from '../../logging/index.js'

export const exposeRouter = Router()

const MAX_OPTION_LENGTH = 200

/** The person at this machine, not a paired device and not a session acting for one. */
export function isPersonAtThisMachine(req: Request): boolean {
  if (CLOUD_MODE) return false
  if (req.get('x-walnut-caller-sid')) return false
  return isLocalOrigin(requestOrigin(req))
}

function refuse(res: Response): void {
  res.status(403).json({ error: 'Only you, at this computer, can change how Walnut is reached from outside (Settings, Phones & Cloud).', code: 'person_at_this_machine' })
}

function offStatus() {
  return { enabled: false, provider: null, state: 'off' as const, since: 0 }
}

exposeRouter.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const cfg = (await getConfig()).expose ?? {}
    res.json({
      status: getExposeRuntime()?.status() ?? offStatus(),
      providers: listExposeProviders(cfg.command),
      settings: {
        enabled: cfg.enabled === true,
        provider: cfg.provider ?? null,
        options: cfg.options ?? {},
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
    const body = (req.body ?? {}) as { enabled?: unknown; provider?: unknown; options?: unknown }
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
      res.status(400).json({ error: 'enabled is true or false' })
      return
    }
    if (body.provider !== undefined && body.provider !== null && (typeof body.provider !== 'string' || !EXPOSE_PROVIDER_ID.test(body.provider))) {
      res.status(400).json({ error: 'provider is a provider id' })
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
    const nextExpose = {
      ...before,
      ...(body.enabled !== undefined ? { enabled: body.enabled as boolean } : {}),
      ...(body.provider !== undefined ? { provider: (body.provider as string | null) ?? undefined } : {}),
      ...(options ? { options } : {}),
    }
    await updateConfig({ expose: nextExpose })
    log.web.info('expose settings changed', { enabled: nextExpose.enabled === true, provider: nextExpose.provider ?? null })
    const status = await getExposeRuntime()?.reconcile() ?? offStatus()
    res.json({ status })
  } catch (err) {
    next(err)
  }
})

exposeRouter.post('/retry', (req: Request, res: Response) => {
  if (!isPersonAtThisMachine(req)) return refuse(res)
  const runtime = getExposeRuntime()
  runtime?.retry()
  res.json({ status: runtime?.status() ?? offStatus() })
})
