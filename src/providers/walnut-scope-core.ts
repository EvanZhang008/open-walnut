/**
 * One daemon, several Walnuts: which Walnut a pushed setting belongs to, and where
 * that Walnut's copy is kept (2026-11-03: a host shared by the user's own Walnut and
 * another person's had one trigger set, one hook set and one bridge for both, and
 * each push replaced the other's).
 *
 * A Walnut is named by its data dir (`home`), as the offline host, the leader book,
 * the host replica and the plugin jobs already key it. Every per-Walnut setting a
 * server pushes (triggers, hooks, the bridge, turn snapshots, workspace providers)
 * carries `home`; the daemon keeps one copy per home and applies each only to that
 * Walnut's sessions and sockets. A push with no home comes from a server older than
 * this split: it goes to the unnamed scope (`''`), which keeps the files and the
 * behaviour an older daemon had, so an older server on a newer daemon works as
 * before and a downgraded daemon reads what it always read.
 *
 * Pushes do not use the socket's bound home (`leader.configure` / `host.slice` bind
 * it): a server pushes these at connect, before it binds. A named push on a bound
 * socket must name the bound home.
 *
 * How the daemon twins get it: daemon-standalone.ts imports createWalnutScope;
 * daemon-source.ts inlines `createWalnutScope.toString()` through
 * `__CREATE_WALNUT_SCOPE__`. So the factory body references NOTHING at module scope.
 */

export interface WalnutScopeDeps {
  path: typeof import('node:path')
  /** Short stable file key for a home (homes are paths); the same keyOf the other cores take. */
  keyOf: (home: string) => string
}

export type ScopeResolution = { ok: true; home: string } | { ok: false; error: string }

export function createWalnutScope(deps: WalnutScopeDeps) {
  const { path } = deps
  const HOME_MAX = 1024

  /** The home a command names ('' when none: a server older than the split). */
  function askedHome(cmd: Record<string, unknown> | null | undefined): string {
    const h = cmd ? cmd.home : undefined
    return typeof h === 'string' && h.length > 0 && h.length <= HOME_MAX ? h : ''
  }

  /**
   * The scope a pushed setting goes to. `bound` is the home the socket speaks for
   * (undefined when it named none yet). A named push that contradicts the socket is
   * refused: one Walnut's server never writes another's copy.
   */
  function resolve(cmd: Record<string, unknown> | null | undefined, bound: string | undefined, what: string): ScopeResolution {
    const home = askedHome(cmd)
    if (home && bound && bound !== home) {
      return { ok: false, error: `${what}: this socket speaks for another Walnut` }
    }
    return { ok: true, home }
  }

  /**
   * A command that names its Walnut (`cmd.home`) on a socket bound to another one is
   * refused (replica.*, offline.drain/ack, server.status, ...). An unbound socket may
   * name any: the bulk channel never binds, and an older server binds late.
   */
  function foreign(cmd: Record<string, unknown> | null | undefined, bound: string | undefined): boolean {
    const home = askedHome(cmd)
    return !!home && !!bound && bound !== home
  }

  /** The directory a scope keeps its files in: the unnamed scope keeps the legacy place. */
  function dirFor(base: string, home: string): string {
    return home ? path.join(base, 'walnuts', deps.keyOf(home)) : base
  }

  /** Every named scope directory under `base` (for a boot load), as [key, dir]. */
  function scopeDirs(fs: typeof import('node:fs'), base: string): Array<[string, string]> {
    const root = path.join(base, 'walnuts')
    let names: string[] = []
    try { names = fs.readdirSync(root) } catch { return [] }
    return names.filter((n) => /^[A-Za-z0-9_-]{1,64}$/.test(n)).map((n) => [n, path.join(root, n)] as [string, string])
  }

  /** A log-safe label for a scope. */
  function label(home: string): string {
    return home ? deps.keyOf(home) : 'unnamed'
  }

  return { askedHome, resolve, foreign, dirFor, scopeDirs, label, keyOf: deps.keyOf }
}

export type WalnutScope = ReturnType<typeof createWalnutScope>
