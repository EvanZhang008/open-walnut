/**
 * Where the copies of a replaced daemon are kept, on this machine (local-daemon-replace.ts) and on
 * an SSH host (daemon-trial-cmd.ts): `${XDG_STATE_HOME:-~/.local/state}/open-walnut/daemon-previous/<key>`,
 * one dir per daemon dir, a dir that survives a reboot. 2026-11-04 review 4: they were kept in
 * <daemon dir>/previous, under /tmp by default, so a reboot inside a refused build's day off lost
 * them, and the next start ran (or deployed) the refused build.
 */
import { createHash } from 'node:crypto'
import path from 'node:path'

/** A daemon dir's own name among the kept copies: the same for the same path on every machine. */
export function previousKeyOf(daemonDir: string): string {
  return createHash('sha256').update(path.posix.normalize(daemonDir).replace(/(.)\/+$/, '$1')).digest('hex').slice(0, 16)
}

/** Where an older build kept the copies, beside the daemon's files: still read. */
export const PREVIOUS_DIR = 'previous'
