/**
 * Remote-host connection status.
 *
 * Two endpoints, both about ONE question: can this host be reached right now,
 * and if not, where is the connect and what should the user do?
 *   - GET  /api/hosts/status        hydrate (the live updates arrive as the
 *                                   `host:status` WS event, so nothing polls)
 *   - POST /api/hosts/:host/connect a deliberate human retry
 *
 * On a cloud replica there is no ssh and no daemon of our own: reachability is
 * whether that host's bridge is dialled in, and connecting is the primary's job.
 */

import { Router } from 'express'
import { CLOUD_MODE } from '../../constants.js'
import { getConfig } from '../../core/config-manager.js'
import { buildHostStatus, listStatusHosts, type HostStatus } from '../../core/hosts/host-status.js'
import { getHostWarmup } from '../../core/hosts/host-warmup-registry.js'
import type { DaemonConnectState } from '../../providers/daemon-connection.js'

export const hostsRouter = Router()

/** A replica never dials ssh, so every phase but connected/idle is meaningless there. */
async function cloudState(hostKey: string): Promise<DaemonConnectState> {
  const { bridgeForHost } = await import('../ws/bridge-registry.js')
  const connected = bridgeForHost(hostKey).connected
  return {
    host: hostKey,
    connected,
    phase: connected ? 'connected' : 'idle',
    phaseElapsedMs: 0,
    connectElapsedMs: 0,
  }
}

// GET /api/hosts/status — every host the folder picker would offer, with where
// its connect stands. Cheap and side-effect free: it NEVER starts a connect
// (a status read that dials would make the picker's own render an ssh storm).
hostsRouter.get('/status', async (_req, res, next) => {
  try {
    const config = await getConfig()
    const entries = listStatusHosts(config)
    const hosts: HostStatus[] = []

    if (CLOUD_MODE) {
      for (const { key, def } of entries) {
        hosts.push(buildHostStatus(key, def, await cloudState(key)))
      }
      res.json({ hosts })
      return
    }

    const { getDaemonConnectState } = await import('../../providers/daemon-connection.js')
    const warmup = getHostWarmup()?.snapshot() ?? {}
    for (const { key, def } of entries) {
      hosts.push(buildHostStatus(key, def, getDaemonConnectState(key), warmup[key]?.state))
    }
    res.json({ hosts })
  } catch (err) {
    next(err)
  }
})

// POST /api/hosts/:host/connect — the human just fixed their VPN / ssh key.
// Clears the 60s failure cache (which exists to throttle AUTOMATIC retries, not
// a deliberate one) and hands the host to the warmup. Fire-and-forget: the reply
// is the CURRENT status, and progress arrives over the `host:status` WS event.
hostsRouter.post('/:host/connect', async (req, res, next) => {
  try {
    const host = typeof req.params.host === 'string' ? req.params.host.trim() : ''
    if (!host || host === '__local__') {
      res.status(400).json({ error: 'host is required' })
      return
    }
    if (CLOUD_MODE) {
      res.status(409).json({ error: 'a cloud replica cannot connect to hosts; run this on the primary' })
      return
    }
    const config = await getConfig()
    const hosts = config.hosts ?? {}
    // hasOwn, not `hosts[host]`: `__proto__` / `constructor` are truthy lookups.
    const def = Object.hasOwn(hosts, host) ? hosts[host] : undefined
    if (!def) {
      res.status(404).json({ error: `Unknown host: ${host}` })
      return
    }
    if (def.enabled === false) {
      // The warmup would skip it silently and the button would look dead.
      res.status(409).json({ error: `${host} is disabled; enable it in Settings > Remote hosts first`, code: 'host_disabled' })
      return
    }

    const { clearDaemonFailureCache, getDaemonConnection, getDaemonConnectState } =
      await import('../../providers/daemon-connection.js')
    clearDaemonFailureCache(host)
    const warmup = getHostWarmup()
    if (warmup) {
      // Resolves once the host is QUEUED (listing hosts, no ssh), so the reply
      // below already says "waiting for its turn" / "connecting" instead of the
      // 'idle' it was a millisecond ago.
      await warmup.kick(host).catch(() => { /* kick never rejects; belt and braces */ })
    } else {
      // No warmup in this process (WALNUT_HOST_WARMUP=0, sandbox): a deliberate
      // human connect still has to dial something.
      getDaemonConnection(host, { hostname: def.hostname, user: def.user, port: def.port })
        .catch(() => { /* recorded in the failure cache and pushed as host:status */ })
    }

    res.json({ ok: true, status: buildHostStatus(host, def, getDaemonConnectState(host), warmup?.stateOf(host)) })
  } catch (err) {
    next(err)
  }
})
