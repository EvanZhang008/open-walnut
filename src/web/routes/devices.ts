/**
 * /api/devices — manage device tokens from the web console (the UI companion
 * to the `walnut device` CLI). The POST response carries the plaintext token
 * and a wn://pair URI exactly once — the console renders it as a QR code for
 * the iOS app to scan; only the hash is stored.
 *
 * Auth: inherited from the global /api authMiddleware (device Bearer tokens
 * in cloud mode, LAN bypass otherwise) — same trust level as the rest of the
 * console. A paired device minting more devices is by design (the console
 * itself is a paired device in cloud mode).
 */

import crypto from 'node:crypto'
import { Router, type Request, type Response, type NextFunction } from 'express'
import { createDevice, revokeDevice, listDevices, listDeviceRecords, type DeviceInfo } from '../../core/device-auth.js'
import { getPairingTargets, getCloudPairingEndpoint } from '../../core/pairing-targets.js'
import { CLOUD_MODE } from '../../constants.js'
import { log } from '../../logging/index.js'

export const devicesRouter = Router()

/**
 * Devices registered on the cloud companion. Best-effort — never throws, so an
 * unreachable cloud degrades to "no cloud devices" instead of a broken list.
 * `bridge-*` entries are daemon machine credentials, not user devices.
 */
async function listCloudDevices(): Promise<DeviceInfo[]> {
  const cloud = getCloudPairingEndpoint()
  if (!cloud) return []
  try {
    const res = await fetch(`${cloud.origin}/api/devices`, {
      headers: { Authorization: `Bearer ${cloud.token}` },
      signal: AbortSignal.timeout(8_000),
    })
    if (!res.ok) return []
    const body = await res.json() as { devices?: DeviceInfo[] }
    return (body.devices ?? []).filter((d) => !d.name.startsWith('bridge-'))
  } catch {
    return []
  }
}

/**
 * Name of the device record this Mac itself authenticates as against the cloud
 * (the credential embedded in the data repo's git remote). That row is
 * infrastructure — revoking it breaks git sync — so the console must not
 * present it as a pairable phone.
 */
async function getSelfCloudDeviceName(): Promise<string | null> {
  const cloud = getCloudPairingEndpoint()
  if (!cloud) return null
  const hash = crypto.createHash('sha256').update(cloud.token, 'utf-8').digest('hex')
  try {
    for (const d of await listDeviceRecords()) {
      if (d.tokenHash === hash) return d.name
    }
  } catch { /* unreadable auth.json — fall through */ }
  return null
}

/** `server` is omitted when no reachable address exists — see the POST handler. */
function buildPairingURI(name: string, token: string, origin?: string): string {
  const server = origin ? `&server=${encodeURIComponent(origin)}` : ''
  return `wn://pair?name=${encodeURIComponent(name)}&token=${token}${server}`
}

/**
 * Mint a device on the cloud companion using the Mac's own cloud credential,
 * mirroring ensureMachineToken() in src/integrations/cloud-bridge-config.ts.
 * The plaintext token is relayed straight to the console and never stored.
 */
async function mintOnCloud(
  name: string,
  replace = false,
): Promise<
  { name: string; token: string; pairingURI: string; createdAt: string; server: string }
  | { error: string; status: number }
> {
  const cloud = getCloudPairingEndpoint()
  if (!cloud) {
    return { error: 'Cloud pairing needs a cloud companion first (Settings → Cloud Companion).', status: 400 }
  }
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${cloud.token}` }
  try {
    if (replace) {
      // Rotate: the old hash must go before the cloud will accept the name.
      await fetch(`${cloud.origin}/api/devices/${encodeURIComponent(name)}`, {
        method: 'DELETE', headers, signal: AbortSignal.timeout(15_000),
      }).catch(() => null)
    }
    const res = await fetch(`${cloud.origin}/api/devices`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name }),
      signal: AbortSignal.timeout(15_000),
    })
    if (res.status !== 201) {
      const body = await res.json().catch(() => ({})) as { error?: string }
      return {
        error: body.error ?? `Cloud rejected the pairing request (HTTP ${res.status}).`,
        // A duplicate name is the caller's problem; anything else is upstream.
        status: res.status === 400 ? 400 : 502,
      }
    }
    const body = await res.json() as { name: string; token: string; createdAt: string }
    // Rebuild the URI against the cloud origin — never trust the cloud's own
    // idea of its host (it sits behind a proxy and may echo an internal name).
    return {
      name: body.name,
      token: body.token,
      createdAt: body.createdAt,
      server: cloud.origin,
      pairingURI: buildPairingURI(body.name, body.token, cloud.origin),
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.web.warn('devices: cloud mint failed', { name, error: message })
    return { error: `Could not reach the cloud companion: ${message}`, status: 502 }
  }
}

/** The port this request arrived on — used to build a LAN pairing origin. */
function requestPort(req: Request): number {
  const fromHost = Number(req.get('host')?.split(':')[1])
  if (Number.isInteger(fromHost) && fromHost > 0) return fromHost
  const addr = req.socket.localPort
  return Number.isInteger(addr) && addr! > 0 ? addr! : 3456
}

// GET /api/devices — list (no secrets) + where a phone can actually reach us.
// The console needs `targets` BEFORE minting so it can offer LAN vs Cloud;
// see src/core/pairing-targets.ts for why the console's own origin isn't it.
devicesRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const origin = `${req.protocol}://${req.get('host') ?? ''}`
    const targets = CLOUD_MODE
      ? [{ kind: 'cloud' as const, origin, label: 'This server', remoteMint: false }]
      : getPairingTargets(origin, requestPort(req))
    // Cloud-paired devices live in the cloud's auth.json — fetch them so the
    // console can list and revoke them (best-effort: a down cloud must not
    // break the local list).
    const cloudDevices = CLOUD_MODE ? [] : await listCloudDevices()
    // Only real, QR-pairable devices reach the console. Daemon bridge
    // credentials (kind:'machine' / the legacy `bridge-*` names) are plumbing —
    // listing them next to a "Show QR" button invited pairing a phone against a
    // daemon credential, and buried the one row that IS the user's phone.
    const devices = (await listDevices()).filter((d) => d.kind !== 'machine' && !d.name.startsWith('bridge-'))
    // Tell the console WHAT each credential is. Everything in auth.json is a
    // "device", but only some are phones — this Mac's own cloud credential and
    // the iOS simulator sit in the same list, and rendering all three
    // identically read as "3 phones I don't own" (reported 2026-07-29).
    const selfName = await getSelfCloudDeviceName()
    const classify = (name: string) =>
      name === selfName ? 'self' : /(^|-)sim(-|$)|simulator/i.test(name) ? 'simulator' : 'phone'
    res.json({
      devices: devices.map((d) => ({ ...d, role: classify(d.name) })),
      cloudDevices: cloudDevices.map((d) => ({ ...d, role: classify(d.name) })),
      targets: targets.map(({ kind, origin: o, label }) => ({ kind, origin: o, label })),
    })
  } catch (err) {
    next(err)
  }
})

// POST /api/devices { name, kind?, target? } → { name, token, pairingURI, createdAt }
// The token/URI appear ONLY in this response. kind:'machine' mints a daemon
// bridge credential (accepted only on the /bridge WS upgrade, never on REST).
//
// target:'cloud' pairs the phone with the cloud companion instead of this Mac.
// That token MUST be minted by the cloud box: auth.json never git-syncs, so a
// locally-created hash is unknown there and would 401 on every request.
devicesRouter.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : ''
    if (!name) {
      res.status(400).json({ error: 'name is required' })
      return
    }
    const kind = req.body?.kind === 'machine' ? 'machine' as const : undefined
    const wantsCloud = req.body?.target === 'cloud' && !CLOUD_MODE
    // replace:true = "show me a new QR for this phone". Tokens are one-time and
    // unrecoverable, so re-pairing an existing phone (app reinstalled → iOS
    // wipes UserDefaults → the app forgot the server URL) MUST rotate the
    // credential. Without this the console dead-ends on "already exists" and
    // the user has to Revoke-then-Add by hand.
    const replace = req.body?.replace === true

    if (wantsCloud) {
      const created = await mintOnCloud(name, replace)
      if ('error' in created) {
        res.status(created.status).json({ error: created.error })
        return
      }
      log.web.info('devices: created on cloud via console', { name, target: 'cloud' })
      res.status(201).json({ ...created, target: 'cloud', server: created.server })
      return
    }

    // The scanning phone needs an address IT can reach. The console's origin is
    // that address only when it isn't loopback — otherwise fall back to this
    // machine's LAN IP (a QR carrying `localhost` points the phone at itself).
    const consoleOrigin = `${req.protocol}://${req.get('host') ?? ''}`
    const target = CLOUD_MODE
      ? { origin: consoleOrigin, kind: 'cloud' as const }
      : getPairingTargets(consoleOrigin, requestPort(req))[0]
    // No reachable address (no LAN, no cloud)? Emit the URI WITHOUT `server=`
    // so the app asks for the address. A loopback `server=` is worse than
    // none: it silently points the phone at itself.
    if (replace) await revokeDevice(name) // rotate: drop the old hash first
    const { token, createdAt } = await createDevice(name, { kind })
    const pairingURI = buildPairingURI(name, token, target?.origin)
    log.web.info('devices: created via console', { name, kind: kind ?? 'device', target: target?.kind ?? 'none' })
    res.status(201).json({
      name, token, pairingURI, createdAt,
      target: target?.kind ?? null, server: target?.origin ?? null,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes('already exists') || message.includes('Invalid device name')) {
      res.status(400).json({ error: message })
      return
    }
    next(err)
  }
})

// DELETE /api/devices/:name[?target=cloud] — revoke. A cloud-paired device
// exists only in the CLOUD box's auth.json, so its revoke must go there too.
devicesRouter.delete('/:name', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const name = String(req.params.name ?? '')
    if (req.query.target === 'cloud' && !CLOUD_MODE) {
      const cloud = getCloudPairingEndpoint()
      if (!cloud) {
        res.status(400).json({ error: 'Cloud sync is not configured.' })
        return
      }
      const upstream = await fetch(`${cloud.origin}/api/devices/${encodeURIComponent(name)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${cloud.token}` },
        signal: AbortSignal.timeout(15_000),
      }).catch((err: unknown) => {
        log.web.warn('devices: cloud revoke failed', { name, error: String(err) })
        return null
      })
      if (!upstream) {
        res.status(502).json({ error: 'Could not reach the cloud companion.' })
        return
      }
      if (upstream.status === 404) {
        res.status(404).json({ error: `Device "${name}" not found on the cloud.` })
        return
      }
      if (!upstream.ok) {
        res.status(502).json({ error: `Cloud rejected the revoke (HTTP ${upstream.status}).` })
        return
      }
      log.web.info('devices: revoked on cloud via console', { name })
      res.json({ ok: true, target: 'cloud' })
      return
    }
    const removed = await revokeDevice(name)
    if (!removed) {
      res.status(404).json({ error: `Device "${name}" not found` })
      return
    }
    log.web.info('devices: revoked via console', { name })
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})
