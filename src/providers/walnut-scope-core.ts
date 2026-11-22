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
 * A Walnut is ONE Walnut wherever its data dir lives: its instance id (`walnutId`,
 * which `leader.configure` carries) names it, the path is only where it is now. When a
 * Walnut this host knows under one home (A) arrives with the same id from another home
 * (B), and A is not in use any more (`adopt`), B becomes an
 * alias of A: `canonical(B)` is A, so every key (`keyOf`), every in-memory map and every
 * file stays A's, and epochs, trigger memory, journals and copies continue. No file is
 * moved or rewritten, and a file's embedded `home` still hashes to its name, so an older
 * daemon reads everything as before. The aliases are kept in one small file
 * (`aliasFile`, read on first use) that older daemons never read, with one flag: a
 * leader here ever offered its home moves (`movesOffered`; until then no alias can come).
 * Only one home of a Walnut speaks at a time (`speakingElsewhere`): two copies of one
 * data dir running at once never share one Walnut's state.
 *
 * How the daemon twins get it: daemon-standalone.ts imports createWalnutScope;
 * daemon-source.ts inlines `createWalnutScope.toString()` through
 * `__CREATE_WALNUT_SCOPE__`. So the factory body references NOTHING at module scope.
 */

export interface WalnutScopeDeps {
  path: typeof import('node:path')
  /** Short stable key of a path string (a hash). `keyOf` below hashes the canonical home with it. */
  keyOf: (home: string) => string
  /** For the aliases (optional: without them every home is a Walnut of its own, as before). */
  fs?: typeof import('node:fs')
  /** Where the aliases are kept; asked on first use, so it may name a dir defined later. */
  aliasFile?: () => string
  now?: () => number
  log?: (level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) => void
}

export type ScopeResolution = { ok: true; home: string } | { ok: false; error: string }

/** What `adopt` needs to know about this host's Walnuts (the leader book and the sockets). */
export interface HomeAdoptionFacts {
  /** The home a command names, as it came. */
  home: string
  walnutId: unknown
  /** The leader keeps this id in memory only (its auth.json did not read): never an identity. */
  volatile?: boolean
  /**
   * The leader offers its home moves (walnutHomeMoves): only a leader running the one-service
   * experiment (in_process_daemon) does, so no host aliases a home before that switch is on.
   */
  offered?: boolean
  /** A leader record names this home already: it is a Walnut of its own here. */
  hasRecord: (home: string) => boolean
  /** The homes whose leader record names this id. */
  homesWith: (walnutId: string) => string[]
  /** Why `home` is still in use (a socket open, heard lately), or null when it is not. */
  inUse: (home: string) => string | null
}

export type HomeAdoption = { aliased: true; from: string; to: string } | { aliased: false; why: string }

interface HomeAlias { to: string; walnutId: string; at: number }

export function createWalnutScope(deps: WalnutScopeDeps) {
  const { path } = deps
  const HOME_MAX = 1024
  const WALNUT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/
  /** home -> the first home of the same Walnut (never itself an alias). */
  const aliases = new Map<string, HomeAlias>()
  /** canonical home -> the home its server named last (where the Walnut is now). */
  const lastAsked = new Map<string, string>()
  let aliasesRead = false
  /** A leader here ever offered its home moves (walnutHomeMoves): only then may an alias come. */
  let offered = false

  function readAliases(): void {
    if (aliasesRead || !deps.fs || !deps.aliasFile) return
    let file: unknown
    // The file's dir may not be defined yet (a twin's boot order): asked again on the next use.
    try { file = deps.aliasFile() } catch { return }
    if (typeof file !== 'string' || !file) return
    aliasesRead = true
    let raw: { v?: unknown; aliases?: Record<string, unknown>; movesOffered?: unknown } | null = null
    try { raw = JSON.parse(deps.fs.readFileSync(file, 'utf8')) } catch { return }
    if (!raw || raw.v !== 1) return
    if (raw.movesOffered === true) offered = true
    if (!raw.aliases || typeof raw.aliases !== 'object') return
    for (const [from, value] of Object.entries(raw.aliases)) {
      const a = value as Partial<HomeAlias> | null
      if (!from || from.length > HOME_MAX || !a || typeof a.to !== 'string' || !a.to || a.to === from || a.to.length > HOME_MAX) continue
      if (typeof a.walnutId !== 'string' || !WALNUT_ID_RE.test(a.walnutId)) continue
      aliases.set(from, { to: a.to, walnutId: a.walnutId, at: typeof a.at === 'number' ? a.at : 0 })
    }
    // A chain (B -> A, A -> Z) names the last; a cycle names nothing.
    for (const [from, a] of [...aliases]) {
      let to = a.to
      const seen = new Set([from])
      while (aliases.has(to) && !seen.has(to)) { seen.add(to); to = aliases.get(to)!.to }
      if (seen.has(to)) aliases.delete(from)
      else if (to !== a.to) aliases.set(from, { ...a, to })
    }
  }

  function writeAliases(): boolean {
    if (!deps.fs || !deps.aliasFile) return false
    try {
      const file = deps.aliasFile()
      deps.fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
      const tmp = `${file}.${process.pid}.tmp`
      deps.fs.writeFileSync(tmp, JSON.stringify({ v: 1, aliases: Object.fromEntries(aliases), ...(offered ? { movesOffered: true } : {}) }), { mode: 0o600 })
      deps.fs.renameSync(tmp, file)
      return true
    } catch (err) {
      deps.log?.('warn', 'walnut scope: the home aliases could not be written', { error: (err as Error).message })
      return false
    }
  }

  /** The home a Walnut is keyed by: its first home on this host, or this one. */
  function canonical(home: string): string {
    if (!home) return home
    readAliases()
    return aliases.get(home)?.to ?? home
  }

  /** The key every per-Walnut file and dir is named by: the canonical home's. */
  function keyOf(home: string): string {
    return deps.keyOf(canonical(home))
  }

  /** A command named `home`: its Walnut lives there now (whereNow). */
  function noteAsked(home: string): void {
    if (!home || aliases.size === 0) return
    const c = canonical(home)
    if (c !== home || [...aliases.values()].some((a) => a.to === c)) lastAsked.set(c, home)
  }

  /** Where a Walnut's server speaks from now: the home it named last, else its newest alias. */
  function whereNow(home: string): string {
    const c = canonical(home)
    const asked = lastAsked.get(c)
    if (asked) return asked
    let newest: [string, HomeAlias] | null = null
    for (const entry of aliases) if (entry[1].to === c && (!newest || entry[1].at > newest[1].at)) newest = entry
    return newest ? newest[0] : c
  }

  /** The other homes that name the same Walnut as `home`'s canonical one. */
  function aliasesOf(home: string): string[] {
    const c = canonical(home)
    return [...aliases].filter(([, a]) => a.to === c).map(([from]) => from)
  }

  /** A leader here ever offered its home moves: a home with no record yet may still become an alias. */
  function movesOffered(): boolean {
    readAliases()
    return offered
  }

  /**
   * Another home of the same Walnut speaks here now: one of `places` (the homes the other
   * live server sockets named) that is not `home` but names its Walnut. Whichever home
   * spoke first keeps it; `home` waits until that one is gone. Null when none does.
   */
  function speakingElsewhere(home: string, places: Iterable<string>): string | null {
    if (!home) return null
    readAliases()
    if (aliases.size === 0) return null
    const c = canonical(home)
    for (const place of places) if (place && place !== home && canonical(place) === c) return place
    return null
  }

  /**
   * leader.configure carries the Walnut's id: when this home is new here and the same id is
   * kept under exactly one other home that is not in use, this home becomes its alias.
   * Never on a volatile id, never over a home that has a record of its own, never while
   * the first home is in use (a copy of the data dir, a standby or a test server, shares
   * the id), never when two homes hold the id (which one would be a guess).
   */
  function adopt(facts: HomeAdoptionFacts): HomeAdoption {
    const home = facts.home
    const id = facts.walnutId
    if (facts.offered === true && !movesOffered()) { offered = true; writeAliases() }
    if (!home || home.length > HOME_MAX) return { aliased: false, why: 'no_home' }
    if (typeof id !== 'string' || !WALNUT_ID_RE.test(id)) return { aliased: false, why: 'no_walnut_id' }
    if (facts.volatile === true) return { aliased: false, why: 'volatile_id' }
    if (facts.offered !== true) return { aliased: false, why: 'not_offered' }
    if (!deps.fs || !deps.aliasFile) return { aliased: false, why: 'no_alias_file' }
    if (canonical(home) !== home) return { aliased: false, why: 'already_aliased' }
    if (facts.hasRecord(home)) return { aliased: false, why: 'own_record' }
    const firsts = [...new Set(facts.homesWith(id))].filter((h) => h && h !== home && canonical(h) === h)
    if (firsts.length === 0) return { aliased: false, why: 'first_home' }
    if (firsts.length > 1) return { aliased: false, why: 'several_homes' }
    const to = firsts[0]!
    const busy = facts.inUse(to)
    if (busy) return { aliased: false, why: `first_home_in_use:${busy}` }
    aliases.set(home, { to, walnutId: id, at: deps.now ? deps.now() : Date.now() })
    if (!writeAliases()) { aliases.delete(home); return { aliased: false, why: 'not_persisted' } }
    lastAsked.set(to, home)
    deps.log?.('info', 'walnut scope: a home names a Walnut this host keeps under another home', { from: deps.keyOf(home), to: deps.keyOf(to) })
    return { aliased: true, from: home, to }
  }

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
    return home ? path.join(base, 'walnuts', keyOf(home)) : base
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
    return home ? keyOf(home) : 'unnamed'
  }

  return {
    askedHome, resolve, foreign, dirFor, scopeDirs, label, keyOf,
    /** The key of the path itself, alias or not (what a server computes for its own home). */
    pathKeyOf: deps.keyOf,
    canonical, adopt, noteAsked, whereNow, aliasesOf, movesOffered, speakingElsewhere,
  }
}

export type WalnutScope = ReturnType<typeof createWalnutScope>
