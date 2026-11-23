/**
 * Service sets on the host network (providers/service-set-net-pair.ts): a later Walnut's service on
 * a machine has a walnut-net identity of its own, beside the machine's. For this leader each such
 * endpoint is an ordinary host member it dials (accept false), kept on the host's set record
 * (providers/service-set-leader.ts), never a machine of its own: no host row, no Settings entry.
 * Once the host moved into the set, the endpoint dialled before (the shared daemon's) is dropped
 * from this leader's own list. With a cloud companion the set's endpoint is on its member list too,
 * which is what lets it on the companion's relay (routes/net-v1.ts relay-access); leaving takes it off.
 */
import { log } from '../../logging/index.js'
import { companionCall, errorOf, hostListNow, netState, syncNet } from './net-mac.js'
import { NetError } from './net-error.js'

type SetMembers = Awaited<ReturnType<typeof import('../../providers/service-set-leader.js').serviceSetNetMembers>>

export async function serviceSetMembersNow(): Promise<SetMembers> {
  const { serviceSetNetMembers } = await import('../../providers/service-set-leader.js')
  return serviceSetNetMembers().catch(() => ({ add: [], drop: new Set<string>() }))
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

/** Leaving: the relay no longer lets it on. Best effort; a companion that already forgot it is fine. */
export async function unregisterSetEndpoint(endpoint: string): Promise<void> {
  if (!netState().companion) return
  const r = await companionCall(`/net/members/${endpoint}`, { method: 'DELETE' })
  if (r.status !== 200 && r.status !== 404) log.session.warn('net: the cloud companion kept a service set endpoint', { endpoint, status: r.status, error: errorOf(r.body).message })
}

/** This leader's walnut-net takes the set members as they are now; throws when the sync did not go through. */
export async function applyServiceSetMembers(): Promise<void> {
  // A sync already running may have read the records before this change: wait for it, then one more.
  await syncNet().catch(() => undefined)
  const s = await syncNet()
  if (s.error) throw new Error(`this machine's walnut-net did not take the change: ${s.error}`)
}
