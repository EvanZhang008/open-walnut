/**
 * DaemonFileReader — reads remote session files via the walnut-daemon WebSocket protocol.
 *
 * Replaces RemoteFileReader (SSH-based) with daemon-based file access.
 * Uses fs.read, fs.ls, and fs.find commands instead of spawning SSH processes.
 */

import path from 'node:path'
import { log } from '../logging/index.js'
import { getDaemonConnection } from '../providers/daemon-connection.js'
import { getConfig } from './config-manager.js'
import type { SshTarget } from '../providers/session-io.js'
import type { SessionFileReader } from './session-file-reader.js'

export class DaemonFileReader implements SessionFileReader {
  private host: string
  private sshTarget: SshTarget | null = null

  constructor(host: string) {
    this.host = host
  }

  private async resolve(): Promise<void> {
    if (this.sshTarget) return
    // Local daemon: no SSH target needed. getDaemonConnection('__local__', …)
    // routes through the in-process localDaemon and ignores sshTarget entirely
    // (see DaemonConnection connect()'s __local__ branch). We still pass a dummy
    // target so the shared signature holds; it is never dereferenced for local.
    if (this.host === '__local__') {
      this.sshTarget = { hostname: '__local__' }
      return
    }
    const config = await getConfig()
    const hostDef = config.hosts?.[this.host]
    if (!hostDef) throw new Error(`Unknown host: ${this.host}`)
    const hostname = hostDef.hostname ?? (hostDef as Record<string, unknown>).ssh as string
    if (!hostname) throw new Error(`Host ${this.host} missing hostname`)
    this.sshTarget = { hostname, user: hostDef.user, port: hostDef.port }
  }

  /** Above this size, whole-file fs.read is unsafe as ONE WS frame — remote,
   *  corp SSH proxies kill giant frames mid-transfer (inc-1783532915925: 11.4MB
   *  JSONL never loaded, seen only as a pong gap + read timeout); local, the ws
   *  client's default maxPayload (100MB) hard-kills the connection outright
   *  (inc-1783842393500: 134MB JSONL → "Max payload size exceeded", daemon
   *  connection bounced on every open). Chunk instead — ALL hosts, local
   *  included. The real constraint is the WS frame size, not the proxy. */
  private static CHUNK_THRESHOLD = 2 * 1024 * 1024
  /** Per-chunk request size for fs.readRange (well under any proxy limit). */
  private static CHUNK_SIZE = 1024 * 1024

  /** Global gate on concurrent WHOLE-FILE chunked reads. A single whale JSONL
   *  (233MB observed) transiently allocates ~4× its size on the event loop
   *  (base64 chunks + Buffer.concat + utf-8 string); several in flight at once
   *  is exactly the V8 heap OOM crash loop of 2026-07-24 (7 SIGABRTs in 11min,
   *  FatalProcessOutOfMemory). Two at a time keeps the worst transient bounded
   *  while still letting a slow remote read overlap a local one. Range/tail
   *  reads are NOT gated — they're bounded by their window size. */
  private static readonly MAX_CONCURRENT_FULL_READS = 2
  private static fullReadsInFlight = 0
  private static fullReadWaiters: Array<() => void> = []

  /** Hard ceiling on the bytes ONE read may materialize as a single JS string.
   *
   *  The concurrency gate above bounds how many whales are in flight; it does NOT
   *  bound how big one may be. A single unbounded read is what drove ~3 GB RSS
   *  minutes after boot (533 reads / 9.56 GB in a day; largest file observed grew
   *  34.9 MB → 174.9 MB in two days, and these keep growing with session age).
   *
   *  Over the ceiling we REJECT rather than truncate: a silently truncated
   *  transcript parses fine and looks successful, which would corrupt history and
   *  session state in ways far harder to diagnose than a loud failure. Callers
   *  that legitimately need a big file must read a bounded window instead
   *  (readSessionHistoryTail / fetchStreamTailFold / readRangeBytes).
   *
   *  Deliberately well above the largest bounded window in the codebase (the 4 MB
   *  history tail) and well below whale territory. Override for a genuinely
   *  outsized deployment via WALNUT_MAX_FILE_READ_BYTES. */
  private static readonly DEFAULT_MAX_READ_BYTES = 32 * 1024 * 1024

  static maxReadBytes(): number {
    const raw = process.env.WALNUT_MAX_FILE_READ_BYTES
    if (raw) {
      const parsed = Number(raw)
      if (Number.isFinite(parsed) && parsed > 0) return parsed
    }
    return DaemonFileReader.DEFAULT_MAX_READ_BYTES
  }

  private static async acquireFullReadSlot(): Promise<void> {
    if (DaemonFileReader.fullReadsInFlight < DaemonFileReader.MAX_CONCURRENT_FULL_READS) {
      DaemonFileReader.fullReadsInFlight++
      return
    }
    await new Promise<void>((resolve) => DaemonFileReader.fullReadWaiters.push(resolve))
    DaemonFileReader.fullReadsInFlight++
  }

  private static releaseFullReadSlot(): void {
    DaemonFileReader.fullReadsInFlight--
    const next = DaemonFileReader.fullReadWaiters.shift()
    if (next) next()
  }

  async readFile(remotePath: string): Promise<string | null> {
    await this.resolve()
    const conn = await getDaemonConnection(this.host, this.sshTarget!)

    // Handle glob patterns by using fs.find
    if (remotePath.includes('*')) {
      const dir = path.dirname(remotePath)
      const pattern = path.basename(remotePath).replace(/\*/g, '')
      const findResult = await conn.send('fs.find', { path: dir, name: pattern, maxDepth: 2 })
      if (!findResult.ok || !(findResult.files as string[])?.length) return null
      remotePath = (findResult.files as string[])[0]
    }

    // Big-file path (ALL hosts, __local__ included): stat first, chunk when
    // large. stat failures (old daemon without fs.stat / transient) fall
    // through to plain fs.read — no behavior regression for small files or
    // old daemons.
    try {
      const st = await this.stat(remotePath)
      if (st === null) return null // definitive ENOENT
      if (st.size > DaemonFileReader.CHUNK_THRESHOLD) {
        return await this.readFileChunked(remotePath, st.size)
      }
    } catch (err) {
      // A byte-ceiling rejection MUST propagate: falling through to the plain
      // fs.read below would perform the very unbounded whole-file read the
      // ceiling exists to prevent (and blow the ws maxPayload besides).
      if (err instanceof Error && err.message.includes('byte ceiling')) throw err
      /* stat unavailable — plain read below */
    }

    const result = await conn.send('fs.read', { path: remotePath, encoding: 'utf-8' })
    if (result.ok) return result.data as string

    // Distinguish "file doesn't exist" (null) from RPC/transport failure (throw).
    // The daemon tags ENOENT in the error message (see cmdFsRead). Any other
    // failure mode means the caller should NOT fall back to glob/find, because
    // the daemon itself is unhealthy.
    const errMsg = typeof result.error === 'string' ? result.error : ''
    if (/ENOENT|no such file/i.test(errMsg)) return null
    throw new Error('fs.read transport failure: ' + (errMsg || 'unknown'))
  }

  /**
   * Write a file's UTF-8 text via the daemon's `fs.write`.
   *
   * The daemon takes base64 so the payload survives the JSON frame byte-exact
   * (a raw utf-8 string in JSON is fine for text, but base64 keeps ONE encoding
   * path for every writer — see RemoteSessionManager's image/spill uploads).
   *
   * Callers are the FileViewer's save path, which caps content at 512 KB, so no
   * chunking is needed: one frame stays far under any proxy's limit. Throws on
   * both daemon-side rejection and transport failure — a save must never report
   * success for bytes that never landed (send() RESOLVES with {ok:false} on a
   * daemon error and only throws on transport death).
   */
  async writeFile(remotePath: string, content: string): Promise<void> {
    await this.resolve()
    const conn = await getDaemonConnection(this.host, this.sshTarget!)
    const result = await conn.send('fs.write', {
      path: remotePath,
      data: Buffer.from(content, 'utf-8').toString('base64'),
      encoding: 'base64',
    })
    if (!result.ok) {
      const errMsg = typeof result.error === 'string' ? result.error : 'unknown'
      throw new Error('fs.write failed: ' + errMsg)
    }
  }

  /**
   * Read [start, EOF) of a remote file in CHUNK_SIZE fs.readRange calls.
   * Byte-exact: chunks are reassembled as bytes THEN utf-8 decoded (a range
   * boundary can split a multi-byte char). Old daemons without fs.readRange
   * throw — callers see the same transport-failure contract as fs.read.
   * `start` > 0 is the incremental turn-delta path (read only appended bytes).
   */
  async readFileRange(remotePath: string, start: number): Promise<{ content: string; fileSize: number } | null> {
    await this.resolve()
    const conn = await getDaemonConnection(this.host, this.sshTarget!)
    const chunks: Buffer[] = []
    let offset = start
    let fileSize = 0
    let totalBytes = 0
    // Ceiling is on bytes THIS call materializes, not on file size: a tail read of
    // a 200 MB file legitimately passes a large `start` and only pulls its window.
    const limit = DaemonFileReader.maxReadBytes()
    for (;;) {
      const res = await conn.send('fs.readRange', {
        path: remotePath, start: offset, length: DaemonFileReader.CHUNK_SIZE,
      })
      if (!res.ok) {
        const errMsg = typeof res.error === 'string' ? res.error : ''
        if (/ENOENT|no such file/i.test(errMsg)) return null
        throw new Error('fs.readRange transport failure: ' + (errMsg || 'unknown'))
      }
      fileSize = (res.fileSize as number) ?? fileSize
      const bytesRead = (res.bytesRead as number) ?? 0
      if (bytesRead > 0) {
        chunks.push(Buffer.from(res.data as string, 'base64'))
        offset += bytesRead
        totalBytes += bytesRead
        if (totalBytes > limit) {
          // Free the partial buffers before throwing — the whole point is to not
          // hold this much at once.
          chunks.length = 0
          log.session.warn('DaemonFileReader: read exceeded the byte ceiling — refusing', {
            host: this.host, path: remotePath, start, fileSize, limit, readSoFar: totalBytes,
          })
          throw new Error(
            `file read exceeded the ${limit}-byte ceiling (path=${remotePath}, size=${fileSize}); ` +
            'read a bounded window instead (see readSessionHistoryTail)',
          )
        }
      }
      if (res.eof || bytesRead === 0) break
    }
    // Concat then decode in one step and drop the chunk refs first, so the peak is
    // the joined buffer + the string rather than chunks + buffer + string.
    const joined = Buffer.concat(chunks)
    chunks.length = 0
    return { content: joined.toString('utf-8'), fileSize }
  }

  /**
   * Read one raw byte window [start, start+length) via fs.readRange.
   * Returns bytes UNDECODED (video/binary serving must never utf-8 decode).
   * Callers loop this primitive; length should stay ≤ CHUNK_SIZE so no single
   * WS frame can trip the corp-proxy kill described above.
   */
  async readRangeBytes(
    remotePath: string,
    start: number,
    length: number,
  ): Promise<{ buf: Buffer; fileSize: number; eof: boolean } | null> {
    await this.resolve()
    const conn = await getDaemonConnection(this.host, this.sshTarget!)
    const res = await conn.send('fs.readRange', { path: remotePath, start, length })
    if (!res.ok) {
      const errMsg = typeof res.error === 'string' ? res.error : ''
      if (/ENOENT|no such file/i.test(errMsg)) return null
      throw new Error('fs.readRange transport failure: ' + (errMsg || 'unknown'))
    }
    const bytesRead = (res.bytesRead as number) ?? 0
    return {
      buf: bytesRead > 0 ? Buffer.from(res.data as string, 'base64') : Buffer.alloc(0),
      fileSize: (res.fileSize as number) ?? 0,
      eof: Boolean(res.eof) || bytesRead === 0,
    }
  }

  private async readFileChunked(remotePath: string, size: number): Promise<string | null> {
    // Fail fast: size is already known here, so reject before spending a
    // concurrency slot and 32 MB of transfer on a read that cannot complete.
    const limit = DaemonFileReader.maxReadBytes()
    if (size > limit) {
      log.session.warn('DaemonFileReader: whole-file read exceeds the byte ceiling — refusing', {
        host: this.host, path: remotePath, fileSize: size, limit,
      })
      throw new Error(
        `file read exceeded the ${limit}-byte ceiling (path=${remotePath}, size=${size}); ` +
        'read a bounded window instead (see readSessionHistoryTail)',
      )
    }
    await DaemonFileReader.acquireFullReadSlot()
    try {
      const result = await this.readFileRange(remotePath, 0)
      if (result === null) return null
      log.session.info('DaemonFileReader: chunked read complete', {
        host: this.host, path: remotePath, fileSize: result.fileSize, chars: result.content.length, statSize: size,
      })
      return result.content
    } finally {
      DaemonFileReader.releaseFullReadSlot()
    }
  }

  /**
   * Stat a remote file via the daemon. Returns mtime/size, null if missing.
   * Throws on transport/RPC failure (caller should fall back to non-cached path).
   * Requires the daemon to implement `fs.stat` — old daemons return "unknown
   * command" which we treat as a transport failure, forcing the caller to
   * skip the cache and do a full read.
   */
  async stat(remotePath: string): Promise<{ mtimeMs: number; size: number } | null> {
    await this.resolve()
    const conn = await getDaemonConnection(this.host, this.sshTarget!)
    const result = await conn.send('fs.stat', { path: remotePath })
    if (result.ok) {
      if (!result.exists) return null
      return { mtimeMs: result.mtimeMs as number, size: result.size as number }
    }
    throw new Error('fs.stat failed: ' + (typeof result.error === 'string' ? result.error : 'unknown'))
  }

  async listDir(remotePath: string): Promise<string[]> {
    await this.resolve()
    const conn = await getDaemonConnection(this.host, this.sshTarget!)
    const result = await conn.send('fs.ls', { path: remotePath })
    return result.ok ? (result.entries as { name: string }[]).map(e => e.name) : []
  }

  /**
   * Locate a session JSONL's absolute path via fs.find WITHOUT reading it.
   * One RPC — used by callers that want to stat/range-read afterwards (e.g.
   * the session-changes incremental cache for hashed-cwd sessions, where a
   * full read just to learn the path would defeat the point).
   */
  async findSessionPath(sessionId: string): Promise<string | null> {
    await this.resolve()
    const conn = await getDaemonConnection(this.host, this.sshTarget!)
    const result = await conn.send('fs.find', {
      path: '~/.claude/projects',
      name: sessionId + '.jsonl',
      maxDepth: 3,
    })
    if (!result.ok || !(result.files as string[])?.length) return null
    return (result.files as string[])[0]
  }

  /**
   * Search for a session JSONL file under ~/.claude/projects using fs.find.
   * Returns { content, path } if found, null otherwise. Path is the full
   * remote path where the file was located (useful for caching so we don't
   * have to search again next time).
   */
  async findSession(sessionId: string): Promise<{ content: string; path: string } | null> {
    const filePath = await this.findSessionPath(sessionId)
    if (!filePath) return null
    // Read via readFile so whale files chunk through fs.readRange. This is the
    // HOT path for hashed-cwd sessions (encoded cwd >200 chars → no exactPath →
    // glob dir contains '*' → fs.find ENOENTs → findSession): the incident whale
    // (inc-1783532915925) reached its 11.4MB one-frame fs.read HERE, not in
    // readFile — chunking only there left this path un-fixed.
    const content = await this.readFile(filePath)
    return content !== null ? { content, path: filePath } : null
  }

  /**
   * Batch-read all subagent JSONL files from a remote directory.
   * Returns a Map<filename, content>.
   */
  async batchReadSubagents(remoteDirPath: string): Promise<Map<string, string>> {
    await this.resolve()
    const conn = await getDaemonConnection(this.host, this.sshTarget!)
    const result = new Map<string, string>()

    const lsResult = await conn.send('fs.ls', { path: remoteDirPath })
    if (!lsResult.ok) return result

    const files = (lsResult.entries as { name: string; type: string }[])
      .filter(e => e.type === 'file' && e.name.startsWith('agent-') && e.name.endsWith('.jsonl'))

    for (const f of files) {
      // Route through readFile so whale subagent JSONLs chunk too (observed
      // 9.9MB on inc-1783842393500's session — same one-frame fs.read class).
      try {
        const content = await this.readFile(remoteDirPath + '/' + f.name)
        if (content) result.set(f.name, content)
      } catch { /* skip unreadable file — matches old skip-on-error behavior */ }
    }

    return result
  }
}
