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

export interface Where { addrs?: string[]; relay?: string }

const MAX_ADDRS = 8

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
    if (addrs.length || relay) out[id] = { ...(addrs.length ? { addrs } : {}), ...(relay ? { relay } : {}) }
  }
  return out
}

/** Each machine with where it was last seen: its addresses and relay ride its dial. */
export function withWhere(members: NetMember[], net: unknown): NetMember[] {
  const w = whereOf(net)
  return members.map((m) => {
    const x = w[m.id]
    if (m.role !== 'host' || !x) return m
    return { ...m, ...(x.addrs ? { addrs: x.addrs } : {}), ...(x.relay ? { relays: [x.relay] } : {}) }
  })
}

/** The addresses to keep: the new ones first, then the old ones, once each, at most 8. */
export function mergeAddrs(fresh: string[], kept: string[] = []): string[] {
  return [...new Set([...fresh.filter(socketAddr), ...kept])].slice(0, MAX_ADDRS)
}

export function sameRelay(a: string, b: string): boolean {
  try { return new URL(a).href === new URL(b).href } catch { return false }
}

/**
 * The relay to keep for a machine on `home`: one of this Mac's own (`ours`, the companion's)
 * is kept; one the machine merely names never is, so it cannot send this Mac anywhere. A
 * machine still on the relay already kept (one that could not move yet) keeps it, and one
 * that says none (restarting) changes nothing.
 */
export function relayToKeep(home: string | null | undefined, ours: string[], was: string | undefined): string | undefined {
  if (!home) return was
  if (ours.some((r) => sameRelay(r, home))) return home
  return was && sameRelay(was, home) ? was : undefined
}

/**
 * Note where a machine was seen: `home` is the relay it reports it is on (absent: the relay
 * kept stays). Only a machine this Mac lists (a host row or `net.joined`) and none being
 * removed, checked in the same config write, so a Remove is never undone (Remove drops the
 * row before it forgets the machine). True when it changed.
 */
export async function noteWhere(endpoint: string, seen: { addrs: string[]; home?: string | null; ours?: string[] }): Promise<boolean> {
  const { modifyConfigDoc } = await import('../config-store.js')
  return modifyConfigDoc((doc) => {
    const net = netDoc(doc)
    const removing = Array.isArray(net.removing) ? net.removing : []
    const listed = netRows((doc.hosts ?? {}) as HostRows).some(([, h]) => h.endpoint === endpoint) || !!joinedOf(net)[endpoint]
    if (!listed || removing.includes(endpoint)) return { write: false, result: false }
    const all = whereOf(net)
    const was = all[endpoint] ?? {}
    const addrs = mergeAddrs(seen.addrs, was.addrs)
    const keep = 'home' in seen ? relayToKeep(seen.home, seen.ours ?? [], was.relay) : was.relay
    const relay = relayOk(keep) ? keep : undefined
    const next: Where = { ...(addrs.length ? { addrs } : {}), ...(relay ? { relay } : {}) }
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
