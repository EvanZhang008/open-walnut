/**
 * /api/host-servers: the servers this Mac keeps on its hosts
 * (docs/plan/walnut-servers-everywhere.md, "A server on a host").
 *
 *   GET  /                    → { hosts: [{ hostKey, label, settings, view }], providers }
 *   PUT  /:hostKey            { enabled?, expose?: { enabled?, provider?, options? } } → { host }
 *   POST /:hostKey/retry      set it up again now (after a failed install, say)
 *   POST /:hostKey/expose/retry  start the host's tunnel again now
 *
 * Reading is for any caller the auth middleware let in. Changing it installs and
 * runs a program on the host and can put a tunnel in front of it, so it is for
 * the person at this machine (routes/expose.ts isPersonAtThisMachine). A replica
 * has no host servers: 404.
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { CLOUD_MODE } from '../../constants.js'
import { getConfig, updateHostServerConfig } from '../../core/config-manager.js'
import { listExposeProviders } from '../../core/expose/registry.js'
import { EXPOSE_PROVIDER_ID } from '../../core/expose/types.js'
import { getHostServerManager, hostServerSettingsFrom } from '../../core/host-server/index.js'
import { bus, EventNames } from '../../core/event-bus.js'
import { log } from '../../logging/index.js'
import { isPersonAtThisMachine } from './expose.js'

export const hostServersRouter = Router()

const HOST_KEY = /^[A-Za-z0-9._-]{1,64}$/
const MAX_OPTION_LENGTH = 200

function refuse(res: Response): void {
  res.status(403).json({ error: 'Only you, at this computer, can change which hosts run a Walnut server (Settings, Hosts).', code: 'person_at_this_machine' })
}

async function hostEntry(hostKey: string) {
  const host = (await getConfig()).hosts?.[hostKey]
  if (!host || host.cloud_box) return null
  const settings = hostServerSettingsFrom(host.server)
  return {
    hostKey,
    label: host.label?.trim() || hostKey,
    settings: { enabled: settings.enabled, expose: settings.expose, ...(settings.node ? { node: settings.node } : {}) },
    view: getHostServerManager()?.view(hostKey) ?? null,
  }
}

hostServersRouter.use((_req, res, next) => {
  if (CLOUD_MODE) { res.status(404).json({ error: 'not_found' }); return }
  next()
})

hostServersRouter.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const keys = Object.entries((await getConfig()).hosts ?? {}).filter(([, h]) => !h.cloud_box).map(([k]) => k)
    const hosts = (await Promise.all(keys.map(hostEntry))).filter((h) => h !== null)
    res.json({ hosts, providers: listExposeProviders().filter((p) => p.id !== 'command') })
  } catch (err) {
    next(err)
  }
})

hostServersRouter.put('/:hostKey', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!isPersonAtThisMachine(req)) return refuse(res)
    const hostKey = String(req.params.hostKey)
    if (!HOST_KEY.test(hostKey) || !(await hostEntry(hostKey))) {
      res.status(404).json({ error: `No host named ${hostKey}` })
      return
    }
    const body = (req.body ?? {}) as { enabled?: unknown; expose?: { enabled?: unknown; provider?: unknown; options?: unknown } }
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
      res.status(400).json({ error: 'enabled is true or false' })
      return
    }
    const patch: Record<string, unknown> = {}
    if (body.enabled !== undefined) patch.enabled = body.enabled
    if (body.expose !== undefined) {
      const e = body.expose
      if (!e || typeof e !== 'object') { res.status(400).json({ error: 'expose is an object' }); return }
      if (e.enabled !== undefined && typeof e.enabled !== 'boolean') { res.status(400).json({ error: 'expose.enabled is true or false' }); return }
      if (e.provider !== undefined && e.provider !== null && (typeof e.provider !== 'string' || !EXPOSE_PROVIDER_ID.test(e.provider))) {
        res.status(400).json({ error: 'expose.provider is a provider id' })
        return
      }
      const options: Record<string, string> = {}
      for (const [k, v] of Object.entries(e.options && typeof e.options === 'object' ? e.options as Record<string, unknown> : {})) {
        if (!/^[a-z][a-z0-9_]*$/i.test(k) || typeof v !== 'string' || v.length > MAX_OPTION_LENGTH) {
          res.status(400).json({ error: `expose.options.${k} must be a string of at most ${MAX_OPTION_LENGTH} characters` })
          return
        }
        options[k] = v
      }
      const before = hostServerSettingsFrom(((await getConfig()).hosts?.[hostKey] ?? {}).server).expose
      patch.expose = {
        enabled: e.enabled !== undefined ? e.enabled : before.enabled,
        ...((e.provider !== undefined ? e.provider : before.provider) ? { provider: e.provider !== undefined ? e.provider : before.provider } : {}),
        options: e.options !== undefined ? options : before.options,
      }
    }
    await updateHostServerConfig(hostKey, patch)
    // Settings re-reads the config on this (the Remote Hosts card shows the hosts too).
    bus.emit(EventNames.CONFIG_CHANGED, { config: await getConfig() }, ['web-ui'], { source: 'api' })
    log.web.info('host server settings changed', { host: hostKey, enabled: patch.enabled, expose: patch.expose ? (patch.expose as { enabled: boolean }).enabled : undefined })
    void getHostServerManager()?.reconcile(hostKey)
    res.json({ host: await hostEntry(hostKey) })
  } catch (err) {
    next(err)
  }
})

hostServersRouter.post('/:hostKey/retry', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!isPersonAtThisMachine(req)) return refuse(res)
    const hostKey = String(req.params.hostKey)
    if (!HOST_KEY.test(hostKey) || !(await hostEntry(hostKey))) { res.status(404).json({ error: `No host named ${hostKey}` }); return }
    void getHostServerManager()?.reconcile(hostKey)
    res.json({ host: await hostEntry(hostKey) })
  } catch (err) {
    next(err)
  }
})

hostServersRouter.post('/:hostKey/expose/retry', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!isPersonAtThisMachine(req)) return refuse(res)
    const hostKey = String(req.params.hostKey)
    if (!HOST_KEY.test(hostKey) || !(await hostEntry(hostKey))) { res.status(404).json({ error: `No host named ${hostKey}` }); return }
    await getHostServerManager()?.retryExpose(hostKey).catch((err: Error) => { throw Object.assign(err, { status: 502 }) })
    res.json({ host: await hostEntry(hostKey) })
  } catch (err) {
    const status = (err as { status?: number }).status
    if (status === 502) { res.status(502).json({ error: (err as Error).message }); return }
    next(err)
  }
})
