/**
 * The host network, from the Mac's Settings > Remote Hosts (core/net/net-mac.ts,
 * docs/reference/host-network.md):
 *
 *   GET    /api/hosts/net                 on or off, this Mac's id, each machine and its path now
 *   POST   /api/hosts/net/invites {name?} a link a new machine runs to join (10 minutes, one use)
 *   GET    /api/hosts/net/invites/:id     waiting | joined | expired
 *   POST   /api/hosts/net/sync            read the list again (the companion's, or this Mac's)
 *   PUT    /api/hosts/net/relay {relay}   own | public | none: how machines reach each other
 *   DELETE /api/hosts/net/machines/:host  take a machine out
 *
 * Every route answers within its deadline: the companion and the daemon are both
 * a network hop away, and a pinned response starves the browser's connection pool.
 */
import { Router, type Response } from 'express'
import { NetError, netState, relayNow, removeMachine, setRelay, syncNet } from '../../core/net/net-mac.js'
import { inviteStatus, makeInvite } from '../../core/net/net-invites.js'

export const hostsNetRouter = Router()

const STATUS_DEADLINE_MS = 6_000
const WRITE_DEADLINE_MS = 60_000

function within<T>(ms: number, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    work.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new NetError(504, 'timeout', 'The host network did not answer in time; try again.')), ms) }),
  ])
}

function sendError(res: Response, err: unknown): void {
  if (err instanceof NetError) { res.status(err.status).json({ error: err.message, code: err.code }); return }
  res.status(500).json({ error: (err as Error).message ?? String(err), code: 'failed' })
}

interface PeerLink { path?: string; rttMs?: number | null }

/** What this Mac's walnut-net says of each machine now (empty when it is off or slow). */
async function peerLinks(): Promise<Map<string, PeerLink & { connected: boolean }>> {
  const out = new Map<string, PeerLink & { connected: boolean }>()
  try {
    const { link } = await import('../../core/hosts/link.js')
    const local = await link('__local__')
    if (!local.hasCapability('net-v1')) return out
    const s = await local.send('net.status', {}, STATUS_DEADLINE_MS - 1_000) as { node?: { peers?: Array<{ id: string; link?: PeerLink }> } | null }
    for (const p of s.node?.peers ?? []) out.set(p.id, { ...(p.link ?? {}), connected: !!p.link && p.link.path !== 'none' })
  } catch { /* shown as unknown */ }
  return out
}

hostsNetRouter.get('/', async (_req, res) => {
  try {
    const state = netState()
    const [{ getConfig }, links, now] = await Promise.all([
      import('../../core/config-manager.js'), within(STATUS_DEADLINE_MS, peerLinks()).catch(() => new Map()),
      within(STATUS_DEADLINE_MS, relayNow()).catch(() => ({ companion: state.companion, relay: state.relay })),
    ])
    const hosts = (await getConfig()).hosts ?? {}
    const machines = Object.entries(hosts)
      .filter(([, h]) => h.transport === 'net' && typeof h.endpoint === 'string')
      .map(([name, h]) => {
        const member = state.members.find((m) => m.id === h.endpoint)
        const l = links.get(h.endpoint as string)
        return {
          host: name, endpoint: h.endpoint, enabled: h.enabled !== false,
          ...(member?.platform ? { platform: member.platform } : {}),
          ...(member?.addedAt ? { addedAt: member.addedAt } : {}),
          path: l ? (l.connected ? l.path : 'none') : 'unknown',
          ...(typeof l?.rttMs === 'number' ? { rttMs: l.rttMs } : {}),
        }
      })
    res.json({
      enabled: state.enabled, macId: state.macId, companion: now.companion, relay: now.relay, relays: state.relays,
      syncedAt: state.syncedAt, error: state.error, machines,
    })
  } catch (err) {
    sendError(res, err)
  }
})

hostsNetRouter.post('/invites', async (req, res) => {
  try {
    res.status(201).json(await within(WRITE_DEADLINE_MS, makeInvite({ name: (req.body ?? {}).name })))
  } catch (err) {
    sendError(res, err)
  }
})

hostsNetRouter.get('/invites/:id', (req, res) => {
  const inv = inviteStatus(String(req.params.id))
  if (!inv) { res.status(404).json({ error: 'No such invite (a restart forgets them; make a new one)', code: 'unknown_invite' }); return }
  res.json(inv)
})

hostsNetRouter.post('/sync', async (_req, res) => {
  try {
    res.json(await within(WRITE_DEADLINE_MS, syncNet()))
  } catch (err) {
    sendError(res, err)
  }
})

hostsNetRouter.put('/relay', async (req, res) => {
  try {
    res.json(await within(WRITE_DEADLINE_MS, setRelay((req.body ?? {}).relay)))
  } catch (err) {
    sendError(res, err)
  }
})

hostsNetRouter.delete('/machines/:host', async (req, res) => {
  try {
    res.json(await within(WRITE_DEADLINE_MS, removeMachine(String(req.params.host))))
  } catch (err) {
    sendError(res, err)
  }
})
