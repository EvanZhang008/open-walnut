/**
 * A replica's copy of the pictures and files in a Walnut's notes (capability
 * 'attachment-copy-v1'). ONE implementation for every replica: each host daemon
 * (both twins) and the cloud companion (core/companion-attachment-copy.ts) keep
 * the same copy the same way. The leader's side is core/attachment-replica.ts.
 *
 *   rounds   the leader sends a manifest (vault path, sha256, size) with
 *            `attachments.sync`; this side answers the paths whose bytes it lacks,
 *            and the leader sends those in chunks of at most 2 MB (`attachments.put`),
 *            so a damaged one costs one retry and a broken upload resumes where
 *            `have` says it stopped. Bytes are stored once per hash: a file moved or
 *            copied in the vault is never sent again. Every finished file is checked
 *            against its sha256 before it is kept.
 *   held     once a whole manifest arrived. A changed file keeps its old bytes until
 *            the new ones arrive, so a read in between answers the older picture.
 *   own      a file this replica wrote that the leader took (the companion's pasted
 *            pictures, keepOwn): kept as this side's own row until a manifest from
 *            after the ack names the path, or 10 minutes.
 *   bounds   at most 20,000 files of at most 50 MB. A manifest that removes most of a
 *            copy of 200 or more files is refused, as the notes copy refuses one.
 *
 * Layout per home (dirOf): index.json, b/<sha256> (the bytes), p/<sha256>.part.
 *
 * How the daemon twins get it: daemon-standalone.ts imports createAttachmentCopy;
 * daemon-source.ts inlines `createAttachmentCopy.toString()` through
 * `__CREATE_ATTACHMENT_COPY__`. So the factory body references NOTHING at module
 * scope; every side effect arrives through deps.
 */

import type fsType from 'node:fs'
import type pathType from 'node:path'
import type cryptoType from 'node:crypto'

export interface AttachmentCopyDeps {
  fs: typeof fsType
  path: typeof pathType
  crypto: typeof cryptoType
  /** The dir of `home`'s copy. */
  dirOf: (home: string) => string
  now?: () => number
  log: (level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) => void
}

export type AttachmentReply = Record<string, unknown> & { ok: boolean }

export function createAttachmentCopy(deps: AttachmentCopyDeps) {
  const { fs, path, crypto } = deps
  const fsp = fs.promises
  const MAX_FILES = 20_000
  const MAX_FILE_BYTES = 50 * 1024 * 1024
  /** One chunk at most, either way (a daemon frame and the companion's door both take it as base64). */
  const CHUNK_BYTES = 2 * 1024 * 1024
  const REMOVAL_FLOOR = 200
  const OWN_AWAIT_MS = 10 * 60_000
  const HASH_RE = /^[0-9a-f]{64}$/
  const now = deps.now || (() => Date.now())

  interface Row {
    /** sha256 of the bytes this copy has for the path ('' while none arrived yet). */
    h: string
    n: number
    /** The bytes the last manifest named, while they are on their way. */
    want?: string
    wantN?: number
    /** A file this replica wrote that the leader took: the leader's clock at its ack, this side's then. */
    own?: { ackAt: number; at: number }
  }
  interface State {
    rows: Record<string, Row>
    /** The leader's clock at the last manifest that arrived whole, or null (never held). */
    asOf: number | null
    /** The manifest still filling in. */
    pendingAsOf: number | null
  }

  const states = new Map<string, State>()
  const indexFile = (home: string): string => path.join(deps.dirOf(home), 'index.json')
  const blobFile = (home: string, h: string): string => path.join(deps.dirOf(home), 'b', h)
  const partFile = (home: string, h: string): string => path.join(deps.dirOf(home), 'p', h + '.part')

  function load(home: string): State {
    const hit = states.get(home)
    if (hit) return hit
    const st: State = { rows: {}, asOf: null, pendingAsOf: null }
    try {
      const raw = JSON.parse(fs.readFileSync(indexFile(home), 'utf8')) as Partial<State>
      if (raw && raw.rows && typeof raw.rows === 'object') {
        st.rows = raw.rows as Record<string, Row>
        st.asOf = typeof raw.asOf === 'number' ? raw.asOf : null
        st.pendingAsOf = typeof raw.pendingAsOf === 'number' ? raw.pendingAsOf : null
      }
    } catch { /* no copy yet */ }
    states.set(home, st)
    return st
  }

  async function persist(home: string, st: State): Promise<void> {
    const file = indexFile(home)
    await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
    const tmp = file + '.' + process.pid + '.tmp'
    await fsp.writeFile(tmp, JSON.stringify(st), { mode: 0o600 })
    await fsp.rename(tmp, file)
  }

  /** A vault-relative attachment path the copy may name, or null. */
  function keyOf(raw: unknown): string | null {
    if (typeof raw !== 'string' || !raw || raw.length > 1024 || /[\u0000-\u001f\u007f\\]/.test(raw)) return null
    if (raw.charAt(0) === '/' || /\.md$/i.test(raw)) return null
    if (raw.split('/').some((seg) => !seg || seg === '.' || seg === '..' || seg.charAt(0) === '.')) return null
    return raw
  }

  function blobExists(home: string, h: string): boolean {
    try { return fs.statSync(blobFile(home, h)).isFile() } catch { return false }
  }

  /** Remove the bytes of `hashes` that no row names any more. */
  async function collect(home: string, st: State, hashes: string[]): Promise<void> {
    const named = new Set<string>()
    for (const r of Object.values(st.rows)) { if (r.h) named.add(r.h); if (r.want) named.add(r.want) }
    for (const h of hashes) {
      if (!h || named.has(h)) continue
      await fsp.rm(blobFile(home, h), { force: true }).catch(() => {})
      await fsp.rm(partFile(home, h), { force: true }).catch(() => {})
    }
  }

  /** Is this side's own row still held against a manifest of `asOf` (the leader's clock)? */
  function ownHeld(row: Row, asOf: number, t: number): boolean {
    return !!row.own && asOf <= row.own.ackAt && t - row.own.at < OWN_AWAIT_MS
  }

  function refused(code: string, message: string, detail?: Record<string, unknown>): AttachmentReply {
    return { ok: false, error: code + ': ' + message, errorKind: code, ...(detail ? { detail } : {}) }
  }

  async function sync(home: string, params: Record<string, unknown>): Promise<AttachmentReply> {
    const entries = params.entries
    if (!Array.isArray(entries) || entries.length > MAX_FILES) return refused('bad_request', 'bad entries')
    const at = typeof params.asOf === 'number' && isFinite(params.asOf) ? params.asOf : now()
    const st = load(home)
    const seen = new Map<string, { h: string; n: number }>()
    for (const raw of entries as Array<{ k?: unknown; h?: unknown; n?: unknown }>) {
      const k = keyOf(raw && raw.k)
      if (!k || seen.has(k) || typeof raw.h !== 'string' || !HASH_RE.test(raw.h)) continue
      if (typeof raw.n !== 'number' || Math.floor(raw.n) !== raw.n || raw.n < 0 || raw.n > MAX_FILE_BYTES) continue
      seen.set(k, { h: raw.h, n: raw.n })
    }
    const t = now()
    // Every blob is named by a row (collect removes the rest), so a first fill of
    // 20,000 files never stats each one.
    const stored = new Set(Object.values(st.rows).map((r) => r.h).filter(Boolean))
    const removing = Object.keys(st.rows).filter((k) => !seen.has(k) && !ownHeld(st.rows[k]!, at, t))
    const local = Object.keys(st.rows).length
    if (local >= REMOVAL_FLOOR && removing.length * 2 > local) {
      deps.log('warn', 'attachments copy: a manifest that removes most of the copy was refused', { local, removing: removing.length, entries: seen.size })
      return refused('manifest_removes_most_rows', 'the manifest would remove ' + removing.length + ' of ' + local + ' files kept here', { local, removing: removing.length, entries: seen.size })
    }
    const freed: string[] = []
    for (const k of removing) { const r = st.rows[k]!; freed.push(r.h, r.want || ''); delete st.rows[k] }
    const need: string[] = []
    let held = 0
    for (const [k, e] of seen) {
      const row = st.rows[k]
      if (row && ownHeld(row, at, t) && row.h !== e.h) { held++; continue }
      if (row && row.h === e.h) {
        if (row.want) freed.push(row.want)
        st.rows[k] = { h: e.h, n: e.n }
        continue
      }
      if (stored.has(e.h)) {
        if (row) freed.push(row.h, row.want || '')
        st.rows[k] = { h: e.h, n: e.n }
        continue
      }
      if (row && row.want && row.want !== e.h) freed.push(row.want)
      // The bytes shown so far stay until the new ones arrive (put frees them then).
      st.rows[k] = { h: row ? row.h : '', n: row ? row.n : 0, want: e.h, wantN: e.n }
      need.push(k)
    }
    if (need.length === 0) { st.asOf = at; st.pendingAsOf = null } else st.pendingAsOf = at
    await persist(home, st)
    await collect(home, st, freed)
    // Where a broken upload stopped, so the leader goes on from there.
    const have: Record<string, number> = {}
    for (const k of need.slice(0, 2_000)) {
      try { const size = (await fsp.stat(partFile(home, st.rows[k]!.want!))).size; if (size > 0) have[k] = size } catch { /* none yet */ }
    }
    return { ok: true, need, have, entries: seen.size, removed: removing.length, held }
  }

  /** sha256 of a file, read in slices (a 50 MB file never blocks the loop in one call). */
  async function hashFile(file: string): Promise<string> {
    const hash = crypto.createHash('sha256')
    for await (const chunk of fs.createReadStream(file, { highWaterMark: 256 * 1024 })) hash.update(chunk as Buffer)
    return hash.digest('hex')
  }

  async function put(home: string, params: Record<string, unknown>): Promise<AttachmentReply> {
    const k = keyOf(params.k)
    const st = load(home)
    const row = k ? st.rows[k] : undefined
    if (!k || !row) return refused('not_wanted', 'no manifest names this file')
    const h = typeof params.h === 'string' ? params.h : ''
    if (row.h === h && h) return { ok: true, have: row.n, stored: true }
    if (!row.want || row.want !== h || row.wantN === undefined) return refused('not_wanted', 'the last manifest names other bytes for this file')
    const offset = typeof params.offset === 'number' && Math.floor(params.offset) === params.offset && params.offset >= 0 ? params.offset : -1
    const data = typeof params.data === 'string' ? Buffer.from(params.data, 'base64') : null
    if (offset < 0 || !data || data.length > CHUNK_BYTES || offset + data.length > row.wantN) return refused('bad_request', 'a chunk outside the file')
    const part = partFile(home, h)
    await fsp.mkdir(path.dirname(part), { recursive: true, mode: 0o700 })
    let have = 0
    try { have = (await fsp.stat(part)).size } catch { /* a first chunk */ }
    // A chunk past what arrived answers where to go on; one already here (a retry) is taken again.
    if (offset > have) return { ok: false, error: 'a chunk past the bytes that arrived', errorKind: 'offset', have }
    const fh = await fsp.open(part, have === 0 ? 'w' : 'r+', 0o600)
    try {
      await fh.write(data, 0, data.length, offset)
      await fh.truncate(offset + data.length)
    } finally {
      await fh.close()
    }
    have = offset + data.length
    if (have < row.wantN) return { ok: true, have, stored: false }
    if (await hashFile(part) !== h) {
      await fsp.rm(part, { force: true })
      return refused('hash_mismatch', 'the bytes that arrived are not the ones the manifest named')
    }
    await fsp.mkdir(path.dirname(blobFile(home, h)), { recursive: true, mode: 0o700 })
    await fsp.rename(part, blobFile(home, h))
    const old = row.h
    // Every row waiting on these bytes has them now (the same file twice in the vault).
    for (const r of Object.values(st.rows)) if (r.want === h) { r.h = h; r.n = r.wantN === undefined ? r.n : r.wantN; delete r.want; delete r.wantN }
    const remaining = Object.values(st.rows).filter((r) => r.want).length
    if (remaining === 0 && st.pendingAsOf !== null) { st.asOf = st.pendingAsOf; st.pendingAsOf = null }
    await persist(home, st)
    await collect(home, st, [old])
    return { ok: true, have, stored: true, remaining }
  }

  async function drop(home: string): Promise<AttachmentReply> {
    const existed = Object.keys(load(home).rows).length > 0
    await fsp.rm(deps.dirOf(home), { recursive: true, force: true }).catch(() => {})
    states.set(home, { rows: {}, asOf: null, pendingAsOf: null })
    if (existed) deps.log('info', 'attachments copy: removed')
    return { ok: true, dropped: existed }
  }

  function status(home: string): AttachmentReply {
    const rows = Object.values(load(home).rows)
    const at = load(home).asOf
    return {
      ok: true, entries: rows.length, pending: rows.filter((r) => r.want).length,
      bytes: rows.reduce((n, r) => n + (r.h ? r.n : 0), 0),
      asOf: at !== null ? new Date(at).toISOString() : null,
    }
  }

  /** Every change of a copy runs alone: each one reads and writes the whole index. */
  let chain: Promise<unknown> = Promise.resolve()
  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = chain.then(fn, fn)
    chain = run.catch(() => {})
    return run
  }

  /** One command of the leader's round for `home`. Never throws. */
  async function command(home: string, cmd: unknown, params: Record<string, unknown>): Promise<AttachmentReply> {
    if (typeof home !== 'string' || !home) return { ok: false, error: String(cmd) + ': missing home', errorKind: 'bad_request' }
    try {
      if (cmd === 'attachments.sync') return await serial(() => sync(home, params))
      if (cmd === 'attachments.put') return await serial(() => put(home, params))
      if (cmd === 'attachments.drop') return await serial(() => drop(home))
      if (cmd === 'attachments.status') return status(home)
      return { ok: false, error: 'unknown command', errorKind: 'bad_request' }
    } catch (err) {
      deps.log('warn', 'attachments copy: a command failed', { cmd: String(cmd), error: (err as Error).message })
      return { ok: false, error: (err as Error).message }
    }
  }

  // ── reads ──

  /** A whole manifest arrived at least once. */
  function held(home: string): boolean {
    return load(home).asOf !== null
  }

  /** The paths whose bytes this copy has, sorted. */
  function keys(home: string): string[] {
    const rows = load(home).rows
    return Object.keys(rows).filter((k) => !!rows[k]!.h).sort()
  }

  /** One path's row: its bytes' hash and size, and whether it is this side's own. */
  function row(home: string, k: string): { h: string; n: number; own: boolean } | null {
    const r = Object.prototype.hasOwnProperty.call(load(home).rows, k) ? load(home).rows[k] : undefined
    return r ? { h: r.h, n: r.n, own: !!r.own } : null
  }

  /** One file's bytes, or null (no bytes for that path, or they are missing on disk). */
  async function readFile(home: string, k: string): Promise<Buffer | null> {
    const r = row(home, k)
    if (!r || !r.h) return null
    try { return await fsp.readFile(blobFile(home, r.h)) } catch {
      deps.log('warn', 'attachments copy: a file the copy names is missing its bytes', { path: k })
      return null
    }
  }

  /**
   * The paths of the copy for a reader (the host replica's notes, follower-reads-core.ts):
   * sorted, after `after`, at most `maxBytes` of them; `next` is where the following page starts.
   */
  function list(home: string, after: unknown, maxBytes: number): { keys: string[]; asOf: string | null; next: string | null } {
    const all = keys(home)
    const from = typeof after === 'string' && after ? all.findIndex((k) => k > after) : 0
    const out: string[] = []
    let bytes = 0
    let next: string | null = null
    for (let i = from < 0 ? all.length : from; i < all.length; i++) {
      bytes += all[i]!.length + 4
      if (out.length > 0 && bytes > maxBytes) { next = out[out.length - 1]!; break }
      out.push(all[i]!)
    }
    const at = load(home).asOf
    return { keys: out, asOf: at !== null ? new Date(at).toISOString() : null, next }
  }

  /** One slice of one file, base64, for a reader that asks chunk by chunk (sync: a follower read). */
  function readChunk(home: string, k: unknown, offset: unknown, maxBytes: number): { k: string; h: string; n: number; offset: number; data: string } | null {
    const key = keyOf(k)
    const r = key ? row(home, key) : null
    if (!key || !r || !r.h) return null
    const from = typeof offset === 'number' && Math.floor(offset) === offset && offset >= 0 ? Math.min(offset, r.n) : 0
    const len = Math.min(Math.min(maxBytes, CHUNK_BYTES), r.n - from)
    let fd: number | null = null
    try {
      fd = fs.openSync(blobFile(home, r.h), 'r')
      const buf = Buffer.alloc(len)
      const got = len > 0 ? fs.readSync(fd, buf, 0, len, from) : 0
      return { k: key, h: r.h, n: r.n, offset: from, data: buf.subarray(0, got).toString('base64') }
    } catch {
      return null
    } finally {
      if (fd !== null) { try { fs.closeSync(fd) } catch { /* closed */ } }
    }
  }

  /**
   * Files this replica wrote that the leader took (its clock `ackAt` once it wrote them):
   * each is kept as this side's own until a manifest from after the ack names it.
   */
  function keepOwn(home: string, files: Array<{ k: string; bytes: Buffer }>, ackAt: number): Promise<number> {
    return serial(async () => {
      const st = load(home)
      let n = 0
      for (const f of files) {
        const k = keyOf(f.k)
        if (!k) continue
        const h = crypto.createHash('sha256').update(f.bytes).digest('hex')
        if (!blobExists(home, h)) {
          await fsp.mkdir(path.dirname(blobFile(home, h)), { recursive: true, mode: 0o700 })
          const tmp = blobFile(home, h) + '.' + process.pid + '.tmp'
          await fsp.writeFile(tmp, f.bytes, { mode: 0o600 })
          await fsp.rename(tmp, blobFile(home, h))
        }
        const prev = st.rows[k]
        st.rows[k] = { h, n: f.bytes.length, own: { ackAt, at: now() } }
        if (prev) await collect(home, st, [prev.h === h ? '' : prev.h, prev.want || ''])
        n++
      }
      if (n > 0) await persist(home, st)
      return n
    })
  }

  /** Tests: a fresh state over the files on disk. */
  function forgetState(): void {
    states.clear()
  }

  return { command, held, keys, row, readFile, list, readChunk, keepOwn, keyOf, forgetState, CHUNK_BYTES }
}

export type AttachmentCopy = ReturnType<typeof createAttachmentCopy>
