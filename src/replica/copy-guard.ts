/**
 * Copy stores on a host replica read only (docs/plan/walnut-replica-servers-impl.md,
 * section 2, runtime guard).
 *
 * On a host replica tasks.sqlite and sessions.sqlite are copies of the Mac's
 * stores, filled by ONE writer: the follower apply connection behind the
 * leader door (WP3, WP4). Every other handle the server opens on them is
 * `query_only`, so a route, a timer or a boot pass that tries to write a copy
 * throws at once ("attempt to write a readonly database") instead of forking
 * the copy away from the Mac's store. The leader and the companion are
 * untouched: the companion's task store takes its own writes on purpose.
 */

import Database, { type Database as DatabaseType } from 'better-sqlite3'
import { isHostReplica } from '../core/server-role.js'
import { log } from '../logging/index.js'

/** The shared handle of a copy store, opened by the store module: read only on a host replica. */
export function guardCopyHandle(handle: DatabaseType, store: string): void {
  if (!isHostReplica()) return
  handle.pragma('query_only = ON')
  log.web.info('copy store opened read only', { store, path: handle.name })
}

/**
 * The follower apply connection of a copy store: its own handle on the same
 * file, the only one that may write. The store module opens its shared handle
 * first (that creates the file and its schema).
 */
export function openApplyConnection(file: string, store: string): DatabaseType {
  const handle = new Database(file, { fileMustExist: true })
  handle.pragma('journal_mode = WAL')
  handle.pragma('busy_timeout = 5000')
  handle.pragma('synchronous = NORMAL')
  log.web.info('copy store apply connection opened', { store, path: file })
  return handle
}
