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
}

export interface WritePartReply { staged: number; done?: true; sha256?: string }
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

  async function writePart(cmd: Record<string, unknown>): Promise<WritePartReply> {
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

  return { writePart: writePart, reach: reach, fetch: fetch, realpath: realpath, stagingSuffix: STAGING_SUFFIX }
}
