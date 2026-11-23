/**
 * Which Walnuts a daemon serves, kept beside daemon.version (2026-11-03: a host shared by
 * two people's Walnuts of different builds; each server replaced the daemon with its own
 * build whenever it connected, because a daemon's version is a content hash with no order).
 *
 * The daemon notes every Walnut a server socket speaks for: a bound home
 * (`leader.configure`, `host.slice`) or a named push, and `-` for a server older than
 * walnut-scope-v1 that pushes with no home. A bridge, follower, lane or probe socket is
 * never a server's, so the cloud companion, a host replica and a read-only test server are
 * not noted.
 *
 * A server this daemon runs for a leader is that leader's Walnut, not another one
 * (2026-11-23: a host's replica pushed `turns.configure` naming its own data dir from its
 * own-sessions link, so its leader read "another Walnut uses it" and kept an old daemon for
 * four hours). So a home is filed under the Walnut it is (`walnutOf`: a server's data dir is
 * its leader's), and a key an older build filed such a data dir under (`followerHomes`) is
 * dropped from the record. Every note goes through `keyFor`, so no call site can skip it
 * (tests/providers/served-walnuts-follower-guard.test.ts).
 *
 * `daemon.serves.json` holds the running daemon's version, its capabilities and when each
 * Walnut was last seen; it survives a daemon restart (the new daemon reads
 * it back), so a server deciding whether to replace this daemon knows another Walnut
 * still uses it (daemon-shared.ts). The hello carries the same `walnuts`.
 *
 * How the daemon twins get it: daemon-standalone.ts imports createServedWalnuts;
 * daemon-source.ts inlines `createServedWalnuts.toString()` through
 * `__CREATE_SERVED_WALNUTS__`. So the factory body references NOTHING at module scope.
 */

export interface ServedWalnutsDeps {
  fs: typeof import('node:fs')
  /** `<daemon dir>/daemon.serves.json`. */
  file: string
  /**
   * The key a server computes for its own home (16 hex of its sha1, daemon-shared.ts
   * walnutKeyOf): of the home a Walnut speaks from now, never its alias target.
   */
  keyOf: (home: string) => string
  /**
   * The Walnut a home is when it is not one of its own (host-server-core.ts walnutOf): the
   * data dir of a server this daemon runs for a leader names that leader's home. undefined
   * for any other home.
   */
  walnutOf?: (home: string) => string | undefined
  /** The data dirs of the servers this daemon runs (their OPEN_WALNUT_HOME), mapped or not by walnutOf. */
  followerHomes?: () => string[]
  /** This daemon's version and its capabilities as its hello says them. */
  version: string
  /** 'binary' (daemon-standalone.ts, compiled or run by bun) or 'source' (daemon-source.ts). */
  twin: 'binary' | 'source'
  capabilities: () => string[]
  /** Whether this daemon's runtime can have a pty at all (pty-stream-v1): a source twin on Node cannot. */
  pty?: () => boolean
  now: () => number
  log?: (level: string, msg: string, data?: Record<string, unknown>) => void
}

export interface ServedWalnuts {
  /** A server socket spoke for `home` ('' = an older server that names none). */
  note(home: string): void
  /** Each Walnut seen within `windowMs`, by key, with when. */
  recent(windowMs?: number): Record<string, number>
  /** A server socket spoke for `home` here within the last week (kept across restarts). */
  knows(home: string): boolean
  /** Writes the file now (at startup, once capabilities are known). */
  write(): void
  /**
   * Forget one key: the home it names became another home's alias (walnut-scope-core.ts),
   * so it is the same Walnut, which must not read as another one still using this daemon.
   */
  forgetKey(key: string): void
}

export function createServedWalnuts(deps: ServedWalnutsDeps): ServedWalnuts {
  // Forgotten after a week: a Walnut that has not connected for that long serves nothing here.
  const KEEP_MS = 7 * 24 * 3600_000
  // A Walnut seen again is written at most this often (every server reconnect notes it).
  const REWRITE_MS = 10 * 60_000
  const seen: Record<string, number> = {}
  // When each Walnut's time was last put in the file (seen moves on every push).
  const written: Record<string, number> = {}
  try {
    const prior = JSON.parse(deps.fs.readFileSync(deps.file, 'utf8')) as { walnuts?: Record<string, unknown> }
    const cutoff = deps.now() - KEEP_MS
    for (const [k, at] of Object.entries(prior?.walnuts ?? {})) {
      if (/^([0-9a-f]{16}|-)$/.test(k) && typeof at === 'number' && Number.isFinite(at) && at > cutoff) { seen[k] = at; written[k] = at }
    }
  } catch { /* none yet */ }

  // One Walnut whatever slashes its dir is written with (daemon-shared.ts walnutKeyOf).
  const tidy = (home: string): string => home.replace(/\/+/g, '/').replace(/(.)\/$/, '$1')
  function walnutOf(home: string): string | undefined {
    let w: string | undefined
    try { w = deps.walnutOf ? deps.walnutOf(home) : undefined } catch { w = undefined }
    return typeof w === 'string' && w ? tidy(w) : undefined
  }
  // The key of the Walnut a home is: a server's data dir here is its leader's Walnut.
  function keyFor(home: string): string {
    if (!home) return '-'
    const h = tidy(home)
    return deps.keyOf(walnutOf(h) ?? h)
  }
  /** Drops the key a server's data dir was filed under by an older build; true when one went. */
  function prune(): boolean {
    let homes: string[] = []
    try { homes = deps.followerHomes ? deps.followerHomes() : [] } catch { homes = [] }
    let dropped = false
    for (const raw of homes) {
      if (typeof raw !== 'string' || !raw) continue
      const own = deps.keyOf(tidy(raw))
      if (!(own in seen) || own === keyFor(raw)) continue
      delete seen[own]
      delete written[own]
      dropped = true
    }
    return dropped
  }

  function write(): void {
    prune()
    const cutoff = deps.now() - KEEP_MS
    for (const k of Object.keys(seen)) if (seen[k]! <= cutoff) { delete seen[k]; delete written[k] }
    for (const k of Object.keys(seen)) written[k] = seen[k]!
    const pty = deps.pty ? deps.pty() === true : undefined
    const body = JSON.stringify({ v: 1, version: deps.version, twin: deps.twin, capabilities: deps.capabilities(), ...(pty === undefined ? {} : { pty }), walnuts: seen, at: deps.now() })
    const tmp = `${deps.file}.${process.pid}.tmp`
    try {
      deps.fs.writeFileSync(tmp, body, { mode: 0o600 })
      deps.fs.renameSync(tmp, deps.file)
    } catch (err) {
      try { deps.fs.unlinkSync(tmp) } catch { /* not made */ }
      deps.log?.('warn', 'served walnuts: could not write the file', { error: (err as Error).message })
    }
  }

  return {
    note(home) {
      const key = keyFor(home)
      const now = deps.now()
      seen[key] = now
      const before = written[key]
      if (before === undefined || now - before >= REWRITE_MS) write()
    },
    recent(windowMs = KEEP_MS) {
      // A record read back from an older build loses its follower's key here and in the file.
      if (prune()) write()
      const cutoff = deps.now() - windowMs
      const out: Record<string, number> = {}
      for (const [k, at] of Object.entries(seen)) if (at > cutoff) out[k] = at
      return out
    },
    knows(home) {
      if (!home) return false
      const at = seen[keyFor(home)]
      return typeof at === 'number' && at > deps.now() - KEEP_MS
    },
    write,
    forgetKey(key) {
      if (!(key in seen)) return
      delete seen[key]
      delete written[key]
      write()
    },
  }
}
