/**
 * The hosts whose door is revoked now (leader-issue.ts revokeHostDoorNow keeps the ban with the
 * credential records; refreshRevokedHosts reads it into here). A sync read, zero imports, for every
 * path that would use a host; each of them is a row of revoked-reach.ts REVOKED_REACH, which names
 * the file that holds its check. Only the leader fills it; elsewhere nothing is revoked.
 *
 * A ban is of a machine, not of one of its names. One machine can be in the config under several
 * host keys (aliases: an ssh row and the row it joined the host network as, reaching one daemon).
 * So a key is revoked when it is a revoked record's key, when its daemon's hello named the machine
 * id of a revoked record, or when it is a recorded alias of a revoked key (one daemon, the twin
 * snapshot of core/hosts/daemon-twins.ts, or a live link to the same daemon process). The last two
 * come from the leader's links through `setRevokedHostResolver` (leader-boot.ts). Every check of a
 * ban goes through revokedAs (tests/core/session-channel/revoked-reach-ratchet.test.ts refuses a
 * new one that compares a bare host key).
 */

/** How the leader's links name a host key's machine and its other keys (sync reads of what they already hold). */
export interface RevokedHostResolver {
  /** The machine id `hostKey`'s daemon said in its hello, or null. */
  machineOf(hostKey: string): string | null
  /** The other host keys of this leader's config that reach `hostKey`'s daemon (its aliases), `hostKey` not needed. */
  aliasesOf(hostKey: string): readonly string[]
}
let resolver: RevokedHostResolver | null = null

/** The leader's boot: how a key's machine and aliases are read (null: by its own key only). */
export function setRevokedHostResolver(r: RevokedHostResolver | null): void {
  resolver = r
}

/** The other keys of `hostKey`'s machine and its machine id, as the leader's links hold them now. */
export function hostAliasesNow(hostKey: string): { machine: string | null; aliases: string[] } {
  try {
    return { machine: resolver?.machineOf(hostKey) ?? null, aliases: (resolver?.aliasesOf(hostKey) ?? []).filter((a) => a && a !== hostKey) }
  } catch {
    return { machine: null, aliases: [] } // a link that cannot be read names nothing more; the key itself still counts
  }
}

/** Are host keys `a` and `b` one machine (the same key, aliases of one daemon, or one machine id by a hello of either's names)? */
export function sameMachine(a: string, b: string): boolean {
  if (a === b) return true
  if (!a || !b) return false
  const of = (k: string) => {
    const names = [k, ...hostAliasesNow(k).aliases]
    return { names, machines: new Set(names.map((n) => hostAliasesNow(n).machine).filter((m): m is string => !!m)) }
  }
  const x = of(a)
  const y = of(b)
  return x.names.some((n) => y.names.includes(n)) || [...x.machines].some((m) => y.machines.has(m))
}

interface Bans { keys: ReadonlySet<string>; machines: ReadonlySet<string> }

function bansOf(records: Iterable<string | RevokedRecord>): Bans {
  const keys = new Set<string>()
  const machines = new Set<string>()
  for (const r of records) {
    const rec = typeof r === 'string' ? { hostKey: r } : r
    if (rec.hostKey) keys.add(rec.hostKey)
    if (rec.machineId) machines.add(rec.machineId)
  }
  return { keys, machines }
}

function banOf(bans: Bans, hostKey: string | undefined | null): string | null {
  if (!hostKey) return null
  if (bans.keys.has(hostKey)) return hostKey
  if (bans.keys.size === 0 && bans.machines.size === 0) return null
  const { machine, aliases } = hostAliasesNow(hostKey)
  for (const a of aliases) if (bans.keys.has(a)) return a
  if (machine && bans.machines.has(machine)) return `machine:${machine}`
  return null
}

let bans: Bans = { keys: new Set(), machines: new Set() }

/**
 * The revoked key `hostKey` is banned as: itself, another key of the same machine, or the
 * machine (`machine:<id>`, a revoked record whose key is none of its aliases). Null: not revoked.
 * The one alias-aware check: every reader of the ban calls it (hostRevokedNow, assertHostNotRevoked),
 * and a read of the records themselves (host-credentials.ts revokedHostIn) calls revokedAsIn.
 */
export function revokedAs(hostKey: string | undefined | null): string | null {
  return banOf(bans, hostKey)
}

/** revokedAs over these records rather than the last read (a check inside the records' lock). */
export function revokedAsIn(records: Iterable<RevokedRecord>, hostKey: string | undefined | null): string | null {
  return banOf(bansOf(records), hostKey)
}

/** Is `hostKey` revoked here, under any name of its machine? */
export function hostRevokedNow(hostKey: string | undefined | null): boolean {
  return revokedAs(hostKey) !== null
}

/** One revoked credential record: the key it was issued to and its machine. */
export interface RevokedRecord { hostKey: string; machineId?: string | null }

/** The revoked records (their last read); the host keys whose standing changed. */
export function setRevokedHosts(records: Iterable<string | RevokedRecord>): string[] {
  const next = bansOf(records)
  const changed = [...next.keys].filter((h) => !bans.keys.has(h)).concat([...bans.keys].filter((h) => !next.keys.has(h)))
  bans = next
  return changed
}

/** What a start, a call or a drain of a revoked host answers. */
export class HostRevokedError extends Error {
  readonly why = 'host_revoked'
  readonly status = 403
  constructor(readonly hostKey: string, what: string, readonly as: string = hostKey) {
    const name = as === hostKey ? '' : as.startsWith('machine:') ? ' (its machine is revoked)' : ` (another name of the revoked host ${as})`
    super(`${what}: the host ${hostKey} is revoked${name}. Allow it again (POST /api/host-doors/${as.startsWith('machine:') ? hostKey : as}/allow) or use another host.`)
  }
}

/** Throw HostRevokedError when `hostKey` is revoked under any name of its machine. */
export function assertHostNotRevoked(hostKey: string | undefined | null, what: string): void {
  const as = revokedAs(hostKey)
  if (hostKey && as) throw new HostRevokedError(hostKey, what, as)
}
