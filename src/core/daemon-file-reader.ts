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

  /** Above this size, whole-file fs.read is unsafe over the tunnel — one giant
   *  WS frame gets killed by corp SSH proxies (WSSH) mid-transfer, showing up
   *  only as a pong gap + read timeout (inc-1783532915925: 11.4MB JSONL never
   *  loaded). Chunk instead. Remote-only; the in-process local daemon has no
   *  proxy in the path. */
  private static CHUNK_THRESHOLD = 2 * 1024 * 1024
  /** Per-chunk request size for fs.readRange (well under any proxy limit). */
  private static CHUNK_SIZE = 1024 * 1024

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

    // Remote big-file path: stat first, chunk when large. stat failures
    // (old daemon without fs.stat / transient) fall through to plain fs.read —
    // no behavior regression for small files or old daemons.
    if (this.host !== '__local__') {
      try {
        const st = await this.stat(remotePath)
        if (st === null) return null // definitive ENOENT
        if (st.size > DaemonFileReader.CHUNK_THRESHOLD) {
          return await this.readFileChunked(remotePath, st.size)
        }
      } catch { /* stat unavailable — plain read below */ }
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
      }
      if (res.eof || bytesRead === 0) break
    }
    return { content: Buffer.concat(chunks).toString('utf-8'), fileSize }
  }

  private async readFileChunked(remotePath: string, size: number): Promise<string | null> {
    const result = await this.readFileRange(remotePath, 0)
    if (result === null) return null
    log.session.info('DaemonFileReader: chunked read complete', {
      host: this.host, path: remotePath, fileSize: result.fileSize, chars: result.content.length, statSize: size,
    })
    return result.content
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
   * Search for a session JSONL file under ~/.claude/projects using fs.find.
   * Returns { content, path } if found, null otherwise. Path is the full
   * remote path where the file was located (useful for caching so we don't
   * have to search again next time).
   */
  async findSession(sessionId: string): Promise<{ content: string; path: string } | null> {
    await this.resolve()
    const conn = await getDaemonConnection(this.host, this.sshTarget!)
    const result = await conn.send('fs.find', {
      path: '~/.claude/projects',
      name: sessionId + '.jsonl',
      maxDepth: 3,
    })
    if (!result.ok || !(result.files as string[])?.length) return null
    const filePath = (result.files as string[])[0]
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
      const content = await conn.send('fs.read', {
        path: remoteDirPath + '/' + f.name,
        encoding: 'utf-8',
      })
      if (content.ok && content.data) {
        result.set(f.name, content.data as string)
      }
    }

    return result
  }
}
