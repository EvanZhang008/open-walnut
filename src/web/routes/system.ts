/**
 * System health API — exposes daemon connection status.
 */

import { Router } from 'express'
import { getSystemHealth } from '../server.js'
import { getDaemonPoolStatus, getConnectedDaemonConnection } from '../../providers/daemon-connection.js'
import { isOnThisMachine } from './expose.js'
import { log } from '../../logging/index.js'
import { getConfig } from '../../core/config-manager.js'
import { CLOUD_MODE } from '../../constants.js'
import { validateBearerCredential } from '../middleware/auth.js'
import { createDesktopUpdateCache, EMPTY_DESKTOP_UPDATE, type DesktopUpdateAnswer } from './desktop-update-cache.js'
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
      ...(health.claudeCodeNeeded !== undefined ? { claudeCodeNeeded: health.claudeCodeNeeded } : {}),
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

const desktopUpdateCache = createDesktopUpdateCache()

systemRouter.get('/desktop-update', async (req, res) => {
  const empty = { available: false, token: null, version: null }
  // Only a page that shows the update in its bottom notice asks with `notice=1`.
  // An older page would show it as a sidebar item; it hears nothing, and its own
  // "Walnut updated · Reload" notice brings it to the page that asks. A session on
  // this machine reads it too (it may restart the app as the person may); a paired
  // device or the companion hears nothing.
  if (req.query.notice !== '1' || !isOnThisMachine(req) || process.platform !== 'darwin') { res.json(empty); return }
  const daemon = getConnectedDaemonConnection('__local__')
  if (!daemon?.hasCapability('desktop-update-v1')) { res.json(empty); return }
  // The last answer, refreshed behind the request (desktop-update-cache.ts).
  res.json(await desktopUpdateCache.get(daemon, async () => {
    const result = await daemon.send('desktop.updateStatus', {}, 7000)
    // The daemon's reply is untyped JSON; it is relayed field for field as before.
    return result.ok ? {
      available: result.available, token: result.token, version: result.version, restarting: result.restarting, error: result.error,
      ...(typeof result.windows === 'number' ? { windows: result.windows } : {}),
    } as DesktopUpdateAnswer : EMPTY_DESKTOP_UPDATE
  }))
})

// A session on this machine may restart the app as the person may (2026-10-27, the
// user: "all human action can be done by agent also"); the call is logged with it.
// `force` is the page's word that the person checked every open window, which a
// session cannot do: a session's restart always goes through the open-windows
// guard, and the answer says when its `force` was ignored.
systemRouter.post('/desktop-update/restart', async (req, res) => {
  if (!isOnThisMachine(req) || process.platform !== 'darwin') { res.status(403).json({ error: 'Restart is only available at this computer.' }); return }
  const daemon = getConnectedDaemonConnection('__local__')
  if (!daemon?.hasCapability('desktop-update-v1')) { res.status(503).json({ error: 'The local daemon is not ready.' }); return }
  const token = req.body?.token
  if (typeof token !== 'string' || !token || token.length > 200) { res.status(400).json({ error: 'An update token is required.' }); return }
  try {
    const callerSid = req.get('x-walnut-caller-sid')
    const asked = req.body?.force === true
    const forceIgnored = !!callerSid && asked
    if (callerSid) log.web.info('desktop update: restart asked by a session', { callerSid, force: asked, forceIgnored })
    const ignoredNote = forceIgnored
      ? { forceIgnored: true, note: 'force was ignored: only the person at this computer can confirm the other open app windows. While one is open the app does not restart; ask the user.' }
      : {}
    // force: the page checked every app window (or the user chose to restart anyway).
    const result = await daemon.send('desktop.restart', { token, force: asked && !callerSid }, 7000)
    if (result.ok && result.accepted) desktopUpdateCache.noteRestart()
    if (!result.ok || !result.accepted) { res.status(409).json({ error: 'The installed update changed. Check again before restarting.', ...ignoredNote }); return }
    res.status(202).json({ accepted: true, ...ignoredNote })
  } catch { res.status(503).json({ error: 'Could not request the app restart. Try again.' }) }
})

// ── Is a newer Open Walnut published? (src/core/self-update) ──

/** The registry call is 5 s; this is the route's own ceiling so a stalled socket never pins a request. */
const UPDATE_CHECK_DEADLINE_MS = 8_000

const updateStatusForClient = async (o: { freshTurns?: boolean } = {}) =>
  (await import('../../core/self-update/client-status.js')).updateStatusForClient(o)

// GET /api/system/update: the cached answer, never a network call. The live
// update's idle gate counts the running turns now (bounded), so the Mac app's
// page restarts its shell on a current answer.
systemRouter.get('/update', async (_req, res) => {
  res.json(await updateStatusForClient({ freshTurns: true }))
})

// POST /api/system/update/install {}: install `latest` now (also with updates.auto
// off or a held version: the person asked) and restart as soon as it is in.
// POST /api/system/update/restart {}: restart into the version already installed.
// Person actions; a session may ask too (agent parity), logged with its id.
for (const action of ['install', 'restart'] as const) {
  systemRouter.post(`/update/${action}`, async (req, res) => {
    const { getLiveUpdater } = await import('../../core/self-update/live-update.js')
    const caller = req.get('x-walnut-caller-sid') ?? null
    // A test run (a browser under automation on the real Walnut) never replaces or restarts it.
    const testRun = (await import('../../core/test-run.js')).ambientTestRun()
    if (testRun) { res.status(409).json({ error: 'test_run', message: 'A test run does not install or restart this Walnut.' }); return }
    log.web.info(`update: ${action} asked`, { caller })
    const updater = getLiveUpdater()
    const answer = updater
      ? (action === 'install' ? updater.installNow(caller) : updater.restartNow('asked', caller))
      : { ok: false as const, code: action === 'install' ? 'cannot_install' as const : 'no_restart' as const, fix: null }
    const status = await updateStatusForClient()
    if (answer.ok) { res.status(202).json(status); return }
    // The client's command: for an install this user cannot write it is the sudo one.
    const fix = answer.code === 'cannot_install' ? (status.install.updateCommand ?? answer.fix ?? null) : undefined
    res.status(409).json({ error: answer.code, ...(fix !== undefined ? { fix } : {}), status })
  })
}

// POST /api/system/update/check: ask the registry now (the card's "Check now",
// `walnut update --check`). 202 with the stored status when the check outran the deadline.
systemRouter.post('/update/check', async (_req, res) => {
  const { getUpdateChecker } = await import('../../core/self-update/update-check.js')
  const checker = getUpdateChecker()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), UPDATE_CHECK_DEADLINE_MS) })
  const done = await Promise.race([checker.checkNow(), deadline])
  clearTimeout(timer)
  res.status(done ? 200 : 202).json(await updateStatusForClient())
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
