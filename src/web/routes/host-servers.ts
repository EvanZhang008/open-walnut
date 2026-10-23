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
import { MaskedValueError, maskSecretShapes, restoreMaskedSecrets } from '../../core/config-secret-shape.js'
import { listExposeProviders } from '../../core/expose/registry.js'
import { EXPOSE_PROVIDER_ID } from '../../core/expose/types.js'
import { getHostServerManager, hostServerSettingsFrom, withThisWalnutTunnel } from '../../core/host-server/index.js'
import { emitConfigChanged } from '../../core/config-broadcast.js'
import { log } from '../../logging/index.js'
import { DEFAULT_COPY_CHOICE, copyChoiceChanged, copyChoiceFrom } from '../../core/replication/kinds/copy-kind.js'
import { isPersonAtThisMachine } from './expose.js'

export const hostServersRouter = Router()

const HOST_KEY = /^[A-Za-z0-9._-]{1,64}$/
const MAX_OPTION_LENGTH = 200

function refuse(res: Response): void {
  res.status(403).json({ error: 'Only you, at this computer, can change which hosts run a Walnut server (Settings, Hosts).', code: 'person_at_this_machine' })
}

async function hostEntry(hostKey: string) {
  const config = await getConfig()
  const host = config.hosts?.[hostKey]
  if (!host || host.cloud_box) return null
  const own = hostServerSettingsFrom(host.server)
  // This Walnut's tunnel placed (Open from a browser): the host that carries it runs a server.
  const settings = withThisWalnutTunnel(hostKey, own, config)
  // The host's own tunnel as set (the carried one is this computer's, set in Open from a browser),
  // with the reason when it is held back.
  const expose = settings.expose.blocked ? { ...own.expose, blocked: settings.expose.blocked } : own.expose
  return {
    hostKey,
    label: host.label?.trim() || hostKey,
    // The tunnel provider's options are a free-form map: secret-shaped values masked,
    // as in GET /api/config. PUT puts a mask back.
    settings: {
      enabled: settings.enabled,
      ...(settings.carriesTunnel ? { carriesTunnel: true } : {}),
      expose: { ...expose, options: maskSecretShapes(expose.options) },
      ...(settings.node ? { node: settings.node } : {}),
      // Which kinds the Mac copies to this host's replica (WP4), defaults filled in.
      copies: copyChoiceFrom((host.server as { copies?: unknown } | undefined)?.copies),
      ...(host.server_program ? { program: host.server_program } : {}),
    },
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
    const body = (req.body ?? {}) as { enabled?: unknown; expose?: { enabled?: unknown; provider?: unknown; options?: unknown }; copies?: unknown }
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
        // The form saves every option back, a masked one too: that one keeps its stored value.
        options: e.options !== undefined ? restoreMaskedSecrets(options, before.options, `hosts.${hostKey}.server.expose.options`) : before.options,
      }
    }
    if (body.copies !== undefined) {
      const c = body.copies as Record<string, unknown> | null
      const known = Object.keys(DEFAULT_COPY_CHOICE)
      if (!c || typeof c !== 'object' || Array.isArray(c) || Object.entries(c).some(([k, v]) => !known.includes(k) || typeof v !== 'boolean')) {
        res.status(400).json({ error: `copies names only ${known.join(', ')}, each true or false` })
        return
      }
      const before = ((await getConfig()).hosts?.[hostKey]?.server as { copies?: Record<string, boolean> } | undefined)?.copies ?? {}
      const next: Record<string, boolean> = { ...before, ...(c as Record<string, boolean>) }
      // Bodies ride with the index: turning the inbox off turns bodies off too, so
      // turning the inbox on again never brings back a body choice the user cannot see.
      if (next.inbox === false) next.inbox_bodies = false
      if (next.conversations === false) next.conversation_bodies = false
      patch.copies = next
    }
    await updateHostServerConfig(hostKey, patch)
    // Settings re-reads the config on this (the Remote Hosts card shows the hosts too).
    // In the client view, like GET /api/config: `web-ui` sends it to every connected client.
    emitConfigChanged(await getConfig(), ['web-ui'], { source: 'api' })
    log.web.info('host server settings changed', { host: hostKey, enabled: patch.enabled, expose: patch.expose ? (patch.expose as { enabled: boolean }).enabled : undefined, ...(patch.copies ? { copies: patch.copies } : {}) })
    void getHostServerManager()?.reconcile(hostKey)
    // A kind turned on copies now, one turned off is purged now (not at the next sweep).
    if (patch.copies) copyChoiceChanged()
    res.json({ host: await hostEntry(hostKey) })
  } catch (err) {
    if (err instanceof MaskedValueError) {
      res.status(400).json({ error: err.message, code: err.code, field: err.field, reason: err.reason })
      return
    }
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
