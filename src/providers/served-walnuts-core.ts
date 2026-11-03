/**
 * Which Walnuts a daemon serves, kept beside daemon.version (2026-11-03: a host shared by
 * two people's Walnuts of different builds; each server replaced the daemon with its own
 * build whenever it connected, because a daemon's version is a content hash with no order).
 *
 * The daemon notes every Walnut a server socket speaks for: a bound home
 * (`leader.configure`, `host.slice`) or a named push, and `-` for a server older than
 * walnut-scope-v1 that pushes with no home. A bridge, follower, lane or probe socket is
 * never a server's, so the cloud companion, a host replica and a read-only test server are
 * not noted. `daemon.serves.json` holds the running daemon's version, its capabilities
 * and when each Walnut was last seen; it survives a daemon restart (the new daemon reads
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
  /** The same key the other cores take for a home (16 hex of its sha1). */
  keyOf: (home: string) => string
  /** This daemon's version and its capabilities as its hello says them. */
  version: string
  /** 'binary' (daemon-standalone.ts, compiled or run by bun) or 'source' (daemon-source.ts). */
  twin: 'binary' | 'source'
  capabilities: () => string[]
  now: () => number
  log?: (level: string, msg: string, data?: Record<string, unknown>) => void
}

export interface ServedWalnuts {
  /** A server socket spoke for `home` ('' = an older server that names none). */
  note(home: string): void
  /** Each Walnut seen within `windowMs`, by key, with when. */
  recent(windowMs?: number): Record<string, number>
  /** Writes the file now (at startup, once capabilities are known). */
  write(): void
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

  function write(): void {
    const cutoff = deps.now() - KEEP_MS
    for (const k of Object.keys(seen)) if (seen[k]! <= cutoff) { delete seen[k]; delete written[k] }
    for (const k of Object.keys(seen)) written[k] = seen[k]!
    const body = JSON.stringify({ v: 1, version: deps.version, twin: deps.twin, capabilities: deps.capabilities(), walnuts: seen, at: deps.now() })
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
      // One Walnut whatever slashes its dir is written with (daemon-shared.ts walnutKeyOf).
      const key = home ? deps.keyOf(home.replace(/\/+/g, '/').replace(/(.)\/$/, '$1')) : '-'
      const now = deps.now()
      seen[key] = now
      const before = written[key]
      if (before === undefined || now - before >= REWRITE_MS) write()
    },
    recent(windowMs = KEEP_MS) {
      const cutoff = deps.now() - windowMs
      const out: Record<string, number> = {}
      for (const [k, at] of Object.entries(seen)) if (at > cutoff) out[k] = at
      return out
    },
    write,
  }
}
