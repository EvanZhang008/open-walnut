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

async function netEnabled(): Promise<boolean> {
  const { getConfig } = await import('../config-manager.js')
  return ((await getConfig().catch(() => null)) as { net?: { enabled?: boolean } } | null)?.net?.enabled === true
}

/**
 * On, this server is the user's real leader, and the host network runs: the door may open.
 * A host network the user turned off stays off (Walnut Connect is off with it).
 */
export async function connectWanted(): Promise<boolean> {
  const [{ isFollower }, { netActive }] = await Promise.all([import('../server-role.js'), import('../net/net-mac.js')])
  if (isFollower()) return false
  return (await walnutConnectOn()) && (await netActive()) && (await netEnabled())
}

/** The experiment's value at the last look; null before the first (a boot is no switch). */
let flagSeen: boolean | null = null

/**
 * The experiment was just switched on: the host network is turned on with it, once. Never at
 * boot and never later on its own, so a network the user turns off is not turned back on.
 */
export async function enableNetIfSwitchedOn(): Promise<void> {
  const on = await walnutConnectOn()
  const switchedOn = flagSeen === false && on
  flagSeen = on
  if (!switchedOn) return
  const [{ isFollower }, net] = await Promise.all([import('../server-role.js'), import('../net/net-mac.js')])
  if (isFollower() || !(await net.netActive()) || (await netEnabled())) return
  await net.syncNet({ enable: true })
  log.web.info('walnut connect: the host network turned on with it')
}

interface LinkLike {
  hasCapability(name: string): boolean
  send(cmd: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown>
}

/** Phones the last config gave walnut-net: with none and Walnut Connect off, a change needs no sync. */
let phonesSent = 0

/**
 * The Walnut Connect part of this Mac's walnut-net config: the phones and the door, only while
 * it is on, the door is open and the daemon passes them on (net-web-v1). Absent otherwise, so a
 * Mac that never turned it on writes the config it always wrote.
 */
export async function connectNetFields(local: LinkLike, reserved: Iterable<string> = []): Promise<{ phones?: ConnectPhone[]; webSocket?: string }> {
  if (!doorPath || !local.hasCapability('net-web-v1') || !(await walnutConnectOn())) { phonesSent = 0; return {} }
  // Never a machine's id (or this Mac's): a phone is no member, and one record never stops the sync.
  const taken = new Set([...reserved].map((id) => id.toLowerCase()))
  const phones = (await connectPhones()).filter((p) => !taken.has(p.id))
  phonesSent = phones.length
  return phones.length ? { phones, webSocket: doorPath } : {}
}

/** The ids no phone may take: this Mac's and its machines' on the host network. */
export async function reservedNetIds(): Promise<Set<string>> {
  const { netState } = await import('../net/net-mac.js')
  const s = netState()
  return new Set([...(s.macId ? [s.macId] : []), ...s.members.map((m) => m.id)].map((id) => id.toLowerCase()))
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

/** Relay URLs once each: the configured one and the one walnut-net reports differ by a final slash. */
export function uniqueRelays(urls: string[]): string[] {
  const seen = new Set<string>()
  return urls.filter((u) => {
    const key = u.trim().replace(/\/+$/, '').toLowerCase()
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
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
    const relays = mode === 'custom' ? uniqueRelays([...net.relays, ...home]) : mode === 'public' ? home : []
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
 * The phones or the door changed: this Mac's walnut-net is told (one host network sync,
 * debounced, started after any sync already running so it reads the phones as they are now).
 * Nothing to tell when Walnut Connect is off and walnut-net was given no phones.
 */
export function scheduleConnectSync(why: string): void {
  if (syncTimer) return
  syncTimer = setTimeout(() => {
    syncTimer = null
    void (async () => {
      const wanted = await connectWanted()
      if (!wanted && phonesSent === 0) return
      statusCache = null
      const net = await import('../net/net-mac.js')
      if (!net.netState().enabled) return
      await net.syncNet({ fresh: true })
      log.web.info('walnut connect: walnut-net told', { why, phones: phonesSent })
    })().catch((err) => log.web.warn('walnut connect: sync failed', { why, error: err instanceof Error ? err.message : String(err) }))
  }, SYNC_DEBOUNCE_MS)
  syncTimer.unref?.()
}

export function resetConnectForTest(): void {
  doorPath = null
  statusCache = null
  flagSeen = null
  phonesSent = 0
  if (syncTimer) clearTimeout(syncTimer)
  syncTimer = null
}
