/**
 * The mode writes of `walnut daemon install|update|uninstall` (daemon-service-cli.ts), each a
 * read-decide-write holding the mode's lock (service-mode-lock.ts), as the leader switch's
 * setServiceRole is: a role the switch writes meanwhile is read, kept and never written over.
 *   stage    the mode the staged version runs with (nextServiceMode);
 *   drop     a carried mode the staged file cannot run (the boot proof's drop), never a leader's;
 *   restore  the mode before, after a failed update, only over this update's own write (compare
 *            and swap): when the mode changed since, it stays as it is.
 */
import { nextServiceMode, readServiceMode, serviceRoleOf, writeServiceMode, type ServiceMode } from './service-mode.js'
import { withServiceModeLockWait } from './service-mode-lock.js'

const modeIn = (stateDir: string): ServiceMode | null => { const r = readServiceMode(stateDir); return 'mode' in r ? r.mode : null }
const same = (a: ServiceMode | null, b: ServiceMode | null): boolean => JSON.stringify(a) === JSON.stringify(b)

export interface StagedMode { before: ServiceMode | null; written: ServiceMode | null; note?: string }

export function stageServiceMode(stateDir: string, ask: { home: string; on: boolean } | undefined, exe: string, o: { waitMs?: number } = {}): Promise<StagedMode> {
  return withServiceModeLockWait(stateDir, () => {
    const before = modeIn(stateDir)
    const next = nextServiceMode(before, ask, exe)
    writeServiceMode(stateDir, next.mode)
    return { before, written: next.mode, ...(next.note ? { note: next.note } : {}) }
  }, o)
}

/** Drops the mode naming `exe`: 'dropped', 'leader' (kept: only the switch changes it), or 'none' (no such mode now). */
export function dropServiceMode(stateDir: string, exe: string, o: { waitMs?: number } = {}): Promise<'dropped' | 'leader' | 'none'> {
  return withServiceModeLockWait(stateDir, () => {
    const now = modeIn(stateDir)
    if (!now || now.exe !== exe) return 'none' as const
    if (serviceRoleOf(now) === 'leader') return 'leader' as const
    writeServiceMode(stateDir, null)
    return 'dropped' as const
  }, o)
}

/** Puts `before` back when the mode is still `written`: 'restored', or 'changed' (someone wrote since; kept). */
export function restoreServiceMode(stateDir: string, before: ServiceMode | null, written: ServiceMode | null, o: { waitMs?: number } = {}): Promise<'restored' | 'changed'> {
  return withServiceModeLockWait(stateDir, () => {
    if (!same(modeIn(stateDir), written)) return 'changed' as const
    writeServiceMode(stateDir, before)
    return 'restored' as const
  }, o)
}

/** Removes the mode (an uninstall), holding the lock. */
export function removeServiceMode(stateDir: string, o: { waitMs?: number } = {}): Promise<void> {
  return withServiceModeLockWait(stateDir, () => writeServiceMode(stateDir, null), o)
}
