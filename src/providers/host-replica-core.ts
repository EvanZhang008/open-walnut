/**
 * Host replica: this host's read copy of a Walnut's notes, memory and skills
 * (docs/plan/walnut-control-plane.md, "Every host reads its own copy").
 *
 * The primary pushes it per kind as a manifest (`replica.sync`: every entry's
 * key, content hash and small metadata), this host answers with the keys it
 * lacks, and the primary sends those bodies (`replica.put`). A kind the user
 * stopped keeping here is removed (`replica.drop`). Bodies are stored under a
 * hash of their key, so a key is never a path on this host.
 *
 * While the leader cannot answer, the offline host hands the read ops here:
 * note_read, note_search (keyword only: the primary's semantic index stays on
 * the primary), memory_read and skill_read, each saying how old the copy is.
 * What the user left out of this copy (a folder or a note, `keepExclude`, and the
 * notes too large to copy, `tooBig`) is never answered from it: a read of one
 * needs the leader (`not_kept_here`), and a search says some notes are only there.
 * A kind the leader turned off here (`replica.drop`) is marked off, not just gone.
 *
 * How the daemon twins get it: daemon-standalone.ts imports createHostReplica;
 * daemon-source.ts inlines `createHostReplica.toString()` through
 * `__CREATE_HOST_REPLICA__`. So the factory body references NOTHING at module
 * scope; every side effect arrives through deps.
 */

export type ReplicaKind = 'notes' | 'memory' | 'skills'

/** One manifest line: key, sha256 of the body (first 12 hex, the notes contentHash), metadata. */
export interface ReplicaEntry {
  k: string
  h: string
  /** Body size in bytes. */
  n?: number
  /** notes: { title, id?, updatedAt }; the others: nothing. */
  m?: Record<string, unknown>
}

export interface ReplicaFile { k: string; body: string }

export interface ReplicaSyncOptions {
  /** notes: folders the primary's own search leaves out (config search.excluded_folders). */
  searchExclude?: string[]
  /** notes: folders and notes this host does not keep (hosts.<key>.keep.notes_exclude): never read or written here. */
  keepExclude?: string[]
  /** notes: notes the primary keeps to itself because they are too large to copy: never written here while away. */
  tooBig?: string[]
}

/** The half rule's override (section 4): the leader confirms a removal of most rows, bound to its manifest. */
export interface ReplicaSyncGuard {
  confirm?: unknown
  /** `{entries, keys}`: the manifest's count and the sha256-12 of its sorted keys joined by newlines. */
  confirmFor?: unknown
}

/**
 * The journal's view of the notes (WP11), set by the daemon once the offline host
 * exists: what a pending away write changed (read through every copy read here and
 * on the follower link) and which keys a manifest must not replace or remove.
 */
export interface ReplicaJournalView {
  /** key -> the note as the pending write leaves it, or null for a pending delete. */
  overlay(home: string): Map<string, { body: string; h: string; n: number; m?: Record<string, unknown> } | null> | null
  /** Keys a manifest of this asOf must not replace or remove (pending, or acked and awaiting a later copy). */
  held(home: string, asOf: number): Set<string>
}

type GatewayResult = { ok: true; result: Record<string, unknown> } | { ok: false; error: { code: string; message: string; detail?: unknown } }

export interface HostReplicaDeps {
  fs: typeof import('node:fs')
  path: typeof import('node:path')
  /** Root of every copy: <dir>/<home key>/<kind>/. */
  dir: string
  now: () => number
  /** Short stable file key (a hash): for homes and for entry keys. */
  keyOf: (value: string) => string
  /** sha256(body) as hex, first 12 characters: what the primary sends as `h`. */
  hash: (body: string) => string
  log: (level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) => void
}

export function createHostReplica(deps: HostReplicaDeps) {
  const { fs, path } = deps
  const KINDS: ReplicaKind[] = ['notes', 'memory', 'skills']
  const MAX_ENTRIES = 20_000
  const MAX_KEY = 1024
  const MAX_BODY = 2 * 1024 * 1024
  const MAX_TOKENS = 12
  const DEFAULT_LIMIT = 30
  const MAX_LIMIT = 100
  const SNIPPET = 90
  const HASH_RE = /^[0-9a-f]{12}$/

  interface IndexRow { h: string; n?: number; m?: Record<string, unknown>; f: string }
  interface KindState {
    index: Record<string, IndexRow>
    /** Keys the last manifest named that have not arrived yet: key → expected hash. */
    pending: Record<string, string>
    pendingMeta: Record<string, { n?: number; m?: Record<string, unknown> }>
    /** The primary's clock at the last manifest that arrived whole. */
    asOf: number
    /** The manifest that is still filling in. */
    pendingAsOf: number
    opts: ReplicaSyncOptions
    /** When the leader turned this kind off here (replica.drop); 0: it did not. */
    off: number
  }

  const states = new Map<string, KindState>()
  /** Bodies read for a search, kept until that entry changes. */
  const bodies = new Map<string, Map<string, string>>()

  const READ_OPS: Record<string, ReplicaKind> = {
    note_read: 'notes', note_search: 'notes', memory_read: 'memory', skill_read: 'skills',
  }
  const OPS: Array<{ kind: ReplicaKind; name: string; title: string; description: string; readonly: boolean; signature: string }> = [
    { kind: 'notes', name: 'note_read', title: 'Read a note (copy on this host)', description: 'From the notes this host keeps; attachments stay on the Walnut server.', readonly: true, signature: 'path|id' },
    { kind: 'notes', name: 'note_search', title: 'Search notes (copy on this host)', description: 'Keyword search of the notes this host keeps (the server\'s semantic ranking needs the server).', readonly: true, signature: 'q [limit]' },
    { kind: 'memory', name: 'memory_read', title: 'Read Walnut memory (copy on this host)', description: 'MEMORY.md or USER.md as this host last received them.', readonly: true, signature: 'doc' },
    { kind: 'skills', name: 'skill_read', title: 'Read a Walnut skill (copy on this host)', description: 'A skill as this host last received it.', readonly: true, signature: 'dirName' },
  ]

  function isKind(kind: unknown): kind is ReplicaKind {
    return typeof kind === 'string' && (KINDS as string[]).indexOf(kind) !== -1
  }

  function kindDir(home: string, kind: ReplicaKind): string {
    return path.join(deps.dir, deps.keyOf(home), kind)
  }

  function stateKey(home: string, kind: ReplicaKind): string {
    return `${home}\u0000${kind}`
  }

  function writeAtomic(target: string, data: string): void {
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
    const tmp = `${target}.${process.pid}.tmp`
    fs.writeFileSync(tmp, data, { mode: 0o600 })
    fs.renameSync(tmp, target)
  }

  function load(home: string, kind: ReplicaKind): KindState {
    const key = stateKey(home, kind)
    let st = states.get(key)
    if (st) return st
    st = { index: {}, pending: {}, pendingMeta: {}, asOf: 0, pendingAsOf: 0, opts: {}, off: 0 }
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(kindDir(home, kind), 'index.json'), 'utf8')) as Partial<KindState>
      if (raw && typeof raw.index === 'object' && raw.index) {
        st.index = raw.index as Record<string, IndexRow>
        st.asOf = typeof raw.asOf === 'number' ? raw.asOf : 0
        st.opts = raw.opts && typeof raw.opts === 'object' ? raw.opts : {}
        st.off = typeof raw.off === 'number' ? raw.off : 0
      }
    } catch { /* no copy yet */ }
    states.set(key, st)
    return st
  }

  function persist(home: string, kind: ReplicaKind, st: KindState): void {
    try {
      writeAtomic(path.join(kindDir(home, kind), 'index.json'), JSON.stringify({ index: st.index, asOf: st.asOf, opts: st.opts, ...(st.off ? { off: st.off } : {}) }))
    } catch (err) {
      deps.log('warn', 'host replica: persist failed', { kind, error: (err as Error).message })
    }
  }

  function bodyFile(home: string, kind: ReplicaKind, f: string): string {
    return path.join(kindDir(home, kind), 'f', f)
  }

  function forget(home: string, kind: ReplicaKind, k: string): void {
    bodies.get(stateKey(home, kind))?.delete(k)
  }

  function has(home: string, kind: ReplicaKind): boolean {
    const index = load(home, kind).index
    for (const k in index) if (Object.prototype.hasOwnProperty.call(index, k)) return true
    return false
  }

  /** This host can answer `name` for `home` from its copy (the op is a copy read and that kind is kept). */
  function keeps(home: string, name: unknown): boolean {
    const kind = typeof name === 'string' && Object.prototype.hasOwnProperty.call(READ_OPS, name) ? READ_OPS[name] : null
    return !!kind && typeof home === 'string' && !!home && has(home, kind)
  }

  // ── the primary's side: manifest, bodies, removal ──

  /** Below this many rows a copy takes any manifest; at it, one removing more than half is refused. */
  const REMOVAL_FLOOR = 200
  let journalView: ReplicaJournalView | null = null

  function folders(raw: unknown, max: number): string[] | undefined {
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string').slice(0, max) : undefined
  }

  /** A refusal the leader can read (`errorKind`), the copy left as it was. */
  function refused(code: string, message: string, detail: Record<string, unknown>): Error {
    return Object.assign(new Error(`${code}: ${message}`), { code, detail })
  }

  function sync(home: string, kind: unknown, entries: unknown, asOf: unknown, opts?: ReplicaSyncOptions, guard?: ReplicaSyncGuard): { need: string[]; entries: number; held: number; heldKeys?: string[]; removed: number } {
    if (typeof home !== 'string' || !home) throw new Error('replica.sync: missing home')
    if (!isKind(kind)) throw new Error(`replica.sync: unknown kind ${String(kind)}`)
    if (!Array.isArray(entries) || entries.length > MAX_ENTRIES) throw new Error('replica.sync: bad entries')
    const st = load(home, kind)
    const at = typeof asOf === 'number' && Number.isFinite(asOf) ? asOf : deps.now()
    // A key an away write holds (pending, or acked and not yet in a later copy) is
    // neither replaced nor removed: the copy keeps the base that write was made on.
    let holds = new Set<string>()
    if (kind === 'notes' && journalView) { try { holds = journalView.held(home, at) } catch { holds = new Set() } }
    const seen = new Set<string>()
    const rows: ReplicaEntry[] = []
    for (const raw of entries as ReplicaEntry[]) {
      if (!raw || typeof raw.k !== 'string' || !raw.k || raw.k.length > MAX_KEY || typeof raw.h !== 'string' || !HASH_RE.test(raw.h)) continue
      if (seen.has(raw.k)) continue
      seen.add(raw.k)
      rows.push(raw)
    }
    const removing = Object.keys(st.index).filter((k) => !seen.has(k) && !holds.has(k))
    const local = Object.keys(st.index).length
    // What the user's choice leaves out goes however much it is; only the rest counts.
    const chosen = kind === 'notes' && opts && typeof opts === 'object'
      ? { exclude: folders(opts.keepExclude, 200) ?? [], tooBig: new Set((folders(opts.tooBig, 5_000) ?? []).map((t) => t.toLowerCase())) }
      : null
    const unchosen = chosen ? removing.filter((k) => !leftOut(k, chosen.exclude) && !chosen.tooBig.has(k.toLowerCase())).length : removing.length
    if (local >= REMOVAL_FLOOR && unchosen * 2 > local) {
      // The half rule (section 4): a leader that lost its store must not empty this copy.
      const c = guard?.confirmFor as { entries?: unknown; keys?: unknown } | undefined
      const keys = deps.hash([...seen].sort().join('\n'))
      const confirmed = guard?.confirm === true && !!c && c.entries === seen.size && c.keys === keys
      if (!confirmed) {
        deps.log('warn', 'host replica: a manifest that removes most of the copy was refused', { kind, local, removing: removing.length, entries: seen.size })
        throw refused('manifest_removes_most_rows', `the manifest would remove ${removing.length} of ${local} ${kind} kept here`, { local, removing: removing.length, entries: seen.size, keys })
      }
      deps.log('warn', 'host replica: the leader confirmed a removal of most of the copy', { kind, local, removing: removing.length, entries: seen.size })
    }
    const need: string[] = []
    const heldKeys: string[] = []
    st.pending = {}
    st.pendingMeta = {}
    for (const raw of rows) {
      const meta = raw.m && typeof raw.m === 'object' ? raw.m : undefined
      const prev = st.index[raw.k]
      if (prev && prev.h === raw.h) {
        // Same body: only the metadata (a touched file's time) may move.
        st.index[raw.k] = { ...prev, n: raw.n, m: meta }
        continue
      }
      if (holds.has(raw.k)) { heldKeys.push(raw.k); continue }
      // A changed entry keeps its old body until the new one arrives: a read
      // in between answers the older text, with the copy's age, not "missing".
      st.pending[raw.k] = raw.h
      st.pendingMeta[raw.k] = { n: raw.n, m: meta }
      need.push(raw.k)
    }
    for (const k of Object.keys(st.index)) {
      if (seen.has(k)) continue
      if (holds.has(k)) { heldKeys.push(k); continue }
      try { fs.rmSync(bodyFile(home, kind, st.index[k].f), { force: true }) } catch { /* gone already */ }
      delete st.index[k]
      forget(home, kind, k)
    }
    st.opts = opts && typeof opts === 'object' ? {
      searchExclude: folders(opts.searchExclude, 200),
      ...(kind === 'notes' ? { keepExclude: folders(opts.keepExclude, 200), tooBig: folders(opts.tooBig, 5_000) } : {}),
    } : {}
    if (need.length === 0) { st.asOf = at; st.pendingAsOf = 0 } else st.pendingAsOf = at
    st.off = 0
    persist(home, kind, st)
    if (heldKeys.length) deps.log('info', 'host replica: keys an away write holds were kept', { kind, held: heldKeys.length })
    return { need, entries: seen.size, held: heldKeys.length, ...(heldKeys.length ? { heldKeys: heldKeys.slice(0, 100) } : {}), removed: removing.length }
  }

  function put(home: string, kind: unknown, files: unknown): { stored: number; rejected: number; remaining: number } {
    if (typeof home !== 'string' || !home) throw new Error('replica.put: missing home')
    if (!isKind(kind)) throw new Error(`replica.put: unknown kind ${String(kind)}`)
    if (!Array.isArray(files)) throw new Error('replica.put: bad files')
    const st = load(home, kind)
    let stored = 0
    let rejected = 0
    for (const file of files as ReplicaFile[]) {
      const k = file && typeof file.k === 'string' ? file.k : ''
      const expected = k ? st.pending[k] : undefined
      // Only a body the last manifest asked for, and only the exact one it named.
      if (!expected || typeof file.body !== 'string' || file.body.length > MAX_BODY || deps.hash(file.body) !== expected) { rejected++; continue }
      const f = deps.keyOf(`${kind}:${k}`)
      try {
        writeAtomic(bodyFile(home, kind, f), file.body)
      } catch (err) {
        deps.log('warn', 'host replica: body write failed', { kind, error: (err as Error).message })
        rejected++
        continue
      }
      const meta = st.pendingMeta[k] ?? {}
      st.index[k] = { h: expected, n: meta.n, m: meta.m, f }
      delete st.pending[k]
      delete st.pendingMeta[k]
      forget(home, kind, k)
      stored++
    }
    const remaining = Object.keys(st.pending).length
    if (remaining === 0 && st.pendingAsOf) { st.asOf = st.pendingAsOf; st.pendingAsOf = 0 }
    persist(home, kind, st)
    return { stored, rejected, remaining }
  }

  function drop(home: string, kind: unknown): { dropped: boolean } {
    if (typeof home !== 'string' || !home) throw new Error('replica.drop: missing home')
    if (!isKind(kind)) throw new Error(`replica.drop: unknown kind ${String(kind)}`)
    const existed = has(home, kind)
    try { fs.rmSync(kindDir(home, kind), { recursive: true, force: true }) } catch { /* nothing kept */ }
    bodies.delete(stateKey(home, kind))
    // The mark says the user turned it off here: a read of it is the leader's, not "not copied yet".
    const st: KindState = { index: {}, pending: {}, pendingMeta: {}, asOf: 0, pendingAsOf: 0, opts: {}, off: deps.now() }
    states.set(stateKey(home, kind), st)
    persist(home, kind, st)
    if (existed) deps.log('info', 'host replica: copy removed', { kind })
    return { dropped: existed }
  }

  function status(home: string): Record<string, { entries: number; pending: number; asOf: string | null; off?: true }> {
    const out: Record<string, { entries: number; pending: number; asOf: string | null; off?: true }> = {}
    for (const kind of KINDS) {
      const st = load(home, kind)
      out[kind] = { entries: Object.keys(st.index).length, pending: Object.keys(st.pending).length, asOf: st.asOf ? new Date(st.asOf).toISOString() : null, ...(st.off ? { off: true as const } : {}) }
    }
    return out
  }

  /** The leader turned `kind` off here (its last word was replica.drop). */
  function isOff(home: string, kind: ReplicaKind): boolean {
    return load(home, kind).off > 0
  }

  // ── what this copy leaves out (core/replication/keep-rule.ts, the same rule) ──

  /** Whether `rel` is left out by one of `entries`: a folder, or one note with or without `.md`, any case. */
  function leftOut(rel: string, entries: readonly string[]): boolean {
    if (!entries || entries.length === 0) return false
    const k = rel.toLowerCase()
    for (const raw of entries) {
      const e = String(raw ?? '').trim().split('\\').join('/').replace(/^(\.\/)+/, '').replace(/^\/+|\/+$/g, '').toLowerCase()
      if (!e) continue
      if (k === e || k.startsWith(`${e}/`)) return true
      if (!e.endsWith('.md') && k === `${e}.md`) return true
    }
    return false
  }

  /** The note at `k` is one the leader keeps from this copy (left out, or too large). */
  function noteLeftOut(home: string, k: string): boolean {
    const o = load(home, 'notes').opts
    const lower = k.toLowerCase()
    return leftOut(k, o.keepExclude ?? []) || (o.tooBig ?? []).some((t) => t.toLowerCase() === lower)
  }

  /** This copy of the notes leaves notes out: a miss may be a note kept only on the leader. */
  function notesPartial(home: string): boolean {
    const o = load(home, 'notes').opts
    return (o.keepExclude ?? []).length > 0 || (o.tooBig ?? []).length > 0
  }

  const PARTIAL_SEARCH = 'Some notes are kept only on your Mac, so they are not in these results.'

  // ── answering reads ──

  type ViewRow = IndexRow & { body?: string }
  /**
   * The copy as every read sees it: the index with the pending away writes over it
   * (notes, WP11). Taken ONCE per read and passed down, never a copy of the index: a
   * copy per key made a search of N notes O(N^2) on the daemon's loop.
   */
  interface View {
    index: Record<string, IndexRow>
    ov: Map<string, { body: string; h: string; n: number; m?: Record<string, unknown> } | null> | null
  }

  function viewOf(home: string, kind: ReplicaKind): View {
    const index = load(home, kind).index
    if (kind !== 'notes' || !journalView) return { index, ov: null }
    let ov: ReturnType<ReplicaJournalView['overlay']> = null
    try { ov = journalView.overlay(home) } catch (err) {
      deps.log('warn', 'host replica: the away writes could not be read over the copy', { error: (err as Error).message })
    }
    return { index, ov: ov && ov.size > 0 ? ov : null }
  }

  /** One key of a view: the away write over it first, then the copy's own row. */
  function rowIn(v: View, k: string): ViewRow | undefined {
    const own = Object.prototype.hasOwnProperty.call(v.index, k) ? v.index[k] : undefined
    if (!v.ov || !v.ov.has(k)) return own
    const o = v.ov.get(k)
    if (!o) return undefined
    return { h: o.h, n: o.n, m: { ...(own?.m ?? {}), ...(o.m ?? {}) }, f: own?.f ?? '', body: o.body }
  }

  /** Every key of a view, in the copy's order, then the notes made while away. */
  function keysOf(v: View): string[] {
    const keys = Object.keys(v.index)
    const ov = v.ov
    if (!ov) return keys
    const out = keys.filter((k) => !(ov.has(k) && ov.get(k) === null))
    for (const [k, o] of ov) if (o !== null && !Object.prototype.hasOwnProperty.call(v.index, k)) out.push(k)
    return out
  }

  function readBody(home: string, kind: ReplicaKind, k: string, v: View = viewOf(home, kind)): string | null {
    const row = rowIn(v, k)
    if (!row) return null
    if (row.body !== undefined) return row.body
    const cacheKey = stateKey(home, kind)
    const cached = bodies.get(cacheKey)?.get(k)
    if (cached !== undefined) return cached
    try {
      const body = fs.readFileSync(bodyFile(home, kind, row.f), 'utf8')
      let map = bodies.get(cacheKey)
      if (!map) { map = new Map(); bodies.set(cacheKey, map) }
      map.set(k, body)
      return body
    } catch {
      return null
    }
  }

  function ageOf(home: string, kind: ReplicaKind): string {
    const at = load(home, kind).asOf
    return at ? new Date(at).toISOString() : 'unknown'
  }

  function ok(result: Record<string, unknown>): GatewayResult {
    return { ok: true, result }
  }

  function fail(code: string, message: string, detail?: unknown): GatewayResult {
    return { ok: false, error: { code, message, ...(detail !== undefined ? { detail } : {}) } }
  }

  function str(v: unknown): string {
    return typeof v === 'string' ? v.trim() : ''
  }

  function titleOf(k: string, row: IndexRow): string {
    const t = row.m && typeof row.m.title === 'string' ? row.m.title : ''
    return t || path.posix.basename(k).replace(/\.md$/i, '')
  }

  function normalizeNotePath(p: string): string {
    let s = p.split('\\').join('/').replace(/^\.\/+/, '').replace(/^\/+/, '')
    if (!/\.md$/i.test(s)) s += '.md'
    return s
  }

  /** A note this copy does not hold and may not: the leader's (never "not found"). */
  function notKept(what: string, sure: boolean, verb = 'is'): GatewayResult {
    const message = sure
      ? `${what} ${verb} kept only on your Mac, which is not answering this host right now.`
      : `${what} ${verb} not in this host's copy, and some notes are kept only on your Mac, which is not answering this host right now.`
    return fail('needs_leader', message, { why: 'not_kept_here' })
  }

  function resolveNote(home: string, v: View, args: Record<string, unknown>): { k?: string; error?: GatewayResult } {
    const id = str(args.id)
    const p = str(args.path)
    if (!id && !p) return { error: fail('bad_request', 'pass path (vault-relative note path) or id (from note_search)') }
    const keys = keysOf(v)
    const ref = id || p
    const partial = notesPartial(home)
    if (id || /^n_[a-z0-9]+$/i.test(p)) {
      for (const k of keys) { const row = rowIn(v, k); if (row && row.m && row.m.id === ref) return { k } }
      if (id) return { error: partial ? notKept(`The note with id ${ref}`, false) : fail('not_found', `No note with id ${ref} in this host's copy`) }
    }
    const direct = normalizeNotePath(p)
    if (rowIn(v, direct)) return { k: direct }
    if (noteLeftOut(home, direct)) return { error: notKept(`The note ${direct}`, true) }
    // A title, as online: the note whose title or file name is the text.
    const want = p.replace(/\.md$/i, '').toLowerCase()
    const hits = keys.filter((k) => titleOf(k, rowIn(v, k)!).toLowerCase() === want || path.posix.basename(k).replace(/\.md$/i, '').toLowerCase() === want)
    if (hits.length === 1) return { k: hits[0] }
    if (hits.length > 1) return { error: fail('ambiguous', `"${p}" names ${hits.length} notes in this host's copy; pass the path`, { candidates: hits.slice(0, 20) }) }
    // A title may name a note the copy leaves out (its title is not known here); a path
    // that is not left out is not on the Mac either.
    if (partial && !p.includes('/')) return { error: notKept(`The note "${p}"`, false) }
    return { error: fail('not_found', `Note not found in this host's copy: ${p}`) }
  }

  function noteRead(home: string, args: Record<string, unknown>, why: string): GatewayResult {
    const v = viewOf(home, 'notes')
    const r = resolveNote(home, v, args)
    if (r.error) return r.error
    const k = r.k!
    const row = rowIn(v, k)
    const content = row ? readBody(home, 'notes', k, v) : null
    if (!row || content === null) return fail('not_found', `Note not found in this host's copy: ${k}`)
    const updatedAt = row.m && typeof row.m.updatedAt === 'string' ? row.m.updatedAt : undefined
    const noteId = row.m && typeof row.m.id === 'string' ? row.m.id : undefined
    return ok({
      path: k.replace(/\.md$/i, ''), content, contentHash: row.h,
      ...(updatedAt ? { updatedAt } : {}), ...(noteId ? { id: noteId } : {}),
      offline: true, as_of: ageOf(home, 'notes'),
      outcome: `Read from this host's copy of the notes (as of ${ageOf(home, 'notes')}). ${why}`,
      next: 'A note_write or note_edit needs the Walnut server; keep contentHash for it.',
    })
  }

  /** The server's search exclusions (`search.excluded_folders`): folders, as the server reads them. */
  function excluded(k: string, folders: string[] | undefined): boolean {
    if (!folders || folders.length === 0) return false
    for (const raw of folders) {
      const f = raw.split('\\').join('/').replace(/^\/+|\/+$/g, '')
      if (f && (k === f || k.startsWith(`${f}/`))) return true
    }
    return false
  }

  function snippetOf(body: string, token: string): string {
    const flat = body.replace(/\s+/g, ' ')
    const at = token ? flat.toLowerCase().indexOf(token) : -1
    if (at < 0) return flat.slice(0, SNIPPET * 2).trim()
    const start = Math.max(0, at - SNIPPET)
    return `${start > 0 ? '...' : ''}${flat.slice(start, at + token.length + SNIPPET).trim()}${at + token.length + SNIPPET < flat.length ? '...' : ''}`
  }

  function noteSearch(home: string, args: Record<string, unknown>, why: string): GatewayResult {
    const q = str(args.q)
    if (!q) return fail('bad_request', 'q is required')
    const limit = Math.min(MAX_LIMIT, Math.max(1, typeof args.limit === 'number' && Number.isFinite(args.limit) ? Math.floor(args.limit) : DEFAULT_LIMIT))
    const tokens = q.toLowerCase().split(/\s+/).filter(Boolean).slice(0, MAX_TOKENS)
    const st = load(home, 'notes')
    const v = viewOf(home, 'notes')
    const phrase = q.toLowerCase()
    type Hit = { k: string; title: string; matched: number; score: number; first: string }
    const hits: Hit[] = []
    for (const k of keysOf(v)) {
      if (excluded(k, st.opts.searchExclude)) continue
      const row = rowIn(v, k)!
      const title = titleOf(k, row)
      const head = `${title}\n${k}`.toLowerCase()
      const body = (readBody(home, 'notes', k, v) ?? '').toLowerCase()
      let matched = 0
      let score = 0
      let first = ''
      for (const t of tokens) {
        const inHead = head.indexOf(t) !== -1
        const inBody = body.indexOf(t) !== -1
        if (!inHead && !inBody) continue
        matched++
        score += (inHead ? 3 : 0) + (inBody ? 1 : 0)
        if (!first && inBody) first = t
      }
      if (matched === 0) continue
      if (title.toLowerCase().indexOf(phrase) !== -1) score += 5
      else if (body.indexOf(phrase) !== -1) score += 2
      hits.push({ k, title, matched, score, first })
    }
    // Every word first, as the server's string leg does; when no note has them
    // all, the notes with the most of them.
    const best = hits.reduce((m, h) => Math.max(m, h.matched), 0)
    const kept = hits.filter((h) => h.matched === best)
    kept.sort((a, b) => b.score - a.score || a.k.localeCompare(b.k))
    const results = kept.slice(0, limit).map((h) => {
      const row = rowIn(v, h.k)!
      const noteId = row.m && typeof row.m.id === 'string' ? row.m.id : undefined
      return {
        id: noteId ?? h.k.replace(/\.md$/i, ''), path: h.k.replace(/\.md$/i, ''), title: h.title,
        snippet: snippetOf(readBody(home, 'notes', h.k, v) ?? '', h.first),
        matchType: 'exact', score: h.score,
      }
    })
    // Said only when the copy leaves notes out: a full copy answers as before.
    const partial = notesPartial(home)
    return ok({
      results, queryTokens: tokens, degraded: 'offline-keyword', offline: true, as_of: ageOf(home, 'notes'),
      ...(partial ? { partial: { why: 'not_kept_here', message: PARTIAL_SEARCH } } : {}),
      outcome: `${results.length} note${results.length === 1 ? '' : 's'} from a keyword search of this host's copy (as of ${ageOf(home, 'notes')}).${partial ? ` ${PARTIAL_SEARCH}` : ''} ${why}`,
      next: 'Read a hit with note_read, by id or path.',
    })
  }

  function jsonEntry(home: string, kind: ReplicaKind, k: string): unknown {
    const body = readBody(home, kind, k)
    if (body === null) return undefined
    try { return JSON.parse(body) } catch { return undefined }
  }

  function memoryRead(home: string, args: Record<string, unknown>, why: string): GatewayResult {
    const doc = str(args.doc)
    if (doc !== 'global' && doc !== 'user') return fail('bad_request', 'doc must be "global" or "user"')
    const memory = jsonEntry(home, 'memory', doc)
    if (memory === undefined) return fail('not_found', `${doc === 'global' ? 'MEMORY.md' : 'USER.md'} is not in this host's copy`)
    return ok({ memory, offline: true, as_of: ageOf(home, 'memory'), outcome: `Read from this host's copy of the memory (as of ${ageOf(home, 'memory')}). ${why}` })
  }

  /** MEMORY.md and USER.md of this host's copy, for the offline `search` (offline-search-core.ts). */
  function memoryDocs(home: string): Array<{ path: string; title: string; content: string }> {
    const out: Array<{ path: string; title: string; content: string }> = []
    if (!has(home, 'memory')) return out
    for (const doc of ['global', 'user']) {
      const m = jsonEntry(home, 'memory', doc) as { path?: unknown; content?: unknown } | undefined
      if (!m || typeof m.content !== 'string') continue
      const name = typeof m.path === 'string' && m.path ? m.path : doc === 'global' ? 'MEMORY.md' : 'USER.md'
      out.push({ path: name, title: name, content: m.content })
    }
    return out
  }

  function skillRead(home: string, args: Record<string, unknown>, why: string): GatewayResult {
    const dirName = str(args.dirName)
    if (!/^[A-Za-z0-9._-]+$/.test(dirName)) return fail('bad_request', 'Invalid skill name')
    const skill = jsonEntry(home, 'skills', dirName)
    if (skill === undefined) return fail('not_found', `Skill not found in this host's copy: ${dirName}`)
    return ok({ skill, offline: true, as_of: ageOf(home, 'skills'), outcome: `Read from this host's copy of the skills (as of ${ageOf(home, 'skills')}). ${why}` })
  }

  /** A read op this copy answers for `home`, or null (not a replica op, or that kind is not kept here). */
  function answer(home: string, name: string, args: Record<string, unknown>, why: string): GatewayResult | null {
    const kind = READ_OPS[name]
    if (!kind) return null
    // Turned off here by the user: the leader's, never "not found" (not copied yet: null, as before).
    if (!has(home, kind)) return isOff(home, kind) ? notKept(kind === 'memory' ? 'Your memory' : `Your ${kind}`, true, kind === 'memory' ? 'is' : 'are') : null
    try {
      if (name === 'note_read') return noteRead(home, args, why)
      if (name === 'note_search') return noteSearch(home, args, why)
      if (name === 'memory_read') return memoryRead(home, args, why)
      return skillRead(home, args, why)
    } catch (err) {
      deps.log('error', 'host replica: read failed', { op: name, error: (err as Error).message })
      return fail('internal', `host copy error: ${(err as Error).message}`)
    }
  }

  /** The read ops this host answers for `home` (for tools.list). */
  function ops(home: string): Array<{ name: string; title: string; description: string; readonly: boolean; signature: string }> {
    return OPS.filter((o) => has(home, o.kind)).map(({ kind: _kind, ...o }) => o)
  }

  // ── reads for the replica server (docs/plan/walnut-replica-servers-impl.md WP6,
  // 'replica-reads-v1'): the follower of `home` reads this copy instead of a
  // second vault on the host. The daemon checks whose follower asks
  // (follower-reads-core.ts); these only read.

  const manifestMemo = new Map<string, { sig: string; hash: string }>()

  /** One hash over the manifest (every key, body hash and metadata, in key order). */
  function manifestHash(home: string, kind: ReplicaKind, v: View = viewOf(home, kind)): string {
    const st = load(home, kind)
    const overlaid = !!v.ov
    const keys = keysOf(v)
    const sig = `${st.asOf}:${st.pendingAsOf}:${keys.length}:${Object.keys(st.pending).length}`
    const memo = manifestMemo.get(stateKey(home, kind))
    // An away write moves the view without moving the index: never the memo then.
    if (!overlaid && memo && memo.sig === sig) return memo.hash
    keys.sort()
    const hash = deps.hash(keys.map((k) => { const row = rowIn(v, k)!; return `${k}\u0000${row.h}\u0000${row.m ? JSON.stringify(row.m) : ''}` }).join('\n'))
    if (!overlaid) manifestMemo.set(stateKey(home, kind), { sig, hash })
    return hash
  }

  /** A body without growing the search cache (a whole-vault read would hold every note). */
  function peekBody(home: string, kind: ReplicaKind, k: string, v: View = viewOf(home, kind)): string | null {
    const row = rowIn(v, k)
    if (!row) return null
    if (row.body !== undefined) return row.body
    const cached = bodies.get(stateKey(home, kind))?.get(k)
    if (cached !== undefined) return cached
    try { return fs.readFileSync(bodyFile(home, kind, row.f), 'utf8') } catch { return null }
  }

  /**
   * The manifest as this host holds it, or null for a kind it never keeps. `off`: the
   * leader turned the kind off here; `keep` (notes): what the leader leaves out of it;
   * `offKinds` (notes): the memory or skills turned off here.
   */
  function list(home: string, kind: unknown): { entries: Array<{ k: string; h: string; n?: number; m?: Record<string, unknown> }>; asOf: string | null; manifestHash: string; off?: true; keep?: { exclude: string[]; tooBig: string[] }; offKinds?: ReplicaKind[] } | null {
    if (!isKind(kind) || typeof home !== 'string' || !home) return null
    const st = load(home, kind)
    const v = viewOf(home, kind)
    const entries = keysOf(v).sort().map((k) => {
      const row = rowIn(v, k)!
      return { k, h: row.h, ...(row.n !== undefined ? { n: row.n } : {}), ...(row.m ? { m: row.m } : {}) }
    })
    const exclude = st.opts.keepExclude ?? []
    const tooBig = st.opts.tooBig ?? []
    return {
      entries, asOf: st.asOf ? new Date(st.asOf).toISOString() : null, manifestHash: manifestHash(home, kind, v),
      ...(st.off ? { off: true as const } : {}),
      ...(kind === 'notes' && (exclude.length > 0 || tooBig.length > 0) ? { keep: { exclude, tooBig } } : {}),
      // The other kinds turned off here: a search over this host's copies leaves them out.
      ...(kind === 'notes' && KINDS.some((k) => k !== 'notes' && isOff(home, k)) ? { offKinds: KINDS.filter((k) => k !== 'notes' && isOff(home, k)) } : {}),
    }
  }

  /** One entry with its body, or null (no such key in this copy). */
  function read(home: string, kind: unknown, key: unknown): { k: string; h: string; n?: number; m?: Record<string, unknown>; body: string } | null {
    if (!isKind(kind) || typeof home !== 'string' || !home || typeof key !== 'string' || !key || key.length > MAX_KEY) return null
    const v = viewOf(home, kind)
    const row = rowIn(v, key)
    const body = row ? peekBody(home, kind, key, v) : null
    if (!row || body === null) return null
    return { k: key, h: row.h, ...(row.n !== undefined ? { n: row.n } : {}), ...(row.m ? { m: row.m } : {}), body }
  }

  /** Many bodies at once, at most `maxBytes` of them; the keys past that come back in `more`. */
  function readMany(home: string, kind: unknown, keys: unknown, maxBytes: number): { files: Array<{ k: string; h: string; body: string }>; missing: string[]; more: string[] } | null {
    if (!isKind(kind) || typeof home !== 'string' || !home || !Array.isArray(keys) || keys.length > MAX_ENTRIES) return null
    const files: Array<{ k: string; h: string; body: string }> = []
    const missing: string[] = []
    const more: string[] = []
    let bytes = 0
    const v = viewOf(home, kind)
    for (const k of keys) {
      if (typeof k !== 'string') continue
      if (more.length > 0) { more.push(k); continue }
      const row = rowIn(v, k)
      const body = row ? peekBody(home, kind, k, v) : null
      if (!row || body === null) { missing.push(k); continue }
      const size = Buffer.byteLength(body) + k.length + 32
      if (files.length > 0 && bytes + size > maxBytes) { more.push(k); continue }
      bytes += size
      files.push({ k, h: row.h, body })
    }
    return { files, missing, more }
  }

  // ── the journal's side (WP11): notes written while away ──

  /** The offline host's view of its pending note writes; set once both exist. */
  function setJournalView(view: ReplicaJournalView | null): void { journalView = view }

  /** The copy's own body of a note (no away write over it): the base of the first away edit. */
  function copyBody(home: string, k: string): string | null {
    const row = load(home, 'notes').index[k]
    if (!row) return null
    try { return fs.readFileSync(bodyFile(home, 'notes', row.f), 'utf8') } catch { return null }
  }

  /** What the leader keeps from this host (folders, too large notes): writes there need the leader. */
  function notesKeep(home: string): { keepExclude: string[]; tooBig: string[] } {
    const o = load(home, 'notes').opts
    return { keepExclude: o.keepExclude ?? [], tooBig: o.tooBig ?? [] }
  }

  return {
    sync, put, drop, status, answer, ops, has, keeps, memoryDocs, READ_OPS: Object.keys(READ_OPS), list, read, readMany,
    isOff, leftOut, notesPartial, keepsNote: (home: string, k: string): boolean => !noteLeftOut(home, k),
    manifestHash: (home: string, kind: ReplicaKind) => manifestHash(home, kind),
    setJournalView, copyBody, notesKeep, peekNote: (home: string, k: string) => peekBody(home, 'notes', k), noteRow: (home: string, k: string): { h: string; n?: number; m?: Record<string, unknown> } | null => rowIn(viewOf(home, 'notes'), k) ?? null,
    hashOf: (body: string) => deps.hash(body),
  }
}

export type HostReplica = ReturnType<typeof createHostReplica>
