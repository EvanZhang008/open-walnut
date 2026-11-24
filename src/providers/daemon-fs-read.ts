/**
 * The session daemon's file reads, run on this host: fs.read, fs.readImage (the one fs read
 * the cloud bridge may make), fs.readBounded, fs.readRange, fs.ls, fs.find, fs.stat,
 * fs.resolvePath ('path-resolve-v1') and fs.grep ('grep-v1'). The writes are daemon-fs-write.ts.
 *
 * Created once per runtime by createDaemonRuntime (daemon-standalone.ts), whose dispatcher
 * calls the returned commands. The code is the runtime's as it was; deps carry the runtime's
 * own names, and children start through the runtime's childUse.
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import { createFsLs } from './fs-ls-core.js'
import { resolvePathHostLocal } from './path-resolve-core.js'
import { findNameMatch, plainFindResults, restoreForRead } from './task-dir-core.js'
import { grepReferencesHostLocal } from './search-grep-core.js'
import type { ChildProcessUse } from './daemon-child-spawn.js'
import type { DaemonReplies } from './daemon-module-deps.js'

export interface DaemonFsReadDeps<W> extends DaemonReplies<W> {
  HOME_DIR: string
  /** The CLI's config home (CLAUDE_CONFIG_DIR or ~/.claude). */
  CLAUDE_CONFIG_HOME: string
  /** Where the CLI keeps transcripts: an archived one is restored before a read. */
  CLAUDE_PROJECTS_DIRS: string[]
  childUse: ChildProcessUse
}

export function createDaemonFsRead<W>(deps: DaemonFsReadDeps<W>) {
  const { HOME_DIR, CLAUDE_CONFIG_HOME, CLAUDE_PROJECTS_DIRS, childUse, sendOk, sendError } = deps

  // ── File system operations ──
  // NOTE: use fs.promises.* instead of sync calls — a large file read (e.g. a
  // 50MB session JSONL) would otherwise block every queued RPC on this daemon
  // until it completes.
  // The reply is one frame built synchronously (base64 + stringify), so a whole
  // file is refused over this size: the server's own DaemonFileReader ceiling,
  // and it reads anything bigger through fs.readRange.
  const FS_READ_MAX_BYTES = 32 * 1024 * 1024
  async function cmdFsRead(ws: W, id: number, cmd: Record<string, unknown>) {
    let filePath = cmd.path as string
    const encoding = cmd.encoding as string | undefined
    if (!filePath) return sendError(ws, id, 'fs.read: missing path')

    // Expand ~ to home directory (Node fs doesn't do shell expansion)
    if (filePath === '~' || filePath.startsWith('~/')) {
      filePath = HOME_DIR + filePath.slice(1)
    }
    // An archived session's transcript comes back plain first (transcript-archive.ts).
    await restoreForRead(filePath, CLAUDE_PROJECTS_DIRS)

    try {
      // Regular files ONLY, checked BEFORE open: open() on a FIFO with no writer
      // blocks a fs-pool thread FOREVER (2026-08-15: 14 wedged threads = every
      // local fs RPC timing out for hours). stat() never blocks on a FIFO.
      const st = await fs.promises.stat(filePath)
      if (!st.isFile()) {
        return sendError(ws, id, 'fs.read failed: not a regular file (ENOTFILE)')
      }
      if (st.size > FS_READ_MAX_BYTES) {
        return sendError(ws, id, 'fs.read failed: file is ' + st.size + ' bytes, over the '
          + FS_READ_MAX_BYTES + '-byte ceiling for one read (EFBIG)')
      }
      const enc = encoding || 'base64'
      const data = await fs.promises.readFile(filePath)
      if (enc === 'base64') {
        sendOk(ws, id, { data: data.toString('base64'), encoding: 'base64' })
      } else {
        sendOk(ws, id, { data: data.toString('utf-8'), encoding: 'utf-8' })
      }
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException
      // Tag ENOENT so the server can distinguish "file not found" from transport failure.
      const code = e.code ?? ''
      sendError(ws, id, 'fs.read failed: ' + e.message + (code ? ' (' + code + ')' : ''))
    }
  }

  // Bridge-safe image read: extension allowlist + size cap. The ONLY fs command
  // reachable from the cloud bridge (see BRIDGE_ALLOWED_COMMANDS) — phones need
  // session-referenced pictures, but a compromised cloud box must not be able to
  // read arbitrary files (keys, configs) off exec hosts.
  const IMAGE_READ_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp'])
  const IMAGE_READ_MAX_BYTES = 20 * 1024 * 1024

  // Magic-byte check: the extension gate alone would let a compromised cloud
  // box exfiltrate any file that merely ENDS in .png; requiring a real image
  // header means non-image bytes (keys, configs) never leave the host.
  function looksLikeImage(data: Buffer): boolean {
    if (data.length < 12) return false
    if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return true // PNG
    if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return true // JPEG
    if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x38) return true // GIF8
    if (data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46
      && data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50) return true // RIFF…WEBP
    return false
  }

  async function cmdFsReadImage(ws: W, id: number, cmd: Record<string, unknown>) {
    let filePath = cmd.path as string
    if (!filePath) return sendError(ws, id, 'fs.readImage: missing path')
    if (filePath === '~' || filePath.startsWith('~/')) {
      filePath = HOME_DIR + filePath.slice(1)
    }
    if (filePath.includes('..')) return sendError(ws, id, 'fs.readImage: invalid path')
    const ext = filePath.slice(filePath.lastIndexOf('.') + 1).toLowerCase()
    if (!IMAGE_READ_EXTENSIONS.has(ext)) return sendError(ws, id, 'fs.readImage: not an image (ENOTIMAGE)')

    try {
      const st = await fs.promises.stat(filePath)
      if (!st.isFile()) return sendError(ws, id, 'fs.readImage: not a file (ENOENT)')
      if (st.size > IMAGE_READ_MAX_BYTES) return sendError(ws, id, 'fs.readImage: too large (EFBIG)')
      const data = await fs.promises.readFile(filePath)
      if (!looksLikeImage(data)) return sendError(ws, id, 'fs.readImage: not an image (ENOTIMAGE)')
      sendOk(ws, id, { data: data.toString('base64'), encoding: 'base64' })
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException
      const code = e.code ?? ''
      sendError(ws, id, 'fs.readImage failed: ' + e.message + (code ? ' (' + code + ')' : ''))
    }
  }

  // Bridge-safe bounded file read: size cap + HOST-SIDE path sandbox. Serves
  // the cloud replica's phone file previews (HTML/text file-content relay).
  // Unlike fs.read (trusted SSH channel only), this is reachable from the
  // public cloud bridge, so THIS handler is the security authority — the
  // replica's own checks are a convenience, not the guarantee.
  const FS_READ_BOUNDED_MAX_BYTES = 2 * 1024 * 1024 // Whole-file reads only
  const FS_READ_BOUNDED_RANGE_BYTES = 1024 * 1024 // One media chunk per bridge frame

  function fsReadBoundedVersion(resolved: string, st: fs.Stats): string {
    return crypto.createHash('sha256').update(JSON.stringify([
      resolved, st.dev, st.ino, st.size, st.mtimeMs, st.ctimeMs,
    ])).digest('hex')
  }
  // Secret files/dirs never served over the bridge. Checked against the
  // REALPATH-resolved target so a symlink can't launder a denied path.
  const FS_READ_BOUNDED_DENIED_DIRS = ['.ssh', '.aws', '.gnupg', path.join('.config', 'walnut-secrets'),
    // Fleet secrets: this host's copies, and the Mac's master (secrets-core.ts, core/secrets/fleet-secrets.ts).
    path.join('open-walnut', 'secrets'), path.join('open-walnut', 'secrets-master')]
  const FS_READ_BOUNDED_DENIED_BASENAMES = new Set([
    '.netrc', '.npmrc', '.git-credentials', 'credentials', 'auth.json', 'bridge-tokens.json',
  ])
  const FS_READ_BOUNDED_DENIED_EXTENSIONS = new Set(['pem', 'key', 'p12', 'pfx', 'ppk', 'jks', 'keystore'])

  function fsReadBoundedDenied(resolved: string): boolean {
    const segments = resolved.split(path.sep)
    for (const dir of FS_READ_BOUNDED_DENIED_DIRS) {
      const abs = path.join(HOME_DIR, dir)
      if (resolved === abs || resolved.startsWith(abs + path.sep)) return true
      // Match consecutive segments, including multi-segment secret directories
      // in backups outside HOME. Similar prefixes and separated segments are safe.
      const denied = dir.split(path.sep)
      if (segments.some((_, index) => denied.every((part, offset) => segments[index + offset] === part))) return true
    }
    const base = path.basename(resolved)
    if (FS_READ_BOUNDED_DENIED_BASENAMES.has(base)) return true
    if (base === '.env' || base.startsWith('.env.')) return true
    if (/^id_(rsa|dsa|ecdsa|ed25519)/.test(base)) return true
    const ext = base.slice(base.lastIndexOf('.') + 1).toLowerCase()
    if (FS_READ_BOUNDED_DENIED_EXTENSIONS.has(ext)) return true
    if (/^config\.ya?ml$/.test(base)) return true
    return false
  }

  async function cmdFsReadBounded(ws: W, id: number, cmd: Record<string, unknown>) {
    let filePath = cmd.path as string
    if (!filePath || typeof filePath !== 'string') return sendError(ws, id, 'fs.readBounded: missing path')
    if (filePath === '~' || filePath.startsWith('~/')) {
      filePath = HOME_DIR + filePath.slice(1)
    }
    await restoreForRead(filePath, CLAUDE_PROJECTS_DIRS)
    if (filePath.includes('..')) return sendError(ws, id, 'fs.readBounded: invalid path (EDENIED)')
    if (!path.isAbsolute(filePath)) return sendError(ws, id, 'fs.readBounded: path must be absolute (EDENIED)')
    try {
      // realpath BEFORE the denylist: a symlink at an innocent path must not
      // serve ~/.ssh bytes. ENOENT here doubles as the not-found check.
      const resolved = await fs.promises.realpath(filePath)
      if (fsReadBoundedDenied(resolved)) {
        return sendError(ws, id, 'fs.readBounded: path not permitted (EDENIED)')
      }
      // Regular files ONLY, stat BEFORE open: open() on a FIFO with no writer
      // wedges an fs-pool thread forever (same guard as fs.read).
      const st = await fs.promises.stat(resolved)
      if (!st.isFile()) return sendError(ws, id, 'fs.readBounded: not a regular file (ENOTFILE)')
      if (cmd.range === true) {
        const { offset, length, expectedVersion } = cmd
        if (!Number.isSafeInteger(offset) || (offset as number) < 0
          || !Number.isSafeInteger(length) || (length as number) < 0
          || (length as number) > FS_READ_BOUNDED_RANGE_BYTES
          || (expectedVersion !== undefined && typeof expectedVersion !== 'string')) {
          return sendError(ws, id, 'fs.readBounded: invalid range (EINVAL)')
        }
        const version = fsReadBoundedVersion(resolved, st)
        if (expectedVersion !== undefined && expectedVersion !== version) {
          return sendError(ws, id, 'fs.readBounded: file changed (ESTALE)')
        }
        // Open only the guarded realpath, then verify the opened file and the
        // path again before releasing bytes. A replacement is never a new chunk.
        const fh = await fs.promises.open(resolved, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW)
        try {
          const opened = await fh.stat()
          if (!opened.isFile()) return sendError(ws, id, 'fs.readBounded: not a regular file (ENOTFILE)')
          if (fsReadBoundedVersion(resolved, opened) !== version) {
            return sendError(ws, id, 'fs.readBounded: file changed (ESTALE)')
          }
          const data = Buffer.alloc(Math.min(length as number, Math.max(0, st.size - (offset as number))))
          let read = 0
          while (read < data.length) {
            const { bytesRead } = await fh.read(data, read, data.length - read, (offset as number) + read)
            if (bytesRead === 0) break
            read += bytesRead
          }
          const after = await fh.stat()
          const current = await fs.promises.realpath(filePath)
          if (fsReadBoundedDenied(current)) return sendError(ws, id, 'fs.readBounded: path not permitted (EDENIED)')
          const currentStat = await fs.promises.stat(current)
          if (read !== data.length || fsReadBoundedVersion(resolved, after) !== version
            || fsReadBoundedVersion(current, currentStat) !== version) {
            return sendError(ws, id, 'fs.readBounded: file changed (ESTALE)')
          }
          sendOk(ws, id, { data: data.toString('base64'), encoding: 'base64', size: st.size,
            offset, mtimeMs: st.mtimeMs, version })
        } finally {
          await fh.close()
        }
        return
      }
      if (st.size > FS_READ_BOUNDED_MAX_BYTES) {
        return sendError(ws, id, 'fs.readBounded: too large (EFBIG)')
      }
      const data = await fs.promises.readFile(resolved)
      sendOk(ws, id, { data: data.toString('base64'), encoding: 'base64', size: data.length })
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException
      const code = e.code ?? ''
      sendError(ws, id, 'fs.readBounded failed: ' + e.message + (code ? ' (' + code + ')' : ''))
    }
  }

  // The listing itself (per-entry and whole-listing budgets, symlink following,
  // detail stats) is fs-ls-core.ts.
  const fsLs = createFsLs({
    readdir: (d) => fs.promises.readdir(d, { withFileTypes: true }),
    stat: (p) => fs.promises.stat(p),
    readlink: (p) => fs.promises.readlink(p),
  })

  async function cmdFsLs(ws: W, id: number, cmd: Record<string, unknown>) {
    let dirPath = cmd.path as string
    if (!dirPath) return sendError(ws, id, 'fs.ls: missing path')

    // Expand ~ to home directory (Node fs doesn't do shell expansion)
    if (dirPath === '~' || dirPath.startsWith('~/')) {
      dirPath = HOME_DIR + dirPath.slice(1)
    }
    // An archived session's transcript comes back plain first (transcript-archive.ts).
    await restoreForRead(dirPath, CLAUDE_PROJECTS_DIRS)

    try {
      // detail:true adds per-file size/mtimeMs (one stat per entry) — used by the
      // session-changes subagent cache to skip re-reading unchanged files. Off by
      // default so high-frequency callers (git-root walks) don't pay the stats.
      const r = await fsLs.list(dirPath, cmd.detail === true)
      // Entries that did not answer in time: the server says "listing incomplete".
      sendOk(ws, id, { entries: r.entries, resolvedPath: dirPath, ...(r.timedOut > 0 ? { partial: true, timedOut: r.timedOut } : {}) })
    } catch (err: unknown) {
      sendError(ws, id, 'fs.ls failed: ' + (err as Error).message)
    }
  }

  async function cmdFsFind(ws: W, id: number, cmd: Record<string, unknown>) {
    let basePath = (cmd.path as string) || '~/.claude/projects'
    const name = cmd.name as string
    const maxDepth = (cmd.maxDepth as number) || 3
    if (!name) return sendError(ws, id, 'fs.find: missing name')

    // The default root names the CLI's transcripts dir: walk this daemon's own
    // CLAUDE_CONFIG_DIR one too, since every CLI it spawns inherits that env and
    // writes there, while a server knows only ~/.claude. One root per real dir.
    const candidates = basePath === '~/.claude/projects' ? CLAUDE_PROJECTS_DIRS : null
    // Expand ~ to home directory
    if (basePath === '~' || basePath.startsWith('~/')) {
      basePath = HOME_DIR + basePath.slice(1)
    }
    const roots: string[] = []
    const seenRoots = new Set<string>()
    for (const root of candidates ?? [basePath]) {
      const key = await fs.promises.realpath(root).catch(() => root)
      if (!seenRoots.has(key)) { seenRoots.add(key); roots.push(root) }
    }

    try {
      const found: string[] = []
      async function walk(dir: string, depth: number) {
        if (depth > maxDepth || found.length >= 10) return
        let entries: fs.Dirent[]
        try {
          entries = await fs.promises.readdir(dir, { withFileTypes: true })
        } catch {
          return
        }
        for (const e of entries) {
          if (found.length >= 10) return
          const full = path.join(dir, e.name)
          if (e.isFile() && findNameMatch(e.name, name)) {
            found.push(full)
            if (found.length >= 10) return
          } else if (e.isDirectory()) {
            await walk(full, depth + 1)
          }
        }
      }
      for (const root of roots) await walk(root, 0)
      // A `<sid>.jsonl` find also matches an archived `<sid>.jsonl.gz`, or the manifest of one kept
      // only in remote storage: answer it restored, as its plain path.
      sendOk(ws, id, { files: await plainFindResults(found, name) })
    } catch (err: unknown) {
      sendError(ws, id, 'fs.find failed: ' + (err as Error).message)
    }
  }

  async function cmdFsStat(ws: W, id: number, cmd: Record<string, unknown>) {
    let filePath = cmd.path as string
    if (!filePath) return sendError(ws, id, 'fs.stat: missing path')

    if (filePath === '~' || filePath.startsWith('~/')) {
      filePath = HOME_DIR + filePath.slice(1)
    }
    // An archived session's transcript comes back plain first (transcript-archive.ts).
    await restoreForRead(filePath, CLAUDE_PROJECTS_DIRS)

    try {
      const st = await fs.promises.stat(filePath)
      // dev/ino/birthtimeMs let walnut compute the stream-file epoch
      // (dev:ino:birthtimeMs) for a file it only sees through this RPC —
      // required to durably reset a consumedOffset watermark that belongs to a
      // dead file incarnation (incident inc-1786428350008: a 37.9 MB legacy-path
      // watermark suppressed every result in the 6 MB successor file).
      sendOk(ws, id, {
        exists: true, mtimeMs: st.mtimeMs, size: st.size,
        dev: st.dev, ino: st.ino, birthtimeMs: st.birthtimeMs,
      })
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException
      if (e.code === 'ENOENT') {
        sendOk(ws, id, { exists: false })
        return
      }
      sendError(ws, id, 'fs.stat failed: ' + e.message)
    }
  }

  /**
   * Resolve "whatever the model wrote" to a real path ON THIS HOST — capability
   * 'path-resolve-v1'.
   *
   * The design-principle path (AGENTS.md): the whole layered search (transcript
   * scan, ancestor walk, git index, pruned find) touches only files on this host,
   * so it runs HERE and one small answer crosses the tunnel. The server's old
   * version did the same search over RPC and needed ~2 round trips per ancestor
   * level (~18 on a deep path), which routinely blew its own time budget and fell
   * back to a path that did not exist.
   */
  async function cmdFsResolvePath(ws: W, id: number, cmd: Record<string, unknown>) {
    const ref = cmd.ref as string
    if (!ref || typeof ref !== 'string') return sendError(ws, id, 'fs.resolvePath: missing ref')
    try {
      const result = await resolvePathHostLocal({
        ref,
        cwd: typeof cmd.cwd === 'string' && cmd.cwd ? cmd.cwd : undefined,
        sessionId: typeof cmd.sessionId === 'string' && cmd.sessionId ? cmd.sessionId : undefined,
        claudeHome: CLAUDE_CONFIG_HOME,
        homeDir: HOME_DIR,
        budgetMs: typeof cmd.budgetMs === 'number' ? cmd.budgetMs : undefined,
        childProcess: childUse,
      })
      sendOk(ws, id, result as unknown as Record<string, unknown>)
    } catch (err: unknown) {
      sendError(ws, id, 'fs.resolvePath failed: ' + (err as Error).message)
    }
  }

  /**
   * Find every mention of a symbol in the tree that owns a file — capability
   * 'grep-v1'. Same host-local rule as fs.resolvePath: git/grep run next to the
   * files and only the small match list crosses the tunnel.
   */
  async function cmdFsGrep(ws: W, id: number, cmd: Record<string, unknown>) {
    const file = cmd.file as string
    const symbol = cmd.symbol as string
    if (!file || typeof file !== 'string') return sendError(ws, id, 'fs.grep: missing file')
    if (!symbol || typeof symbol !== 'string') return sendError(ws, id, 'fs.grep: missing symbol')
    try {
      const result = await grepReferencesHostLocal({
        file,
        symbol,
        maxMatches: typeof cmd.maxMatches === 'number' ? cmd.maxMatches : undefined,
        budgetMs: typeof cmd.budgetMs === 'number' ? cmd.budgetMs : undefined,
        childProcess: childUse,
      })
      sendOk(ws, id, result as unknown as Record<string, unknown>)
    } catch (err: unknown) {
      sendError(ws, id, 'fs.grep failed: ' + (err as Error).message)
    }
  }

  /** fs-read-range-gz-v1: a range shorter than this goes plain (gzip would save little). */
  const RANGE_GZ_MIN_BYTES = 16 * 1024
  /** The range gzipped at level 1 (fast; a JSONL packs 2 to 4 times), or null when gzip failed. */
  function gzipRange(bytes: Buffer): Promise<Buffer | null> {
    return new Promise((resolve) => zlib.gzip(bytes, { level: 1 }, (err, out) => resolve(err ? null : out)))
  }

  // Byte-range read for LARGE files. A whole-file fs.read of a multi-MB session
  // JSONL serializes into ONE giant WS frame; some corporate SSH proxies kill the
  // tunnel mid-frame, the client sees only a pong gap, and the read times out
  // forever (inc-1783532915925: 11.4MB history → 30s timeout loop). Range reads
  // keep every frame small enough to survive the proxy, and double as the
  // incremental "only the appended bytes" path for turn deltas.
  // Returns base64 (byte-exact — a range can split a UTF-8 char; the CLIENT
  // reassembles bytes then decodes). eof lets the caller stop without a stat race.
  async function cmdFsReadRange(ws: W, id: number, cmd: Record<string, unknown>) {
    let filePath = cmd.path as string
    const start = typeof cmd.start === 'number' && cmd.start >= 0 ? cmd.start : 0
    const length = typeof cmd.length === 'number' && cmd.length > 0
      ? Math.min(cmd.length as number, 4 * 1024 * 1024) : 1024 * 1024
    if (!filePath) return sendError(ws, id, 'fs.readRange: missing path')

    if (filePath === '~' || filePath.startsWith('~/')) {
      filePath = HOME_DIR + filePath.slice(1)
    }
    // An archived session's transcript comes back plain first (transcript-archive.ts).
    await restoreForRead(filePath, CLAUDE_PROJECTS_DIRS)

    let fh: fs.promises.FileHandle | null = null
    try {
      // Same FIFO guard as fs.read: stat BEFORE open (see cmdFsRead).
      const pre = await fs.promises.stat(filePath)
      if (!pre.isFile()) {
        return sendError(ws, id, 'fs.readRange failed: not a regular file (ENOTFILE)')
      }
      fh = await fs.promises.open(filePath, 'r')
      const st = await fh.stat()
      if (start >= st.size) {
        sendOk(ws, id, { data: '', bytesRead: 0, fileSize: st.size, eof: true })
        return
      }
      const toRead = Math.min(length, st.size - start)
      const buf = Buffer.alloc(toRead)
      const { bytesRead } = await fh.read(buf, 0, toRead, start)
      const bytes = buf.subarray(0, bytesRead)
      // fs-read-range-gz-v1: gzipped off this loop (zlib's thread pool) when the caller asked.
      const gz = cmd.gz === true && bytesRead >= RANGE_GZ_MIN_BYTES ? await gzipRange(bytes) : null
      sendOk(ws, id, {
        ...(gz && gz.length < bytesRead ? { dataGz: gz.toString('base64') } : { data: bytes.toString('base64') }),
        bytesRead,
        fileSize: st.size,
        eof: start + bytesRead >= st.size,
      })
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException
      const code = e.code ?? ''
      sendError(ws, id, 'fs.readRange failed: ' + e.message + (code ? ' (' + code + ')' : ''))
    } finally {
      try { await fh?.close() } catch { /* already closed */ }
    }
  }

  return { cmdFsRead, cmdFsReadImage, cmdFsReadBounded, cmdFsReadRange, cmdFsLs, cmdFsFind, cmdFsStat, cmdFsResolvePath, cmdFsGrep, looksLikeImage }
}
