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
 * A Walnut is ONE Walnut wherever its data dir lives, but only its server can say that it
 * moved (src/core/home-move.ts): `leader.configure` carries `movedFrom`, the data dir it used
 * before, as the first per-home frame of a connect. When this host knows `movedFrom` as a home
 * whose leader record names the same Walnut id, the new home becomes its alias (`declareMove`):
 * `canonical(new)` is the first home, so every key (`keyOf`), every in-memory map and every file
 * stays the first home's, and epochs, trigger memory, journals and copies continue. No file is
 * moved or rewritten, and a file's embedded `home` still hashes to its name, so an older daemon
 * reads everything as before. Nothing is ever inferred: a copy of a data dir that declares
 * nothing is a Walnut of its own by its path. After a move, the home it left is refused for good
 * (`movedTo`), so two diverged copies never take turns on one Walnut's state; a declared move
 * back flips it. A declaration lists every former home (`formerHomes`), so a host that missed
 * some moves follows from the one it knows; one that does not come from where the Walnut is now
 * here (a backup started after the move) is refused for good too, so the first copy to move
 * keeps the Walnut, until another copy's server says that one is gone from its machine
 * (`copyGone`: its folder no longer holds the Walnut's id). The aliases are kept in one small file (`aliasFile`, read on first use) that
 * older daemons never read.
 *
 * Imported by daemon-standalone.ts (createWalnutScope). The factory body references NOTHING at module scope.
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

/** A home move a server declared (leader.configure's movedFrom), with what the host knows. */
export interface DeclaredMove {
  /** The home the command names: where the Walnut is now. */
  home: string
  /** The home it says it used before (its newest one). */
  movedFrom: unknown
  /** Every home it used before on its machine, newest first (movedFrom is the first); absent: movedFrom alone. */
  formerHomes?: unknown
  walnutId: unknown
  /** The leader keeps this id in memory only (its auth.json did not read): never an identity. */
  volatile?: boolean
  /** The Walnut id of the leader record kept under a home, or null when there is none. */
  recordIdOf: (home: string) => string | null
  /** Every home this host keeps a leader record for (to tell a host that lost the trail from one that never knew it). */
  homes?: () => string[]
  /**
   * The home of another copy of this Walnut that its server found gone on its machine (that
   * folder no longer holds this Walnut's id): when it is where the Walnut is now here, this
   * declaration takes its place instead of being `contested` (primary-leader.ts describeTo).
   */
  copyGone?: unknown
}

/**
 * `aliased`: the new home just became an alias (what it set up here before folds into `to`).
 * `contested`: another home of the same Walnut is where it is now here, and this one never was
 * (a copy started after the move, declaring the same former home): it is refused for good.
 */
export type MoveOutcome = { moved: true; to: string; aliased: boolean } | { moved: false; why: string }

/** Why a host refuses a home: `walnut_home_busy` (this Walnut is elsewhere now), `walnut_home_taken` (another Walnut moved away from this path). */
export interface HomeRefusal { errorKind: 'walnut_home_busy' | 'walnut_home_taken'; movedTo: string }

interface HomeAlias { to: string; walnutId: string; at: number }

export function createWalnutScope(deps: WalnutScopeDeps) {
  const { path } = deps
  const HOME_MAX = 1024
  const WALNUT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/
  /** The most former homes one declaration is read for. */
  const FORMER_MAX = 16
  /** The reasons a move was not taken that its server hears of (Walnut Health words: home-busy-health.ts). */
  const TOLD = ['lost_trail', 'own_record', 'already_aliased', 'not_persisted']
  /** home -> the first home of the same Walnut (never itself an alias). */
  const aliases = new Map<string, HomeAlias>()
  /** canonical home -> the home its server declared last (where the Walnut is now). */
  const places = new Map<string, string>()
  let aliasesRead = false

  function readAliases(): void {
    if (aliasesRead || !deps.fs || !deps.aliasFile) return
    let file: unknown
    // The file's dir may not be defined yet (a twin's boot order): asked again on the next use.
    try { file = deps.aliasFile() } catch { return }
    if (typeof file !== 'string' || !file) return
    aliasesRead = true
    let raw: { v?: unknown; aliases?: Record<string, unknown>; places?: Record<string, unknown> } | null = null
    try { raw = JSON.parse(deps.fs.readFileSync(file, 'utf8')) } catch { return }
    // v1 held inferred aliases (never on a production host): dropped, rewritten at the next move.
    if (!raw || raw.v !== 2 || !raw.aliases || typeof raw.aliases !== 'object') return
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
    // Where each Walnut is now: one of its own homes, else none (it speaks from its first home).
    for (const [c, at] of Object.entries(raw.places && typeof raw.places === 'object' ? raw.places : {})) {
      if (typeof at === 'string' && at !== c && !aliases.has(c) && aliases.get(at)?.to === c) places.set(c, at)
    }
  }

  function writeAliases(): boolean {
    if (!deps.fs || !deps.aliasFile) return false
    try {
      const file = deps.aliasFile()
      deps.fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
      const tmp = `${file}.${process.pid}.tmp`
      deps.fs.writeFileSync(tmp, JSON.stringify({ v: 2, aliases: Object.fromEntries(aliases), places: Object.fromEntries(places) }), { mode: 0o600 })
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

  /** Where a Walnut's server speaks from now: the home it declared last, else its first home. */
  function whereNow(home: string): string {
    const c = canonical(home)
    return places.get(c) ?? c
  }

  /**
   * The home the Walnut moved to when `home` is one it left (a declared move): a server that
   * still speaks as `home` is refused for good. Null for a home that is where its Walnut is now.
   */
  function movedTo(home: string): string | null {
    if (!home) return null
    readAliases()
    if (aliases.size === 0) return null
    const now = whereNow(home)
    return now !== home ? now : null
  }

  /** The former homes a declaration names, newest first: valid, distinct, never the home itself (null: none declared). */
  function formersOf(m: DeclaredMove): string[] | null {
    if (typeof m.movedFrom !== 'string' || !m.movedFrom) return null
    const listed = Array.isArray(m.formerHomes) ? m.formerHomes : []
    const out: string[] = []
    for (const h of [m.movedFrom, ...listed]) {
      if (typeof h !== 'string' || !h || h.length > HOME_MAX || h === m.home || out.includes(h)) continue
      out.push(h)
      if (out.length >= FORMER_MAX) break
    }
    return out
  }

  /**
   * leader.configure declared `movedFrom` (and `formerHomes`, every home it used before): the
   * Walnut that used one of them continues here, but only when this host keeps one of them as a
   * Walnut whose leader record names the same id, and only from where that Walnut is now here.
   * The first such former home decides (a host that missed some moves still finds the one it
   * knows). A declaration that does not name where the Walnut is now is a copy that diverged
   * before (a backup started after the move): it never takes turns with the real one, its home
   * is refused for good (`contested`), unless its server says the copy that is where the Walnut
   * is now is gone from its machine (`copyGone`): then this one takes the place, and the gone
   * copy's home is the one refused. A move back to a home of the same Walnut flips where it is
   * now. Never on a volatile id, never over a home that is a Walnut of its own here already (it
   * has a record: `own_record_same` when that record is this Walnut's, a split its server has
   * lived with since a move made before it declared moves, so not news), never when the alias
   * cannot be kept.
   */
  function declareMove(m: DeclaredMove): MoveOutcome {
    const { home, walnutId: id } = m
    const formers = formersOf(m)
    if (formers === null) return { moved: false, why: 'none' }
    if (!home || home.length > HOME_MAX || formers.length === 0) return { moved: false, why: 'bad_home' }
    if (typeof id !== 'string' || !WALNUT_ID_RE.test(id)) return { moved: false, why: 'no_walnut_id' }
    if (m.volatile === true) return { moved: false, why: 'volatile_id' }
    if (!deps.fs || !deps.aliasFile) return { moved: false, why: 'no_alias_file' }
    let to: string | null = null
    for (const f of formers) {
      const c = canonical(f)
      if (m.recordIdOf(c) === id) { to = c; break }
    }
    if (to === null) {
      // This host keeps the Walnut under a home the declaration does not list: it cannot follow.
      const mine = canonical(home)
      const elsewhere = (m.homes ? m.homes() : []).some((h) => h !== home && canonical(h) !== mine && m.recordIdOf(h) === id)
      return { moved: false, why: elsewhere ? 'lost_trail' : 'not_this_walnut' }
    }
    const now = whereNow(to)
    // The same move again (every connect sends it).
    if (now === home) return { moved: true, to, aliased: false }
    const mine = canonical(home)
    if (mine !== to && mine !== home) return { moved: false, why: 'already_aliased' }
    const own = mine !== to ? m.recordIdOf(home) : null
    if (own !== null) return { moved: false, why: own === id ? 'own_record_same' : 'own_record' }
    if (!formers.includes(now) && m.copyGone !== now) {
      // A copy that left from where the Walnut no longer is: refused for good (movedTo), kept so
      // a restarted daemon refuses it too. Kept in memory even when the file cannot be written.
      if (mine === home && home !== to) {
        aliases.set(home, { to, walnutId: id, at: deps.now ? deps.now() : Date.now() })
        writeAliases()
      }
      deps.log?.('warn', 'walnut scope: a second copy of a Walnut declared a move from where it no longer is; refused', { home: deps.keyOf(home), to: deps.keyOf(to) })
      return { moved: false, why: 'contested' }
    }
    if (m.copyGone === now && !formers.includes(now)) {
      deps.log?.('info', 'walnut scope: the copy of a Walnut that was where it is now here is gone; this one takes its place', { gone: deps.keyOf(now), now: deps.keyOf(home) })
    }
    // A move back (only where the Walnut is now changes), or a new home that becomes an alias.
    const aliased = mine !== to
    const before = places.get(to)
    if (aliased) aliases.set(home, { to, walnutId: id, at: deps.now ? deps.now() : Date.now() })
    if (home === to) places.delete(to)
    else places.set(to, home)
    if (!writeAliases()) {
      if (aliased) aliases.delete(home)
      if (before) places.set(to, before); else places.delete(to)
      return { moved: false, why: 'not_persisted' }
    }
    deps.log?.('info', aliased ? 'walnut scope: a Walnut this host keeps under another home moved here' : 'walnut scope: a Walnut moved back to a home it had here', { to: deps.keyOf(to), now: deps.keyOf(home) })
    return { moved: true, to, aliased }
  }

  /**
   * A declared move not taken that its server should hear of (Walnut Health): the host keeps this
   * Walnut's earlier data where it cannot follow. Not a host that never knew the Walnut, not a
   * declaration with nothing in it, not a contested copy (it is refused, which says so).
   */
  function moveNotTakenTold(why: string): boolean {
    return TOLD.includes(why)
  }

  /**
   * Why a server socket that speaks as `home` is refused, or null. A home its Walnut moved away
   * from is refused for good; a configure that names ANOTHER Walnut id than the one kept there
   * (a new Walnut at a path an earlier one left) reads `walnut_home_taken`, so its server says
   * the right thing: its own data is not here, and another data folder is the way in.
   */
  function refusalOf(home: string, walnutId: unknown, recordIdOf?: (home: string) => string | null): HomeRefusal | null {
    const to = movedTo(home)
    if (!to) return null
    const kept = (recordIdOf ? recordIdOf(canonical(home)) : null) ?? aliases.get(home)?.walnutId ?? null
    const other = typeof walnutId === 'string' && WALNUT_ID_RE.test(walnutId) && kept !== null && walnutId !== kept
    return { errorKind: other ? 'walnut_home_taken' : 'walnut_home_busy', movedTo: to }
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
    canonical, whereNow, movedTo, declareMove, moveNotTakenTold, refusalOf,
    /** Every reason `moveNotTakenTold` is true for (the leader's words cover each: home-busy-health.test.ts). */
    toldReasons: (): readonly string[] => TOLD,
  }
}

export type WalnutScope = ReturnType<typeof createWalnutScope>
