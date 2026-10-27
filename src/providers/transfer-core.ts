/**
 * Moving files between hosts, the per-host half, shared by both daemon twins.
 *
 * - writePart ('fs-write-part-v1'): a file arrives in chunks. Each chunk is
 *   appended to a staging file next to the target (`<path>.walnut-part`), at the
 *   offset the caller names: offset 0 starts over, a chunk the staging already
 *   holds is acknowledged without writing (a retry after a lost reply), and a
 *   chunk past the end answers `gap` with `have` so the caller resumes there.
 *   The final chunk checks size and sha256, fsyncs and renames atomically; a
 *   mismatch leaves the staging file for diagnosis and never touches the target.
 * - reach / fetch ('transfer-v1'): run ON the receiving host and pull from the
 *   sending one over this host's own ssh setup. Fixed argv, never a shell, never
 *   agent forwarding, never a new key; host, user, port and paths are validated
 *   before anything runs. A fetched file lands under a temp name and is renamed
 *   only after its size and sha256 match.
 *
 * How each twin gets it: daemon-standalone.ts imports createTransferCore;
 * daemon-source.ts inlines `createTransferCore.toString()` through
 * `__CREATE_TRANSFER_CORE__`. So the factory body references NOTHING at module
 * scope (the type imports are erased), every capability comes from `deps`, and
 * it carries no backticks.
 */

import type fsType from 'node:fs'
import type pathType from 'node:path'
import type cryptoType from 'node:crypto'

export interface TransferChild {
  pid?: number
  stdout: { on(ev: string, cb: (b: Buffer) => void): void } | null
  stderr: { on(ev: string, cb: (b: Buffer) => void): void } | null
  on(ev: string, cb: (...a: never[]) => void): void
  kill(sig?: string): boolean
}

export interface TransferCoreDeps {
  fs: typeof fsType
  path: typeof pathType
  crypto: typeof cryptoType
  /** child_process.spawn */
  spawn: (cmd: string, args: string[], opts: Record<string, unknown>) => TransferChild
  /** The daemon's environment (PATH finds ssh/scp; SSH_AUTH_SOCK reaches the user's agent). */
  env: Record<string, string | undefined>
  /** What `~` means on this host (the daemon's HOME_DIR). */
  home: string
  now?: () => number
  randomId?: () => string
  /** process.getuid: who owns what a private write creates ('transfer-private-v1'). */
  getuid?: () => number
  /**
   * The raw text of this daemon's own owner stamp (`daemon.owner` in its daemon dir,
   * written by the local Walnut that spawned it): null when there is none (a daemon
   * started over ssh), undefined when one exists but is not a plain readable file.
   */
  ownerStamp?: () => string | null | undefined
  /** This daemon incarnation's id (DAEMON_INSTANCE_ID): a stamp vouches only when it names it. */
  instanceId?: string
}

/** Who sent a command, from the daemon's own socket state, never from the command. */
export interface TransferCallerCtx {
  /** The Walnut data dir bound to the socket by leader.configure / leader.claim. */
  boundHome?: string | null
  /** The socket's origin; absent = a trusted local or ssh client. */
  origin?: string | null
}

export interface WritePartReply { staged: number; done?: true; sha256?: string; path?: string }
export interface ReachReply { reachable: boolean; ms: number; error?: string }
export interface FetchFileResult { localPath: string; ok: boolean; size?: number; sha256?: string; error?: string }
export interface FetchReply { ok: boolean; results: FetchFileResult[] }
/** A refusal the twins answer as `{ok:false, error, code, ...data}`. */
export type TransferError = Error & { code: string; data?: Record<string, unknown> }

/** Self-contained factory: see the file comment before adding any reference outside it. */
export function createTransferCore(deps: TransferCoreDeps) {
  var MAX_PART_BYTES = 4 * 1024 * 1024
  var STAGING_SUFFIX = '.walnut-part'
  var MAX_FETCH_FILES = 1000
  var SAFE_HOST = /^[A-Za-z0-9._@-]+$/
  var SAFE_USER = /^[A-Za-z0-9._-]+$/
  // The remote side may hand this path to its shell (legacy scp), so only plain characters pass.
  var SAFE_REMOTE_PATH = /^(~\/|\/)[A-Za-z0-9._\/+@%,=-]*$/
  var SHA256 = /^[0-9a-f]{64}$/
  var now = deps.now || function () { return Date.now() }
  var randomId = deps.randomId || function () { return deps.crypto.randomBytes(6).toString('hex') }
  var locks = new Map<string, Promise<unknown>>()

  function fail(code: string, message: string, data?: Record<string, unknown>): TransferError {
    var e = new Error(message) as TransferError
    e.code = code
    if (data) e.data = data
    return e
  }

  /** An absolute host path from a caller, `~` expanded against this host's home. */
  function localPath(p: unknown, what: string): string {
    if (typeof p !== 'string' || !p) throw fail('bad_request', what + ' is required')
    if (p.indexOf('\u0000') >= 0) throw fail('bad_request', what + ' contains a NUL byte')
    var expanded = p === '~' || p.indexOf('~/') === 0 ? deps.home + p.slice(1) : p
    if (!deps.path.isAbsolute(expanded)) throw fail('bad_request', what + ' must be absolute or start with ~/')
    return deps.path.resolve(expanded)
  }

  function optInt(v: unknown, what: string, min: number, max: number): number | undefined {
    if (v === undefined || v === null) return undefined
    if (typeof v !== 'number' || !isFinite(v) || Math.floor(v) !== v || v < min || v > max) {
      throw fail('bad_request', what + ' must be an integer from ' + min + ' to ' + max)
    }
    return v
  }

  function optSha(v: unknown, what: string): string | undefined {
    if (v === undefined || v === null || v === '') return undefined
    var s = typeof v === 'string' ? v.toLowerCase() : ''
    if (!SHA256.test(s)) throw fail('bad_request', what + ' must be 64 hex characters')
    return s
  }

  /** One writer per key at a time: two chunks of one file never interleave. */
  function serialize<T>(key: string, work: () => Promise<T>): Promise<T> {
    var prev = locks.get(key) || Promise.resolve()
    var next = prev.then(work, work)
    var tail = next.then(function () { /* settled */ }, function () { /* settled */ })
    locks.set(key, tail)
    tail.then(function () { if (locks.get(key) === tail) locks.delete(key) })
    return next
  }

  async function sizeOf(p: string): Promise<number> {
    try { return (await deps.fs.promises.stat(p)).size } catch (_e) { return -1 }
  }

  function sha256File(p: string): Promise<string> {
    return new Promise(function (resolve, reject) {
      var h = deps.crypto.createHash('sha256')
      var s = deps.fs.createReadStream(p)
      s.on('data', function (c) { h.update(c as Buffer) })
      s.on('error', reject)
      s.on('end', function () { resolve(h.digest('hex')) })
    })
  }

  async function fsyncFile(p: string): Promise<void> {
    var fh = await deps.fs.promises.open(p, 'r+')
    try { await fh.sync() } finally { await fh.close() }
  }

  /** A retried final chunk whose rename already happened: the target is the finished file. */
  async function finishedAlready(target: string, end: number, size: number | undefined, sha: string | undefined): Promise<WritePartReply | null> {
    if (!sha || (size !== undefined && size !== end)) return null
    if (await sizeOf(target) !== end) return null
    var digest = await sha256File(target)
    return digest === sha ? { staged: end, done: true, sha256: digest } : null
  }

  function decodeBase64(data: unknown): Buffer {
    if (typeof data !== 'string') throw fail('bad_request', 'data must be base64 text')
    var clean = data.replace(/=+$/, '')
    if (/[^A-Za-z0-9+\/]/.test(clean)) throw fail('bad_request', 'data is not base64')
    var buf = Buffer.from(data, 'base64')
    if (buf.length !== Math.floor(clean.length * 3 / 4)) throw fail('bad_request', 'data is not base64')
    return buf
  }

  async function writePart(cmd: Record<string, unknown>, ctx?: TransferCallerCtx): Promise<WritePartReply> {
    if (cmd.private === true) return writePrivatePart(cmd, ctx)
    var target = localPath(cmd.path, 'path')
    var offset = optInt(cmd.offset, 'offset', 0, Number.MAX_SAFE_INTEGER)
    if (offset === undefined) throw fail('bad_request', 'offset is required')
    var buf = decodeBase64(cmd.data)
    if (buf.length > MAX_PART_BYTES) throw fail('too_large', 'a part carries at most ' + MAX_PART_BYTES + ' bytes')
    var final = cmd.final === true
    var size = optInt(cmd.size, 'size', 0, Number.MAX_SAFE_INTEGER)
    var sha = optSha(cmd.sha256, 'sha256')
    var start = offset
    var end = offset + buf.length
    if (size !== undefined && end > size) throw fail('size_mismatch', 'the part ends at ' + end + ', past the file size ' + size, { have: -1, expected: size })
    var staging = target + STAGING_SUFFIX
    return serialize(target, async function () {
      var have = await sizeOf(staging)
      if (start === 0) {
        await deps.fs.promises.mkdir(deps.path.dirname(target), { recursive: true })
        await deps.fs.promises.writeFile(staging, buf)
        have = end
      } else if (have < 0) {
        var done = final ? await finishedAlready(target, end, size, sha) : null
        if (done) return done
        throw fail('gap', 'nothing staged yet; start at offset 0', { have: 0 })
      } else if (start > have) {
        throw fail('gap', 'staged ' + have + ' bytes, the part starts at ' + start, { have: have })
      } else if (end > have) {
        // New bytes (over a torn tail when the part starts inside it): cut, then append.
        if (start < have) await deps.fs.promises.truncate(staging, start)
        await deps.fs.promises.appendFile(staging, buf)
        have = end
      }
      // else: the staging already holds this part, a retry; nothing is written.
      if (!final) return { staged: have }
      var expected = size !== undefined ? size : end
      if (have !== expected) throw fail('size_mismatch', 'staged ' + have + ' bytes, expected ' + expected, { have: have, expected: expected })
      var digest = await sha256File(staging)
      if (sha && digest !== sha) throw fail('checksum_mismatch', 'sha256 of the staged file is ' + digest + ', expected ' + sha, { have: have, sha256: digest })
      await fsyncFile(staging)
      await deps.fs.promises.rename(staging, target)
      return { staged: have, done: true, sha256: digest }
    })
  }

  // ── Session uploads ('upload-part-v1') ──
  // `upload.part` is fs.writePart for a file a person attached to a session from a
  // phone, and it is bridge-reachable, so it writes ONE shape only:
  //   <uploadsRoot>/<uploadId>/<name>
  // The root is the twin's (the task's own directory when there is one), never the
  // caller's; the id and the name are checked, never cleaned up here, so a caller
  // that got either wrong is refused instead of writing somewhere it did not name.
  var UPLOAD_ID = /^up-[A-Za-z0-9-]{8,64}$/
  var MAX_UPLOAD_BYTES = 4 * 1024 * 1024 * 1024
  var MAX_UPLOAD_NAME_BYTES = 200
  // Room left on the disk beyond the file itself, so an upload never fills it.
  var UPLOAD_DISK_MARGIN = 512 * 1024 * 1024

  function checkUploadName(name: unknown): string {
    if (typeof name !== 'string' || !name) throw fail('bad_request', 'name is required')
    if (Buffer.byteLength(name, 'utf8') > MAX_UPLOAD_NAME_BYTES) throw fail('bad_request', 'name is longer than ' + MAX_UPLOAD_NAME_BYTES + ' bytes')
    if (/[\u0000-\u001f\u007f\/\\]/.test(name)) throw fail('bad_request', 'name may not hold a slash or a control character')
    if (name.charAt(0) === '.' || name.trim() !== name) throw fail('bad_request', 'name may not start with a dot or a space')
    if (name.slice(-STAGING_SUFFIX.length) === STAGING_SUFFIX) throw fail('bad_request', 'name may not end in ' + STAGING_SUFFIX)
    return name
  }

  async function freeBytes(dir: string): Promise<number | null> {
    var statfs = (deps.fs.promises as unknown as { statfs?: (p: string) => Promise<{ bavail: number; bsize: number }> }).statfs
    if (typeof statfs !== 'function') return null
    // The nearest existing ancestor: the upload's own folder is made by its first chunk.
    var probe = dir
    for (var i = 0; i < 32; i++) {
      try {
        var s = await statfs(probe)
        return Number(s.bavail) * Number(s.bsize)
      } catch (_e) {
        var up = deps.path.dirname(probe)
        if (up === probe) return null
        probe = up
      }
    }
    return null
  }

  // The upload's declared size, written by its first chunk beside the file (a
  // dot name, which no upload name can take): every later chunk must name the
  // same size, so the free-space check made for it holds for the whole upload.
  var UPLOAD_RECORD = '.upload.json'
  // Staging files nobody touched for this long are uploads given up on.
  var UPLOAD_STALE_MS = 24 * 60 * 60 * 1000

  async function readUploadSize(dir: string): Promise<number | null> {
    try {
      var rec = JSON.parse(await deps.fs.promises.readFile(deps.path.join(dir, UPLOAD_RECORD), 'utf8'))
      return rec && typeof rec.size === 'number' ? rec.size : null
    } catch (_e) { return null }
  }

  // Best effort, never awaited by a chunk: remove uploads whose staging file has
  // not moved in a day, and their folders once empty. Finished files stay; they
  // go with the task's directory.
  async function sweepStaleUploads(root: string, keep: string): Promise<void> {
    var ids: string[]
    try { ids = await deps.fs.promises.readdir(root) } catch (_e) { return }
    for (var i = 0; i < ids.length && i < 500; i++) {
      if (ids[i] === keep || !UPLOAD_ID.test(ids[i])) continue
      var dir = deps.path.join(root, ids[i])
      try {
        var names = await deps.fs.promises.readdir(dir)
        var parts = names.filter(function (n) { return n.slice(-STAGING_SUFFIX.length) === STAGING_SUFFIX })
        var stale = 0
        for (var j = 0; j < parts.length; j++) {
          var st = await deps.fs.promises.stat(deps.path.join(dir, parts[j]))
          if (now() - st.mtimeMs > UPLOAD_STALE_MS) { await deps.fs.promises.unlink(deps.path.join(dir, parts[j])); stale++ }
        }
        if (stale > 0 && names.length === stale + (names.indexOf(UPLOAD_RECORD) >= 0 ? 1 : 0)) {
          await deps.fs.promises.rm(dir, { recursive: true, force: true })
        }
      } catch (_e) { /* the next first chunk tries again */ }
    }
  }

  async function uploadPart(cmd: Record<string, unknown>, uploadsRoot: string): Promise<WritePartReply> {
    if (typeof uploadsRoot !== 'string' || !deps.path.isAbsolute(uploadsRoot)) throw fail('unavailable', 'this host has no place for uploads')
    var uploadId = typeof cmd.uploadId === 'string' ? cmd.uploadId : ''
    if (!UPLOAD_ID.test(uploadId)) throw fail('bad_request', 'uploadId must look like up-<id>')
    var name = checkUploadName(cmd.name)
    var size = optInt(cmd.size, 'size', 0, MAX_UPLOAD_BYTES)
    if (size === undefined) throw fail('bad_request', 'size is required')
    var offset = optInt(cmd.offset, 'offset', 0, MAX_UPLOAD_BYTES)
    if (offset === undefined) throw fail('bad_request', 'offset is required')
    var dir = deps.path.join(uploadsRoot, uploadId)
    var target = deps.path.join(dir, name)
    // The part's length decides whether it is the last one, not a flag the caller
    // sets; read from the base64 text without decoding it (writePart decodes once).
    var clean = typeof cmd.data === 'string' ? cmd.data.replace(/=+$/, '') : ''
    var length = Math.floor(clean.length * 3 / 4)
    var final = offset + length === size
    var sha = optSha(cmd.sha256, 'sha256')
    // One chunk of an upload at a time, from the finished check to the reply: a
    // repeat racing the last chunk then sees the finished file, never a half
    // state (writePart serializes on the target itself, so this key differs).
    var total: number = size, at: number = offset
    return serialize('upload:' + target, function () {
      return uploadChunk(cmd, uploadsRoot, dir, target, name, total, at, final, sha)
    })
  }

  async function uploadChunk(
    cmd: Record<string, unknown>, uploadsRoot: string, dir: string, target: string, name: string,
    size: number, offset: number, final: boolean, sha: string | undefined,
  ): Promise<WritePartReply> {
    var uploadId = deps.path.basename(dir)
    // A finished upload is never written again. The repeat of its last chunk (the
    // same checksum) answers its path, so a lost reply still gets it; any earlier
    // chunk of the same size (a phone resending after it was ended mid-send)
    // answers `gap` at the end, and its empty last chunk gets the path.
    var finished = await sizeOf(target)
    if (finished >= 0) {
      if (final && sha && finished === size && await sha256File(target) === sha) {
        return { staged: size, done: true, sha256: sha, path: target }
      }
      if (!final && finished === size) throw fail('gap', 'this upload is finished; send its last chunk', { have: size })
      throw fail('bad_request', 'this upload is finished; send the file under a new upload id')
    }
    if (offset === 0) {
      void sweepStaleUploads(uploadsRoot, uploadId).catch(function () { /* best effort */ })
    } else {
      var declared = await readUploadSize(dir)
      if (declared !== null && declared !== size) throw fail('bad_request', 'this upload was started for ' + declared + ' bytes, not ' + size)
    }
    // Every chunk checks the room the rest of the file needs, so two uploads that
    // each fit alone stop with a clear answer instead of filling the disk.
    var free = await freeBytes(dir)
    if (free !== null && free < (size - offset) + UPLOAD_DISK_MARGIN) {
      throw fail('no_space', 'this host has ' + free + ' bytes free, the file needs ' + (size - offset) + ' more', { free: free })
    }
    if (offset === 0) {
      await deps.fs.promises.mkdir(dir, { recursive: true })
      await deps.fs.promises.writeFile(deps.path.join(dir, UPLOAD_RECORD), JSON.stringify({ size: size, name: name }) + '\n')
    }
    var reply: WritePartReply
    try {
      reply = await writePart({ path: target, offset: offset, data: cmd.data, size: size, final: final, sha256: sha })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOSPC') throw fail('no_space', 'this host ran out of disk space', {})
      throw err
    }
    if (reply.done) {
      await deps.fs.promises.unlink(deps.path.join(dir, UPLOAD_RECORD)).catch(function () { /* already gone */ })
      return { staged: reply.staged, done: true, sha256: reply.sha256, path: target }
    }
    return { staged: reply.staged }
  }

  // ── Private transcript stage ('transfer-private-v1') ──
  // `fs.writePart` with `private: true` writes ONE shape only:
  //   <root>/xf-<uuid>/transcript/<uuid>.jsonl
  // The root is this instance's, never the caller's: `<Walnut data dir>-transfers`
  // when this daemon's own owner stamp names THIS incarnation (its instanceId) and the
  // Walnut bound to the asking socket, `<HOME>/.open-walnut-transfers` when there is
  // no stamp; anything else (a stale stamp an earlier daemon left, an unreadable or
  // malformed one, another Walnut) refuses before any fs call.
  // An existing root is only checked, never changed; a missing one is made here
  // like the attempt dir and its transcript dir: 0700, the files 0600, each set on
  // its own fd so no umask lowers or widens them.
  // `.attempt` holds the caller's token (a retry after a lost reply proves itself
  // with it) and `.staged` the staging file's dev+ino (a file is this attempt's only
  // by that identity, never by its bytes). Writes go through one file handle, and
  // every step re-reads the chain and fails closed on any change it sees.
  // Every open of an existing name is O_NONBLOCK | O_NOCTTY | O_NOFOLLOW and its fd
  // is type-checked before any read or write, so a FIFO or a device under a record,
  // staging or target name is refused instead of blocking the daemon.
  // Once the target name is linked (nlink 2) the file is published: it is never
  // written or truncated again; a final retry may only verify it and drop the
  // staging name.
  // Not defended: a same-uid process swapping an ancestor between a check and an open.
  var XF_NAME = /^xf-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
  var SID_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/
  var ATTEMPT_TOKEN = /^[0-9a-f]{32}$/
  var REMOTE_ROOT = '.open-walnut-transfers'
  var ATTEMPT_FILE = '.attempt'
  var STAGED_FILE = '.staged'

  interface PrivatePaths { root: string; xf: string; dir: string; staging: string; target: string }
  interface FileId { dev: number; ino: number }
  type Handle = Awaited<ReturnType<typeof deps.fs.promises.open>>
  type Stat = { dev: number; ino: number; uid: number; mode: number; nlink: number; size: number; isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }

  function uid(): number { return (deps.getuid as () => number)() }
  function sameFile(a: FileId, b: FileId): boolean { return a.dev === b.dev && a.ino === b.ino }
  function permOf(st: Stat): number { return st.mode & 0o777 }

  async function lstatOrNull(p: string): Promise<Stat | null> {
    try { return await deps.fs.promises.lstat(p) as unknown as Stat } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
  }

  function privateRoot(ctx: TransferCallerCtx | undefined): string {
    if (!ctx || ctx.origin) throw fail('not_owner', 'a private write needs a trusted connection')
    var bound = typeof ctx.boundHome === 'string' ? ctx.boundHome : ''
    if (!bound || !deps.path.isAbsolute(bound)) throw fail('not_owner', 'this connection has not described its Walnut (leader.configure)')
    if (!deps.getuid || !deps.ownerStamp || typeof deps.instanceId !== 'string' || !deps.instanceId) {
      throw fail('not_supported', 'this daemon cannot write private files')
    }
    var raw = deps.ownerStamp()
    if (raw === null) return deps.path.join(deps.home, REMOTE_ROOT)
    var stamped = stampedHome(raw, deps.instanceId)
    if (stamped === null || deps.path.resolve(stamped) !== deps.path.resolve(bound)) {
      throw fail('topology_unknown', 'this daemon was not started by the Walnut on this connection')
    }
    return deps.path.resolve(bound) + '-transfers'
  }

  /** The home a stamp names, only when it is this incarnation's and well formed; else null. */
  function stampedHome(raw: string | undefined, instanceId: string): string | null {
    if (typeof raw !== 'string') return null
    var o: unknown
    try { o = JSON.parse(raw) } catch (_e) { return null }
    if (!o || typeof o !== 'object' || Array.isArray(o)) return null
    var stamp = o as { instanceId?: unknown; walnutHome?: unknown }
    if (stamp.instanceId !== instanceId) return null
    return typeof stamp.walnutHome === 'string' && deps.path.isAbsolute(stamp.walnutHome) ? stamp.walnutHome : null
  }

  /** Open flags for an existing name: never follows a link, never waits on a FIFO, never takes a tty. */
  function existingFlags(access: number): number {
    var C = deps.fs.constants
    if (typeof C.O_NONBLOCK !== 'number' || typeof C.O_NOFOLLOW !== 'number') throw fail('not_supported', 'this daemon cannot open files without blocking')
    return access | C.O_NOFOLLOW | C.O_NONBLOCK | (typeof C.O_NOCTTY === 'number' ? C.O_NOCTTY : 0)
  }

  function privatePaths(cmd: Record<string, unknown>, root: string): PrivatePaths {
    var target = localPath(cmd.path, 'path')
    var rel = deps.path.relative(root, target)
    var parts = rel.split('/')
    if (!rel || rel.indexOf('..') === 0 || deps.path.isAbsolute(rel) || parts.length !== 3
      || !XF_NAME.test(parts[0]) || parts[1] !== 'transcript' || !SID_FILE.test(parts[2])) {
      throw fail('not_private_path', 'a private write goes to <root>/xf-<uuid>/transcript/<uuid>.jsonl under ' + root)
    }
    var xf = deps.path.join(root, parts[0])
    var dir = deps.path.join(xf, 'transcript')
    return { root: root, xf: xf, dir: dir, staging: deps.path.join(dir, '.' + parts[2] + '.part'), target: target }
  }

  /** The root: a dir of this uid, not a link, not writable by group or others. Never changed. */
  function checkRoot(st: Stat | null): void {
    if (!st || st.isSymbolicLink() || !st.isDirectory() || st.uid !== uid() || (st.mode & 0o022) !== 0) {
      throw fail('root_unsafe', 'the transfers root is missing, a link, not ours, or writable by others')
    }
  }

  function checkOwnDir(st: Stat | null, what: string): void {
    if (!st || st.isSymbolicLink() || !st.isDirectory() || st.uid !== uid() || permOf(st) !== 0o700) {
      throw fail('stage_changed', what + ' is not the private dir this attempt made')
    }
  }

  async function checkChain(p: PrivatePaths): Promise<void> {
    checkRoot(await lstatOrNull(p.root))
    checkOwnDir(await lstatOrNull(p.xf), 'the attempt dir')
    checkOwnDir(await lstatOrNull(p.dir), 'the transcript dir')
  }

  /** mkdir, then set 0700 on the fd of what was just made (umask only ever removes bits). */
  async function makeOwnDir(p: string): Promise<void> {
    await deps.fs.promises.mkdir(p, { mode: 0o700 })
    var C = deps.fs.constants
    var fh = await deps.fs.promises.open(p, existingFlags(C.O_RDONLY) | C.O_DIRECTORY)
    try {
      var st = await fh.stat() as unknown as Stat
      if (!st.isDirectory() || st.uid !== uid()) throw fail('stage_changed', 'the dir just made is not ours')
      await fh.chmod(0o700)
      var after = await lstatOrNull(p)
      if (!after || !sameFile(after, st)) throw fail('stage_changed', 'the dir just made was replaced')
    } finally { await fh.close() }
  }

  /** A new file (O_EXCL, never a link) set to 0600 on its own fd; the caller closes it. */
  async function createOwnFile(p: string) {
    var C = deps.fs.constants
    var fh = await deps.fs.promises.open(p, C.O_CREAT | C.O_EXCL | C.O_RDWR | C.O_NOFOLLOW, 0o600)
    try {
      await fh.chmod(0o600)
      return fh
    } catch (err) { await fh.close(); throw err }
  }

  async function writeRecord(p: string, text: string): Promise<void> {
    var fh = await createOwnFile(p)
    try { await fh.writeFile(text); await fh.sync() } finally { await fh.close() }
  }

  /** A record this attempt wrote: a 0600 file of ours with one name, read through its fd. Null when absent. */
  async function readRecord(p: string): Promise<string | null> {
    var fh: Handle
    try { fh = await deps.fs.promises.open(p, existingFlags(deps.fs.constants.O_RDONLY)) } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw fail('stage_changed', 'an attempt record is not a plain file')
    }
    try {
      var st = await fh.stat() as unknown as Stat
      if (!st.isFile() || st.uid !== uid() || permOf(st) !== 0o600 || st.nlink !== 1 || st.size > 1024) {
        throw fail('stage_changed', 'an attempt record is not the one this attempt wrote')
      }
      return String(await fh.readFile('utf8'))
    } finally { await fh.close() }
  }

  function parseId(text: string): FileId {
    try {
      var o = JSON.parse(text) as { dev?: unknown; ino?: unknown }
      if (typeof o.dev === 'number' && typeof o.ino === 'number') return { dev: o.dev, ino: o.ino }
    } catch (_e) { /* below */ }
    throw fail('stage_changed', 'the staged-file record is unreadable')
  }

  /**
   * This attempt's dir: made here at offset 0 (dir, transcript dir, `.attempt`), or
   * found and proven by the token. Returns the staged file's recorded identity, if any.
   * Creation order, and what an interrupted daemon leaves: xf → transcript → .attempt
   * → staging → .staged. Without `.attempt` the dir proves nothing (stage_foreign);
   * a staging file without `.staged` cannot be proven ours (stage_incomplete).
   */
  async function ensureAttempt(p: PrivatePaths, token: string, start: boolean): Promise<FileId | null> {
    if (start) {
      var made = false
      try { await makeOwnDir(p.xf); made = true } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      }
      if (made) {
        await makeOwnDir(p.dir)
        await writeRecord(deps.path.join(p.xf, ATTEMPT_FILE), token + '\n')
        await checkChain(p)
        return null
      }
    } else if (!await lstatOrNull(p.xf)) {
      throw fail('gap', 'nothing staged yet; start at offset 0', { have: 0 })
    }
    await checkChain(p)
    var held = await readRecord(deps.path.join(p.xf, ATTEMPT_FILE))
    if (held === null || held.trim() !== token) throw fail('stage_foreign', 'that attempt dir belongs to another transfer')
    var staged = await readRecord(deps.path.join(p.xf, STAGED_FILE))
    return staged === null ? null : parseId(staged)
  }

  /** The staging file is the recorded one, private, under the checked chain; nlink 2 only mid-commit. */
  async function checkStaging(p: PrivatePaths, st: Stat, id: FileId): Promise<void> {
    if (!sameFile(st, id) || !st.isFile() || st.uid !== uid() || permOf(st) !== 0o600) {
      throw fail('stage_changed', 'the staged file is not the one this attempt made')
    }
    await checkChain(p)
    var named = await lstatOrNull(p.staging)
    if (!named || !sameFile(named, id)) throw fail('stage_changed', 'the staged name now points elsewhere')
    if (st.nlink === 1) return
    var linked = st.nlink === 2 ? await lstatOrNull(p.target) : null
    if (linked && sameFile(linked, id)) return
    throw fail('stage_changed', 'the staged file has a name outside this attempt')
  }

  async function writeAll(fh: { write(b: Buffer, o: number, l: number, pos: number): Promise<{ bytesWritten: number }> }, buf: Buffer, pos: number): Promise<void> {
    var off = 0
    while (off < buf.length) {
      var r = await fh.write(buf, off, buf.length - off, pos + off)
      if (!(r.bytesWritten > 0)) throw fail('write_failed', 'the write made no progress')
      off += r.bytesWritten
    }
  }

  async function sha256Fd(fh: { read(b: Buffer, o: number, l: number, pos: number): Promise<{ bytesRead: number }> }, size: number): Promise<string> {
    var h = deps.crypto.createHash('sha256')
    var chunk = Buffer.alloc(Math.min(Math.max(size, 1), 1024 * 1024))
    var pos = 0
    while (pos < size) {
      var r = await fh.read(chunk, 0, Math.min(chunk.length, size - pos), pos)
      if (!(r.bytesRead > 0)) throw fail('read_failed', 'the staged file ended early')
      h.update(chunk.subarray(0, r.bytesRead))
      pos += r.bytesRead
    }
    return h.digest('hex')
  }

  /** Name the finished file without ever replacing one, then drop the staging name. */
  async function commitLink(p: PrivatePaths, fh: { stat(): Promise<unknown> }, id: FileId): Promise<void> {
    try { await deps.fs.promises.link(p.staging, p.target) } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      var there = await lstatOrNull(p.target)
      // Linked by this attempt already (a reply lost mid-commit), or someone else's file.
      if (!there || !sameFile(there, id)) throw fail('target_exists', 'a file already has the target name')
    }
    await dropStagingName(p, fh, id)
  }

  /** The target is linked: remove the staging name, only while both names are this attempt's file. */
  async function dropStagingName(p: PrivatePaths, fh: { stat(): Promise<unknown> }, id: FileId): Promise<void> {
    var now = await fh.stat() as Stat
    var target = await lstatOrNull(p.target)
    if (now.nlink !== 2 || !sameFile(now, id) || !target || !sameFile(target, id)) {
      throw fail('stage_changed', 'the commit did not leave exactly the two names of this attempt')
    }
    var staged = await lstatOrNull(p.staging)
    if (!staged || !sameFile(staged, id)) throw fail('stage_changed', 'not removing a staged name that changed')
    await deps.fs.promises.unlink(p.staging)
    var after = await fh.stat() as Stat
    if (after.nlink !== 1) throw fail('stage_changed', 'the finished file has another name')
  }

  /** A final retry after the staging name is gone: the target counts only as this attempt's own file. */
  async function finishedPrivately(p: PrivatePaths, id: FileId, end: number, size: number | undefined, sha: string | undefined): Promise<WritePartReply> {
    var expected = size !== undefined ? size : end
    var there = await lstatOrNull(p.target)
    if (!there) throw fail('gap', 'nothing staged yet; start at offset 0', { have: 0 })
    if (!sha || !sameFile(there, id)) throw fail('target_exists', 'a file already has the target name')
    var fh: Handle
    try { fh = await deps.fs.promises.open(p.target, existingFlags(deps.fs.constants.O_RDONLY)) } catch (_e) {
      throw fail('target_exists', 'the target is not the file this attempt finished')
    }
    try {
      var st = await fh.stat() as unknown as Stat
      if (!sameFile(st, id) || !st.isFile() || st.uid !== uid() || permOf(st) !== 0o600 || st.nlink !== 1 || st.size !== expected) {
        throw fail('target_exists', 'the target is not the file this attempt finished')
      }
      var digest = await sha256Fd(fh, st.size)
      if (digest !== sha) throw fail('target_exists', 'the target is not the file this attempt finished')
      return { staged: st.size, done: true, sha256: digest, path: p.target }
    } finally { await fh.close() }
  }

  /**
   * The daemon died (or the reply was lost) between the link and the unlink: the
   * target is published. Only the final part that ends at the file's size, with the
   * same size and sha256, finishes it, read-only, by dropping the staging name.
   */
  async function finishPublished(p: PrivatePaths, fh: Handle, st: Stat, id: FileId, final: boolean, end: number, size: number | undefined, sha: string | undefined): Promise<WritePartReply> {
    if (!final) throw fail('stage_changed', 'the file is already published; only its final part can finish it')
    var expected = size !== undefined ? size : end
    if (end !== st.size || expected !== st.size) {
      throw fail('size_mismatch', 'the published file holds ' + st.size + ' bytes, this part ends at ' + end, { have: st.size, expected: expected })
    }
    if (!sha) throw fail('checksum_mismatch', 'a published file is finished only with its sha256', { have: st.size })
    var digest = await sha256Fd(fh, st.size)
    if (digest !== sha) throw fail('checksum_mismatch', 'sha256 of the published file is ' + digest + ', expected ' + sha, { have: st.size, sha256: digest })
    await dropStagingName(p, fh, id)
    return { staged: st.size, done: true, sha256: digest, path: p.target }
  }

  async function writePrivatePart(cmd: Record<string, unknown>, ctx: TransferCallerCtx | undefined): Promise<WritePartReply> {
    var p = privatePaths(cmd, privateRoot(ctx))
    var token = typeof cmd.attempt === 'string' && ATTEMPT_TOKEN.test(cmd.attempt) ? cmd.attempt : ''
    if (!token) throw fail('bad_request', 'attempt must be 32 hex characters')
    var offset = optInt(cmd.offset, 'offset', 0, Number.MAX_SAFE_INTEGER)
    if (offset === undefined) throw fail('bad_request', 'offset is required')
    var buf = decodeBase64(cmd.data)
    if (buf.length > MAX_PART_BYTES) throw fail('too_large', 'a part carries at most ' + MAX_PART_BYTES + ' bytes')
    var final = cmd.final === true
    var size = optInt(cmd.size, 'size', 0, Number.MAX_SAFE_INTEGER)
    var sha = optSha(cmd.sha256, 'sha256')
    var start = offset
    var end = offset + buf.length
    if (size !== undefined && end > size) throw fail('size_mismatch', 'the part ends at ' + end + ', past the file size ' + size, { have: -1, expected: size })
    return serialize(p.xf, async function () {
      if (start === 0 && !await lstatOrNull(p.root)) {
        try { await makeOwnDir(p.root) } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
        }
      }
      checkRoot(await lstatOrNull(p.root))
      var id = await ensureAttempt(p, token, start === 0)
      var fh: Handle
      if (!id) {
        if (start !== 0) throw fail('gap', 'nothing staged yet; start at offset 0', { have: 0 })
        if (await lstatOrNull(p.staging)) throw fail('stage_incomplete', 'a staged file exists that this attempt never recorded')
        fh = await createOwnFile(p.staging)
        var made = await fh.stat() as unknown as Stat
        id = { dev: made.dev, ino: made.ino }
        try { await writeRecord(deps.path.join(p.xf, STAGED_FILE), JSON.stringify(id)) } catch (err) { await fh.close(); throw err }
      } else if (!await lstatOrNull(p.staging)) {
        // Committed already (the staging name is gone): only a final retry finds the file.
        if (final) return finishedPrivately(p, id, end, size, sha)
        throw fail('stage_changed', 'the staged file is gone')
      } else {
        // Read-only first: a published file (nlink 2) is never opened for writing.
        var look: Handle
        try { look = await deps.fs.promises.open(p.staging, existingFlags(deps.fs.constants.O_RDONLY)) } catch (_e) {
          throw fail('stage_changed', 'the staged name is no longer a plain file')
        }
        try {
          var seen = await look.stat() as unknown as Stat
          await checkStaging(p, seen, id)
          if (seen.nlink === 2) return await finishPublished(p, look, seen, id, final, end, size, sha)
        } finally { await look.close() }
        try { fh = await deps.fs.promises.open(p.staging, existingFlags(deps.fs.constants.O_RDWR)) } catch (_e) {
          throw fail('stage_changed', 'the staged name is no longer a plain file')
        }
        var writable = await fh.stat() as unknown as Stat
        if (!sameFile(writable, id) || writable.nlink !== 1) {
          await fh.close()
          throw fail('stage_changed', 'the staged file changed while it was reopened for writing')
        }
      }
      try {
        var st = await fh.stat() as unknown as Stat
        await checkStaging(p, st, id)
        // Only an unpublished file (one name) is ever written or truncated.
        if (st.nlink !== 1) throw fail('stage_changed', 'the staged file is already published')
        var have = st.size
        if (start === 0) {
          await fh.truncate(0)
          await writeAll(fh, buf, 0)
          have = end
        } else if (start > have) {
          throw fail('gap', 'staged ' + have + ' bytes, the part starts at ' + start, { have: have })
        } else if (end > have) {
          if (start < have) await fh.truncate(start)
          await writeAll(fh, buf, start)
          have = end
        }
        // else: the staging already holds this part, a retry; nothing is written.
        await checkStaging(p, await fh.stat() as unknown as Stat, id)
        if (!final) return { staged: have }
        var expected = size !== undefined ? size : end
        if (have !== expected) throw fail('size_mismatch', 'staged ' + have + ' bytes, expected ' + expected, { have: have, expected: expected })
        var digest = await sha256Fd(fh, have)
        if (sha && digest !== sha) throw fail('checksum_mismatch', 'sha256 of the staged file is ' + digest + ', expected ' + sha, { have: have, sha256: digest })
        await fh.sync()
        await commitLink(p, fh, id)
        return { staged: have, done: true, sha256: digest, path: p.target }
      } finally { await fh.close() }
    })
  }

  /** `[user@]host` and the port flag pair, validated; never an option or a shell word. */
  function sshTarget(cmd: Record<string, unknown>, portFlag: string): { dest: string; portArgs: string[] } {
    var host = cmd.host
    if (typeof host !== 'string' || !host || !SAFE_HOST.test(host) || host.charAt(0) === '-' || host.length > 255) {
      throw fail('bad_request', 'host must be letters, digits, dot, dash, underscore or @')
    }
    var user = cmd.user
    if (user !== undefined && user !== null && user !== '') {
      if (typeof user !== 'string' || !SAFE_USER.test(user) || user.charAt(0) === '-' || user.length > 64) {
        throw fail('bad_request', 'user must be letters, digits, dot, dash or underscore')
      }
      if (host.indexOf('@') >= 0) throw fail('bad_request', 'give the user either in host or in user, not both')
    } else {
      user = ''
    }
    var port = optInt(cmd.port, 'port', 1, 65535)
    return { dest: (user ? user + '@' : '') + host, portArgs: port !== undefined ? [portFlag, String(port)] : [] }
  }

  var SSH_OPTS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'StrictHostKeyChecking=yes', '-o', 'UpdateHostKeys=no', '-o', 'ForwardAgent=no']

  function lastLine(s: string): string {
    var lines = String(s || '').split('\n').map(function (l) { return l.trim() }).filter(Boolean)
    var l = lines.length ? lines[lines.length - 1] : ''
    return l.length > 300 ? l.slice(0, 300) : l
  }

  function run(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number; stderr: string; timedOut: boolean }> {
    return new Promise(function (resolve) {
      var settled = false
      var errText = ''
      var child: TransferChild
      var finish = function (code: number, timedOut: boolean) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ code: code, stderr: errText, timedOut: timedOut })
      }
      // Settle at the deadline even when a grandchild (a ProxyCommand) still holds the pipes.
      var timer = setTimeout(function () {
        try { child.kill('SIGKILL') } catch (_e) { /* gone */ }
        finish(-1, true)
      }, timeoutMs)
      try {
        child = deps.spawn(cmd, args, { env: deps.env, stdio: ['ignore', 'ignore', 'pipe'] })
      } catch (err) {
        errText = String((err as Error).message || err)
        finish(-1, false)
        return
      }
      if (child.stderr) child.stderr.on('data', function (b: Buffer) { if (errText.length < 64 * 1024) errText += b.toString('utf8') })
      child.on('error', function (e: never) { errText = errText || String((e as unknown as Error).message || e); finish(-1, false) })
      child.on('close', function (code: never) { finish(typeof code === 'number' ? code : -1, false) })
    })
  }

  async function reach(cmd: Record<string, unknown>): Promise<ReachReply> {
    var t = sshTarget(cmd, '-p')
    var timeoutMs = optInt(cmd.timeoutMs, 'timeoutMs', 500, 120000) || 8000
    var started = now()
    var r = await run('ssh', SSH_OPTS.concat(['-o', 'ClearAllForwardings=yes'], t.portArgs, ['--', t.dest, 'true']), timeoutMs)
    var out: ReachReply = { reachable: r.code === 0, ms: now() - started }
    if (r.code !== 0) out.error = r.timedOut ? 'timed out after ' + timeoutMs + ' ms' : (lastLine(r.stderr) || 'ssh exited with code ' + r.code)
    return out
  }

  async function fetchOne(t: { dest: string; portArgs: string[] }, f: { remotePath: string; localPath: string; size?: number; sha256?: string }, deadline: number): Promise<FetchFileResult> {
    var remaining = deadline - now()
    if (remaining <= 0) return { localPath: f.localPath, ok: false, error: 'timed out before this file started' }
    await deps.fs.promises.mkdir(deps.path.dirname(f.localPath), { recursive: true })
    var tmp = f.localPath + '.walnut-fetch-' + randomId()
    var drop = async function (error: string): Promise<FetchFileResult> {
      try { await deps.fs.promises.unlink(tmp) } catch (_e) { /* never written */ }
      return { localPath: f.localPath, ok: false, error: error }
    }
    var r = await run('scp', ['-B', '-q'].concat(SSH_OPTS, t.portArgs, ['--', t.dest + ':' + f.remotePath, tmp]), remaining)
    if (r.code !== 0) return drop(r.timedOut ? 'timed out' : (lastLine(r.stderr) || 'scp exited with code ' + r.code))
    var size = await sizeOf(tmp)
    if (size < 0) return drop('scp wrote nothing')
    if (f.size !== undefined && size !== f.size) return drop('size ' + size + ', expected ' + f.size)
    var digest = await sha256File(tmp)
    if (f.sha256 && digest !== f.sha256) return drop('sha256 ' + digest + ', expected ' + f.sha256)
    await deps.fs.promises.rename(tmp, f.localPath)
    return { localPath: f.localPath, ok: true, size: size, sha256: digest }
  }

  async function fetch(cmd: Record<string, unknown>): Promise<FetchReply> {
    var t = sshTarget(cmd, '-P')
    var timeoutMs = optInt(cmd.timeoutMs, 'timeoutMs', 1000, 6 * 3600 * 1000) || 600000
    if (!Array.isArray(cmd.files) || cmd.files.length === 0) throw fail('bad_request', 'files must be a non-empty list')
    if (cmd.files.length > MAX_FETCH_FILES) throw fail('bad_request', 'at most ' + MAX_FETCH_FILES + ' files per fetch')
    var files = (cmd.files as unknown[]).map(function (raw, i) {
      var f = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
      var remote = f.remotePath
      if (typeof remote !== 'string' || !SAFE_REMOTE_PATH.test(remote) || remote.indexOf('/../') >= 0) {
        throw fail('bad_request', 'files[' + i + '].remotePath must be absolute or ~/, plain characters only')
      }
      return {
        remotePath: remote,
        localPath: localPath(f.localPath, 'files[' + i + '].localPath'),
        size: optInt(f.size, 'files[' + i + '].size', 0, Number.MAX_SAFE_INTEGER),
        sha256: optSha(f.sha256, 'files[' + i + '].sha256'),
      }
    })
    var deadline = now() + timeoutMs
    var results: FetchFileResult[] = []
    for (var i = 0; i < files.length; i++) {
      try { results.push(await fetchOne(t, files[i], deadline)) } catch (err) {
        results.push({ localPath: files[i].localPath, ok: false, error: String((err as Error).message || err) })
      }
    }
    return { ok: results.every(function (r) { return r.ok }), results: results }
  }

  /** The path as the kernel names it (symlinks resolved): what a CLI started there sees as its cwd. */
  async function realpath(cmd: Record<string, unknown>): Promise<{ path: string }> {
    var p = localPath(cmd.path, 'path')
    try {
      return { path: await deps.fs.promises.realpath(p) }
    } catch (err) {
      throw fail('not_found', String((err as Error).message || err))
    }
  }

  return { writePart: writePart, uploadPart: uploadPart, reach: reach, fetch: fetch, realpath: realpath, stagingSuffix: STAGING_SUFFIX }
}
