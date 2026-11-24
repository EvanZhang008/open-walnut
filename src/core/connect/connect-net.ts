/**
 * Walnut Connect on the leader (docs/reference/walnut-connect.md): whether it runs, what this
 * Mac's walnut-net is told about phones, and the route a paired phone dials.
 *
 *   phone app ──iroh, walnut/web/1──▶ this Mac's walnut-net ──unix socket──▶ the connect door
 *   (native/walnut-connect)            (lets in listed phones only)          (web/connect-door.ts:
 *                                                                              device token required)
 *
 * It runs only on the leader, only on the user's real Walnut (netActive: a test server's copied
 * config would put its key in the Mac's place), and only while the walnut_connect experiment is
 * on. It rides the host network: turning it on turns that on (net.enabled), and the phones and
 * the door go into the same walnut-net config the machines do (net-mac.ts runSync).
 */

import { log } from '../../logging/index.js'
import { experimentalEnabled } from '../experimental.js'
import { connectPhones, type ConnectPhone } from './connect-phones.js'

export const CONNECT_ROUTE_LABEL = 'Walnut Connect'
/** walnut-net's control protocol that takes phones (native/walnut-net/src/main.rs PROTOCOL). */
export const WEB_PROTOCOL = 3
const STATUS_TTL_MS = 10_000
const SYNC_DEBOUNCE_MS = 1_000
const ADDRS_MAX = 8

/** Where a phone finds this Mac: its network id, the relay it is on, its addresses. */
export interface ConnectPeer {
  id: string
  relayMode: 'public' | 'custom' | 'none'
  relays: string[]
  relayRoots?: string[]
  addrs: string[]
}

export interface ConnectRoute {
  kind: 'connect'
  /** Names the route (and this Mac) only: the app dials it through its own 127.0.0.1 port. */
  origin: string
  label: string
  instance: string
  connect: ConnectPeer
}

let doorPath: string | null = null

/** The connect door's socket while it is open (web/connect-door.ts sets it). */
export function setConnectDoor(path: string | null): void {
  const changed = doorPath !== path
  doorPath = path
  if (changed) scheduleConnectSync('door')
}

export function connectDoor(): string | null {
  return doorPath
}

export async function walnutConnectOn(): Promise<boolean> {
  const { getConfig } = await import('../config-manager.js')
  const cfg = await getConfig().catch(() => null)
  return experimentalEnabled(cfg?.experimental, 'walnut_connect')
}

/** On, and this server is the user's real leader: the door may open and the network run. */
export async function connectWanted(): Promise<boolean> {
  const [{ isFollower }, { netActive }] = await Promise.all([import('../server-role.js'), import('../net/net-mac.js')])
  if (isFollower()) return false
  return (await walnutConnectOn()) && (await netActive())
}

interface LinkLike {
  hasCapability(name: string): boolean
  send(cmd: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown>
}

/**
 * The Walnut Connect part of this Mac's walnut-net config: the phones and the door, only while
 * it is on, the door is open and the daemon passes them on (net-web-v1). Absent otherwise, so a
 * Mac that never turned it on writes the config it always wrote.
 */
export async function connectNetFields(local: LinkLike): Promise<{ phones?: ConnectPhone[]; webSocket?: string }> {
  if (!doorPath || !local.hasCapability('net-web-v1') || !(await walnutConnectOn())) return {}
  const phones = await connectPhones()
  return phones.length ? { phones, webSocket: doorPath } : {}
}

interface NodeStatus {
  id?: unknown
  relayMode?: unknown
  homeRelay?: unknown
  addrs?: unknown
}

let statusCache: { at: number; value: { protocol: number; node: NodeStatus | null } } | null = null

type StatusSource = () => Promise<{ running?: boolean; protocol?: number; node?: NodeStatus | null } | null>
let statusSource: StatusSource | null = null

/** Tests: answer walnut-net's status without a daemon. */
export function setConnectStatusSourceForTest(fn: StatusSource | null): void {
  statusSource = fn
  statusCache = null
}

async function localNetStatus(): Promise<{ protocol: number; node: NodeStatus | null } | null> {
  if (statusCache && Date.now() - statusCache.at < STATUS_TTL_MS) return statusCache.value
  if (statusSource) {
    const s = await statusSource()
    return s ? { protocol: s.running ? Number(s.protocol ?? 0) : 0, node: s.running ? s.node ?? null : null } : null
  }
  const { link } = await import('../hosts/link.js')
  const local = await link('__local__')
  if (!local.hasCapability('net-web-v1')) return null
  const s = await local.send('net.status', {}, 5_000) as { running?: boolean; protocol?: number; node?: NodeStatus | null }
  const value = { protocol: s.running ? Number(s.protocol ?? 0) : 0, node: s.running ? s.node ?? null : null }
  statusCache = { at: Date.now(), value }
  return value
}

/** Addresses a phone may dial directly: no loopback or link-local (another device's would be). */
export function dialableAddrs(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const a of raw) {
    if (typeof a !== 'string' || a.length > 64) continue
    if (/^127\.|^\[::1\]|^\[fe80:|^169\.254\./i.test(a)) continue
    out.push(a)
    if (out.length >= ADDRS_MAX) break
  }
  return out
}

/**
 * The route a paired phone dials, or null while Walnut Connect cannot take one: off, no door,
 * the network not running, or a walnut-net older than phones (it downloads the new one).
 */
export async function connectRoute(instance: string): Promise<ConnectRoute | null> {
  try {
    if (!doorPath || !(await connectWanted())) return null
    const st = await localNetStatus()
    if (!st || st.protocol < WEB_PROTOCOL || !st.node) return null
    const id = typeof st.node.id === 'string' ? st.node.id : ''
    if (!/^[0-9a-f]{64}$/.test(id)) return null
    const mode = st.node.relayMode === 'public' || st.node.relayMode === 'none' ? st.node.relayMode : 'custom'
    const { netState } = await import('../net/net-mac.js')
    const net = netState()
    const home = typeof st.node.homeRelay === 'string' && /^https:\/\//.test(st.node.homeRelay) ? [st.node.homeRelay] : []
    // custom: the user's own relays (the companion's), and the roots its address discovery needs;
    // public: the relay this Mac is homed on, so the phone needs no lookup to find it.
    const relays = mode === 'custom' ? [...new Set([...net.relays, ...home])] : mode === 'public' ? home : []
    const peer: ConnectPeer = {
      id, relayMode: mode, relays, addrs: dialableAddrs(st.node.addrs),
      ...(mode === 'custom' && net.relayRoots.length ? { relayRoots: net.relayRoots } : {}),
    }
    return { kind: 'connect', origin: `walnut-connect://${id}`, label: CONNECT_ROUTE_LABEL, instance, connect: peer }
  } catch (err) {
    log.web.warn('walnut connect: no route', { error: err instanceof Error ? err.message : String(err) })
    return null
  }
}

let syncTimer: ReturnType<typeof setTimeout> | null = null

/**
 * The phones or the door changed: this Mac's walnut-net is told (one host network sync, debounced),
 * and the network is turned on first when Walnut Connect is on and it is off.
 */
export function scheduleConnectSync(why: string): void {
  if (syncTimer) return
  syncTimer = setTimeout(() => {
    syncTimer = null
    void (async () => {
      if (!(await connectWanted())) {
        // Off: a sync drops the phones (connectNetFields answers none), only if the network runs anyway.
        const net = await import('../net/net-mac.js')
        if (net.netState().enabled) await net.syncNet()
        return
      }
      statusCache = null
      const net = await import('../net/net-mac.js')
      const { getConfig } = await import('../config-manager.js')
      const enabled = ((await getConfig()) as { net?: { enabled?: boolean } }).net?.enabled === true
      await net.syncNet(enabled ? {} : { enable: true })
      log.web.info('walnut connect: walnut-net told', { why, phones: (await connectPhones()).length, enabledNetwork: !enabled })
    })().catch((err) => log.web.warn('walnut connect: sync failed', { why, error: err instanceof Error ? err.message : String(err) }))
  }, SYNC_DEBOUNCE_MS)
  syncTimer.unref?.()
}

export function resetConnectForTest(): void {
  doorPath = null
  statusCache = null
  if (syncTimer) clearTimeout(syncTimer)
  syncTimer = null
}
