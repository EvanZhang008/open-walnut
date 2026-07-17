/**
 * ensureCwd — create the working directory before a quick-start session when
 * the user explicitly opted in ("create & start" in the path selector).
 *
 * Deliberately NOT a standalone mkdir endpoint: the mkdir happens server-side
 * inside quick-start at message-send time, so abandoning a picked path never
 * leaves an orphan directory, and failures surface synchronously in the
 * quick-start HTTP response.
 */

import fsp from 'node:fs/promises'
import os from 'node:os'
import { QuickStartError } from './quick-start.js'
import { getConfig } from '../config-manager.js'

/**
 * Create `cwd` (recursive, idempotent) on the given host.
 * Local: direct mkdir. Remote: daemon fs.mkdir RPC.
 * Throws QuickStartError(400) on failure so the route maps it 1:1.
 */
export async function ensureCwd(cwd: string, host?: string): Promise<void> {
  if (!host) {
    let expanded = cwd
    if (expanded === '~' || expanded.startsWith('~/')) {
      expanded = os.homedir() + expanded.slice(1)
    }
    try {
      await fsp.mkdir(expanded, { recursive: true })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new QuickStartError(`Cannot create directory ${expanded}: ${msg}`, 400)
    }
    return
  }

  // Remote — daemon fs.mkdir (daemon expands ~ on the remote host)
  const config = await getConfig()
  const hostDef = config.hosts?.[host]
  if (!hostDef?.hostname) {
    throw new QuickStartError(`Unknown host: ${host}`, 400)
  }

  const { getDaemonConnection } = await import('../../providers/daemon-connection.js')
  const sshTarget = { hostname: hostDef.hostname, user: hostDef.user, port: hostDef.port }
  let timeoutId: ReturnType<typeof setTimeout>
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`Remote connection to ${host} timed out`)), 15_000)
  })
  try {
    const conn = await Promise.race([
      getDaemonConnection(host, sshTarget),
      timeoutPromise,
    ]).finally(() => clearTimeout(timeoutId!))
    const result = await conn.send('fs.mkdir', { path: cwd })
    if (!result.ok) {
      const errMsg = typeof result.error === 'string' ? result.error : 'unknown daemon error'
      throw new Error(errMsg)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new QuickStartError(`Cannot create directory on ${host}: ${msg}`, 400)
  }
}
