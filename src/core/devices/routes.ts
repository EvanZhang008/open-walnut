/**
 * The addresses a paired client can use to reach THIS Walnut (GET /api/v1/routes).
 *
 * A route is an origin plus the `instance` id of the box behind it, so a client
 * that tries an address can check it reached the box it meant (a LAN address
 * handed out again to another machine answers with another id). The Mac's
 * direct routes are its LAN and tailnet addresses on the port it listens on;
 * the cloud route is the companion's public origin.
 */

import { getSelfApiRoot } from '../../lib/self-api-root.js'
import { detectLanAddress, detectTailnetAddress, tailnetLabel } from '../pairing-targets.js'

export type DeviceRouteKind = 'lan' | 'tailnet' | 'cloud'

export interface DeviceRoute {
  kind: DeviceRouteKind
  origin: string
  label: string
  instance: string
}

export const CLOUD_ROUTE_LABEL = 'Cloud (anywhere)'

/** The port this process's server listens on (the Mac's direct routes use it). */
export function listeningPort(fallback = 3456): number {
  const root = getSelfApiRoot()
  if (!root) return fallback
  const port = Number(new URL(root).port)
  return Number.isInteger(port) && port > 0 ? port : fallback
}

/** This machine's LAN and tailnet routes on `port`, best-first. */
export async function directRoutes(port: number, instance: string): Promise<DeviceRoute[]> {
  const routes: DeviceRoute[] = []
  const lan = detectLanAddress()
  if (lan) routes.push({ kind: 'lan', origin: `http://${lan}:${port}`, label: 'This network (Wi-Fi)', instance })
  const tailnet = detectTailnetAddress()
  if (tailnet) routes.push({ kind: 'tailnet', origin: `http://${tailnet.address}:${port}`, label: await tailnetLabel(), instance })
  return routes
}

/**
 * Routes another box answered, kept only when well formed: a known kind among
 * `kinds`, an http(s) origin with nothing after the host, a label, an instance id.
 */
export function wellFormedRoutes(raw: unknown, kinds: readonly DeviceRouteKind[]): DeviceRoute[] {
  if (!Array.isArray(raw)) return []
  const out: DeviceRoute[] = []
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue
    const { kind, origin, label, instance } = r as Record<string, unknown>
    if (typeof kind !== 'string' || !kinds.includes(kind as DeviceRouteKind)) continue
    if (typeof origin !== 'string' || typeof label !== 'string' || typeof instance !== 'string' || !/^[0-9a-f]{32}$/.test(instance)) continue
    try {
      const u = new URL(origin)
      if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.origin !== origin) continue
    } catch {
      continue
    }
    out.push({ kind: kind as DeviceRouteKind, origin, label: label.slice(0, 120), instance })
  }
  return out
}
