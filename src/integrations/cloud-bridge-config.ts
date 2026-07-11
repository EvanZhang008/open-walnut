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
import { getCloudRemoteCredentials } from './git-sync.js'
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

/**
 * Mint (or reuse) a machine token for one host on the cloud box. Returns null
 * on any failure — bridge provisioning is best-effort and must never break a
 * daemon connect.
 */
async function ensureMachineToken(
  hostAlias: string,
  cloud: { domain: string; token: string; secure: boolean },
): Promise<string | null> {
  const cache = await readTokenCache()
  const deviceName = bridgeDeviceName(hostAlias)
  if (cache[deviceName]) return cache[deviceName]

  const base = `${cloud.secure ? 'https' : 'http'}://${cloud.domain}`
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${cloud.token}`,
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
        // Mac). Tokens are unrecoverable by design — revoke and re-mint.
        await fetch(`${base}/api/devices/${encodeURIComponent(deviceName)}`, {
          method: 'DELETE', headers, signal: AbortSignal.timeout(10_000),
        })
        res = await create()
      }
    }
    if (res.status !== 201) {
      log.session.warn('bridge: machine token mint failed', { hostAlias, status: res.status })
      return null
    }
    const { token } = await res.json() as { token: string }
    cache[deviceName] = token
    await writeTokenCache(cache)
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

  const cloud = getCloudRemoteCredentials()
  if (!cloud) return { enabled: false }

  const url = cfg?.cloud_bridge?.url
    ?? `${cloud.secure ? 'wss' : 'ws'}://${cloud.domain}/bridge`
  const token = await ensureMachineToken(hostAlias, cloud)
  if (!token) return { enabled: false }

  return { enabled: true, url, token, hostAlias }
}
