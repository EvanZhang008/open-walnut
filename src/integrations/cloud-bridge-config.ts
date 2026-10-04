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
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { WALNUT_HOME, CLOUD_MODE } from '../constants.js'
import { getCloudRemoteCredentialsAsync } from './git-sync.js'
import { getConfig } from '../core/config-manager.js'
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

/**
 * Names whose last mint the companion refused because another Mac holds its
 * machine credentials (409 other_mac_connected, core/machine-credentials.ts).
 * Cleared by the next successful mint.
 */
const mintConflicts = new Set<string>()

/** Did the companion refuse this host's machine token because another Mac is connected? */
export function machineTokenConflict(hostAlias: string): boolean {
  return mintConflicts.has(bridgeDeviceName(hostAlias))
}

/** Names already offered for adoption by this process (once per start is enough). */
const adoptionsSent = new Set<string>()

/**
 * Tokens minted before the companion recorded ownership have no owner there:
 * claim them, with this Mac's own `bridge-local` token as proof (the only one
 * the companion accepts: a remote host's daemon holds its own token), so a
 * lost cache later re-mints as the owner. One call adopts them all.
 * Best-effort and once per start; a companion without the route answers 404,
 * which changes nothing.
 */
function adoptOnce(localToken: string | undefined, cloud: { domain: string; token: string; secure: boolean }): void {
  const deviceName = bridgeDeviceName('__local__')
  if (!localToken || adoptionsSent.has(deviceName)) return
  adoptionsSent.add(deviceName)
  const base = `${cloud.secure ? 'https' : 'http'}://${cloud.domain}`
  void import('../core/machine-credentials.js').then(({ MACHINE_PROOF_HEADER }) => fetch(`${base}/api/devices/${encodeURIComponent(deviceName)}/adopt`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cloud.token}`, [MACHINE_PROOF_HEADER]: localToken },
    signal: AbortSignal.timeout(10_000),
  })).then(async (res) => {
    if (res.status === 200) {
      const body = await res.json().catch(() => ({})) as { outcome?: string }
      if (body.outcome === 'adopted') log.session.info('bridge: machine token ownership recorded on the companion', { deviceName })
    } else if (res.status === 409) {
      log.session.warn('bridge: the companion says another Mac holds its machine credentials', { deviceName })
    }
  }).catch(() => { /* offline or an older companion: try again next start */ })
}

async function mintMachineToken(
  deviceName: string,
  hostAlias: string,
  cloud: { domain: string; token: string; secure: boolean },
  opts: { remint?: boolean } = {},
): Promise<string | null> {
  const cache = await readTokenCache()
  if (cache[deviceName]) {
    adoptOnce(cache[bridgeDeviceName('__local__')], cloud)
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
  // Proof that this Mac is the one the companion's older, unowned machine
  // credentials belong to: its own bridge-local token, the only one that counts.
  const { MACHINE_PROOF_HEADER } = await import('../core/machine-credentials.js')
  const proof = cache[bridgeDeviceName('__local__')]
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
  const refusedAsOtherMac = async (res: Response): Promise<boolean> => {
    if (res.status !== 409) return false
    const body = await res.clone().json().catch(() => ({})) as { code?: string }
    return body.code === 'other_mac_connected'
  }

  try {
    let res = await create()
    if (res.status === 400) {
      const body = await res.json().catch(() => ({})) as { error?: string }
      if (typeof body.error === 'string' && body.error.includes('already exists')) {
        // Cloud has the device but we lost the plaintext (cache wiped / new
        // Mac). Tokens are unrecoverable by design, so revoke and re-mint. The
        // companion allows that only to the Mac that owns it (409 otherwise).
        const del = await fetch(`${base}/api/devices/${encodeURIComponent(deviceName)}`, {
          method: 'DELETE', headers, signal: AbortSignal.timeout(10_000),
        })
        res = await refusedAsOtherMac(del) ? del : await create()
      }
    }
    if (await refusedAsOtherMac(res)) {
      mintConflicts.add(deviceName)
      log.session.warn('bridge: the companion serves another Mac; no machine token for this one', { hostAlias, deviceName })
      return null
    }
    if (res.status !== 201) {
      log.session.warn('bridge: machine token mint failed', { hostAlias, status: res.status })
      return null
    }
    const { token } = await res.json() as { token: string }
    cache[deviceName] = token
    await writeTokenCache(cache)
    mintConflicts.delete(deviceName)
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
  return remintBlocked(deviceName) && !mintConflicts.has(deviceName)
}

/** A person pressed Retry: the next mint for this host runs now, whatever the window says. */
export function allowNextRemint(hostAlias: string): void {
  lastRemintAt.delete(bridgeDeviceName(hostAlias))
}

/**
 * The companion refused `deadToken` (401 on the tunnel or the bridge): drop it
 * from the cache and mint a fresh one, once. 'reminted' = the cache now holds a
 * different token (this call's, or a concurrent caller's); 'conflict' = another
 * Mac holds this companion's machine credentials; 'failed' = anything else
 * (the window's one re-mint is spent, the mint failed), and the caller keeps
 * its own error.
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
  return mintConflicts.has(deviceName) ? 'conflict' : 'failed'
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
    import('ws'), import('../core/hosts/cloud-box-host.js'),
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

/** Test seam: forget the per-process rate limits and conflicts. */
export function resetMachineTokenStateForTest(): void {
  lastRemintAt.clear()
  lastTokenProbeAt.clear()
  mintConflicts.clear()
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
  let cfg: Awaited<ReturnType<typeof getConfig>> | undefined
  try { cfg = await getConfig() } catch { /* default-on */ }
  if (cfg?.cloud_bridge?.enabled === false) return { enabled: false }

  // Async: this runs on every daemon (re)connect, on the server's event loop.
  // The sync twin spawns `git remote get-url` twice, 50 to 120ms of blocked loop.
  const cloud = await getCloudRemoteCredentialsAsync()
  if (!cloud) return { enabled: false }

  const url = cfg?.cloud_bridge?.url
    ?? `${cloud.secure ? 'wss' : 'ws'}://${cloud.domain}/bridge`
  const token = await ensureMachineToken(hostAlias, cloud)
  if (!token) return { enabled: false }

  return { enabled: true, url, token, hostAlias }
}
