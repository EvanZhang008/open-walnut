/**
 * Remote-host connection status.
 *
 * Two endpoints, both about ONE question: can this host be reached right now,
 * and if not, where is the connect and what should the user do?
 *   - GET  /api/hosts/status        hydrate (the live updates arrive as the
 *                                   `host:status` WS event, so nothing polls)
 *   - POST /api/hosts/:host/connect a deliberate human retry (connectHostNow,
 *                                   the same function as /api/sessions/host-retry)
 *   - POST /api/hosts/:host/check   Check again: re-run the readiness probe now
 *
 * On a cloud replica there is no ssh and no daemon of our own: reachability is
 * whether that host's bridge is dialled in, and connecting is the primary's job.
 */

import { Router } from 'express'
import { CLOUD_MODE } from '../../constants.js'
import { getConfig } from '../../core/config-manager.js'
import { buildHostStatus, listStatusHosts, type HostStatus } from '../../core/hosts/host-status.js'
import { checkHostNow, configHostDef, connectHostNow, hostStatusFrame } from '../../core/hosts/host-connect-action.js'
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

    // Disabled hosts are absent (listStatusHosts); the fixture, the ephemeral
    // "off" answer and the warmup's credential clock all ride hostStatusFrame.
    for (const { key, def } of entries) hosts.push(hostStatusFrame(key, def))
    res.json({ hosts })
  } catch (err) {
    next(err)
  }
})

// POST /api/hosts/:host/connect — the human just fixed their VPN / ssh key.
// connectHostNow: enabled check, failure cache cleared, autofix reset, the
// reconnect backoff cancelled, then the dial (fire-and-forget: progress arrives
// as `host:status`). The reply is the CURRENT status.
hostsRouter.post('/:host/connect', async (req, res, next) => {
  try {
    const host = typeof req.params.host === 'string' ? req.params.host.trim() : ''
    const r = await connectHostNow(host)
    res.status(r.httpStatus).json(r.body)
  } catch (err) {
    next(err)
  }
})

// POST /api/hosts/:host/check: Check again. The primary re-runs the host's
// readiness probe (force) and answers with the fresh frame; a replica relays it
// to the primary ('server.host-readiness-refresh') and the result comes back as
// the primary's normal status push.
hostsRouter.post('/:host/check', async (req, res, next) => {
  try {
    const host = typeof req.params.host === 'string' ? req.params.host.trim() : ''
    if (!host || host === '__local__') {
      res.status(400).json({ error: 'host is required' })
      return
    }
    if (CLOUD_MODE) {
      const { callPrimaryControl } = await import('./v1-control-relay.js')
      const r = await callPrimaryControl('server.host-readiness-refresh', '__server__', { host }, CHECK_RELAY_TIMEOUT_MS)
      if (r.ok) res.json({ ok: true, ...(r.result.status ? { status: r.result.status } : {}) })
      else res.status(503).json({ error: r.failure.message, code: 'check_failed' })
      return
    }
    const def = await configHostDef(host)
    if (!def || def.enabled === false) {
      res.status(404).json({ error: 'unknown host' })
      return
    }
    await checkHostNow(host, { force: true, deadlineMs: CHECK_DEADLINE_MS })
    res.json({ ok: true, status: hostStatusFrame(host, def) })
  } catch (err) {
    next(err)
  }
})

/** The UI's "Check again" waits 15s; the probe caps itself at 14s. */
const CHECK_DEADLINE_MS = 15_000
/** The relay hop to the primary, with the probe inside it. */
export const CHECK_RELAY_TIMEOUT_MS = 20_000
