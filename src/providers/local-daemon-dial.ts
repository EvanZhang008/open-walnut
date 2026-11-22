/**
 * The one way to dial the local daemon: at the address it serves from now.
 *
 * The local daemon's address changes whenever it starts again (a crash, an upgrade, a test
 * daemon whose parent server went away). A caller that read `localDaemon.wsUrl` once and dialled
 * it later reached the gone one: on 2026-11-16 (nightly server-restart-upload) a session made
 * while a new daemon was starting kept the old address and its start failed with ECONNREFUSED,
 * though the new daemon was up a second later. So the address is read at the dial, after any
 * start in flight, and an address that refuses is checked once with ensureRunning (which adopts
 * the daemon serving or starts one) before the dial is tried again.
 *
 * Ratchet: tests/providers/local-daemon-dial.test.ts fails on a dial of `localDaemon.wsUrl`
 * anywhere else.
 */
import { log } from '../logging/index.js'
import { role } from '../core/server-role.js'
import { assertLocalDialAllowed, getDirectDaemonConnection, type DaemonConnection } from './daemon-connection.js'

const refused = (err: unknown): boolean => /ECONNREFUSED/.test(err instanceof Error ? err.message : String(err))

/** Runs `dial` with the local daemon's current address; once more after a refusal. */
export async function dialLocalDaemon<T>(dial: (wsUrl: string) => Promise<T>): Promise<T> {
  // A host replica, the host's one Walnut service included, dials no local daemon (and starts none
  // for a caller): refused before ensureRunning (daemon-connection.ts assertLocalDialAllowed). A
  // leader is never one, so its dial asks nothing more than its role: the path keeps its timing.
  if (role() !== 'leader') assertLocalDialAllowed('__local__')
  const { localDaemon } = await import('./local-daemon.js')
  // A daemon starting again (another caller found the old one gone) has its address once up.
  await localDaemon.starting?.catch(() => {})
  if (!localDaemon.wsUrl) await localDaemon.ensureRunning()
  const first = localDaemon.wsUrl
  if (!first) throw new Error('Local daemon not running')
  try {
    return await dial(first)
  } catch (err) {
    if (!refused(err)) throw err
    // Nothing listens there: the daemon behind it is gone and nobody noticed yet.
    await localDaemon.ensureRunning()
    const next = localDaemon.wsUrl
    if (!next) throw err
    log.session.warn('local daemon refused its address; dialling where it serves now', { from: first, to: next })
    return dial(next)
  }
}

/** The pooled connection to the local daemon, where it serves now. */
export function getLocalDaemonConnection(): Promise<DaemonConnection> {
  return dialLocalDaemon((wsUrl) => getDirectDaemonConnection('__local__', wsUrl))
}
