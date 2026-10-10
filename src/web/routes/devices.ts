/**
 * /api/devices — manage device tokens from the web console (the UI companion
 * to the `walnut device` CLI). The POST response carries the plaintext token
 * and a wn://pair URI exactly once — the console renders it as a QR code for
 * the iOS app to scan; only the hash is stored.
 *
 * Auth: inherited from the global /api authMiddleware (device Bearer tokens
 * in cloud mode, LAN bypass otherwise) — same trust level as the rest of the
 * console. A paired device minting more devices is by design (the console
 * itself is a paired device in cloud mode), except a phone.
 *
 * Changing an EXISTING device (re-pair, remove) is for that device itself, the
 * Mac that owns this companion's machine credentials, or this machine itself
 * (core/device-actor.ts). The caller is the token it presented, never a name.
 *
 * The cloud half (`target: 'cloud'`, `?target=cloud`, `cloudDevices`) is this
 * Mac acting on its companion with its own token there, so it is for this Mac
 * itself only (cloudRelayDecision); everyone else hears 403 first.
 */

import crypto from 'node:crypto'
import { Router, type Request, type Response, type NextFunction } from 'express'
import { createDevice, revokePairing, rotateDevice, listDevices, listDeviceRecords, type DeviceInfo } from '../../core/device-auth.js'
import { DeviceChangeRefused, LOCAL_ACTOR, cloudRelayDecision, type DeviceActor, type DeviceChange } from '../../core/device-actor.js'
import { getPairingTargets, getCloudPairingEndpoint } from '../../core/pairing-targets.js'
import { tailscaleSummary } from '../../core/tailnet.js'
import { CLOUD_MODE } from '../../constants.js'
import { log } from '../../logging/index.js'
import { requestOrigin } from '../middleware/request-origin.js'
import { isLocalOrigin } from '../../lib/caller-origin.js'
import {
  MACHINE_PROOF_HEADER, MachineCredentialRefused, adoptMachineCredential, mintMachineCredential, revokeMachineCredential,
} from '../../core/machine-credentials.js'

export const devicesRouter = Router()

/**
 * Who is asking. This machine itself only for a request this machine trusts
 * that also acts for a caller on this Mac (the console, a local client, a
 * session on this Mac): the op executor's loopback self-calls carry the
 * ORIGINAL caller's class in x-walnut-origin (src/lib/caller-origin.ts), and one
 * made for a session on another exec host or for a paired client is that
 * caller, never this Mac (request-origin.ts: the header only lowers trust).
 * Never this Mac on a companion, whose public traffic reaches it through a
 * local proxy. Else the credential the auth middleware accepted: a paired
 * device by its token, a config.yaml API key by its name. A self-call for a
 * caller off this Mac that carries no credential is its origin alone.
 */
export function actorOf(req: Request): DeviceActor {
  const origin = requestOrigin(req)
  if (!CLOUD_MODE && isLocalOrigin(origin)) return LOCAL_ACTOR
  const named = req as Request & { apiKeyName?: string; deviceName?: string }
  const header = req.headers.authorization
  if (header?.startsWith('Bearer ')) {
    // The auth middleware names every credential it accepts and marks the
    // paired devices among them: a named one that is no device is an API key.
    return named.apiKeyName && !named.deviceName ? { apiKey: named.apiKeyName } : { token: header.slice(7) }
  }
  return { onBehalfOf: origin }
}

/** Name of the caller for logs (the auth middleware's; absent for an API key). */
function callerDevice(req: Request): string | undefined {
  return (req as Request & { deviceName?: string }).deviceName
}

/** A refusal from the device rules, as the console shows it. */
export function sendRefusal(res: Response, err: unknown): boolean {
  if (err instanceof MachineCredentialRefused || err instanceof DeviceChangeRefused) {
    res.status(err.status).json({ error: err.message, code: err.code })
    return true
  }
  return false
}

/**
 * Before any relay to the cloud companion, which speaks with this Mac's own
 * token there: the caller must be this Mac itself (device-actor.ts
 * cloudRelayDecision). Otherwise answers the refusal and returns false.
 */
async function cloudRelayAllowed(req: Request, res: Response, change: DeviceChange): Promise<boolean> {
  const decision = cloudRelayDecision(await listDeviceRecords(), actorOf(req), change)
  if (decision.ok) return true
  log.web.warn('devices: cloud relay refused', { caller: callerDevice(req), change, code: decision.refusal.code })
  sendRefusal(res, decision.refusal)
  return false
}

/** A machine credential's current token, presented as proof of holding it. */
function machineProof(req: Request): string | undefined {
  const v = req.get(MACHINE_PROOF_HEADER)
  return v && v.length <= 128 ? v : undefined
}

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

/**
 * `server` is omitted when no reachable address exists — see the POST handler.
 *
 * The `wn://` scheme is INTENTIONALLY not part of the internal wn→walnut rename:
 * it is the shipped iOS pairing contract (AppConfig.parsePairingURI, the QR
 * scanner, pasted links), so changing it would break already-installed builds.
 */
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
      const del = await fetch(`${cloud.origin}/api/devices/${encodeURIComponent(name)}`, {
        method: 'DELETE', headers, signal: AbortSignal.timeout(15_000),
      }).catch(() => null)
      // The companion's own rules said no (this Mac may not re-pair that device): say its words.
      if (del && (del.status === 403 || del.status === 409)) {
        const body = await del.json().catch(() => ({})) as { error?: string }
        return { error: body.error ?? `Cloud refused to re-pair ${name} (HTTP ${del.status}).`, status: del.status }
      }
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
      : await getPairingTargets(origin, requestPort(req))
    // Cloud-paired devices live in the cloud's auth.json — fetch them so the
    // console can list and revoke them (best-effort: a down cloud must not
    // break the local list). That half is this Mac's view on its companion
    // (its own token there): for this Mac itself only, like every other relay.
    const relayed = !CLOUD_MODE && cloudRelayDecision([], actorOf(req), 'list').ok
    const cloudDevices = relayed ? await listCloudDevices() : []
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
    const tailscale = CLOUD_MODE ? null : await tailscaleSummary()
    // A browser signed in with a code (routes/browser-pair.ts) is named browser-<6 hex>.
    const classify = (name: string) =>
      name === selfName ? 'self' : /(^|-)sim(-|$)|simulator/i.test(name) ? 'simulator'
        : /^browser-[0-9a-f]{6}$/.test(name) ? 'browser' : 'phone'
    res.json({
      devices: devices.map((d) => ({ ...d, role: classify(d.name) })),
      cloudDevices: cloudDevices.map((d) => ({ ...d, role: classify(d.name) })),
      targets: targets.filter((t) => CLOUD_MODE || relayed || t.kind !== 'cloud').map(({ kind, origin: o, label }) => ({ kind, origin: o, label })),
      // So the console can say "install Tailscale" when no tailnet target exists.
      // Absent = say nothing: on a companion, and while the first probe is still out.
      ...(tailscale ? { tailscale } : {}),
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
    // On the companion a name that already is a machine credential stays one:
    // a "re-pair" of it (replace:true, no kind) goes through the machine rules
    // too, or it would be a way around them.
    const existingMachine = CLOUD_MODE && req.body?.kind !== 'machine'
      && (await listDeviceRecords()).some((d) => d.name === name && d.kind === 'machine')
    const kind = req.body?.kind === 'machine' || existingMachine ? 'machine' as const : undefined
    const wantsCloud = req.body?.target === 'cloud' && !CLOUD_MODE
    // replace:true = "show me a new QR for this phone". Tokens are one-time and
    // unrecoverable, so re-pairing an existing phone (app reinstalled → iOS
    // wipes UserDefaults → the app forgot the server URL) MUST rotate the
    // credential. Without this the console dead-ends on "already exists" and
    // the user has to Revoke-then-Add by hand.
    const replace = req.body?.replace === true

    if (wantsCloud) {
      if (!await cloudRelayAllowed(req, res, replace ? 'rotate' : 'create')) return
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
    // `target: 'lan' | 'tailnet'` picks that address for the QR when this Mac has it.
    const localTargets = CLOUD_MODE ? [] : await getPairingTargets(consoleOrigin, requestPort(req))
    const target = CLOUD_MODE
      ? { origin: consoleOrigin, kind: 'cloud' as const }
      : localTargets.find((t) => t.kind === req.body?.target) ?? localTargets[0]
    // No reachable address (no LAN, no cloud)? Emit the URI WITHOUT `server=`
    // so the app asks for the address. A loopback `server=` is worse than
    // none: it silently points the phone at itself.
    const by = actorOf(req)
    if (kind === 'machine' && CLOUD_MODE) {
      // Machine credentials open /bridge and /daemon-tunnel on this box: who may
      // mint or rotate one is machine-credentials.ts (one Mac per companion).
      const minted = await mintMachineCredential(name, { by, replace, proof: machineProof(req) })
      log.web.info('devices: machine credential created via console', { name, caller: callerDevice(req) })
      res.status(201).json({ name, token: minted.token, pairingURI: buildPairingURI(name, minted.token, target?.origin), createdAt: minted.createdAt, target: target?.kind ?? null, server: target?.origin ?? null })
      return
    }
    // A re-pair is one locked step with the rules in it (device-auth.ts
    // rotateDevice), and it removes the old token's copy on the other box too.
    const { token, createdAt } = replace ? await rotateDevice(name, { by }) : await createDevice(name, { kind, by })
    const pairingURI = buildPairingURI(name, token, target?.origin)
    log.web.info('devices: created via console', { name, kind: kind ?? 'device', target: target?.kind ?? 'none', replace })
    res.status(201).json({
      name, token, pairingURI, createdAt,
      target: target?.kind ?? null, server: target?.origin ?? null,
    })
  } catch (err) {
    if (sendRefusal(res, err)) return
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes('already exists') || message.includes('Invalid device name')) {
      res.status(400).json({ error: message })
      return
    }
    next(err)
  }
})

// POST /api/devices/:name/adopt (cloud mode): the calling Mac records itself
// as the owner of a machine credential from before ownership was recorded,
// with the credential's current token as proof (machine-credentials.ts).
// 200 {adopted|owned}, 404 missing, 409 another Mac owns one here.
devicesRouter.post('/:name/adopt', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!CLOUD_MODE) { res.status(404).json({ error: 'Not found' }); return }
    const outcome = await adoptMachineCredential(String(req.params.name ?? ''), { by: actorOf(req), proof: machineProof(req) })
    if (outcome === 'missing') { res.status(404).json({ error: `Device "${String(req.params.name)}" not found` }); return }
    res.json({ ok: true, outcome })
  } catch (err) {
    if (sendRefusal(res, err)) return
    next(err)
  }
})

// DELETE /api/devices/:name[?target=cloud] — revoke. A cloud-paired device
// exists only in the CLOUD box's auth.json, so its revoke must go there too.
devicesRouter.delete('/:name', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const name = String(req.params.name ?? '')
    if (req.query.target === 'cloud' && !CLOUD_MODE) {
      if (!await cloudRelayAllowed(req, res, 'revoke')) return
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
      if (upstream.status === 403 || upstream.status === 409) {
        // The companion's device rules said no: the console shows their sentence.
        const body = await upstream.json().catch(() => ({})) as { error?: string; code?: string }
        res.status(upstream.status).json({ error: body.error ?? `Cloud refused to remove ${name} (HTTP ${upstream.status}).`, ...(body.code ? { code: body.code } : {}) })
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
    const by = actorOf(req)
    try {
      if (CLOUD_MODE && (await listDeviceRecords()).some((d) => d.name === name && d.kind === 'machine')) {
        // A machine credential: only the Mac that owns it may revoke it.
        if (!await revokeMachineCredential(name, { by, proof: machineProof(req) })) {
          res.status(404).json({ error: `Device "${name}" not found` })
          return
        }
        res.json({ ok: true })
        return
      }
    } catch (err) {
      if (sendRefusal(res, err)) return
      throw err
    }
    // A paired device: revoking it also revokes the machine credentials it
    // minted (that Mac is disconnected from this companion). Only that device,
    // the Mac this companion serves, or this machine itself may.
    let outcome: Awaited<ReturnType<typeof revokePairing>>
    try {
      // The revoke also stops the device's PUSHES and removes its copy on the
      // other box (revokePairing owns both), or a lost phone keeps showing letter
      // subjects and previews on its lock screen. Best effort by design: the
      // pairing is gone either way, so a bridge outage reports
      // `pushRevokePending` (and queues the rest) instead of leaving it paired.
      outcome = await revokePairing(name, { by })
    } catch (err) {
      if (sendRefusal(res, err)) return
      throw err
    }
    if (!outcome.revoked) {
      res.status(404).json({ error: `Device "${name}" not found` })
      return
    }
    const push = outcome.push ?? { removed: 0, relayed: false }
    log.web.info('devices: revoked via console', {
      name, pushTokensRevoked: push.removed,
      ...(push.pending ? { pushRevokePending: push.pending } : {}),
    })
    res.json({
      ok: true,
      pushTokensRevoked: push.removed,
      ...(push.pending ? { pushRevokePending: true } : {}),
    })
  } catch (err) {
    next(err)
  }
})
