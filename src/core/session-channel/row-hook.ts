/**
 * One hook point in the session store for the rows a host owns (sessions/session-row-owner.ts):
 * session-tracker calls `noteSessionRowWritten` after each committed write of a row (every write
 * path), and the host's fact emitter (installed only on a host that runs its sessions) turns a
 * write of one of its own rows into a `row` fact. Nothing listens anywhere else, so the call costs
 * one null check.
 */
import type { SessionRecord } from '../types.js'

type Listener = (row: SessionRecord) => void
let listener: Listener | null = null

export function setOwnRowListener(fn: Listener | null): void {
  listener = fn
}

/** After a committed write of `row` (the whole stored record). Never throws. */
export function noteSessionRowWritten(row: SessionRecord): void {
  if (!listener) return
  try { listener(row) } catch { /* the emitter logs its own failures */ }
}
