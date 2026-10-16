/**
 * Self host (docs/plan/walnut-replica-servers-impl.md WP6, section 3 "Local
 * routes"): on a host replica, the Mac's name for THIS host (a session record's
 * `host`, a file route's `?host=`) resolves to the follower Link, the loopback
 * socket to the daemon right here. So a host session's history, its files and
 * its diffs are read on the host even while the Mac answers (no hairpin through
 * the Mac and back over SSH).
 *
 * The daemon scopes every follower read to this Walnut ('replica-reads-v1',
 * src/providers/follower-reads-core.ts): another Walnut's session or a file
 * outside this Walnut's session cwds answers `not_found`. Without that
 * capability the shim is off and the routes are forwarded, as before.
 *
 * Off everywhere else: nothing installs it on the Mac or the companion, so
 * `getDaemonConnection` and DaemonFileReader behave there exactly as before.
 */

/** What the shim needs of the follower Link (core/link/follower-link.ts). */
export interface SelfHostLink {
  request(cmd: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>
  capabilities(): readonly string[] | null
  state(): 'up' | 'down'
}

/** The capability the daemon must advertise for reads through the shim. */
export const REPLICA_READS_CAP = 'replica-reads-v1'

/** The part of DaemonConnection that the file reader and the history readers use. */
export interface SelfHostConnection {
  readonly hostKey: string
  readonly connected: boolean
  readonly capabilitiesKnown: boolean
  hasCapability(cap: string): boolean
  send(cmd: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown> & { ok: boolean }>
}

const COMMAND_TIMEOUT_MS = 30_000

let installed: { aliases: Set<string>; link: SelfHostLink } | null = null

/** A host replica's boot: `aliases` are the names the Mac gives this host (its hosts key). */
export function installSelfHost(o: { aliases: string[]; link: SelfHostLink }): void {
  const aliases = new Set(o.aliases.map((a) => a.trim()).filter((a) => a.length > 0 && a !== '__local__'))
  installed = aliases.size > 0 ? { aliases, link: o.link } : null
}

export function clearSelfHost(): void {
  installed = null
}

/**
 * `host` names this host, on a replica whose daemon answers owner-scoped reads.
 * Its connection stays the follower link while that link is down (never an SSH
 * dial from here); whether a request is answered here also needs the link up
 * (isLocalHere).
 */
export function isSelfHost(host: string | null | undefined): boolean {
  if (!installed || !host || !installed.aliases.has(host)) return false
  return installed.link.capabilities()?.includes(REPLICA_READS_CAP) === true
}

/**
 * The hosts-config entry a route needs for `host`, or a stand-in for this host
 * on a replica: a replica's own config lists no hosts, and getDaemonConnection
 * takes the follower link for this host whatever target it is given. Every
 * route that looks up `config.hosts[host]` before it dials goes through this.
 */
export function hostEntryOf<T extends object>(hosts: Record<string, T> | undefined, host: string): T | undefined {
  // Only `hostname` is read of the stand-in (user, port, label stay unset).
  if (isSelfHost(host)) return { hostname: host } as unknown as T
  return hosts?.[host]
}

/** The connection for `host` when it is this host (see isSelfHost), else null: the caller goes on as before. */
export function selfHostConnection(host: string): SelfHostConnection | null {
  const self = installed
  if (!self || !isSelfHost(host)) return null
  const caps = () => self.link.capabilities() ?? []
  return {
    hostKey: host,
    get connected() { return self.link.state() === 'up' },
    get capabilitiesKnown() { return self.link.capabilities() !== null },
    hasCapability: (cap) => caps().includes(cap),
    async send(cmd, params = {}, timeoutMs = COMMAND_TIMEOUT_MS) {
      const r = await self.link.request(cmd, params, timeoutMs)
      return { ...r, ok: r.ok === true }
    },
  }
}

/** The session id of `/api/sessions/:id/...` or `/api/v1/sessions/:id/...`, or null. */
export function sessionIdOfPath(pathname: string): string | null {
  const parts = pathname.split('?')[0]!.split('/').filter(Boolean)
  const at = parts[1] === 'v1' ? 2 : 1
  if (parts[0] !== 'api' || parts[at] !== 'sessions' || !parts[at + 1]) return null
  try { return decodeURIComponent(parts[at + 1]!) } catch { return null }
}

/** A session record, as far as the shim needs it (its host). */
export type SelfHostLookup = (sessionId: string) => Promise<{ host?: string | null } | null | undefined>

/**
 * Whether a conditional `local` row's request is this host's data
 * (route-table.ts `local`): `session`, the session the path names runs here
 * (its record's host); `host`, the `host` query names this host. Anything
 * unknown: no. A file route with no `host` is the Mac's own file (that is what
 * it means on the Mac), so it is never answered here, whatever its `sessionId`
 * says: the handler would read it from this replica's own disk, outside the
 * daemon's owner scope.
 */
export async function isLocalHere(url: string, local: 'session' | 'host', lookup: SelfHostLookup, cap?: string): Promise<boolean> {
  // The capabilities stay known across a drop (a daemon upgrade during a Mac
  // deploy): while the follower link is down, the Mac answers, as before WP6.
  if (!installed || installed.link.state() !== 'up') return false
  // A row that needs a daemon capability (route-table.ts `cap`) the daemon lacks: the Mac's.
  if (cap && installed.link.capabilities()?.includes(cap) !== true) return false
  const q = new URLSearchParams(url.includes('?') ? url.slice(url.indexOf('?') + 1) : '')
  if (local === 'host') return isSelfHost(q.get('host'))
  const sid = sessionIdOfPath(url)
  return sid ? isSelfHost((await lookup(sid))?.host) : false
}
