/**
 * System health API — exposes daemon connection status.
 */

import { Router } from 'express'
import { getSystemHealth } from '../server.js'
import { getDaemonPoolStatus } from '../../providers/daemon-connection.js'
import { getConfig } from '../../core/config-manager.js'
import { CLOUD_MODE } from '../../constants.js'
import { validateBearerCredential } from '../middleware/auth.js'

export const systemRouter = Router()

/**
 * Is this a trusted caller allowed to see health DETAIL (daemon host list +
 * credential provenance)? On the Mac (trusted LAN) always yes. In cloud mode
 * the path is auth-exempt (so a load balancer can probe liveness), so a public
 * internet caller would otherwise enumerate our host aliases and credential
 * source — require a real device token for the detailed view there.
 */
async function maySeeHealthDetail(authHeader: string | undefined): Promise<boolean> {
  if (!CLOUD_MODE) return true
  if (!authHeader?.startsWith('Bearer ')) return false
  const cred = await validateBearerCredential(authHeader.slice(7))
  return !!cred && cred.kind !== 'machine'
}

// GET /api/system/health — liveness always; daemon + credential detail only for
// trusted callers (auth-exempt path, so we gate the sensitive fields in-handler).
systemRouter.get('/health', async (req, res) => {
  const detailed = await maySeeHealthDetail(req.headers.authorization)
  const health = getSystemHealth()

  if (!detailed) {
    // Public internet: liveness + readiness booleans only (the SPA's setup
    // banner needs these). Withhold the SENSITIVE fields — credentialSource /
    // credentialDetail (e.g. "profile: dev") and the daemon host list.
    res.json({
      status: 'ok',
      claudeCliAvailable: health.claudeCliAvailable,
      hasReadyProvider: health.hasReadyProvider,
    })
    return
  }

  // Build response with optional daemons field
  const response: Record<string, unknown> = { ...health }

  try {
    const config = await getConfig()
    const hosts = config.hosts
    if (hosts && Object.keys(hosts).length > 0) {
      let activeMap = new Map<string, { connected: boolean; bridgeConnected: boolean | null }>()
      try {
        activeMap = new Map(getDaemonPoolStatus().map(d => [d.host, d]))
      } catch { /* pool not ready */ }

      response.daemons = Object.entries(hosts).map(([key, def]) => ({
        host: key,
        label: def.label ?? def.hostname,
        connected: activeMap.get(key)?.connected ?? false,
        // null = unknown / no cloud bridge configured for this host.
        bridgeConnected: activeMap.get(key)?.bridgeConnected ?? null,
      }))
    }
  } catch { /* config not ready */ }

  res.json(response)
})
