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
import { log } from '../../logging/index.js'

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

  const { link } = await import('../hosts/link.js')
  const { boundHostRead, HostReconnectingError, HOST_RECONNECTING } = await import('../hosts/remote-read-bound.js')
  const { linkFailureKind } = await import('../../providers/link-failure.js')
  const { hostDisplayName, inHostTerms } = await import('../hosts/host-display-name.js')
  // Every sentence names the host by its label, once: "Cannot create directory
  // on __cloudbox__: Remote connection to __cloudbox__ timed out" put an
  // internal alias in front of the user twice.
  const name = hostDisplayName(host, hostDef.label)
  const reconnecting = (message: string) => new QuickStartError(message, 503, { code: HOST_RECONNECTING, host })
  let timeoutId: ReturnType<typeof setTimeout>
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new HostReconnectingError(host, name)), 15_000)
  })
  // The mkdir was asked of the host: from then on a lost link may have let it happen.
  let sent = false
  try {
    // A user action, not a background read: it waits for a dial already under way
    // (15s at most), so a send right after the picker started a first connect goes through.
    const conn = await Promise.race([
      link(host),
      timeoutPromise,
    ]).finally(() => clearTimeout(timeoutId!))
    // The mkdir rides the host-read liveness rule: a connected link that stopped
    // answering held it for the daemon's 30s command timeout.
    sent = true
    const result = await boundHostRead(host, () => conn.send('fs.mkdir', { path: cwd }))
    if (!result.ok) {
      const errMsg = typeof result.error === 'string' ? result.error : 'unknown daemon error'
      throw new Error(errMsg)
    }
  } catch (err) {
    // The link, not the folder: the reconnecting category, in a plain sentence
    // (the dial's own words, an errno or a URL, go to the log only). The gate
    // (2026-10-07) saw "Cannot create directory on Cloud: the connection timed out"
    // while the host was dialling.
    const link = err instanceof HostReconnectingError || linkFailureKind(err) !== null
    if (link) {
      log.web.info('quick-start createCwd answered reconnecting', {
        host, sent, error: err instanceof Error ? err.message : String(err),
      })
      throw reconnecting(sent
        ? `${name} stopped answering while creating the folder, so it may or may not exist. Try again: creating it twice is safe.`
        : `Reconnecting to ${name}, so the folder was not created. Try again in a moment.`)
    }
    const msg = err instanceof Error ? err.message : String(err)
    throw new QuickStartError(`Cannot create directory on ${name}: ${inHostTerms(msg, host, name)}`, 400)
  }
}
