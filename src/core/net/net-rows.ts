/**
 * The host network's rows in config.yaml (core/net/net-mac.ts): each machine a
 * `transport: net` host, the removals Remove has started (`net.removing`), and with no
 * cloud companion the machines that joined this Mac (`net.joined`, the list itself).
 */
import type { NetMember } from './net-mac.js'

/**
 * The hostname of a host network row: a name that never resolves (`.invalid`), so an
 * older Walnut, which reads the row as an SSH host, fails at once instead of reaching
 * some other machine of that name. This Mac dials the endpoint, never the hostname.
 */
export function netHostname(alias: string): string {
  return `${alias}.walnut-net.invalid`
}

export type HostRows = Record<string, Record<string, unknown>>

export function netRows(hosts: HostRows): Array<[string, Record<string, unknown> & { endpoint: string }]> {
  return Object.entries(hosts).filter((e): e is [string, Record<string, unknown> & { endpoint: string }] =>
    !!e[1] && e[1].transport === 'net' && typeof e[1].endpoint === 'string')
}

/** `name`, else `name-net`, `name-net-2`, ...: never a row already there. */
function freeAlias(name: string, hosts: HostRows): string {
  if (!Object.hasOwn(hosts, name)) return name
  for (let i = 1; i < 100; i++) {
    const n = i === 1 ? `${name}-net` : `${name}-net-${i}`
    if (!Object.hasOwn(hosts, n)) return n
  }
  return `${name}-net-${Date.now().toString(36)}`
}

/**
 * Make config.hosts hold every host member: a row per machine, matched by its endpoint
 * (a row keeps its name). A row whose machine the list lacks stays (syncNet puts it back
 * on the list); only `drop`, the machine Remove takes out, loses its row.
 */
export async function reconcileHosts(members: NetMember[], opts: { drop?: string } = {}): Promise<{ added: string[]; removed: string[] }> {
  const { modifyConfigDoc } = await import('../config-store.js')
  return modifyConfigDoc((doc) => {
    const hosts: HostRows = doc.hosts && typeof doc.hosts === 'object' && !Array.isArray(doc.hosts) ? { ...(doc.hosts as HostRows) } : {}
    const added: string[] = []
    const removed: string[] = []
    let changed = false
    const byEndpoint = new Map<string, string>()
    for (const [alias, h] of netRows(hosts)) {
      if (opts.drop && h.endpoint === opts.drop) { delete hosts[alias]; removed.push(alias); continue }
      byEndpoint.set(h.endpoint, alias)
      // A row an earlier version wrote with a plain hostname gets the one that never resolves.
      if (h.hostname !== netHostname(alias)) { hosts[alias] = { ...h, hostname: netHostname(alias) }; changed = true }
    }
    // A row an older Remote Hosts editor saved without its transport and endpoint: its
    // never-resolving hostname still marks it, and the member of its name (the row's
    // label, else its alias: the user may have renamed the label) takes it back.
    const lost: Array<{ alias: string; label: string | null }> = []
    for (const [alias, h] of Object.entries(hosts)) {
      if (h && h.transport === undefined && h.hostname === netHostname(alias)) lost.push({ alias, label: typeof h.label === 'string' && h.label ? h.label : null })
    }
    for (const m of members) {
      if (m.role !== 'host' || m.id === opts.drop || byEndpoint.has(m.id)) continue
      let at = lost.findIndex((l) => l.label === m.name)
      if (at < 0) at = lost.findIndex((l) => l.alias === m.name)
      if (at >= 0) {
        const back = lost[at].alias
        hosts[back] = { ...hosts[back], transport: 'net', endpoint: m.id }
        byEndpoint.set(m.id, back)
        lost.splice(at, 1)
        changed = true
        continue
      }
      const alias = freeAlias(m.name, hosts)
      hosts[alias] = { hostname: netHostname(alias), label: m.name, transport: 'net', endpoint: m.id, enabled: true }
      byEndpoint.set(m.id, alias)
      added.push(alias)
    }
    if (!changed && added.length === 0 && removed.length === 0) return { write: false, result: { added, removed } }
    doc.hosts = hosts
    return { write: true, result: { added, removed } }
  })
}


/**
 * `net.removing` in config: machines Remove has started to take out. Kept across a
 * restart, so a removal cut short is finished by the next sync instead of the machine
 * being put back on the list.
 */
export async function removalsPending(): Promise<string[]> {
  const { getConfig } = await import('../config-manager.js')
  const r = ((await getConfig()) as { net?: { removing?: unknown } }).net?.removing
  return Array.isArray(r) ? r.filter((x): x is string => typeof x === 'string') : []
}

export async function markRemoving(endpoint: string, on: boolean): Promise<void> {
  const { modifyConfigDoc } = await import('../config-store.js')
  await modifyConfigDoc((doc) => {
    const net = doc.net && typeof doc.net === 'object' && !Array.isArray(doc.net) ? { ...(doc.net as Record<string, unknown>) } : {}
    const was = Array.isArray(net.removing) ? (net.removing as unknown[]).filter((x): x is string => typeof x === 'string') : []
    const next = on ? [...new Set([...was, endpoint])] : was.filter((x) => x !== endpoint)
    if (next.length === was.length && next.every((x, i) => x === was[i])) return { write: false, result: undefined }
    if (next.length) net.removing = next
    else delete net.removing
    doc.net = net
    return { write: true, result: undefined }
  })
}


/** A machine that joined this Mac with no companion: what the list keeps of it. */
export interface JoinedMachine { name: string; platform?: string; addedAt: number }

export function netDoc(doc: Record<string, unknown>): Record<string, unknown> {
  return doc.net && typeof doc.net === 'object' && !Array.isArray(doc.net) ? { ...(doc.net as Record<string, unknown>) } : {}
}

export function joinedOf(net: unknown): Record<string, JoinedMachine> {
  const j = net && typeof net === 'object' ? (net as { joined?: unknown }).joined : undefined
  if (!j || typeof j !== 'object' || Array.isArray(j)) return {}
  const out: Record<string, JoinedMachine> = {}
  for (const [id, m] of Object.entries(j as Record<string, unknown>)) {
    if (!/^[0-9a-f]{64}$/.test(id) || !m || typeof m !== 'object') continue
    const o = m as Record<string, unknown>
    out[id] = { name: typeof o.name === 'string' && o.name ? o.name : 'machine', ...(typeof o.platform === 'string' ? { platform: o.platform } : {}), addedAt: typeof o.addedAt === 'number' ? o.addedAt : 0 }
  }
  return out
}

/** Keep (`m`) or forget (null) a machine in `net.joined`. */
export async function setJoined(endpoint: string, m: JoinedMachine | null): Promise<void> {
  const { modifyConfigDoc } = await import('../config-store.js')
  await modifyConfigDoc((doc) => {
    const net = netDoc(doc)
    const joined = { ...joinedOf(net) }
    if (m) joined[endpoint] = m
    else if (joined[endpoint]) delete joined[endpoint]
    else return { write: false, result: undefined }
    if (Object.keys(joined).length) net.joined = joined
    else delete net.joined
    doc.net = net
    return { write: true, result: undefined }
  })
}

/**
 * With no companion the list is this Mac's: every machine in `net.joined` and every
 * `transport: net` row (one an earlier companion put there), never one being removed.
 */
export function localMembers(hosts: HostRows, net: unknown, macId: string, macName: string, skip: Set<string>): NetMember[] {
  const joined = joinedOf(net)
  const out = new Map<string, NetMember>()
  for (const [alias, h] of netRows(hosts)) {
    if (skip.has(h.endpoint) || h.endpoint === macId) continue
    const j = joined[h.endpoint]
    out.set(h.endpoint, { id: h.endpoint, name: typeof h.label === 'string' && h.label ? h.label : alias, role: 'host', ...(j?.platform ? { platform: j.platform } : {}), ...(j?.addedAt ? { addedAt: j.addedAt } : {}) })
  }
  for (const [id, j] of Object.entries(joined)) {
    if (skip.has(id) || id === macId || out.has(id)) continue
    out.set(id, { id, name: j.name, role: 'host', ...(j.platform ? { platform: j.platform } : {}), addedAt: j.addedAt })
  }
  return [{ id: macId, name: macName, role: 'mac' }, ...out.values()]
}
