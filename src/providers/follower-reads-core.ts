/**
 * Follower reads, owner scoped (docs/plan/walnut-replica-servers-impl.md WP6,
 * capability 'replica-reads-v1').
 *
 * A follower socket is the server this daemon runs for ONE Walnut (its home,
 * set by `follower.hello`). Several Walnuts may share a host, so everything a
 * follower reads is scoped to its own Walnut:
 *
 *   - a session read (attach, status, markers.find, read-history, changes.*)
 *     names a session that Walnut owns (its host slice lists it, else the spawn
 *     journal says that Walnut started it); `status` never carries the argv;
 *   - `list` keeps that Walnut's rows only;
 *   - a file or git read (fs.ls/read/stat/readRange/resolvePath/grep, git.diff,
 *     git.fileShow, git.fileLog) names a path inside one of that Walnut's
 *     session cwds, after `~`, `..` and links are resolved; when another
 *     Walnut's session works in a deeper dir, that dir is the other Walnut's;
 *   - `replica.list`, `replica.read`, `replica.readMany` answer from this
 *     host's copy of that Walnut's notes, memory and skills, and
 *     `attachments.list`, `attachments.read` from its copy of the notes'
 *     pictures and files ('attachment-copy-v1'), whatever home the frame names.
 *
 * Anything else of another Walnut answers `not_found`, the same as a session
 * or a file that does not exist, so a follower cannot even tell it is there.
 * A leader (trusted) socket never reaches this code.
 *
 * How the daemon twins get it: daemon-standalone.ts imports createFollowerReads;
 * daemon-source.ts inlines `createFollowerReads.toString()` through
 * `__CREATE_FOLLOWER_READS__`. So the factory body references NOTHING at module
 * scope; every side effect arrives through deps.
 */

export interface FollowerReplicaReads {
  list(home: string, kind: unknown): { entries: Array<{ k: string; h: string; n?: number; m?: Record<string, unknown> }>; asOf: string | null; manifestHash: string } | null
  read(home: string, kind: unknown, key: unknown): { k: string; h: string; n?: number; m?: Record<string, unknown>; body: string } | null
  readMany(home: string, kind: unknown, keys: unknown, maxBytes: number): { files: Array<{ k: string; h: string; body: string }>; missing: string[]; more: string[] } | null
}

/** This host's copy of the notes' pictures and files (attachment-copy-core.ts), for its own Walnut's follower. */
export interface FollowerAttachmentReads {
  list(home: string, after: unknown, maxBytes: number): { keys: string[]; asOf: string | null; next: string | null }
  readChunk(home: string, key: unknown, offset: unknown, maxBytes: number): { k: string; h: string; n: number; offset: number; data: string } | null
}

export interface FollowerReadsDeps {
  path: typeof import('node:path')
  /** What `~` means on this host (the daemon's HOME_DIR). */
  homeDir: string
  /**
   * Where the Claude CLI keeps transcripts on this host (`<dir>/<project>/<sid>.jsonl`
   * and `<dir>/<project>/<sid>/...`): a session's own files there are its Walnut's.
   */
  claudeProjectsDirs?: string[]
  /** The daemon's streams dir (`<sid>.jsonl` and friends): a session's own files there are its Walnut's. */
  streamsDir?: string
  /** The real path of an existing path, or null when nothing is there. */
  realpath: (p: string) => string | null
  /** The Walnut whose host slice lists `sid`. */
  sliceOwner: (sid: string) => string | undefined
  /** The Walnut that first asked this host to spawn `sid` (the spawn journal). */
  journalOwner: (sid: string) => string | undefined
  /** The sessions the daemon runs or adopted, with their cwd. */
  liveSessions: () => Array<{ sid: string; cwd: string }>
  /** The spawn journal's size in bytes (-1 when there is none): it is read again only when this moves. */
  journalSize: () => number
  /** The spawn journal's text ('' when there is none): its first line per session names the cwd. */
  readJournal: () => string
  replica: FollowerReplicaReads
  /** Absent: this daemon keeps no attachments copy (the reads answer an error). */
  attachments?: FollowerAttachmentReads
  /**
   * Dirs no follower reads through, whatever session works above them: the
   * daemon's own dirs (its copies of every Walnut's notes among them), every
   * Walnut's data dir on this host, the CLI's config dirs and the streams dir.
   * A session's own transcript and stream files are still its Walnut's
   * (sessionFileOf), and a session cwd deeper than one of these decides below it.
   */
  denyRoots?: () => string[]
  /** The clock of the roots cache (Date.now when absent). */
  now?: () => number
  log: (level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) => void
}

/** An answer the handler made, cut to what the follower's Walnut may see. */
export type FollowerAnswerScope = (answer: Record<string, unknown>) => Record<string, unknown>

/** What the gate decided for one follower frame. */
export type FollowerDecision =
  | { pass: true; scope?: FollowerAnswerScope }
  | { refuse: string }
  | { answer: Record<string, unknown> }
  | { error: string }

export function createFollowerReads(deps: FollowerReadsDeps) {
  const { path } = deps
  /** The follower reads WP6 adds to the allowlist (both twins add exactly these). */
  const COMMANDS = [
    'fs.ls', 'fs.read', 'fs.stat', 'fs.readRange', 'fs.resolvePath', 'fs.grep',
    'git.diff', 'git.fileShow', 'git.fileLog', 'changes.compute', 'changes.file',
    'replica.list', 'replica.read', 'replica.readMany', 'fs.find',
    'attachments.list', 'attachments.read',
  ]
  const MAX_ANSWER_BYTES = 4 * 1024 * 1024
  const MAX_REAL_CACHE = 5000
  /** How long a roots map (and the owners it looked up) is used while no session starts or ends. */
  const ROOTS_TTL_MS = 1000
  const realCache = new Map<string, string>()
  let journalLen = -1
  let journalRows: Array<{ sid: string; cwd: string }> = []
  /** Owners looked up in this generation (the slice and journal scans are linear per sid). */
  const ownerMemo = new Map<string, string | null>()
  let rootsKey = ''
  let rootsAt = -Infinity
  let rootsMap: Map<string, Set<string>> | null = null
  /** The answers a passed frame waits for, cut by its scope (per socket, per frame id). */
  const held = new WeakMap<object, Map<unknown, FollowerAnswerScope>>()
  const now = () => (deps.now ? deps.now() : Date.now())

  function str(v: unknown): string {
    return typeof v === 'string' ? v : ''
  }

  /** The Walnut that owns `sid` on this host: its slice first, then who started it. */
  function ownerOf(sid: string): string | undefined {
    const hit = ownerMemo.get(sid)
    if (hit !== undefined) return hit ?? undefined
    const home = deps.sliceOwner(sid) ?? deps.journalOwner(sid)
    if (ownerMemo.size >= MAX_REAL_CACHE) ownerMemo.clear()
    ownerMemo.set(sid, home ?? null)
    return home
  }

  /**
   * A new generation when a session started or ended, the journal moved, or the
   * last one is older than ROOTS_TTL_MS (a slice the Mac pushed): the owners and
   * the roots are looked up again. Called once per gate, list and broadcast, so
   * a read costs a stat and a walk of the live set, not a scan of every slice.
   */
  function refresh(): void {
    let size = -1
    try { size = deps.journalSize() } catch { size = -1 }
    let key = String(size)
    for (const s of deps.liveSessions()) key += '|' + s.sid + '\u0000' + s.cwd
    const t = now()
    // A spawn moves the live set and the journal at once (one stat, no read);
    // the slices (a copy the Mac pushed) are looked at again past the TTL.
    if (key === rootsKey && t - rootsAt < ROOTS_TTL_MS) return
    rootsKey = key
    rootsAt = t
    rootsMap = null
    ownerMemo.clear()
  }

  function owns(home: string, sid: unknown): boolean {
    return typeof sid === 'string' && !!sid && ownerOf(sid) === home
  }

  /** The real path of `p`, or of its nearest existing ancestor plus the rest (a file not made yet). */
  function realOf(p: string): string {
    const abs = path.resolve(p)
    const hit = realCache.get(abs)
    if (hit !== undefined) return hit
    let head = abs
    const rest: string[] = []
    let real: string | null = null
    for (let i = 0; i < 256; i++) {
      real = deps.realpath(head)
      if (real !== null) break
      const up = path.dirname(head)
      if (up === head) break
      rest.unshift(path.basename(head))
      head = up
    }
    const out = real === null ? abs : (rest.length ? path.join(real, ...rest) : real)
    return out
  }

  /** realOf, remembered for session cwds (they rarely move, and the scan runs per read). */
  function realRoot(cwd: string): string {
    const hit = realCache.get(cwd)
    if (hit !== undefined) return hit
    const real = realOf(cwd)
    // The oldest entry goes (a Map keeps insertion order), never the whole cache.
    if (realCache.size >= MAX_REAL_CACHE) realCache.delete(realCache.keys().next().value as string)
    realCache.set(cwd, real)
    return real
  }

  function journalCwds(): Array<{ sid: string; cwd: string }> {
    let size = -1
    try { size = deps.journalSize() } catch { size = -1 }
    if (size === journalLen) return journalRows
    let text = ''
    try { text = deps.readJournal() } catch { text = '' }
    const seen = new Set<string>()
    const rows: Array<{ sid: string; cwd: string }> = []
    for (const line of text.split('\n')) {
      if (!line) continue
      try {
        const rec = JSON.parse(line) as { sid?: unknown; cwd?: unknown }
        // The first line per session is the one that counts (appendSpawnJournal writes one).
        if (typeof rec.sid !== 'string' || seen.has(rec.sid)) continue
        seen.add(rec.sid)
        if (typeof rec.cwd === 'string' && rec.cwd) rows.push({ sid: rec.sid, cwd: rec.cwd })
      } catch { /* a torn tail */ }
    }
    journalLen = size
    journalRows = rows
    return rows
  }

  /**
   * Every session cwd on this host, real, with the Walnuts that work in it, and
   * every deny root with nobody: the deepest root that holds a path decides.
   * Built once per generation (refresh).
   */
  function roots(): Map<string, Set<string>> {
    if (rootsMap) return rootsMap
    const out = new Map<string, Set<string>>()
    const denied = new Set<string>()
    let deny: string[] = []
    try { deny = deps.denyRoots ? deps.denyRoots() : [] } catch { deny = [] }
    for (const d of deny) {
      if (!d || !path.isAbsolute(d)) continue
      const real = realRoot(d)
      if (real === path.parse(real).root) continue
      denied.add(real)
      out.set(real, new Set())
    }
    const add = (sid: string, cwd: string) => {
      const home = ownerOf(sid)
      if (!home || !cwd || !path.isAbsolute(cwd)) return
      const real = realRoot(cwd)
      // The filesystem root is no session's own tree, and a deny root stays nobody's.
      if (real === path.parse(real).root || denied.has(real)) return
      let set = out.get(real)
      if (!set) { set = new Set(); out.set(real, set) }
      set.add(home)
    }
    for (const s of deps.liveSessions()) add(s.sid, s.cwd)
    for (const s of journalCwds()) add(s.sid, s.cwd)
    rootsMap = out
    return out
  }

  function expand(p: string): string {
    if (p === '~' || p.startsWith('~/')) return deps.homeDir + p.slice(1)
    return p
  }

  /** `real` is a transcript or stream file of a session `home` owns (the session id names it). */
  function sessionFileOf(home: string, real: string): boolean {
    const within = (dir: string): string[] | null => {
      const root = realRoot(dir)
      return real.startsWith(root + path.sep) ? real.slice(root.length + 1).split(path.sep) : null
    }
    for (const dir of deps.claudeProjectsDirs ?? []) {
      const parts = within(dir)
      if (!parts || parts.length < 2) continue
      const name = parts[1]!
      const sid = parts.length === 2 ? (name.endsWith('.jsonl') ? name.slice(0, -'.jsonl'.length) : '') : name
      if (sid && owns(home, sid)) return true
    }
    if (deps.streamsDir) {
      const parts = within(deps.streamsDir)
      const m = parts && parts.length === 1 ? /^([A-Za-z0-9_-]{1,128})\.(jsonl|meta\.json)$/.exec(parts[0]!) : null
      if (m && owns(home, m[1]!)) return true
    }
    return false
  }

  /**
   * `p` (absolute, or relative to `base`) lies inside a session cwd of `home`:
   * the deepest session cwd that holds it is one `home` works in.
   */
  function inScope(home: string, p: unknown, base?: string): boolean {
    let s = str(p)
    if (!s || s.indexOf('\u0000') !== -1) return false
    s = expand(s)
    if (!path.isAbsolute(s)) {
      if (!base) return false
      s = path.join(base, s)
    }
    const real = realOf(s)
    if (sessionFileOf(home, real)) return true
    let best = ''
    let owners: Set<string> | undefined
    for (const [root, homes] of roots()) {
      const inside = real === root || real.startsWith(root.endsWith(path.sep) ? root : root + path.sep)
      if (inside && root.length > best.length) { best = root; owners = homes }
    }
    return !!owners && owners.has(home)
  }

  /** The cwd a session of `home` works in (live first, then the journal), for a relative path. */
  function sessionCwd(sid: string): string | undefined {
    for (const s of deps.liveSessions()) if (s.sid === sid && s.cwd) return s.cwd
    for (const s of journalCwds()) if (s.sid === sid) return s.cwd
    return undefined
  }

  function refuse(home: string, c: string, sid?: unknown): FollowerDecision {
    deps.log('info', 'follower: not this Walnut\'s, answered not_found', { cmd: c, home, ...(typeof sid === 'string' && sid ? { sid } : {}) })
    // ENOENT: every reader of a daemon answer already takes it as "no such file" (DaemonFileReader).
    return { refuse: `${c}: ENOENT: not found for this Walnut on this host` }
  }

  function replicaAnswer(home: string, c: string, cmd: Record<string, unknown>): FollowerDecision {
    try {
      if (c === 'replica.list') {
        const r = deps.replica.list(home, cmd.kind)
        return r ? { answer: r as unknown as Record<string, unknown> } : { error: `replica.list: unknown kind ${String(cmd.kind)}` }
      }
      if (c === 'replica.read') {
        // A kind check, not a list: one read must not sort and hash the whole copy.
        if (['notes', 'memory', 'skills'].indexOf(String(cmd.kind)) === -1) return { error: `replica.read: unknown kind ${String(cmd.kind)}` }
        const r = deps.replica.read(home, cmd.kind, cmd.key)
        return r ? { answer: r as unknown as Record<string, unknown> } : refuse(home, c)
      }
      const r = deps.replica.readMany(home, cmd.kind, cmd.keys, MAX_ANSWER_BYTES)
      return r ? { answer: r as unknown as Record<string, unknown> } : { error: `replica.readMany: unknown kind or bad keys` }
    } catch (err) {
      deps.log('error', 'follower: replica read failed', { cmd: c, home, error: (err as Error).message })
      return { error: `${c}: ${(err as Error).message}` }
    }
  }

  /**
   * `home`'s copy of the pictures: its paths a page at a time (a quarter of
   * MAX_ANSWER_BYTES of characters, so a page of CJK names stays under it), and
   * one 2 MB slice of a file per answer (base64 stays under it too).
   */
  function attachmentAnswer(home: string, c: string, cmd: Record<string, unknown>): FollowerDecision {
    const a = deps.attachments
    if (!a) return { error: c + ': this host keeps no copy of the attachments' }
    try {
      if (c === 'attachments.list') return { answer: a.list(home, cmd.after, MAX_ANSWER_BYTES / 4) as unknown as Record<string, unknown> }
      const r = a.readChunk(home, cmd.key, cmd.offset, 2 * 1024 * 1024)
      return r ? { answer: r as unknown as Record<string, unknown> } : refuse(home, c)
    } catch (err) {
      deps.log('error', 'follower: attachments read failed', { cmd: c, home, error: (err as Error).message })
      return { error: c + ': ' + (err as Error).message }
    }
  }

  /**
   * One follower frame of the Walnut `home`: go on to the handler (`pass`; a
   * `status` loses `includeArgs` on the way), refuse it as not found, or answer
   * it here (the replica reads). `home` null: the socket has not said hello.
   */
  function gate(home: string | null, cmd: Record<string, unknown>): FollowerDecision {
    const c = str(cmd.cmd)
    const scoped = c === 'attach' || c === 'status' || c === 'markers.find' || c === 'read-history' || COMMANDS.indexOf(c) !== -1
    if (!scoped) return { pass: true }
    if (!home) return { error: `${c}: send follower.hello first` }
    refresh()
    if (c === 'attach' || c === 'status' || c === 'markers.find' || c === 'read-history') {
      if (!owns(home, cmd.sid)) return refuse(home, c, cmd.sid)
      // The argv carries the leader's prompt: a follower never needs it.
      if (c === 'status') delete cmd.includeArgs
      return { pass: true }
    }
    if (c === 'replica.list' || c === 'replica.read' || c === 'replica.readMany') return replicaAnswer(home, c, cmd)
    if (c === 'attachments.list' || c === 'attachments.read') return attachmentAnswer(home, c, cmd)
    if (c === 'changes.compute' || c === 'changes.file') {
      // The answer is the owned session's own change list (or one file of it):
      // that Walnut's data wherever the session edited, so no path check.
      if (!owns(home, cmd.sid)) return refuse(home, c, cmd.sid)
      if (cmd.cwd !== undefined && !inScope(home, cmd.cwd)) return refuse(home, c, cmd.sid)
      return { pass: true }
    }
    if (c === 'fs.find') return findGate(home, cmd)
    if (c === 'fs.resolvePath') {
      if (cmd.sessionId !== undefined && !owns(home, cmd.sessionId)) return refuse(home, c, cmd.sessionId)
      const base = str(cmd.cwd) || (typeof cmd.sessionId === 'string' ? sessionCwd(cmd.sessionId) : undefined)
      if (!base || !inScope(home, base)) return refuse(home, c, cmd.sessionId)
      const ref = expand(str(cmd.ref))
      if (path.isAbsolute(ref) && !inScope(home, ref)) return refuse(home, c, cmd.sessionId)
      // The search runs under the cwd, where another Walnut may work deeper.
      return { pass: true, scope: (a) => resolvedInScope(home, a, expand(base)) }
    }
    // The handlers below resolve a relative path against the daemon's own cwd,
    // not the one checked here: only an absolute path is ever let through.
    if (c === 'fs.grep') {
      if (cmd.cwd !== undefined && !inScope(home, cmd.cwd)) return refuse(home, c)
      if (!absolute(cmd.file) || !inScope(home, cmd.file)) return refuse(home, c)
      // git grep searches the whole repository: matches under another Walnut's cwd go.
      return { pass: true, scope: (a) => (Array.isArray(a.matches) ? { ...a, matches: a.matches.filter((m: { file?: unknown }) => inScope(home, m?.file)) } : a) }
    }
    if (c === 'git.diff') {
      // Out of scope looks like no repository (the daemon's own answer for a
      // dir outside git): a session's change in another Walnut's tree, or in a
      // tree no session works in, is left out, never a failed diff.
      if (!inScope(home, cmd.cwd)) { refuse(home, c); return { answer: { repoRoot: null, files: [] } } }
      // The diff is the whole repository's: files under another Walnut's cwd go.
      return { pass: true, scope: (a) => diffInScope(home, a) }
    }
    if (c === 'git.fileShow' || c === 'git.fileLog') {
      if (!inScope(home, cmd.cwd)) return refuse(home, c)
      return absolute(cmd.path) && inScope(home, cmd.path) ? { pass: true } : refuse(home, c)
    }
    // fs.ls, fs.read, fs.stat, fs.readRange: one path. A stat out of scope is
    // the daemon's own answer for a missing file, so no reader can tell.
    if (inScope(home, cmd.path)) return { pass: true }
    if (c === 'fs.stat') { refuse(home, c); return { answer: { exists: false } } }
    return refuse(home, c)
  }

  /** `p` is absolute once `~` is expanded (a relative one is refused outright). */
  function absolute(p: unknown): boolean {
    const s = str(p)
    return !!s && path.isAbsolute(expand(s))
  }

  /** A git.diff answer without the files outside `home`'s scope (a rename counts from both ends). */
  function diffInScope(home: string, a: Record<string, unknown>): Record<string, unknown> {
    const root = str(a.repoRoot)
    if (!root || !Array.isArray(a.files)) return a
    const inside = (rel: unknown) => typeof rel === 'string' && inScope(home, path.join(root, rel))
    const files = a.files.filter((f: { relPath?: unknown; oldRelPath?: unknown }) => inside(f?.relPath) && (f?.oldRelPath === undefined || inside(f.oldRelPath)))
    return { ...a, files }
  }

  /** A resolvePath answer that names nothing outside `home`'s scope: an outside hit falls back to the cwd. */
  function resolvedInScope(home: string, a: Record<string, unknown>, base: string): Record<string, unknown> {
    const alternatives = Array.isArray(a.alternatives) ? a.alternatives.filter((p: unknown) => inScope(home, p)) : undefined
    const out: Record<string, unknown> = alternatives ? { ...a, alternatives } : { ...a }
    if (typeof a.path === 'string' && !inScope(home, a.path)) Object.assign(out, { path: base, resolved: false, degraded: true })
    return out
  }

  /**
   * fs.find, for a session's transcript under the CLI's projects dir (a reader
   * that has no cwd for it): only a session `home` owns, and only its own files.
   */
  function findGate(home: string, cmd: Record<string, unknown>): FollowerDecision {
    const m = /^([A-Za-z0-9_-]{1,128})(\.jsonl)?$/.exec(str(cmd.name))
    if (!m || !owns(home, m[1])) return refuse(home, 'fs.find')
    const real = realOf(expand(str(cmd.path) || '~/.claude/projects'))
    const under = (deps.claudeProjectsDirs ?? []).some((d) => { const r = realRoot(d); return real === r || real.startsWith(r + path.sep) })
    if (!under) return refuse(home, 'fs.find')
    return { pass: true, scope: (a) => (Array.isArray(a.files) ? { ...a, files: a.files.filter((f: unknown) => inScope(home, f)) } : a) }
  }

  /** Keep a passed frame's scope until its answer goes out (`settle`). */
  function hold(socket: object, id: unknown, scope: FollowerAnswerScope): void {
    let m = held.get(socket)
    if (!m) { m = new Map(); held.set(socket, m) }
    // A handler that never answers leaves one entry: the oldest go past a bound.
    if (m.size >= 256) m.delete(m.keys().next().value)
    m.set(id, scope)
  }

  /** The answer to frame `id` on `socket`, cut by the scope held for it (an error answer only drops it). */
  function settle(socket: object, id: unknown, data?: Record<string, unknown>): Record<string, unknown> | undefined {
    const m = held.get(socket)
    const scope = m?.get(id)
    if (!scope) return data
    m!.delete(id)
    if (!data) return data
    try { return scope(data) } catch (err) {
      // Nothing of a half-cut answer goes out.
      deps.log('error', 'follower: an answer scope failed, answered empty', { error: (err as Error).message })
      return {}
    }
  }

  /** `list` rows a follower of `home` may see: its own sessions only. */
  function ownRows<T extends { sid: string }>(home: string | null, rows: T[]): T[] {
    if (!home) return []
    refresh()
    return rows.filter((r) => owns(home, r.sid))
  }

  /** inScope for a caller outside the gate (a fresh generation first). */
  function inScopeNow(home: string, p: unknown, base?: string): boolean {
    refresh()
    return inScope(home, p, base)
  }

  return { COMMANDS, MAX_ANSWER_BYTES, gate, ownRows, inScope: inScopeNow, ownerOf, hold, settle }
}

export type FollowerReads = ReturnType<typeof createFollowerReads>
