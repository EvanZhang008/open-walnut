/**
 * System health API — exposes daemon connection status.
 */

import { Router } from 'express'
import { getSystemHealth } from '../server.js'
import { getDaemonPoolStatus } from '../../providers/daemon-connection.js'
import { getConfig } from '../../core/config-manager.js'
import { CLOUD_MODE } from '../../constants.js'
import { validateBearerCredential } from '../middleware/auth.js'
import { getBuildInfo } from '../../lib/build-info.js'

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

  // Build response with optional daemons field. `build` (commit + branch) stays
  // on the detailed view: an anonymous cloud caller gets liveness only.
  const response: Record<string, unknown> = { ...health, build: getBuildInfo() }

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

// ── This machine's Claude Code (the setup banner) ──

/** The banner's re-check answers inside this even when the probe hangs (the daemon caps itself at 12s). */
const LOCAL_CHECK_DEADLINE_MS = 14_000

// POST /api/system/local-claude/check: ask this machine again. `{ poll: true }`
// (the banner's 15s timer) is answered from a result under 10s old, so several
// open windows share one probe; a click always asks.
systemRouter.post('/local-claude/check', async (req, res) => {
  if (CLOUD_MODE) { res.status(404).json({ error: 'not available on a cloud companion' }); return }
  const { refreshLocalClaude, getLocalClaude } = await import('../../core/hosts/local-readiness.js')
  const poll = (req.body as { poll?: unknown } | undefined)?.poll === true
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), LOCAL_CHECK_DEADLINE_MS) })
  const status = await Promise.race([refreshLocalClaude({ maxAgeMs: poll ? 10_000 : 0 }), deadline])
  clearTimeout(timer)
  // Timed out or failed: the stored answer (with its checkError), never a hang.
  res.status(status ? 200 : 202).json({ localClaude: status ?? getLocalClaude() ?? null })
})

// POST /api/system/local-claude/fix { kind }: the banner's one-click install or
// update for one problem. Answers at once; progress arrives on system:health.
systemRouter.post('/local-claude/fix', async (req, res) => {
  if (CLOUD_MODE) { res.status(404).json({ error: 'not available on a cloud companion' }); return }
  const { startLocalClaudeFix, getLocalClaude } = await import('../../core/hosts/local-readiness.js')
  const kind = (req.body as { kind?: unknown } | undefined)?.kind
  const started = startLocalClaudeFix(typeof kind === 'string' ? kind : '')
  if (!started.ok) { res.status(409).json({ error: started.error, localClaude: getLocalClaude() ?? null }); return }
  res.status(202).json({ localClaude: started.status })
})
