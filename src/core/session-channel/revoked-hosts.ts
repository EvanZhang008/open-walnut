/**
 * The hosts whose door is revoked now (leader-issue.ts revokeHostDoorNow keeps the ban with the
 * credential records; refreshRevokedHosts reads it into here). A sync read, zero imports, for every
 * path that would use a host; each of them is a row of revoked-reach.ts REVOKED_REACH, which names
 * the entry whose check refuses it. Only the leader fills it; elsewhere nothing is revoked.
 *
 * A ban is of a machine, not of one of its names. One machine can be in the config under several
 * host keys (aliases: an ssh row and the row it joined the host network as, reaching one daemon).
 * A key is revoked when:
 *   - it is a revoked record's key, or one of the keys the ban named when it was made (`keys`: the
 *     machine's other config keys known then). These are the person's facts: they hold whatever
 *     the host says about itself later (S1 of the C7 review);
 *   - it was once judged an alias of a banned key while this ban stood, by a link to the same
 *     daemon (`sticky`): a machine id or daemon instance that changes afterwards cannot shake it
 *     off. leader-issue.ts writes these into the record too, so a restart keeps them. A match by
 *     the machine id a hello claims is never kept: it bans only while the hello says it;
 *   - its daemon's hello names a revoked record's machine id, or the twin snapshot / a live link
 *     ties it to a revoked key (the host's own word: enough to ban, never to unban).
 * A machine id equal to this leader's own, and this Mac's `__local__`, are never banned (a copied
 * data home shares one id). Every check of a ban goes through revokedAs
 * (tests/core/session-channel/revoked-reach-ratchet.test.ts refuses a new one that compares a bare
 * host key).
 */

const LOCAL = '__local__'

/** How the leader's links name a host key's machine and its other keys (sync reads of what they already hold). */
export interface RevokedHostResolver {
  /** The machine id `hostKey`'s daemon said in its hello, or null. */
  machineOf(hostKey: string): string | null
  /** The other host keys of this leader's config that reach `hostKey`'s daemon (its aliases), `hostKey` not needed. */
  aliasesOf(hostKey: string): readonly string[]
  /** This leader's own machine id: never a banned machine. */
  ownMachine?(): string | null
  /**
   * The other host keys whose daemon link THIS leader opened reaches, right now, the same daemon
   * process as `hostKey`'s link it opened (both hellos name one live instance: daemon-connection.ts
   * liveSameDaemonHosts). The grant side's one tie (oneDaemonNow).
   */
  sameDaemonNow?(hostKey: string): readonly string[]
}
let resolver: RevokedHostResolver | null = null

/** The leader's boot: how a key's machine and aliases are read (null: by its own key only). */
export function setRevokedHostResolver(r: RevokedHostResolver | null): void {
  resolver = r
}

/** The other keys of `hostKey`'s machine and its machine id, as the leader's links hold them now. */
export function hostAliasesNow(hostKey: string): { machine: string | null; aliases: string[] } {
  try {
    const machine = resolver?.machineOf(hostKey) ?? null
    const own = resolver?.ownMachine?.() ?? null
    return { machine: machine && machine !== own ? machine : null, aliases: (resolver?.aliasesOf(hostKey) ?? []).filter((a) => a && a !== hostKey && a !== LOCAL) }
  } catch {
    return { machine: null, aliases: [] } // a link that cannot be read names nothing more; the key itself still counts
  }
}

/**
 * Are host keys `a` and `b` one machine: the same key, keys one ban names together, aliases of one
 * daemon, or one machine id by a hello of either's names?
 */
export function sameMachine(a: string, b: string): boolean {
  if (a === b) return true
  if (!a || !b) return false
  const ba = revokedAs(a)
  if (ba && ba === revokedAs(b)) return true
  const of = (k: string) => {
    const names = [k, ...hostAliasesNow(k).aliases]
    return { names, machines: new Set(names.map((n) => hostAliasesNow(n).machine).filter((m): m is string => !!m)) }
  }
  const x = of(a)
  const y = of(b)
  return x.names.some((n) => y.names.includes(n)) || [...x.machines].some((m) => y.machines.has(m))
}

/**
 * Are host keys `a` and `b` one machine for what one name's records GRANT the other (a hand, a row,
 * a fact, a start routed to the other name's service: handed-sessions.ts hostOwns, leader-side.ts
 * startKeyOf)? Only a tie this leader proved with its own links: the same key, or both keys' daemon
 * links it opened answer, now, as one live daemon process. Never sameMachine's other grounds: a
 * machine id a hello claims (a host could name another's, and a data home moved to a new box keeps
 * its old id), a pair recorded earlier, or keys a ban named. Those may ban (a liar bans only
 * itself); they never grant.
 */
export function oneDaemonNow(a: string, b: string): boolean {
  if (a === b) return !!a
  if (!a || !b || a === LOCAL || b === LOCAL) return false
  try {
    return (resolver?.sameDaemonNow?.(a) ?? []).includes(b) || (resolver?.sameDaemonNow?.(b) ?? []).includes(a)
  } catch {
    return false // a link that cannot be read proves nothing
  }
}

/** One revoked credential record: the key it was issued to, its machine, and the other keys the ban named. */
export interface RevokedRecord { hostKey: string; machineId?: string | null; keys?: readonly string[] }

interface Bans {
  /** Each banned key, with the key of the record that bans it. */
  keys: ReadonlyMap<string, string>
  /** Each banned machine id, with its record's key. */
  machines: ReadonlyMap<string, string>
}

function bansOf(records: Iterable<string | RevokedRecord>): Bans {
  const keys = new Map<string, string>()
  const machines = new Map<string, string>()
  for (const r of records) {
    const rec: RevokedRecord = typeof r === 'string' ? { hostKey: r } : r
    if (!rec.hostKey || rec.hostKey === LOCAL) continue
    keys.set(rec.hostKey, rec.hostKey)
    for (const k of rec.keys ?? []) if (k && k !== LOCAL && !keys.has(k)) keys.set(k, rec.hostKey)
    if (rec.machineId) machines.set(rec.machineId, rec.hostKey)
  }
  return { keys, machines }
}

/** The ban's own answer for `hostKey` (null: not banned), with how it was found. */
function banOf(b: Bans, hostKey: string | undefined | null): { as: string; via: 'key' | 'alias' | 'machine' } | null {
  if (!hostKey || hostKey === LOCAL) return null
  const own = b.keys.get(hostKey)
  if (own) return { as: own, via: own === hostKey ? 'key' : 'alias' }
  if (b.keys.size === 0 && b.machines.size === 0) return null
  const { machine, aliases } = hostAliasesNow(hostKey)
  for (const a of aliases) { const as = b.keys.get(a); if (as) return { as, via: 'alias' } }
  const own2 = resolver?.ownMachine?.() ?? null
  if (machine && machine !== own2) { const as = b.machines.get(machine); if (as) return { as, via: 'machine' } }
  return null
}

let bans: Bans = { keys: new Map(), machines: new Map() }
/** Keys once judged an alias of a ban while it stood, with that ban's key (S1: a changed hello does not unban them). */
const sticky = new Map<string, string>()

/**
 * The revoked key `hostKey` is banned as (the key of the record that bans it), or null: itself, a
 * key the ban named, a key once judged its alias, another key of the same daemon, or one whose hello
 * names its machine. The one alias-aware check: every reader of the ban calls it (hostRevokedNow,
 * assertHostNotRevoked), and a read of the records themselves (host-credentials.ts revokedHostIn)
 * calls revokedAsIn.
 */
export function revokedAs(hostKey: string | undefined | null): string | null {
  if (!hostKey || hostKey === LOCAL) return null
  const kept = sticky.get(hostKey)
  if (kept && bans.keys.has(kept)) return kept
  const ban = banOf(bans, hostKey)
  // Only a link to the same daemon (the twin snapshot, a live link) makes a key part of the ban; a
  // machine id its hello claims bans it only while it says so (R2-S1: a copied data home shares one).
  if (ban && ban.via === 'alias') sticky.set(hostKey, ban.as)
  return ban?.as ?? null
}

/** revokedAs over these records rather than the last read (a check inside the records' lock). */
export function revokedAsIn(records: Iterable<RevokedRecord>, hostKey: string | undefined | null): string | null {
  if (!hostKey || hostKey === LOCAL) return null
  const b = bansOf(records)
  const kept = sticky.get(hostKey)
  if (kept && b.keys.has(kept)) return kept
  return banOf(b, hostKey)?.as ?? null
}

/** Does any ban stand now? */
export function anyHostRevoked(): boolean {
  return bans.keys.size > 0 || bans.machines.size > 0
}

/** Is `hostKey` revoked here, under any name of its machine? */
export function hostRevokedNow(hostKey: string | undefined | null): boolean {
  return revokedAs(hostKey) !== null
}

/** Is `machineId` this leader's own machine id (never a host's to ban)? */
export function isOwnMachine(machineId: string | undefined | null): boolean {
  try { return !!machineId && machineId === (resolver?.ownMachine?.() ?? null) } catch { return false }
}

/** Is machine id `machineId` banned now (a mint for it is refused whatever key asks)? Never this leader's own. */
export function machineRevokedNow(machineId: string | undefined | null): boolean {
  if (!machineId || machineId === (resolver?.ownMachine?.() ?? null)) return false
  return bans.machines.has(machineId)
}

/** The keys judged aliases of the ban made as `asKey` since it stood (leader-issue.ts keeps them in its record). */
export function stickyAliasesOf(asKey: string): string[] {
  return [...sticky].filter(([, as]) => as === asKey).map(([k]) => k).sort()
}

/**
 * The revoked records (their last read); the host keys whose standing changed, a machine whose ban
 * came or went counted under its record's key (N4). A ban that went takes its sticky aliases with it.
 */
export function setRevokedHosts(records: Iterable<string | RevokedRecord>): string[] {
  const next = bansOf(records)
  const changed = new Set<string>()
  for (const [k, as] of next.keys) if (bans.keys.get(k) !== as) changed.add(k)
  for (const k of bans.keys.keys()) if (!next.keys.has(k)) changed.add(k)
  for (const [m, as] of next.machines) if (bans.machines.get(m) !== as) changed.add(as)
  for (const [m, as] of bans.machines) if (!next.machines.has(m)) changed.add(as)
  for (const [k, as] of [...sticky]) if (!next.keys.has(as)) { sticky.delete(k); changed.add(k) }
  bans = next
  return [...changed]
}

/** What a start, a call or a drain of a revoked host answers. */
export class HostRevokedError extends Error {
  readonly why = 'host_revoked'
  readonly status = 403
  constructor(readonly hostKey: string, what: string, readonly as: string = hostKey) {
    const name = as === hostKey ? '' : ` (another name of the revoked host ${as})`
    super(`${what}: the host ${hostKey} is revoked${name}. Allow it again (POST /api/host-doors/${as}/allow) or use another host.`)
    this.name = 'HostRevokedError'
  }
}

/** Throw HostRevokedError when `hostKey` is revoked under any name of its machine. */
export function assertHostNotRevoked(hostKey: string | undefined | null, what: string): void {
  const as = revokedAs(hostKey)
  if (hostKey && as) throw new HostRevokedError(hostKey, what, as)
}

/** HostRevokedError's words when `hostKey` is revoked, else null: for a path that answers with an error of its own kind. */
export function revokedWhy(hostKey: string | undefined | null, what: string): string | null {
  const as = revokedAs(hostKey)
  return hostKey && as ? new HostRevokedError(hostKey, what, as).message : null
}
