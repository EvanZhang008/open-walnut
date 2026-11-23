/**
 * The leader's side of a service set's own walnut-net (service-set-net.ts on the host; the
 * experiment host_service_sets). A later Walnut's set on a machine has its own network identity, so
 * a host-network leader pairs with it before it moves, automatically and only over the link it
 * already holds there (the one to the shared daemon, authenticated by that walnut-net):
 *
 *   1. `walnut daemon net-id --walnut … --request <list>` on the host, by this build's copy in the
 *      set: the set's daemon takes the leader's member list (the one every joined machine gets, so
 *      this leader is let in) and starts the set's walnut-net; the answer is its endpoint id and addresses;
 *   2. the endpoint is kept on the host's set record first, so a sync from here on takes it for the
 *      set's (never for a machine of its own that gets a host row);
 *   3. with a cloud companion, the endpoint goes on its member list (its relay lets members on; a
 *      refusal takes the record back), and this leader's own walnut-net lists it as a host member it
 *      dials (core/net/net-service-sets.ts).
 * Anything not done throws: the move does not start, and nothing of the shared daemon was touched.
 *
 * The flip is then only which endpoint the link dials (service-set-move-link.ts netEndpoint); the
 * endpoint dialled before stays a member until the move is confirmed. After it, this leader takes
 * itself off the shared walnut-net's list (`net-forget`, only its own entry) and drops that endpoint
 * from its own. Leaving the host (a Remove) forgets the set's endpoint on the companion first, then
 * the host's whole record here (forgetSetNet).
 */
import { NET_FORGET_ACTION, NET_ID_ACTION, NET_ID_BUDGET_MS, encodeNetRequest } from './service-set-net.js'
import { hostServiceSets, markServiceSetNetLeft, markServiceSetNetPaired, movedToSet, serviceSetWords, setNetMemberName, unmarkServiceSetNetPaired, type SetAsk } from './service-set-leader.js'
import { parseServiceSetLine } from './service-set.js'
import { serviceSetMoves } from './service-set-move.js'

const NET_ID = /^[0-9a-f]{64}$/
/** The host side ends within NET_ID_BUDGET_MS (a first walnut-net download included); the line's own start comes on top. */
export const NET_ID_TIMEOUT_MS = NET_ID_BUDGET_MS + 20_000

/** What pairing and its undo use; the link and core/net/net-service-sets.ts give each. */
export interface NetPairDeps {
  place: string
  set: string
  ask: SetAsk
  /** The endpoint the link dials now (the shared daemon's walnut-net), or null. */
  shared: string | null
  /** The set's own `walnut daemon <words>` line on the host, over the link as it is now. */
  runSetCli(words: string, timeoutMs: number): Promise<string>
  /** The member list the set's walnut-net is given (throws before this machine's network synced). */
  list(): Record<string, unknown>
  /** The relay lets `endpoint` on (a companion's list), or not any more. */
  register(endpoint: string, name: string): Promise<void>
  unregister(endpoint: string): Promise<void>
  /** This leader's own walnut-net takes the set members as the records say now. */
  apply(): Promise<void>
}

/** The last JSON line of a `walnut daemon` answer, or null. */
export function jsonAnswer(said: string): Record<string, unknown> | null {
  const line = said.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{')).pop()
  if (!line) return null
  try { return JSON.parse(line) as Record<string, unknown> } catch { return null }
}

const why = (a: Record<string, unknown> | null): string => String(a?.message ?? a?.code ?? 'no answer').slice(0, 300)

/** Pair this leader with the set's own walnut-net (the header); throws, saying why, when any step is not done. */
export async function pairServiceSetNet(d: NetPairDeps): Promise<{ endpoint: string; addrs: string[] }> {
  const words = serviceSetWords(d.ask)
  if (!words) throw new Error('this Walnut has no id the host can name a set by')
  const said = await d.runSetCli(`${NET_ID_ACTION}${words} --request ${encodeNetRequest(d.list())}`, NET_ID_TIMEOUT_MS)
  const named = parseServiceSetLine(said)
  const a = jsonAnswer(said)
  if (named !== d.set) throw new Error(`the host named ${named === null ? 'no set' : `set ${named || 'default'}`} for its walnut-net, not this Walnut's own (${d.set}): ${why(a)}`)
  if (a?.ok !== true || typeof a.endpointId !== 'string' || !NET_ID.test(a.endpointId)) throw new Error(`the set's walnut-net did not start: ${why(a)}`)
  const endpoint = a.endpointId
  if (endpoint === d.shared) throw new Error('the set answered the endpoint the link reaches already, not one of its own')
  const addrs = Array.isArray(a.addrs) ? a.addrs.filter((x): x is string => typeof x === 'string').slice(0, 16) : []
  const before = await hostServiceSets.read(d.place).catch(() => null)
  if (!(await markServiceSetNetPaired(d.place, d.set, { endpoint, addrs, shared: d.shared }))) throw new Error('the host\'s set record changed meanwhile')
  try {
    await d.register(endpoint, setNetMemberName(d.place))
  } catch (err) {
    await unmarkServiceSetNetPaired(d.place, endpoint, before)
    throw err
  }
  await d.apply()
  return { endpoint, addrs }
}

/**
 * After the move is confirmed: this leader dials the shared endpoint no more (its own list), and the
 * shared walnut-net lets this leader in no more (`net-forget`: only its own entry, never the other
 * Walnut's key, members or process). Once; a step that fails is tried at the next look.
 */
export async function leaveSharedNet(d: Pick<NetPairDeps, 'place' | 'set' | 'runSetCli' | 'apply'> & { me: string | null }): Promise<void> {
  const r = await hostServiceSets.read(d.place).catch(() => null)
  if (!movedToSet(r) || r.set !== d.set || !r.netShared || r.netSharedLeftAt !== undefined) return
  await d.apply()
  if (!d.me || !NET_ID.test(d.me)) return
  const a = jsonAnswer(await d.runSetCli(`${NET_FORGET_ACTION} --member ${d.me}`, 30_000))
  if (a?.ok !== true) throw new Error(`the machine's walnut-net still lets this leader in: ${why(a)}`)
  await markServiceSetNetLeft(d.place, d.set)
}

/**
 * Leaving the host: the companion forgets the set's endpoint first (throws when it did not: the record
 * stays, and the next sync tries again, net-service-sets.ts), then the host's whole record goes here,
 * so this leader's walnut-net dials it no more (`apply`).
 */
export async function forgetSetNet(d: Pick<NetPairDeps, 'place' | 'unregister' | 'apply'>): Promise<void> {
  const r = await hostServiceSets.read(d.place)
  if (!r) return
  if (r.netEndpoint) await d.unregister(r.netEndpoint)
  await hostServiceSets.write(d.place, null)
  // A move record of the host is no try to resume, nor a done move to dial by, if the host comes back.
  await serviceSetMoves.write(d.place, null).catch(() => {})
  if (r.netEndpoint) await d.apply()
}
