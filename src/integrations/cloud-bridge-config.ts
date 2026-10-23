/**
 * Mac-side bridge provisioning: derive where daemons should dial (from the
 * data repo's `cloud` git remote) and mint per-host machine tokens on the
 * cloud box. DaemonConnection pushes the result to each daemon via the
 * `bridge.configure` RPC after its capability handshake.
 *
 * Token distribution: auth.json NEVER git-syncs (CRITICAL_IGNORES), so a
 * token minted locally would be unknown to the cloud box. Instead the Mac
 * uses its existing cloud credential (the device token embedded in the
 * `cloud` remote URL) to call the cloud's POST /api/devices with
 * kind:'machine' — the hash lands directly in the CLOUD box's auth.json.
 * The plaintext comes back once and is cached under sync/ (gitignored by
 * the `sync/*.json` rule) so reconnects don't re-mint.
 *
 * Only the companion's owner may mint (core/machine-credentials.ts): the Mac
 * that claimed it. A companion from before owners were recorded learns that
 * this Mac is it from the first `bridge-local` token, which only this Mac's
 * own daemon ever held: every request that needs ownership carries it
 * (machineProofHeaders), and once per start it is offered on its own
 * (adoptOnce), so the console's cloud relay and a lost token cache keep
 * working after the companion upgrades.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { WALNUT_HOME, CLOUD_MODE } from '../constants.js'
import { getCloudRemoteCredentialsAsync } from './git-sync.js'
import { getConfig } from '../core/config-manager.js'
import { MACHINE_PROOF_HEADER } from '../core/device-actor.js'
import { log } from '../logging/index.js'

export interface BridgeConfigPayload {
  enabled: boolean
  url?: string
  token?: string
  hostAlias?: string
}

const TOKEN_CACHE_FILE = () => path.join(WALNUT_HOME, 'sync', 'bridge-tokens.json')

/** hostKey '__local__' fails device-name validation — use a clean alias. */
function bridgeDeviceName(hostAlias: string): string {
  return `bridge-${hostAlias === '__local__' ? 'local' : hostAlias}`
}

async function readTokenCache(): Promise<Record<string, string>> {
  try {
    const raw = await fs.readFile(TOKEN_CACHE_FILE(), 'utf-8')
    const parsed = JSON.parse(raw) as Record<string, string>
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

async function writeTokenCache(cache: Record<string, string>): Promise<void> {
  const file = TOKEN_CACHE_FILE()
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify(cache, null, 2), { mode: 0o600 })
}

const PRIMARY_DEVICE_NAME = bridgeDeviceName('__local__')

/**
 * The header proving this Mac holds its first `bridge-local` token, for a
 * request to the companion that needs its owner (a mint, a re-pair, a
 * removal). Empty when this Mac has none cached.
 */
export async function machineProofHeaders(): Promise<Record<string, string>> {
  const local = (await readTokenCache())[PRIMARY_DEVICE_NAME]
  return local ? { [MACHINE_PROOF_HEADER]: local } : {}
}

const mintsInFlight = new Map<string, Promise<string | null>>()

/**
 * Mint (or reuse) a machine token for one host on the cloud box. Returns null
 * on any failure — bridge provisioning is best-effort and must never break a
 * daemon connect.
 */
async function ensureMachineToken(
  hostAlias: string,
  cloud: { domain: string; token: string; secure: boolean },
  opts: { remint?: boolean } = {},
): Promise<string | null> {
  // One mint per name at a time: `bridge-local` has two users now (the local
  // daemon's bridge push and the cloud box tunnel), and two concurrent mints
  // would revoke each other's token on the "already exists" path below.
  const deviceName = bridgeDeviceName(hostAlias)
  const pending = mintsInFlight.get(deviceName)
  if (pending) return pending
  const mint = mintMachineToken(deviceName, hostAlias, cloud, opts).finally(() => mintsInFlight.delete(deviceName))
  mintsInFlight.set(deviceName, mint)
  return mint
}

type MintRefusal = { status: number; code?: string; error?: string }

/**
 * Names whose last mint the companion refused by its ownership rules (403 or
 * 409, core/machine-credentials.ts), with its code and sentence. Cleared by the
 * next successful mint.
 */
const mintRefusals = new Map<string, MintRefusal>()

/** Why the companion last refused this host's machine token (its code and its sentence), if it did. */
export function machineTokenRefusal(hostAlias: string): MintRefusal | undefined {
  return mintRefusals.get(bridgeDeviceName(hostAlias))
}

/** Did the companion refuse this host's machine token because it belongs to another Mac? */
export function machineTokenConflict(hostAlias: string): boolean {
  const code = machineTokenRefusal(hostAlias)?.code
  return code === 'other_mac_connected' || code === 'not_companion_owner'
}

/** Names already offered for adoption by this process (once per start is enough). */
const adoptionsSent = new Set<string>()

/**
 * Offer the first bridge-local token as proof that this Mac is the companion's
 * owner, once per start. Best-effort: a companion without the route answers
 * 404, a companion that already knows answers 'owned', and either changes
 * nothing.
 */
function adoptOnce(localToken: string | undefined, cloud: { domain: string; token: string; secure: boolean }): void {
  if (!localToken || adoptionsSent.has(PRIMARY_DEVICE_NAME)) return
  adoptionsSent.add(PRIMARY_DEVICE_NAME)
  const base = `${cloud.secure ? 'https' : 'http'}://${cloud.domain}`
  void fetch(`${base}/api/devices/${encodeURIComponent(PRIMARY_DEVICE_NAME)}/adopt`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cloud.token}`, [MACHINE_PROOF_HEADER]: localToken },
    signal: AbortSignal.timeout(10_000),
  }).then(async (res) => {
    const body = await res.json().catch(() => ({})) as { outcome?: string; error?: string }
    if (res.status === 200 && body.outcome === 'adopted') log.session.info('bridge: the companion recorded this Mac as its owner', { deviceName: PRIMARY_DEVICE_NAME })
    else if (res.status === 403 || res.status === 409) log.session.warn('bridge: the companion did not take this Mac as its owner', { status: res.status, error: body.error })
  }).catch(() => { /* offline or an older companion: try again next start */ })
}

/** A refusal by the companion's ownership rules (not a network or server failure), read from its answer. */
async function ownershipRefusal(res: Response): Promise<MintRefusal | null> {
  if (res.status !== 403 && res.status !== 409) return null
  const body = await res.clone().json().catch(() => ({})) as { code?: string; error?: string }
  return { status: res.status, code: body.code, error: body.error }
}

async function mintMachineToken(
  deviceName: string,
  hostAlias: string,
  cloud: { domain: string; token: string; secure: boolean },
  opts: { remint?: boolean } = {},
): Promise<string | null> {
  const cache = await readTokenCache()
  if (cache[deviceName]) {
    adoptOnce(cache[PRIMARY_DEVICE_NAME], cloud)
    return cache[deviceName]
  }
  // A token the companion refused was dropped moments ago and the one re-mint
  // this window allows is spent: wait out the window, or a Retry (allowNextRemint).
  if (!opts.remint && remintBlocked(deviceName)) {
    log.session.info('bridge: no machine token until the re-mint window passes or Retry', { hostAlias, deviceName })
    return null
  }
  if (opts.remint) lastRemintAt.set(deviceName, Date.now())

  const base = `${cloud.secure ? 'https' : 'http'}://${cloud.domain}`
  // Proof that this Mac is the companion's owner, for a companion from before
  // owners were recorded: its own first bridge-local token, the only one that counts.
  const proof = cache[PRIMARY_DEVICE_NAME]
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${cloud.token}`,
    ...(proof ? { [MACHINE_PROOF_HEADER]: proof } : {}),
  }
  const create = () => fetch(`${base}/api/devices`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: deviceName, kind: 'machine' }),
    signal: AbortSignal.timeout(10_000),
  })
  try {
    let res = await create()
    if (res.status === 400) {
      const body = await res.json().catch(() => ({})) as { error?: string }
      if (typeof body.error === 'string' && body.error.includes('already exists')) {
        // Cloud has the device but we lost the plaintext (cache wiped / new
        // Mac). Tokens are unrecoverable by design, so revoke and re-mint. The
        // companion allows that only to its owner, so a refusal ends it here.
        const del = await fetch(`${base}/api/devices/${encodeURIComponent(deviceName)}`, {
          method: 'DELETE', headers, signal: AbortSignal.timeout(10_000),
        })
        res = await ownershipRefusal(del) ? del : await create()
      }
    }
    const refused = await ownershipRefusal(res)
    if (refused) {
      mintRefusals.set(deviceName, refused)
      log.session.warn('bridge: the companion refused a machine token for this Mac', { hostAlias, deviceName, status: refused.status, code: refused.code, error: refused.error })
      return null
    }
    if (res.status !== 201) {
      log.session.warn('bridge: machine token mint failed', { hostAlias, status: res.status })
      return null
    }
    const { token } = await res.json() as { token: string }
    cache[deviceName] = token
    await writeTokenCache(cache)
    mintRefusals.delete(deviceName)
    log.session.info('bridge: machine token minted', { hostAlias, deviceName })
    return token
  } catch (err) {
    log.session.warn('bridge: machine token mint errored', {
      hostAlias, error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

/**
 * At most one AUTOMATIC re-mint per name per window: a companion that keeps
 * refusing fresh tokens is not hammered. A person's Retry lifts it
 * (allowNextRemint); a refused token is dropped either way, so no path ever
 * dials with it again.
 */
const REMINT_MIN_INTERVAL_MS = 10 * 60_000
const lastRemintAt = new Map<string, number>()

function remintBlocked(deviceName: string): boolean {
  const last = lastRemintAt.get(deviceName)
  return last !== undefined && Date.now() - last < REMINT_MIN_INTERVAL_MS
}

/** Is this host's machine token held back by the re-mint window (its dead token already dropped)? */
export function machineTokenAwaitsRetry(hostAlias: string): boolean {
  const deviceName = bridgeDeviceName(hostAlias)
  return remintBlocked(deviceName) && !mintRefusals.has(deviceName)
}

/** A person pressed Retry: the next mint for this host runs now, whatever the window says. */
export function allowNextRemint(hostAlias: string): void {
  lastRemintAt.delete(bridgeDeviceName(hostAlias))
}

/**
 * The companion refused `deadToken` (401 on the tunnel or the bridge): drop it
 * from the cache and mint a fresh one, once. 'reminted' = the cache now holds a
 * different token (this call's, or a concurrent caller's); 'conflict' = the
 * companion belongs to another Mac; 'failed' = anything else (the window's one
 * re-mint is spent, the mint failed or was refused for another reason, which
 * machineTokenRefusal names), and the caller keeps its own error.
 */
export async function recoverMachineToken(
  hostAlias: string,
  deadToken: string,
  cloud: { domain: string; token: string; secure: boolean },
): Promise<'reminted' | 'conflict' | 'failed'> {
  if (CLOUD_MODE) return 'failed'
  const deviceName = bridgeDeviceName(hostAlias)
  const cache = await readTokenCache()
  if (cache[deviceName] && cache[deviceName] !== deadToken) return 'reminted'
  if (cache[deviceName] === deadToken) {
    delete cache[deviceName]
    await writeTokenCache(cache)
  }
  if (remintBlocked(deviceName)) {
    log.session.warn('bridge: the companion refused this machine token again inside the re-mint window; dropped it, Retry mints a new one', { hostAlias, deviceName })
    return 'failed'
  }
  log.session.warn('bridge: the companion no longer accepts this machine token, minting a new one', { hostAlias, deviceName })
  const token = await ensureMachineToken(hostAlias, cloud, { remint: true })
  if (token) return 'reminted'
  return machineTokenConflict(hostAlias) ? 'conflict' : 'failed'
}

/**
 * Is `token` a machine credential the companion accepts? Asked on the tunnel
 * route with TUNNEL_PROBE_HEADER, which starts nothing: 'valid' (204),
 * 'refused' (401), 'unknown' (an older companion, the network, anything else).
 */
export async function probeMachineToken(
  cloud: { domain: string; secure: boolean },
  token: string,
): Promise<'valid' | 'refused' | 'unknown'> {
  const [{ WebSocket }, { TUNNEL_PROBE_HEADER, DAEMON_TUNNEL_PATH }] = await Promise.all([
    import('#ws'), import('../core/hosts/cloud-box-host.js'),
  ])
  return new Promise((resolve) => {
    let settled = false
    const ws = new WebSocket(`${cloud.secure ? 'wss' : 'ws'}://${cloud.domain}${DAEMON_TUNNEL_PATH}`, {
      headers: { Authorization: `Bearer ${token}`, [TUNNEL_PROBE_HEADER]: 'credential' },
      handshakeTimeout: 10_000,
    })
    const done = (v: 'valid' | 'refused' | 'unknown') => {
      if (settled) return
      settled = true
      try { ws.terminate() } catch { /* gone */ }
      resolve(v)
    }
    ws.on('unexpected-response', (_req, res) => {
      res.resume()
      done(res.statusCode === 204 ? 'valid' : res.statusCode === 401 ? 'refused' : 'unknown')
    })
    // An older companion that opened a real tunnel instead: close it at once.
    ws.on('open', () => done('unknown'))
    ws.on('error', () => done('unknown'))
  })
}

const TOKEN_PROBE_MIN_INTERVAL_MS = 10 * 60_000
const lastTokenProbeAt = new Map<string, number>()

/**
 * A host's bridge is enabled but not connected: the network, or a token the
 * companion stopped accepting? Asks the companion at most every 10 minutes per
 * host and re-mints on a 401. True = the cache holds a new token (push again).
 */
export async function revalidateBridgeToken(hostAlias: string): Promise<boolean> {
  if (CLOUD_MODE) return false
  const deviceName = bridgeDeviceName(hostAlias)
  const last = lastTokenProbeAt.get(deviceName)
  if (last !== undefined && Date.now() - last < TOKEN_PROBE_MIN_INTERVAL_MS) return false
  lastTokenProbeAt.set(deviceName, Date.now())
  const { getCloudRemoteCredentialsAsync } = await import('./git-sync.js')
  const cloud = await getCloudRemoteCredentialsAsync()
  if (!cloud) return false
  const token = (await readTokenCache())[deviceName]
  if (!token) return false
  if (await probeMachineToken(cloud, token) !== 'refused') return false
  return (await recoverMachineToken(hostAlias, token, cloud)) === 'reminted'
}

/** Test seam: forget the per-process rate limits, refusals and adoption offers. */
export function resetMachineTokenStateForTest(): void {
  lastRemintAt.clear()
  lastTokenProbeAt.clear()
  mintRefusals.clear()
  adoptionsSent.clear()
}

/**
 * The PRIMARY's machine credential on the companion: the very token its own
 * daemon dials /bridge with (`bridge-local`, bound to `__local__`). The daemon
 * tunnel (core/hosts/cloud-box-probe.ts) authenticates with it too, so there is
 * one machine identity per Mac and no second auth scheme. Minted on first use
 * and cached exactly like the bridge's copy; null on any failure.
 */
export async function getPrimaryMachineToken(
  cloud: { domain: string; token: string; secure: boolean },
): Promise<string | null> {
  if (CLOUD_MODE) return null
  return ensureMachineToken('__local__', cloud)
}

/**
 * Build the bridge.configure payload for one host. Zero-config default: if
 * cloud sync is set up (a `cloud` remote with an embedded token exists), the
 * bridge is on; config.yaml `cloud_bridge.enabled: false` opts out,
 * `cloud_bridge.url` overrides the derived endpoint.
 */
export async function getBridgeConfigForHost(hostAlias: string): Promise<BridgeConfigPayload> {
  if (CLOUD_MODE) return { enabled: false }
  const cfg = await getConfig()
  if (cfg.cloud_bridge?.enabled === false) return { enabled: false }

  const cloud = await getCloudRemoteCredentialsAsync({ strict: true })
  if (!cloud) return { enabled: false }

  const url = cfg?.cloud_bridge?.url
    ?? `${cloud.secure ? 'wss' : 'ws'}://${cloud.domain}/bridge`
  const token = await ensureMachineToken(hostAlias, cloud)
  if (!token) throw new Error('Bridge credential unavailable; existing daemon configuration was not changed')

  return { enabled: true, url, token, hostAlias }
}
