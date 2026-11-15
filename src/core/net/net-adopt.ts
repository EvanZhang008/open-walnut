/**
 * Keep an existing host alias when that same machine joins the host network.
 * The caller must first read net.identity over the old link and match the joined
 * endpoint. Names alone never prove that an SSH host and a joined machine are one.
 * This changes rows, not membership, credentials, sessions or the daemon.
 */
import type { Config } from '../types.js'
import { netHostname, netRows, type HostRows } from './net-rows.js'

export interface HostAdoption {
  host: string
  joined: string
  /** net.identity read over the existing host's link, before its transport changes. */
  endpoint: string
  /** The source row must still name the machine that was checked. */
  hostname: string
  route: string
}

/** Only routing fields: a concurrent label, server or weight edit is kept. */
export function adoptionRoute(row: Record<string, unknown>): string {
  return JSON.stringify(['hostname', 'ssh', 'user', 'port', 'discovered', 'shell_setup'].map((key) => row[key] ?? null))
}

export function adoptHostRows(hosts: HostRows, input: HostAdoption): HostRows {
  const { host, joined, endpoint, hostname } = input
  if (!/^[0-9a-f]{64}$/.test(endpoint)) throw new Error('Host adoption needs a verified network endpoint')
  if (!Object.hasOwn(hosts, host) || !Object.hasOwn(hosts, joined)) throw new Error('A host row is missing; nothing was changed')
  const old = hosts[host]
  const machine = hosts[joined]
  if (old.transport === 'net' && old.endpoint === endpoint && host === joined) return hosts
  if (host === joined || old.transport === 'net' || old.hostname !== hostname || adoptionRoute(old) !== input.route) throw new Error('The existing host changed after it was checked; nothing was changed')
  if (machine.transport !== 'net' || machine.endpoint !== endpoint) throw new Error('The joined machine changed after it was checked; nothing was changed')
  if (netRows(hosts).filter(([, row]) => row.endpoint === endpoint).length !== 1) throw new Error('The network endpoint has more than one host row; nothing was changed')
  const out = { ...hosts }
  out[host] = { ...old, transport: 'net', endpoint, hostname: netHostname(host) }
  delete out[joined]
  return out
}

/** Only an existing live link is asked: adopting a join never starts an SSH login. */
export async function verifiedAdoptions(hosts: HostRows, members: Array<{ id: string; name: string; role: string }>, requested: string[]): Promise<HostAdoption[]> {
  const [{ peekDaemonConnection, pooledConnectionTargets }, { linkTarget }] = await Promise.all([
    import('../../providers/daemon-connection.js'), import('../hosts/link.js'),
  ])
  const candidates = members.filter((member) => requested.includes(member.name) && member.role === 'host' && Object.hasOwn(hosts, member.name)
    && typeof hosts[member.name]?.hostname === 'string')
  const checked = await Promise.all(candidates.map(async (member): Promise<HostAdoption | null> => {
    const existing = hosts[member.name]
    if (existing.transport === 'net') {
      return existing.endpoint === member.id
        ? { host: member.name, joined: member.name, endpoint: member.id, hostname: String(existing.hostname), route: adoptionRoute(existing) }
        : null
    }
    const conn = peekDaemonConnection(member.name)
    if (!conn?.connected || !conn.hasCapability('net-v1')) return null
    try {
      if (!pooledConnectionTargets(member.name, linkTarget(member.name, { hosts: hosts as unknown as Config['hosts'] }))) return null
      const identity = await conn.send('net.identity', {}, 5_000)
      if (identity.ok !== true || identity.endpointId !== member.id) return null
      const joined = netRows(hosts).filter(([, row]) => row.endpoint === member.id)
      if (joined.length !== 1) return null
      return { host: member.name, joined: joined[0][0], endpoint: member.id, hostname: String(hosts[member.name].hostname), route: adoptionRoute(hosts[member.name]) }
    } catch { return null }
  }))
  return checked.filter((entry): entry is HostAdoption => entry !== null)
}
