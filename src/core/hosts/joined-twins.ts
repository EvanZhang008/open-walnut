/**
 * A machine found in ~/.ssh/config that has joined the host network since: one machine, so
 * Remote Hosts lists it once. 2026-11-03: after studio-mac joined (row Studio-MacBook,
 * Connected), Remote Hosts still listed `studio-mac 10.20.30.40 · Not connected` from
 * ~/.ssh/config above it, and the user read the same machine twice, one of them not
 * connected, as a join that failed.
 *
 * Only the list leaves the found row out (GET /api/hosts/net names it, the Remote Hosts
 * editor skips it and still saves it): its sessions, its server and its settings are the
 * user's, and config.yaml keeps it as it was.
 *
 * The same machine when the found row's HostName is
 *  - an address the joined machine itself reported at its last sighting (`net.where` `self`,
 *    its own network interfaces, net-seen.ts): a private one or an IPv6 one, never a public
 *    IPv4 (the machines behind one home router share it), loopback or link-local, and never
 *    an address two machines reported;
 *  - or a name that is one joined machine's name, bare or with a local-network suffix
 *    (`studio-mac`, `studio-mac.local`, `.lan`, `.home`, `.localdomain`, `.home.arpa`),
 *    never a name under someone's domain: `dev.corp.example.com` is not the joined "dev".
 * Only a joined row that can be used counts: enabled, while the host network is on
 * (`net.enabled`). A user who turns it off, or disables the joined row, gets the found row
 * back everywhere.
 * A found row whose alias is a joined machine's never got in (config-manager.ts).
 */
import { isIP } from 'node:net'
import { whereOf } from '../net/net-where.js'

type HostRows = Record<string, { hostname?: unknown; discovered?: unknown; transport?: unknown; endpoint?: unknown; label?: unknown; enabled?: unknown } | undefined>

/** What may follow a machine's own name and still name that machine on a home network. */
const LOCAL_SUFFIX = /^(?:local|lan|home|localdomain|home\.arpa)$/

/** The address of an `ip:port` or `[ip]:port`, lowercased. */
function ipOf(socket: string): string {
  const m = /^\[([^\]]+)\]:\d+$/.exec(socket) ?? /^([^:]+):\d+$/.exec(socket)
  return (m ? m[1] : socket).toLowerCase()
}

/** An address that names one machine: private IPv4, or IPv6 that is not loopback or link-local. */
function namesOneMachine(ip: string): boolean {
  if (isIP(ip) === 6) return ip !== '::1' && !/^fe[89ab][0-9a-f]:/.test(ip)
  const [a, b] = ip.split('.').map(Number)
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
}

/** Each found row that is a joined machine, with that machine's alias. */
export function joinedTwins(hosts: HostRows, net: unknown): Array<{ alias: string; joined: string }> {
  if (!net || typeof net !== 'object' || (net as { enabled?: unknown }).enabled !== true) return []
  const joined = Object.entries(hosts).filter(([, h]) => h?.transport === 'net' && typeof h.endpoint === 'string' && h.enabled !== false) as Array<[string, NonNullable<HostRows[string]>]>
  if (joined.length === 0) return []
  const where = whereOf(net)
  // Each address and each name with the machines that have it; one held by two names neither.
  const at = new Map<string, Set<string>>()
  const named = new Map<string, Set<string>>()
  const add = (m: Map<string, Set<string>>, k: string, alias: string) => { if (!m.has(k)) m.set(k, new Set()); m.get(k)!.add(alias) }
  for (const [alias, h] of joined) {
    for (const s of where[h.endpoint as string]?.self ?? []) {
      const ip = ipOf(s)
      if (namesOneMachine(ip)) add(at, ip, alias)
    }
    for (const n of new Set([alias, typeof h.label === 'string' ? h.label : ''])) if (n) add(named, n.toLowerCase(), alias)
  }
  const out: Array<{ alias: string; joined: string }> = []
  for (const [alias, h] of Object.entries(hosts)) {
    if (!h || h.discovered !== true || h.transport === 'net' || typeof h.hostname !== 'string') continue
    const name = h.hostname.trim().toLowerCase().replace(/^\[|\]$/g, '')
    const dot = name.indexOf('.')
    const local = dot < 0 || LOCAL_SUFFIX.test(name.slice(dot + 1))
    const seen = isIP(name) ? at.get(name) : local ? named.get(dot < 0 ? name : name.slice(0, dot)) : undefined
    if (seen?.size === 1) out.push({ alias, joined: [...seen][0] })
  }
  return out
}

/**
 * The hosts a person picks from (a session's host, Quick Start, the phone's launcher, a
 * transfer): the enabled rows, each machine once (a found twin of a joined machine left
 * out). Every place that lists hosts for a choice takes them from here; a new one that does
 * not is caught by tests/core/hosts/joined-twins-pickers.test.ts.
 */
export function pickableHosts<T extends { enabled?: unknown }>(hosts: Record<string, T | undefined>, net: unknown): Array<[string, T]> {
  const twins = new Set(joinedTwins(hosts as HostRows, net).map((t) => t.alias))
  return Object.entries(hosts).filter((e): e is [string, T] => !!e[1] && e[1].enabled !== false && !twins.has(e[0]))
}

/**
 * A found twin's alias read as its joined machine's, every other alias as it is: what was
 * recorded under the ~/.ssh/config row (a folder used there) belongs to the machine the
 * pickers list.
 */
export function joinedAliasOf(hosts: HostRows, net: unknown): <A extends string | null | undefined>(alias: A) => A | string {
  const to = new Map(joinedTwins(hosts, net).map((t) => [t.alias, t.joined]))
  return (alias) => (alias && to.get(alias)) || alias
}
