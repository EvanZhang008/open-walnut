/**
 * Where this Mac last reached each machine on the host network (`net.where` in
 * config.yaml): its addresses (ip:port) and the relay it was on. An address book, never
 * the list: it decides nobody's membership (that is the companion's list, or `net.joined`).
 * The Mac dials each machine with it, so one that has not moved to the relay choice yet
 * (it was away), or one with no relay at all, is still found (docs/reference/host-network.md).
 */
import { socketAddr } from '../../providers/net-config-core.js'
import { joinedOf, netDoc, netRows, type HostRows } from './net-rows.js'
import type { NetMember } from './net-mac.js'

/**
 * `self`: the addresses the machine itself reported at its last sighting (its own network
 * interfaces), replaced each time, never merged: the found ~/.ssh/config row for the same
 * machine is matched by them (core/hosts/joined-twins.ts), and a network it has left must not.
 */
export interface Where { addrs?: string[]; relay?: string; self?: string[]; relayAt?: number }

const MAX_ADDRS = 8
/**
 * How long a relay outside this Mac's choice is still dialled after a machine was last seen on
 * it (`relayAt`): a machine that never comes back must not keep this Mac talking to n0's relay
 * for good while the user picked their own (2026-11-04 review). A sighting refreshes it daily.
 */
export const AWAY_RELAY_KEEP_MS = 14 * 24 * 60 * 60_000
const RELAY_AT_REFRESH_MS = 24 * 60 * 60_000

function relayOk(r: unknown): r is string {
  if (typeof r !== 'string' || !/^https?:\/\/\S{1,500}$/.test(r)) return false
  // What walnut-net and the daemon accept (net-config-core.ts): https, or http in a test.
  return r.startsWith('https://') || process.env.WALNUT_NET_ALLOW_HTTP_RELAY === '1'
}

export function whereOf(net: unknown): Record<string, Where> {
  const w = net && typeof net === 'object' ? (net as { where?: unknown }).where : undefined
  if (!w || typeof w !== 'object' || Array.isArray(w)) return {}
  const out: Record<string, Where> = {}
  for (const [id, v] of Object.entries(w as Record<string, unknown>)) {
    if (!/^[0-9a-f]{64}$/.test(id) || !v || typeof v !== 'object') continue
    const o = v as Record<string, unknown>
    const addrs = Array.isArray(o.addrs) ? (o.addrs.filter(socketAddr) as string[]).slice(0, MAX_ADDRS) : []
    const relay = relayOk(o.relay) ? o.relay : undefined
    const self = Array.isArray(o.self) ? (o.self.filter(socketAddr) as string[]).slice(0, MAX_ADDRS) : []
    const relayAt = relay && typeof o.relayAt === 'number' && Number.isFinite(o.relayAt) && o.relayAt > 0 ? o.relayAt : undefined
    if (addrs.length || relay || self.length) out[id] = { ...(addrs.length ? { addrs } : {}), ...(relay ? { relay } : {}), ...(relayAt ? { relayAt } : {}), ...(self.length ? { self } : {}) }
  }
  return out
}

/**
 * Each machine with where it was last seen: its addresses and relay ride its dial. A relay
 * outside `ours` (the relays of this Mac's choice) rides it only for AWAY_RELAY_KEEP_MS after the
 * machine was last seen there; one kept before that was stamped is dialled as before.
 */
export function withWhere(members: NetMember[], net: unknown, ours: string[] = [], now = Date.now()): NetMember[] {
  const w = whereOf(net)
  return members.map((m) => {
    const x = w[m.id]
    if (m.role !== 'host' || !x) return m
    const relay = x.relay && (ours.some((r) => sameRelay(r, x.relay!)) || x.relayAt === undefined || now - x.relayAt < AWAY_RELAY_KEEP_MS) ? x.relay : undefined
    return { ...m, ...(x.addrs ? { addrs: x.addrs } : {}), ...(relay ? { relays: [relay] } : {}) }
  })
}

/** A valid socket's identity, independent of IPv6 spelling and leading zeroes in its port. */
function addrKey(addr: string): string {
  const colon = addr.lastIndexOf(':')
  return `${new URL(`http://${addr.slice(0, colon)}/`).hostname}:${Number(addr.slice(colon + 1))}`
}

/** New sockets first, then old ones, at most 8; oversized reports choose a stable subset. */
export function mergeAddrs(fresh: string[], kept: string[] = []): string[] {
  const keys = new Set<string>()
  const out: string[] = []
  for (const addr of fresh) {
    if (!socketAddr(addr)) continue
    const key = addrKey(addr)
    if (keys.has(key)) continue
    keys.add(key)
    out.push(addr)
  }
  // A report larger than the address book must pick the same subset in any order.
  // Otherwise changing the direct path can repeatedly evict and restore its eighth socket.
  // Byte order keeps IPv4 (including LAN/NAT sockets) before IPv6, independent of locale.
  if (out.length > MAX_ADDRS) return out.sort((a, b) => {
    const ka = addrKey(a), kb = addrKey(b)
    return ka < kb ? -1 : ka > kb ? 1 : 0
  }).slice(0, MAX_ADDRS)
  for (const addr of kept) {
    if (out.length === MAX_ADDRS) break
    if (!socketAddr(addr)) continue
    const key = addrKey(addr)
    if (keys.has(key)) continue
    keys.add(key)
    out.push(addr)
  }
  return out
}

/** Keep the stored spelling and dial order when a sighting only permutes the same sockets. */
function stableAddrs(next: string[], was: string[] = []): string[] {
  const before = new Set(was.map(addrKey))
  const after = new Set(next.map(addrKey))
  return before.size === after.size && [...after].every((addr) => before.has(addr)) ? was : next
}

/** The same relay: a hostname with or without its final dot (iroh writes n0's with it). */
export function sameRelay(a: string, b: string): boolean {
  const key = (r: string) => { const u = new URL(r); u.hostname = u.hostname.replace(/\.$/, ''); return u.href }
  try { return key(a) === key(b) } catch { return false }
}

/**
 * The relay to keep for a machine on `home`: one of this Mac's own (`ours`: the companion's,
 * n0's while this Mac is on public relays, the one it is homed on) is kept; one the machine
 * merely names never is, so it cannot send this Mac anywhere. A
 * machine still on the relay already kept (one that could not move yet) keeps it, and one
 * that says none (restarting) changes nothing.
 */
export function relayToKeep(home: string | null | undefined, ours: string[], was: string | undefined): string | undefined {
  if (!home) return was
  // This Mac's own spelling, never the machine's: walnut-net parses what is kept, and a spelling
  // only one of the two parsers takes must not reach it (2026-11-04 review).
  const mine = ours.find((r) => sameRelay(r, home))
  if (mine) return mine
  return was && sameRelay(was, home) ? was : undefined
}

/**
 * Note where a machine was seen: `home` is the relay it reports it is on (absent: the relay
 * kept stays). Only a machine this Mac lists (a host row or `net.joined`) and none being
 * removed, checked in the same config write, so a Remove is never undone (Remove drops the
 * row before it forgets the machine). True when it changed.
 */
export async function noteWhere(endpoint: string, seen: { addrs: string[]; home?: string | null; ours?: string[]; self?: string[] }): Promise<boolean> {
  const { modifyConfigDoc } = await import('../config-store.js')
  return modifyConfigDoc((doc) => {
    const net = netDoc(doc)
    const removing = Array.isArray(net.removing) ? net.removing : []
    const listed = netRows((doc.hosts ?? {}) as HostRows).some(([, h]) => h.endpoint === endpoint) || !!joinedOf(net)[endpoint]
    if (!listed || removing.includes(endpoint)) return { write: false, result: false }
    const all = whereOf(net)
    const was = all[endpoint] ?? {}
    const addrs = stableAddrs(mergeAddrs(seen.addrs, was.addrs), was.addrs)
    const keep = 'home' in seen ? relayToKeep(seen.home, seen.ours ?? [], was.relay) : was.relay
    const relay = relayOk(keep) ? keep : undefined
    const self = seen.self ? stableAddrs(mergeAddrs(seen.self), was.self) : was.self ?? []
    // Seen on the relay kept: stamped, at most once a day so a sighting rarely writes config.yaml.
    const onIt = !!relay && !!seen.home && sameRelay(relay, seen.home)
    const now = Date.now()
    const relayAt = !relay ? undefined
      : onIt ? (was.relay === relay && was.relayAt && now - was.relayAt < RELAY_AT_REFRESH_MS ? was.relayAt : now)
      : was.relay === relay ? was.relayAt : now
    const next: Where = { ...(addrs.length ? { addrs } : {}), ...(relay ? { relay } : {}), ...(relayAt ? { relayAt } : {}), ...(self.length ? { self } : {}) }
    if (JSON.stringify(next) === JSON.stringify(was)) return { write: false, result: false }
    net.where = { ...all, [endpoint]: next }
    doc.net = net
    return { write: true, result: true }
  })
}

/** Forget every machine but `keep` (the ones still listed). */
export async function keepWhere(keep: Set<string>): Promise<void> {
  const { modifyConfigDoc } = await import('../config-store.js')
  await modifyConfigDoc((doc) => {
    const net = netDoc(doc)
    const all = whereOf(net)
    const next = Object.fromEntries(Object.entries(all).filter(([id]) => keep.has(id)))
    if (Object.keys(next).length === Object.keys(all).length) return { write: false, result: undefined }
    if (Object.keys(next).length) net.where = next
    else delete net.where
    doc.net = net
    return { write: true, result: undefined }
  })
}
