/**
 * DaemonFileReader — reads remote session files via the walnut-daemon WebSocket protocol.
 *
 * Replaces RemoteFileReader (SSH-based) with daemon-based file access.
 * Uses fs.read, fs.ls, and fs.find commands instead of spawning SSH processes.
 */

import path from 'node:path'
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
    const content = await conn.send('fs.read', { path: filePath, encoding: 'utf-8' })
    return content.ok ? { content: content.data as string, path: filePath } : null
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
