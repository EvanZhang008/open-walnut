/**
 * Where a phone should point after scanning a pairing QR.
 *
 * The console's own origin is the WRONG answer whenever it is `localhost` —
 * that resolves to the phone itself, so a scanned QR produced a permanently
 * "connecting" app (reported 2026-07-28). A pairing target must be an address
 * that is reachable from ANOTHER device:
 *
 * - `lan`   — this Mac's private-network IPv4 (http://192.168.x.y:PORT). Works
 *   on the same Wi-Fi only. iOS allows plain http here via NSAllowsLocalNetworking.
 * - `tailnet`: this Mac's tailnet IPv4 (http://100.x.y.z:PORT, see tailnet.ts).
 *   Works from anywhere the phone is on the same tailnet, straight to this Mac.
 * - `cloud` — the cloud companion's public origin, derived from the data repo's
 *   git remote (the same source cloud-bridge-config.ts already trusts). Works
 *   from anywhere, which is what "connect to Cloud" means.
 *
 * Tokens are NOT minted here — see src/web/routes/devices.ts. That split
 * matters: a cloud token must be minted BY THE CLOUD BOX (auth.json never
 * git-syncs, so a Mac-minted hash is unknown to the cloud and authenticates
 * nowhere).
 */

import os from 'node:os'
import { getCloudRemoteCredentials, getCloudRemoteCredentialsAsync } from '../integrations/git-sync.js'
import { detectTailnetAddress, isTailnetHost, peekTailscaleStatus } from './tailnet.js'

export { detectTailnetAddress, isCgnatV4 } from './tailnet.js'

export type PairingTargetKind = 'lan' | 'tailnet' | 'cloud'

export interface PairingTarget {
  kind: PairingTargetKind
  /** Origin the phone should talk to, e.g. `http://192.168.1.20:3456`. */
  origin: string
  /** Human label for the console UI. */
  label: string
  /** True when the token must be minted on the remote (cloud) box, not locally. */
  remoteMint: boolean
}

/**
 * Private-network IPv4 of this machine, preferring real Ethernet/Wi-Fi (`en*`)
 * over VPN/virtual interfaces (`utun*`, `bridge*`) — a VPN address is routable
 * for us but not for a phone on the house Wi-Fi.
 *
 * Only RFC1918 ranges qualify: a home or office LAN. Carrier-grade NAT
 * (100.64/10) and link-local (169.254/16) are deliberately excluded. The
 * address grants nothing by itself: every request from it still needs the
 * device token the QR carries.
 */
export function detectLanAddress(): string | null {
  const candidates: Array<{ name: string; address: string }> = []
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family !== 'IPv4' || addr.internal) continue
      if (!isPrivateV4(addr.address)) continue
      candidates.push({ name, address: addr.address })
    }
  }
  if (candidates.length === 0) return null
  // Physical interfaces first; within a class keep OS enumeration order.
  const rank = (name: string) => (/^en\d/.test(name) ? 0 : /^(utun|bridge|vnic|vmenet|tap|tun)/.test(name) ? 2 : 1)
  candidates.sort((a, b) => rank(a.name) - rank(b.name))
  return candidates[0].address
}

function isPrivateV4(ip: string): boolean {
  const p = ip.split('.').map(Number)
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false
  return p[0] === 10
    || (p[0] === 172 && p[1] >= 16 && p[1] <= 31)
    || (p[0] === 192 && p[1] === 168)
}

/** True when an origin's host is loopback — i.e. useless to another device. */
export function isLoopbackOrigin(origin: string): boolean {
  try {
    const host = new URL(origin).hostname.toLowerCase()
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
  } catch {
    return false
  }
}

/** The tailnet target's label: name Tailscale only when its CLI is known to be here. */
export async function tailnetLabel(): Promise<string> {
  return (await peekTailscaleStatus())?.installed
    ? 'Tailscale (anywhere this machine is on)'
    : 'Tailnet (anywhere this machine is on)'
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).hostname
  } catch {
    return ''
  }
}

/**
 * Pairing targets for this instance, best-first: `lan`, `tailnet`, `cloud`.
 *
 * `consoleOrigin` (the browser's own origin) is offered only when it is NOT
 * loopback (the console already reached over the LAN, the tailnet or a reverse
 * proxy), in which case that exact origin is known to work. A tailnet console
 * origin fills the `tailnet` slot, not the `lan` one.
 */
export async function getPairingTargets(consoleOrigin: string, port: number): Promise<PairingTarget[]> {
  const targets: PairingTarget[] = []
  const usable = !!consoleOrigin && !isLoopbackOrigin(consoleOrigin)
  const consoleOnTailnet = usable && isTailnetHost(hostOf(consoleOrigin))

  if (usable && !consoleOnTailnet) {
    targets.push({ kind: 'lan', origin: consoleOrigin, label: 'This network', remoteMint: false })
  } else {
    const lan = detectLanAddress()
    if (lan) {
      targets.push({ kind: 'lan', origin: `http://${lan}:${port}`, label: 'This network (Wi-Fi)', remoteMint: false })
    }
  }

  const tailnet = consoleOnTailnet ? consoleOrigin : (() => {
    const found = detectTailnetAddress()
    return found ? `http://${found.address}:${port}` : null
  })()
  if (tailnet) {
    targets.push({ kind: 'tailnet', origin: tailnet, label: await tailnetLabel(), remoteMint: false })
  }

  const cloud = await getCloudRemoteCredentialsAsync()
  if (cloud) {
    targets.push({
      kind: 'cloud',
      origin: `${cloud.secure ? 'https' : 'http'}://${cloud.domain}`,
      label: 'Cloud (anywhere)',
      remoteMint: true,
    })
  }

  return targets
}

/** The cloud companion's origin + the credential that can mint devices on it. */
export function getCloudPairingEndpoint(): { origin: string; token: string } | null {
  const cloud = getCloudRemoteCredentials()
  if (!cloud) return null
  return { origin: `${cloud.secure ? 'https' : 'http'}://${cloud.domain}`, token: cloud.token }
}

/** Async twin of getCloudPairingEndpoint for request paths (no blocking git spawn). */
export async function getCloudPairingEndpointAsync(): Promise<{ origin: string; token: string } | null> {
  const cloud = await getCloudRemoteCredentialsAsync()
  if (!cloud) return null
  return { origin: `${cloud.secure ? 'https' : 'http'}://${cloud.domain}`, token: cloud.token }
}
