/**
 * The daemon's half of a host's local call entry ('host-call-entry-v1'): a new session or plugin
 * job on a host posts its `walnut` calls to its own Walnut server over a private unix socket
 * (replica/host-call-entry.ts), which hands each to this daemon (`follower.gateway`).
 *
 * Where: the follower listens at `<daemon dir>/host-call/<16 hex>.sock` (0600, in a 0700 dir: only
 * this uid can connect, as with the gateway socket) and says that path at follower.hello and in its
 * reports. `socketOf` keeps only such a path, a private socket of this uid that exists now.
 *
 * The token: every run this daemon starts (a native session's CLI, an ACP worker, a plugin job run)
 * gets a fresh random nonce recorded for its caller sid, and WALNUT_CALL_TOKEN =
 * HMAC-SHA256(key, sid + '\n' + nonce). `verify` checks a line's token against the nonce of that
 * sid's CURRENT run: the next start of the same sid (a resume, a respawn) replaces the nonce, so the
 * old run's token dies; `retire` ends it when a run ends. The nonces live beside the key in
 * `host-call-runs.json` (0600, written whole by rename), so a daemon restart keeps a live run's
 * token good. One record of runs for every kind of caller, instead of one per caller store.
 *
 * The key is 32 random bytes in `<daemon dir>/host-call.key`, made once and kept: written whole to
 * a temp file, then link()ed into place (never replaces one, so a second opener never sees it half
 * made). A key or runs file that is not this user's private regular file is never used or replaced:
 * no tokens then, and every caller uses the socket as before.
 *
 * Shared by both daemon twins (daemon-source.ts inlines it by `toString()`): self-contained, no
 * imports at runtime, nothing at module scope that the factory references.
 */

/** The follower's entry socket dir inside the daemon dir (the factory keeps its own copy; tests pin both). */
export const HOST_CALL_SOCKET_DIR = 'host-call'
/** The longest unix socket path both macOS (104) and Linux (108) take, with its NUL. */
export const HOST_CALL_SOCKET_MAX_BYTES = 103

/** The entry socket of the follower of Walnut `walnutId`, served for the daemon in `daemonDir`. */
export function hostCallSocketPath(
  pathMod: typeof import('node:path'),
  cryptoMod: typeof import('node:crypto'),
  daemonDir: string,
  walnutId: string,
): string {
  const name = cryptoMod.createHash('sha256').update(walnutId, 'utf8').digest('hex').slice(0, 16)
  return pathMod.join(pathMod.resolve(daemonDir), HOST_CALL_SOCKET_DIR, name + '.sock')
}

export interface HostCallTokenDeps {
  fs: typeof import('node:fs')
  path: typeof import('node:path')
  crypto: typeof import('node:crypto')
  /** The daemon's own dir, where the key file lives. */
  dir: string
  /** This process's uid (null where there is none): the key file must be its. */
  uid: number | null
  /** The entry socket the follower of Walnut `home` said (already checked by socketOf), if any. */
  socketFor?: (home: string) => string | undefined
  now?: () => number
  /** Runs kept (default 1024); past it the oldest go, and their callers use the socket. */
  maxRuns?: number
  log?: (level: 'info' | 'warn', msg: string, data?: Record<string, unknown>) => void
}

export function createHostCallTokens(deps: HostCallTokenDeps) {
  const { fs, path, crypto } = deps
  const KEY_FILE = 'host-call.key'
  const RUNS_FILE = 'host-call-runs.json'
  // Same values as HOST_CALL_SOCKET_DIR / HOST_CALL_SOCKET_MAX_BYTES (tests pin them).
  const SOCKET_DIR = 'host-call'
  const SOCKET_MAX_BYTES = 103
  const SOCKET_NAME = /^[0-9a-f]{16}\.sock$/
  const KEY_HEX = /^[0-9a-f]{64}$/
  const TOKEN_HEX = /^[0-9a-f]{64}$/
  const NONCE_HEX = /^[0-9a-f]{32}$/
  const MAX_RUNS = deps.maxRuns ?? 1024
  const now = deps.now ?? (() => Date.now())
  const NOFOLLOW = fs.constants.O_NOFOLLOW || 0
  let key: Buffer | null = null
  /** A key file that could not be used: not tried again in this process. */
  let refused = false
  /** The runs as last read, and the file's identity then (another daemon of this dir may write it). */
  let runs: Record<string, [string, number]> = {}
  let runsSeen = ''

  function file(): string {
    return path.join(deps.dir, KEY_FILE)
  }
  function runsFile(): string {
    return path.join(deps.dir, RUNS_FILE)
  }

  /** A private regular file of this user, read whole; null when there is none. Throws when it is not private. */
  function readPrivate(p: string): string | null {
    let fd: number
    try { fd = fs.openSync(p, fs.constants.O_RDONLY | NOFOLLOW) } catch (err) {
      if ((err as { code?: string }).code === 'ENOENT') return null
      throw err
    }
    try {
      const st = fs.fstatSync(fd)
      if (!st.isFile() || (deps.uid !== null && st.uid !== deps.uid) || (st.mode & 0o077) !== 0) {
        throw new Error('the file ' + path.basename(p) + ' is not this user\'s private file')
      }
      return String(fs.readFileSync(fd, 'utf8'))
    } finally {
      fs.closeSync(fd)
    }
  }

  /** `text` in a new private temp file beside the key; its path. */
  function writeTemp(text: string): string {
    const tmp = path.join(deps.dir, '.host-call.' + crypto.randomBytes(6).toString('hex') + '.tmp')
    const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW, 0o600)
    try {
      fs.writeSync(fd, text)
      try { fs.fsyncSync(fd) } catch { /* best effort */ }
    } finally {
      fs.closeSync(fd)
    }
    return tmp
  }

  function readKey(): Buffer | null {
    const text = readPrivate(file())
    if (text === null) return null
    if (!KEY_HEX.test(text.trim())) throw new Error('the key file holds no key')
    return Buffer.from(text.trim(), 'hex')
  }

  function makeKey(): Buffer | null {
    const fresh = crypto.randomBytes(32)
    const tmp = writeTemp(fresh.toString('hex') + '\n')
    try {
      // link() never replaces: a whole key already there (another start a moment ago) is the key.
      try { fs.linkSync(tmp, file()) } catch (err) {
        if ((err as { code?: string }).code === 'EEXIST') return readKey()
        throw err
      }
    } finally {
      try { fs.unlinkSync(tmp) } catch { /* gone */ }
    }
    deps.log?.('info', 'host call entry: made this daemon\'s token key', { file: file() })
    return fresh
  }

  /** The key, made on first use; null when it cannot be had (the entry is then off here). */
  function keyNow(): Buffer | null {
    if (key) return key
    if (refused) return null
    try {
      key = readKey() ?? makeKey()
    } catch (err) {
      refused = true
      deps.log?.('warn', 'host call entry: no token key, callers use the socket', { file: file(), error: (err as Error).message })
      return null
    }
    return key
  }

  /** The runs file as it is now (read again only when it changed). Throws when it is not private. */
  function loadRuns(): void {
    let seen = ''
    try { const st = fs.lstatSync(runsFile()); seen = st.ino + ':' + st.size + ':' + st.mtimeMs } catch { seen = 'none' }
    if (seen === runsSeen) return
    const text = seen === 'none' ? null : readPrivate(runsFile())
    const next: Record<string, [string, number]> = {}
    if (text) {
      let parsed: { runs?: Record<string, unknown> } | null = null
      try { parsed = JSON.parse(text) } catch { parsed = null }
      for (const [sid, r] of Object.entries(parsed && parsed.runs && typeof parsed.runs === 'object' ? parsed.runs : {})) {
        if (Array.isArray(r) && typeof r[0] === 'string' && NONCE_HEX.test(r[0]) && typeof r[1] === 'number') next[sid] = [r[0], r[1]]
      }
    }
    runs = next
    runsSeen = seen
  }

  function saveRuns(): void {
    const sids = Object.keys(runs)
    if (sids.length > MAX_RUNS) {
      sids.sort((a, b) => runs[a]![1] - runs[b]![1])
      for (const sid of sids.slice(0, sids.length - MAX_RUNS)) delete runs[sid]
    }
    const tmp = writeTemp(JSON.stringify({ v: 1, runs }))
    try { fs.renameSync(tmp, runsFile()) } catch (err) {
      try { fs.unlinkSync(tmp) } catch { /* gone */ }
      throw err
    }
    try { const st = fs.lstatSync(runsFile()); runsSeen = st.ino + ':' + st.size + ':' + st.mtimeMs } catch { runsSeen = '' }
  }

  function mac(k: Buffer, sid: string, nonce: string): string {
    return crypto.createHmac('sha256', k).update(sid + '\n' + nonce, 'utf8').digest('hex')
  }

  /** A new run of caller `sid`: its token, which ends the token of any run before it. Null without a key. */
  function issue(sid: string): string | null {
    if (typeof sid !== 'string' || !sid) return null
    const k = keyNow()
    if (!k) return null
    try {
      loadRuns()
      const nonce = crypto.randomBytes(16).toString('hex')
      runs[sid] = [nonce, now()]
      saveRuns()
      return mac(k, sid, nonce)
    } catch (err) {
      deps.log?.('warn', 'host call entry: the run was not recorded, its caller uses the socket', { sid, error: (err as Error).message })
      return null
    }
  }

  /** Caller `sid`'s run ended (or started with no entry): its token is good no more. */
  function retire(sid: string): void {
    if (typeof sid !== 'string' || !sid) return
    try {
      loadRuns()
      if (!Object.prototype.hasOwnProperty.call(runs, sid)) return
      delete runs[sid]
      saveRuns()
    } catch { /* an unreadable runs file takes no token anyway */ }
  }

  /** Whether `token` is the token of caller `sid`'s current run (constant time over the token's bytes). */
  function verify(sid: unknown, token: unknown): boolean {
    if (typeof sid !== 'string' || !sid || typeof token !== 'string' || !TOKEN_HEX.test(token)) return false
    const k = keyNow()
    if (!k) return false
    try { loadRuns() } catch { return false }
    const run = Object.prototype.hasOwnProperty.call(runs, sid) ? runs[sid] : undefined
    if (!run) return false
    return crypto.timingSafeEqual(Buffer.from(mac(k, sid, run[0]), 'hex'), Buffer.from(token, 'hex'))
  }

  /** A follower's entry socket, kept only as this daemon dir's entry path to a private socket of this uid. */
  function socketOf(raw: unknown): string | undefined {
    if (typeof raw !== 'string' || !raw || Buffer.byteLength(raw) > SOCKET_MAX_BYTES) return undefined
    if (!path.isAbsolute(raw) || path.normalize(raw) !== raw) return undefined
    if (path.dirname(raw) !== path.join(path.resolve(deps.dir), SOCKET_DIR) || !SOCKET_NAME.test(path.basename(raw))) return undefined
    try {
      const st = fs.lstatSync(raw)
      if (!st.isSocket() || (deps.uid !== null && st.uid !== deps.uid) || (st.mode & 0o077) !== 0) return undefined
    } catch { return undefined }
    return raw
  }

  /**
   * The entry's env for a new run of caller `sid` of Walnut `home`: its socket and a token of this
   * run, or none (no follower said a socket; any token an earlier run of `sid` had then ends too).
   */
  function envFor(home: unknown, sid: unknown): Record<string, string> {
    if (typeof sid !== 'string' || !sid) return {}
    const socket = typeof home === 'string' && home && deps.socketFor ? deps.socketFor(home) : undefined
    if (!socket) { retire(sid); return {} }
    const token = issue(sid)
    return token ? { WALNUT_CALL_SOCKET: socket, WALNUT_CALL_TOKEN: token } : {}
  }

  return { issue, retire, verify, socketOf, envFor, file }
}

export type HostCallTokens = ReturnType<typeof createHostCallTokens>
