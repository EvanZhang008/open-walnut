// One area's routing work, serialized across processes: a route holds it from its access check through claim, send and settle,
// and a migration rollback holds it from its first ledger check to the watcher's restore, so no claim lands after a restore.
// Lock order: migration lock, then this lock, then the org lock. A route never holds the org lock while it takes this one.
import path from 'node:path'
import { FileLockTimeoutError, withFileLock } from '../../utils/file-lock.js'
import { routerAreaId } from './store.js'

/**
 * How long a route or a rollback waits for its area's lock. Routes of one area queue behind each
 * other (a holder may be starting its receiver), and a wait that runs out throws before any claim,
 * so it is never read as a delivery.
 */
export const ROUTE_LOCK_WAIT_MS = 10_000

export class RouteLockBusyError extends Error {
  readonly code = 'area_route_busy'
  readonly status = 503
  constructor(areaId: string, waitMs: number) {
    super(`Area ${areaId} is busy with another route or a migration rollback for over ${waitMs} ms. Nothing was changed; try again.`)
    this.name = 'RouteLockBusyError'
  }
}

/** The lock sits beside the area's ledger file, so it is keyed by exactly the ledger the work writes. */
export function routeLockPathForLedger(ledgerFile: string): string {
  return path.join(path.dirname(path.resolve(ledgerFile)), 'route')
}

export function routeLockPath(home: string, areaId: string): string {
  if (typeof home !== 'string' || !path.isAbsolute(home)) throw new TypeError('The Walnut home must be an absolute path')
  return routeLockPathForLedger(path.join(path.resolve(home), 'router', 'areas', routerAreaId(areaId), 'items.sqlite'))
}

async function held<T>(lock: string, areaId: string, work: () => Promise<T>, waitMs: number): Promise<T> {
  try {
    return await withFileLock(lock, work, { timeoutMs: waitMs })
  } catch (error) {
    // Only a wait that never got the lock is busy; an error from the work itself passes through unchanged.
    if (error instanceof FileLockTimeoutError && error.message.endsWith(`${lock}.lock`)) throw new RouteLockBusyError(areaId, waitMs)
    throw error
  }
}

export function withAreaRouteLock<T>(home: string, areaId: string, work: () => Promise<T>, opts: { timeoutMs?: number } = {}): Promise<T> {
  return held(routeLockPath(home, areaId), areaId, work, opts.timeoutMs ?? ROUTE_LOCK_WAIT_MS)
}

/** The same lock, named by the ledger the caller already holds (its `file`). */
export function withLedgerRouteLock<T>(ledger: { areaId: string; file: string }, work: () => Promise<T>, opts: { timeoutMs?: number } = {}): Promise<T> {
  return held(routeLockPathForLedger(ledger.file), ledger.areaId, work, opts.timeoutMs ?? ROUTE_LOCK_WAIT_MS)
}
