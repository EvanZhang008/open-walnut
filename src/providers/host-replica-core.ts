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
    st = { index: {}, pending: {}, pendingMeta: {}, asOf: 0, pendingAsOf: 0, opts: {} }
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(kindDir(home, kind), 'index.json'), 'utf8')) as Partial<KindState>
      if (raw && typeof raw.index === 'object' && raw.index) {
        st.index = raw.index as Record<string, IndexRow>
        st.asOf = typeof raw.asOf === 'number' ? raw.asOf : 0
        st.opts = raw.opts && typeof raw.opts === 'object' ? raw.opts : {}
      }
    } catch { /* no copy yet */ }
    states.set(key, st)
    return st
  }

  function persist(home: string, kind: ReplicaKind, st: KindState): void {
    try {
      writeAtomic(path.join(kindDir(home, kind), 'index.json'), JSON.stringify({ index: st.index, asOf: st.asOf, opts: st.opts }))
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
    return Object.keys(load(home, kind).index).length > 0
  }

  /** This host can answer `name` for `home` from its copy (the op is a copy read and that kind is kept). */
  function keeps(home: string, name: unknown): boolean {
    const kind = typeof name === 'string' && Object.prototype.hasOwnProperty.call(READ_OPS, name) ? READ_OPS[name] : null
    return !!kind && typeof home === 'string' && !!home && has(home, kind)
  }

  // ── the primary's side: manifest, bodies, removal ──

  function sync(home: string, kind: unknown, entries: unknown, asOf: unknown, opts?: ReplicaSyncOptions): { need: string[]; entries: number } {
    if (typeof home !== 'string' || !home) throw new Error('replica.sync: missing home')
    if (!isKind(kind)) throw new Error(`replica.sync: unknown kind ${String(kind)}`)
    if (!Array.isArray(entries) || entries.length > MAX_ENTRIES) throw new Error('replica.sync: bad entries')
    const st = load(home, kind)
    const seen = new Set<string>()
    const need: string[] = []
    st.pending = {}
    st.pendingMeta = {}
    for (const raw of entries as ReplicaEntry[]) {
      if (!raw || typeof raw.k !== 'string' || !raw.k || raw.k.length > MAX_KEY || typeof raw.h !== 'string' || !HASH_RE.test(raw.h)) continue
      if (seen.has(raw.k)) continue
      seen.add(raw.k)
      const meta = raw.m && typeof raw.m === 'object' ? raw.m : undefined
      const prev = st.index[raw.k]
      if (prev && prev.h === raw.h) {
        // Same body: only the metadata (a touched file's time) may move.
        st.index[raw.k] = { ...prev, n: raw.n, m: meta }
        continue
      }
      // A changed entry keeps its old body until the new one arrives: a read
      // in between answers the older text, with the copy's age, not "missing".
      st.pending[raw.k] = raw.h
      st.pendingMeta[raw.k] = { n: raw.n, m: meta }
      need.push(raw.k)
    }
    for (const k of Object.keys(st.index)) {
      if (seen.has(k)) continue
      try { fs.rmSync(bodyFile(home, kind, st.index[k].f), { force: true }) } catch { /* gone already */ }
      delete st.index[k]
      forget(home, kind, k)
    }
    st.opts = opts && typeof opts === 'object' ? { searchExclude: Array.isArray(opts.searchExclude) ? opts.searchExclude.filter((s) => typeof s === 'string').slice(0, 200) : undefined } : {}
    const at = typeof asOf === 'number' && Number.isFinite(asOf) ? asOf : deps.now()
    if (need.length === 0) { st.asOf = at; st.pendingAsOf = 0 } else st.pendingAsOf = at
    persist(home, kind, st)
    return { need, entries: seen.size }
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
    states.delete(stateKey(home, kind))
    bodies.delete(stateKey(home, kind))
    if (existed) deps.log('info', 'host replica: copy removed', { kind })
    return { dropped: existed }
  }

  function status(home: string): Record<string, { entries: number; pending: number; asOf: string | null }> {
    const out: Record<string, { entries: number; pending: number; asOf: string | null }> = {}
    for (const kind of KINDS) {
      const st = load(home, kind)
      out[kind] = { entries: Object.keys(st.index).length, pending: Object.keys(st.pending).length, asOf: st.asOf ? new Date(st.asOf).toISOString() : null }
    }
    return out
  }

  // ── answering reads ──

  function readBody(home: string, kind: ReplicaKind, k: string): string | null {
    const row = load(home, kind).index[k]
    if (!row) return null
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

  function resolveNote(home: string, args: Record<string, unknown>): { k?: string; error?: GatewayResult } {
    const id = str(args.id)
    const p = str(args.path)
    if (!id && !p) return { error: fail('bad_request', 'pass path (vault-relative note path) or id (from note_search)') }
    const index = load(home, 'notes').index
    const ref = id || p
    if (id || /^n_[a-z0-9]+$/i.test(p)) {
      for (const k of Object.keys(index)) if (index[k].m && index[k].m!.id === ref) return { k }
      if (id) return { error: fail('not_found', `No note with id ${ref} in this host's copy`) }
    }
    const direct = normalizeNotePath(p)
    if (index[direct]) return { k: direct }
    // A title, as online: the note whose title or file name is the text.
    const want = p.replace(/\.md$/i, '').toLowerCase()
    const hits = Object.keys(index).filter((k) => titleOf(k, index[k]).toLowerCase() === want || path.posix.basename(k).replace(/\.md$/i, '').toLowerCase() === want)
    if (hits.length === 1) return { k: hits[0] }
    if (hits.length > 1) return { error: fail('ambiguous', `"${p}" names ${hits.length} notes in this host's copy; pass the path`, { candidates: hits.slice(0, 20) }) }
    return { error: fail('not_found', `Note not found in this host's copy: ${p}`) }
  }

  function noteRead(home: string, args: Record<string, unknown>, why: string): GatewayResult {
    const r = resolveNote(home, args)
    if (r.error) return r.error
    const k = r.k!
    const row = load(home, 'notes').index[k]
    const content = readBody(home, 'notes', k)
    if (content === null) return fail('not_found', `Note not found in this host's copy: ${k}`)
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
    const phrase = q.toLowerCase()
    type Hit = { k: string; title: string; matched: number; score: number; first: string }
    const hits: Hit[] = []
    for (const k of Object.keys(st.index)) {
      if (excluded(k, st.opts.searchExclude)) continue
      const row = st.index[k]
      const title = titleOf(k, row)
      const head = `${title}\n${k}`.toLowerCase()
      const body = (readBody(home, 'notes', k) ?? '').toLowerCase()
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
      const row = st.index[h.k]
      const noteId = row.m && typeof row.m.id === 'string' ? row.m.id : undefined
      return {
        id: noteId ?? h.k.replace(/\.md$/i, ''), path: h.k.replace(/\.md$/i, ''), title: h.title,
        snippet: snippetOf(readBody(home, 'notes', h.k) ?? '', h.first),
        matchType: 'exact', score: h.score,
      }
    })
    return ok({
      results, queryTokens: tokens, degraded: 'offline-keyword', offline: true, as_of: ageOf(home, 'notes'),
      outcome: `${results.length} note${results.length === 1 ? '' : 's'} from a keyword search of this host's copy (as of ${ageOf(home, 'notes')}). ${why}`,
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
    if (!kind || !has(home, kind)) return null
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

  return { sync, put, drop, status, answer, ops, has, keeps, READ_OPS: Object.keys(READ_OPS) }
}

export type HostReplica = ReturnType<typeof createHostReplica>
