/**
 * The credential of a host's local call entry ('host-call-entry-v1'): a new session or plugin
 * job on a host posts its `walnut` calls to its own Walnut server over HTTP (replica/host-call-entry.ts),
 * which hands each to this daemon (`follower.gateway`). The daemon gives every caller it starts a
 * token of its own, HMAC-SHA256(daemon key, caller sid) in hex, in WALNUT_CALL_TOKEN, and checks it
 * against the sid the request line names before the line goes the gateway socket's way. So the
 * token proves what the 0600 socket proves today: the daemon started that caller.
 *
 * The key is 32 random bytes in `<daemon dir>/host-call.key`, made once (0600, O_EXCL, never
 * through a link) and kept: a daemon restart keeps every running caller's token good. A key file
 * that is not this user's private regular file is never used or replaced: no tokens then, and
 * every caller uses the socket as before.
 *
 * Shared by both daemon twins (daemon-source.ts inlines it by `toString()`): self-contained, no
 * imports at runtime, nothing at module scope that the factory references.
 */

export interface HostCallTokenDeps {
  fs: typeof import('node:fs')
  path: typeof import('node:path')
  crypto: typeof import('node:crypto')
  /** The daemon's own dir, where the key file lives. */
  dir: string
  /** This process's uid (null where there is none): the key file must be its. */
  uid: number | null
  log?: (level: 'info' | 'warn', msg: string, data?: Record<string, unknown>) => void
}

export function createHostCallTokens(deps: HostCallTokenDeps) {
  const { fs, path, crypto } = deps
  const KEY_FILE = 'host-call.key'
  const KEY_HEX = /^[0-9a-f]{64}$/
  const TOKEN_HEX = /^[0-9a-f]{64}$/
  let key: Buffer | null = null
  /** A key file that could not be used: not tried again in this process. */
  let refused = false

  function file(): string {
    return path.join(deps.dir, KEY_FILE)
  }

  function readKey(): Buffer | null {
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
    let fd: number
    try { fd = fs.openSync(file(), flags) } catch (err) {
      if ((err as { code?: string }).code === 'ENOENT') return null
      throw err
    }
    try {
      const st = fs.fstatSync(fd)
      if (!st.isFile() || (deps.uid !== null && st.uid !== deps.uid) || (st.mode & 0o077) !== 0) {
        throw new Error('the key file is not this user\'s private file')
      }
      const text = String(fs.readFileSync(fd, 'utf8')).trim()
      if (!KEY_HEX.test(text)) throw new Error('the key file holds no key')
      return Buffer.from(text, 'hex')
    } finally {
      fs.closeSync(fd)
    }
  }

  function makeKey(): Buffer | null {
    const fresh = crypto.randomBytes(32)
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0)
    let fd: number
    try { fd = fs.openSync(file(), flags, 0o600) } catch (err) {
      // Another start made it a moment ago: that one is the key.
      if ((err as { code?: string }).code === 'EEXIST') return readKey()
      throw err
    }
    try {
      fs.writeSync(fd, fresh.toString('hex') + '\n')
      try { fs.fsyncSync(fd) } catch { /* best effort */ }
    } finally {
      fs.closeSync(fd)
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

  /** The token of caller `sid`, or null without a key. */
  function tokenFor(sid: string): string | null {
    if (typeof sid !== 'string' || !sid) return null
    const k = keyNow()
    if (!k) return null
    return crypto.createHmac('sha256', k).update(sid, 'utf8').digest('hex')
  }

  /** Whether `token` is caller `sid`'s (constant time over the token's bytes). */
  function verify(sid: unknown, token: unknown): boolean {
    if (typeof sid !== 'string' || !sid || typeof token !== 'string' || !TOKEN_HEX.test(token)) return false
    const want = tokenFor(sid)
    if (!want) return false
    return crypto.timingSafeEqual(Buffer.from(want, 'hex'), Buffer.from(token, 'hex'))
  }

  return { tokenFor, verify, file }
}

export type HostCallTokens = ReturnType<typeof createHostCallTokens>
