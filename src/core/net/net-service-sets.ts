/**
 * Service sets on the host network (providers/service-set-net-pair.ts): a later Walnut's service on
 * a machine has a walnut-net identity of its own, beside the machine's. For this leader each such
 * endpoint is an ordinary host member it dials (accept false), kept on the host's set record
 * (providers/service-set-leader.ts), never a machine of its own: no host row, no Settings entry.
 * Once the host moved into the set, the endpoint dialled before (the shared daemon's) is dropped
 * from this leader's own list. With a cloud companion the set's endpoint is on its member list too,
 * which is what lets it on the companion's relay (routes/net-v1.ts relay-access); leaving takes it off.
 * The endpoint is dialled where it was last seen too (net-where.ts), as a host row's machine is.
 */
import { log } from '../../logging/index.js'
import { companionCall, companionPaired, errorOf, hostListNow, netState, syncNet } from './net-mac.js'
import { NetError } from './net-error.js'
import { mergeAddrs, withWhere } from './net-where.js'
import type { SetNetMembers } from '../../providers/service-set-leader.js'

type SetMembers = SetNetMembers

/**
 * The set members for this sync, read from the host records. Throws when they cannot be read (the
 * sync then fails before reconcileHosts: an empty list would give each set endpoint the companion
 * lists a host row of its own). A record of a host this leader no longer has (a Remove whose
 * companion DELETE did not go through) is forgotten here, and never dialled meanwhile.
 */
export async function serviceSetMembersNow(): Promise<SetMembers> {
  const [{ serviceSetNetMembers }, { forgetSetNet }, { getConfig }] = await Promise.all([
    import('../../providers/service-set-leader.js'), import('../../providers/service-set-net-pair.js'), import('../config-manager.js'),
  ])
  const cfg = await getConfig() as { net?: { enabled?: unknown }; hosts?: Record<string, unknown> }
  // An unreadable config reads as the defaults, with the network off: no host is taken for gone then.
  const hosts = cfg.net?.enabled === true ? cfg.hosts ?? {} : null
  const sets = await serviceSetNetMembers(hosts ? (host) => Object.hasOwn(hosts, host) : undefined)
  for (const g of sets.gone) {
    // This very sync applies the list without it: no apply of its own (it would wait for itself).
    await forgetSetNet({ place: g.place, unregister: unregisterSetEndpoint, apply: async () => {} }).then(
      () => log.session.info('net: forgot the service set endpoint of a host that left', { place: g.place }),
      (err: unknown) => log.session.warn('net: the cloud companion still lists the service set endpoint of a host that left', { place: g.place, error: err instanceof Error ? err.message : String(err) }),
    )
  }
  return sets
}

/** Every set endpoint on a record (dialled, or of a host that left): never a machine of its own. */
export function setEndpointIds(sets: SetMembers): Set<string> {
  return new Set([...sets.add.map((a) => a.id), ...sets.gone.map((g) => g.id)])
}

/**
 * Each set endpoint with where it was last seen (net-where.ts withWhere, as each host row's machine):
 * those addresses first, then the ones its pairing answered; its relay when one is kept.
 */
export function withSetWhere(sets: SetMembers, net: unknown, ours: string[]): SetMembers {
  if (!sets.add.length) return sets
  const seen = withWhere(sets.add.map((a) => ({ id: a.id, name: a.name, role: 'host' as const })), net, ours)
  return {
    ...sets,
    add: sets.add.map((a, i) => {
      const w = seen[i]!
      const addrs = mergeAddrs(w.addrs ?? [], a.addrs ?? [])
      return { ...a, ...(addrs.length ? { addrs } : {}), ...(w.relays?.length ? { relays: w.relays } : {}) }
    }),
  }
}

/** This leader's own walnut-net config with the set endpoints in and the moved hosts' shared endpoints out. */
export function withServiceSetMembers(cfg: Record<string, unknown>, sets: SetMembers): Record<string, unknown> {
  if (!sets.add.length && !sets.drop.size) return cfg
  const members = (Array.isArray(cfg.members) ? cfg.members as Array<{ id?: unknown }> : [])
    .filter((m) => typeof m.id !== 'string' || (!sets.drop.has(m.id) && !sets.add.some((a) => a.id === m.id)))
  return { ...cfg, members: [...members, ...sets.add] }
}

/** The member list a set's walnut-net is given at pairing (the one every joined machine gets); throws before a sync. */
export function pairingList(): Record<string, unknown> {
  const list = hostListNow()
  if (!list) throw new NetError(409, 'net_not_synced', 'this machine\'s host network has not synced yet')
  return list
}

/** The relay lets the set's endpoint on (a companion's list); nothing to do on public relays or none. */
export async function registerSetEndpoint(endpoint: string, name: string): Promise<void> {
  if (!netState().companion) return
  const r = await companionCall(`/net/members/${endpoint}`, { method: 'PUT', body: { name } })
  if (r.status !== 200) throw new NetError(r.status, errorOf(r.body).code, `the cloud companion did not take this Walnut's own endpoint there: ${errorOf(r.body).message}`)
}

/**
 * Leaving: the relay no longer lets it on; a companion that already forgot it is fine. Throws when it
 * kept it, or the pairing does not read. The pairing is read now, not taken from the last sync: a
 * Remove right after a restart (no sync yet) must still reach the companion.
 */
export async function unregisterSetEndpoint(endpoint: string): Promise<void> {
  if (!(await companionPaired())) return
  const r = await companionCall(`/net/members/${endpoint}`, { method: 'DELETE' })
  if (r.status !== 200 && r.status !== 404) throw new NetError(r.status, errorOf(r.body).code, `the cloud companion kept this Walnut's own endpoint: ${errorOf(r.body).message}`)
}

/** This leader's walnut-net takes the set members as they are now; throws when the sync did not go through. */
export async function applyServiceSetMembers(): Promise<void> {
  // A sync already running may have read the records before this change: wait for it, then one more.
  await syncNet().catch(() => undefined)
  const s = await syncNet()
  if (s.error) throw new Error(`this machine's walnut-net did not take the change: ${s.error}`)
}
