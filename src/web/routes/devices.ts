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
 * companion's owner (the Mac it belongs to), or this machine itself
 * (core/device-actor.ts). The caller is the token it presented, never a name,
 * and an API key changes no device.
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { createDeviceAs, revokePairingAs, rotateDevice, listDevices, listDeviceRecords, readDeviceRegistry, type DeviceInfo, type DeviceSelfInfo } from '../../core/device-auth.js'
import { CLOUD_LIST_WITHHELD, DeviceChangeRefused, LOCAL_ACTOR, cloudRelayDecision, companionOwnerRecord, recordForToken, type DeviceActor, type DeviceChange } from '../../core/device-actor.js'
import { CLOUD_UNPAIRED_SENTENCE, isCloudUnpaired, markCloudUnpaired } from '../../core/cloud-unpaired.js'
import { getPairingTargets, getCloudPairingEndpoint } from '../../core/pairing-targets.js'
import { tailscaleSummary } from '../../core/tailnet.js'
import { CLOUD_MODE } from '../../constants.js'
import { log } from '../../logging/index.js'
import { requestOrigin } from '../middleware/request-origin.js'
import { isLocalOrigin } from '../../lib/caller-origin.js'
import {
  MACHINE_PROOF_HEADER, MachineCredentialRefused, adoptMachineCredential, mintMachineCredential, revokeMachineCredential,
} from '../../core/machine-credentials.js'
import { machineProofHeaders } from '../../integrations/cloud-bridge-config.js'

export const devicesRouter = Router()

/**
 * Who is asking. This machine itself only for a request this machine trusts
 * that also acts for a caller on this Mac (the console, a local client, a
 * session on this Mac): the op executor's loopback self-calls carry the
 * ORIGINAL caller's class in x-walnut-origin (src/lib/caller-origin.ts), and one
 * made for a session on another exec host or for a paired client is that
 * caller, never this Mac (request-origin.ts: the header only lowers trust).
 * Never this Mac on a companion, whose public traffic reaches it through a
 * local proxy. Else the paired device whose bearer token the auth middleware
 * accepted, else an API key (or a bearer the rules do not know). A self-call
 * for a caller off this Mac that carries no credential is its origin alone.
 */
export function actorOf(req: Request): DeviceActor {
  const origin = requestOrigin(req)
  if (!CLOUD_MODE && isLocalOrigin(origin)) return LOCAL_ACTOR
  const r = req as Request & { deviceName?: string; apiKeyName?: string }
  const header = req.headers.authorization
  if (r.deviceName && header?.startsWith('Bearer ')) return { token: header.slice(7) }
  if (header?.startsWith('Bearer ')) return { apiKey: r.apiKeyName ?? '' }
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

/** The first bridge-local's token, presented as proof of being the Mac that holds it (device-actor.ts proofClaim). */
function machineProof(req: Request): string | undefined {
  const v = req.get(MACHINE_PROOF_HEADER)
  return v && v.length <= 128 ? v : undefined
}

/** What the cloud companion said about its devices, as the console lists them. */
interface CloudDeviceList {
  devices: DeviceInfo[]
  /** The record this Mac's own cloud token matched (the companion says which). */
  caller?: string
  /** Why the list is missing, in a sentence; absent when it loaded or no cloud is set up. */
  error?: string
  /** This Mac unpaired itself from the companion at this origin (core/cloud-unpaired.ts): nothing to list, nothing wrong. */
  unpaired?: string
  /** The companion refused this Mac's token (401) and this Mac did not unpair itself: the operator revoked it there. */
  refused?: boolean
}

/**
 * A failed fetch in plain words. `AbortSignal.timeout` rejects with "The
 * operation was aborted due to timeout" and an unreachable host with "fetch
 * failed": neither means anything to a person reading Settings.
 */
export function plainFetchFailure(err: unknown, timeoutMs: number): string {
  const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } }
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return `timed out after ${Math.round(timeoutMs / 1000)}s`
  const code = e?.cause?.code ?? ''
  const byCode: Record<string, string> = {
    ECONNREFUSED: 'the connection was refused',
    ECONNRESET: 'the connection was reset',
    ENOTFOUND: 'its address could not be found',
    EAI_AGAIN: 'its address could not be found',
    ETIMEDOUT: `timed out after ${Math.round(timeoutMs / 1000)}s`,
    UND_ERR_CONNECT_TIMEOUT: `timed out after ${Math.round(timeoutMs / 1000)}s`,
    EHOSTUNREACH: 'the network has no route to it',
    ENETUNREACH: 'the network has no route to it',
  }
  if (byCode[code]) return byCode[code]
  if (/certificate|CERT_|SSL|TLS/i.test(`${code} ${e?.cause?.message ?? ''}`)) return 'its TLS certificate was not accepted'
  return e?.cause?.message ?? e?.message ?? String(err)
}

/** A computer that runs Walnut, by its own report: another Mac, never a phone. */
function reportsAsComputer(info?: DeviceSelfInfo): boolean {
  return /^(Mac|Computer)$/.test(info?.model?.trim() ?? '') || /^macOS\b/i.test(info?.os?.trim() ?? '')
}

/**
 * An iOS Simulator reports the Mac's CPU as its model (`arm64`, `x86_64`); a real
 * phone reports a hardware id (`iPhone18,2`). Named `sim2-…`, one was listed as a phone.
 */
function reportsAsSimulator(info?: DeviceSelfInfo): boolean {
  return /^(arm64|x86_64|i386)$/.test(info?.model?.trim() ?? '')
}

type DeviceRole = 'phone' | 'simulator' | 'browser' | 'mac' | 'self'

/**
 * What a credential is, for the console. Display only: who may change a
 * record is device-actor.ts, which this never feeds. A Mac is the companion's
 * owner (`macs`) or a record that reported itself as a computer; it was listed
 * as a phone (Show QR, "Model unknown until the app opens on this phone"),
 * which invited minting a phone QR over a Mac's pairing.
 */
export function roleOf(d: DeviceInfo & { role?: unknown }, macs: ReadonlySet<string>): DeviceRole {
  if (d.role === 'mac' || macs.has(d.name) || reportsAsComputer(d.info)) return 'mac'
  if (/(^|-)sim\d*(-|$)|simulator/i.test(d.name) || reportsAsSimulator(d.info)) return 'simulator'
  // A browser signed in with a code (routes/browser-pair.ts) is named browser-<6 hex>.
  return /^browser-[0-9a-f]{6}$/.test(d.name) ? 'browser' : 'phone'
}

/**
 * Devices registered on the cloud companion. Never throws: a list that cannot
 * load comes back empty WITH the reason, so the console says so instead of
 * showing "no phones" (a 401 here used to read as an empty list).
 * `bridge-*` entries are daemon machine credentials, not user devices.
 */
async function listCloudDevices(): Promise<CloudDeviceList> {
  const cloud = getCloudPairingEndpoint()
  if (!cloud) return { devices: [] }
  // Our own unpair: the token is revoked there, and asking again only earns the 401.
  if (isCloudUnpaired(cloud)) return { devices: [], unpaired: cloud.origin }
  const missing = "so the phones paired there can't be listed."
  try {
    const res = await fetch(`${cloud.origin}/api/devices`, {
      headers: { Authorization: `Bearer ${cloud.token}` },
      signal: AbortSignal.timeout(CLOUD_LIST_TIMEOUT_MS),
    })
    if (res.status === 401) {
      return { devices: [], refused: true, error: `The cloud companion no longer accepts this Mac's token, ${missing.slice(0, -1)} (this Mac may have been unpaired there).` }
    }
    if (!res.ok) return { devices: [], error: `The cloud companion could not answer just now, ${missing}` }
    const body = await res.json() as { devices?: Array<DeviceInfo & { role?: unknown }>; caller?: unknown }
    return {
      devices: (body.devices ?? []).filter((d) => !d.name.startsWith('bridge-')),
      ...(typeof body.caller === 'string' ? { caller: body.caller } : {}),
    }
  } catch (err) {
    return { devices: [], error: `Could not reach the cloud companion (${plainFetchFailure(err, CLOUD_LIST_TIMEOUT_MS)}), ${missing}` }
  }
}

export const CLOUD_LIST_TIMEOUT_MS = 8_000
export const CLOUD_CHANGE_TIMEOUT_MS = 15_000
/**
 * The longest this Mac waits on its companion for one console request: a
 * re-pair is a removal and a mint in a row, a removal one call and a list. The
 * console waits longer (web/src/components/settings/sections/cloud/cloud-change-timeout.ts).
 */
export const CLOUD_RELAY_WORST_MS = Math.max(2 * CLOUD_CHANGE_TIMEOUT_MS, CLOUD_CHANGE_TIMEOUT_MS + CLOUD_LIST_TIMEOUT_MS)

/** Pairing targets without Cloud once this Mac unpaired itself from it: a mint there can only fail. */
function liveTargets<T extends { kind: string }>(targets: T[]): T[] {
  return isCloudUnpaired(getCloudPairingEndpoint()) ? targets.filter((t) => t.kind !== 'cloud') : targets
}

/** Pairing again is the one way back, and the token for it is made on the companion. */
const UNPAIRED_CANNOT = `${CLOUD_UNPAIRED_SENTENCE} Pairing it again needs a new token made on the companion.`

/**
 * After a removal on the companion: was it this Mac's own record? The
 * companion then refuses the token we just used (401), and that is recorded,
 * so every surface says "no longer paired" instead of "connected" or "may have
 * been unpaired". Any other answer (or none) records nothing.
 */
async function noteIfSelfUnpaired(cloud: { origin: string; token: string }): Promise<boolean> {
  try {
    const res = await fetch(`${cloud.origin}/api/devices`, {
      headers: { Authorization: `Bearer ${cloud.token}` },
      signal: AbortSignal.timeout(CLOUD_LIST_TIMEOUT_MS),
    })
    if (res.status !== 401) return false
    await markCloudUnpaired(cloud)
    log.web.info('devices: this Mac unpaired itself from the cloud companion', { origin: cloud.origin })
    return true
  } catch {
    return false
  }
}

/**
 * On the companion: the name of the record the caller's bearer token matched.
 * The Mac reads it to find ITS OWN row in the list (its cloud record lives only
 * in the companion's auth.json, so the Mac cannot look it up itself).
 */
async function callerRecordName(req: Request): Promise<string | undefined> {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) return undefined
  const me = recordForToken(await listDeviceRecords(), header.slice(7))
  return me && me.kind !== 'machine' ? me.name : undefined
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
  if (isCloudUnpaired(cloud)) return { error: UNPAIRED_CANNOT, status: 400 }
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${cloud.token}`, ...await machineProofHeaders() }
  try {
    if (replace) {
      // Rotate: the old hash must go before the cloud will accept the name.
      const del = await fetch(`${cloud.origin}/api/devices/${encodeURIComponent(name)}`, {
        method: 'DELETE', headers, signal: AbortSignal.timeout(CLOUD_CHANGE_TIMEOUT_MS),
      }).catch(() => null)
      // The companion's own rules said no (this Mac may not re-pair that device): say its words.
      if (del && (del.status === 403 || del.status === 409)) {
        const body = await del.json().catch(() => ({})) as { error?: string }
        return { error: body.error ?? `The cloud companion would not re-pair ${name}.`, status: del.status }
      }
    }
    const res = await fetch(`${cloud.origin}/api/devices`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name }),
      signal: AbortSignal.timeout(CLOUD_CHANGE_TIMEOUT_MS),
    })
    if (res.status !== 201) {
      const body = await res.json().catch(() => ({})) as { error?: string }
      return {
        error: body.error ?? 'The cloud companion did not accept the pairing.',
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
    log.web.warn('devices: cloud mint failed', { name, error: err instanceof Error ? err.message : String(err) })
    return { error: `Could not reach the cloud companion: ${plainFetchFailure(err, CLOUD_CHANGE_TIMEOUT_MS)}.`, status: 502 }
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
      : liveTargets(await getPairingTargets(origin, requestPort(req)))
    // Cloud-paired devices live in the cloud's auth.json — fetch them so the
    // console can list and revoke them (a down cloud must not break the local
    // list, and says why its half is missing).
    // The cloud half is this Mac's view on its companion (its own token there):
    // for this Mac itself only, like every other relay (cloudRelayAllowed).
    const macServer = !CLOUD_MODE
    const relayed = macServer && cloudRelayDecision([], actorOf(req), 'list').ok
    const cloud = relayed ? await listCloudDevices() : { devices: [] } as CloudDeviceList
    // A caller off this Mac reads an empty cloud half as "no companion": say it is withheld,
    // but only when there is a Cloud target to withhold (liveTargets already dropped a self-unpaired one).
    const withheld = macServer && !relayed && targets.some((t) => t.kind === 'cloud')
    // On the companion, its owner is the Mac it belongs to (recorded, else the one owning its machine credentials).
    const owner = CLOUD_MODE ? companionOwnerRecord(await readDeviceRegistry()) : undefined
    const macs = new Set(owner ? [owner.name] : [])
    // Only real, QR-pairable devices reach the console. Daemon bridge
    // credentials (kind:'machine' / the legacy `bridge-*` names) are plumbing —
    // listing them next to a "Show QR" button invited pairing a phone against a
    // daemon credential, and buried the one row that IS the user's phone.
    const devices = (await listDevices()).filter((d) => d.kind !== 'machine' && !d.name.startsWith('bridge-'))
    // Tell the console WHAT each credential is. Everything in auth.json is a
    // "device", but only some are phones — this Mac's own cloud credential and
    // the iOS simulator sit in the same list, and rendering all three
    // identically read as "3 phones I don't own" (reported 2026-07-29).
    const tailscale = CLOUD_MODE ? null : await tailscaleSummary()
    // This Mac's own row is the cloud record its token matched, as the
    // companion says: never a name guess, and never a local lookup.
    // Other Macs are their own kind too (roleOf): no phone wording, no QR.
    res.json({
      devices: devices.map((d) => ({ ...d, role: roleOf(d, macs) })),
      cloudDevices: cloud.devices.map((d) => ({ ...d, role: d.name === cloud.caller ? 'self' : roleOf(d, macs) })),
      ...(cloud.error ? { cloudError: cloud.error } : {}),
      ...(cloud.unpaired ? { cloudUnpaired: { origin: cloud.unpaired } } : {}),
      // So Cloud Companion stops saying "Connected" for a token the companion refuses.
      ...(cloud.refused ? { cloudRefused: true } : {}),
      ...(withheld ? { cloudWithheld: CLOUD_LIST_WITHHELD } : {}),
      // On the companion: which record the caller is (the Mac reads it, above).
      ...(CLOUD_MODE ? { caller: await callerRecordName(req) } : {}),
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
    const bridgeScope = req.body?.bridge_scope
    if (bridgeScope !== undefined && (bridgeScope !== 'status-only' || kind !== 'machine' || !CLOUD_MODE)) {
      res.status(400).json({ error: 'bridge_scope requires a status-only machine credential on the companion' })
      return
    }
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
    const localTargets = CLOUD_MODE ? [] : liveTargets(await getPairingTargets(consoleOrigin, requestPort(req)))
    const target = CLOUD_MODE
      ? { origin: consoleOrigin, kind: 'cloud' as const }
      : localTargets.find((t) => t.kind === req.body?.target) ?? localTargets[0]
    // No reachable address (no LAN, no cloud)? Emit the URI WITHOUT `server=`
    // so the app asks for the address. A loopback `server=` is worse than
    // none: it silently points the phone at itself.
    const by = actorOf(req)
    if (kind === 'machine' && CLOUD_MODE) {
      // Machine credentials open /bridge and /daemon-tunnel on this box: only
      // the companion's owner may mint or rotate one (machine-credentials.ts).
      const minted = await mintMachineCredential(name, { by, replace, proof: machineProof(req), bridgeScope })
      log.web.info('devices: machine credential created via console', { name, caller: callerDevice(req) })
      res.status(201).json({ name, token: minted.token, pairingURI: buildPairingURI(name, minted.token, target?.origin), createdAt: minted.createdAt, target: target?.kind ?? null, server: target?.origin ?? null })
      return
    }
    // A re-pair is one locked step with the rules in it (device-auth.ts
    // rotateDevice), and it removes the old token's copy on the other box too.
    const { token, createdAt } = replace ? await rotateDevice(name, { by, proof: machineProof(req) }) : await createDeviceAs(name, { kind, by })
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

// POST /api/devices/:name/adopt (cloud mode): the calling Mac proves it is the
// owner of a companion from before owners were recorded, with the first
// bridge-local's token (machine-credentials.ts). 200 {adopted|owned}, 404
// missing, 403/409 refused.
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
      if (isCloudUnpaired(cloud)) {
        res.status(400).json({ error: UNPAIRED_CANNOT })
        return
      }
      let failure = ''
      const upstream = await fetch(`${cloud.origin}/api/devices/${encodeURIComponent(name)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${cloud.token}`, ...await machineProofHeaders() },
        signal: AbortSignal.timeout(CLOUD_CHANGE_TIMEOUT_MS),
      }).catch((err: unknown) => {
        log.web.warn('devices: cloud revoke failed', { name, error: String(err) })
        failure = plainFetchFailure(err, CLOUD_CHANGE_TIMEOUT_MS)
        return null
      })
      if (!upstream) {
        res.status(502).json({ error: `Could not reach the cloud companion (${failure}).` })
        return
      }
      if (upstream.status === 404) {
        res.status(404).json({ error: `Device "${name}" not found on the cloud.` })
        return
      }
      if (upstream.status === 403 || upstream.status === 409) {
        // The companion's device rules said no: the console shows their sentence.
        const body = await upstream.json().catch(() => ({})) as { error?: string; code?: string }
        res.status(upstream.status).json({ error: body.error ?? `The cloud companion would not remove ${name}.`, ...(body.code ? { code: body.code } : {}) })
        return
      }
      if (!upstream.ok) {
        res.status(502).json({ error: `The cloud companion could not remove ${name}.` })
        return
      }
      log.web.info('devices: revoked on cloud via console', { name })
      // Removing this Mac's own record is an unpair: remember it (noteIfSelfUnpaired).
      const unpaired = await noteIfSelfUnpaired(cloud)
      res.json({ ok: true, target: 'cloud', ...(unpaired ? { unpaired: true } : {}) })
      return
    }
    const by = actorOf(req)
    try {
      if (CLOUD_MODE && (await listDeviceRecords()).some((d) => d.name === name && d.kind === 'machine')) {
        // A machine credential: only the companion's owner may revoke it.
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
    // A paired device: revoking the owner also revokes every machine
    // credential (that Mac is disconnected from this companion). Only that
    // device, the owner, or this machine itself may.
    let outcome: Awaited<ReturnType<typeof revokePairingAs>>
    try {
      // The revoke also stops the device's PUSHES and removes its copy on the
      // other box (device-auth.ts revokePairingAs owns both), or a lost phone
      // keeps showing letter subjects and previews on its lock screen. Best
      // effort by design: the pairing is gone either way, so a bridge outage
      // reports `pushRevokePending` (and queues the rest) instead of leaving it paired.
      outcome = await revokePairingAs(name, { by, proof: machineProof(req) })
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
