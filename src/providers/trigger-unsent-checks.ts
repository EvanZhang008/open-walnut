/**
 * The checks a host ran while no server of the trigger's Walnut was there to take the report
 * (2026-11-25: a clouddev trigger checked every 30 minutes from 05:09 to 08:40Z while the Mac
 * slept, and its record on the Mac kept only the check before and two after; read at 08:39Z it
 * said "last check 04:40Z" and looked stopped for four hours). The daemon keeps them, bounded,
 * in the trigger's state file, and the configure of a server that dedups checks takes them, oldest
 * first, before the latest one (daemon-trigger-set.ts), so the record has no hole.
 *
 * A report put on the wire is not yet a report read. 2026-11-25 18:12 to 19:25Z the Mac's lid was
 * shut: its sockets to clouddev stayed open but silent for two minutes after each dark wake, and
 * every check sent into one (and the configure replay of 19:22:07, ten seconds before the Mac slept
 * again) was gone; the record skipped from 18:05 to 19:25. So each report stays kept until a socket
 * it went to answers a ping sent after it (settleChecksOnWire: one stream, in order, so the socket
 * read the report); one whose sockets closed unanswered is sent again. The server takes a report it
 * already holds as nothing (trigger-apply.ts).
 */
// Types only: the daemon's trigger area loads no trigger logic of its own (daemon-task-logic-ratchet.test.ts);
// reading the kept list from disk is trigger-check-core.ts's (coerceUnsentChecks).
import type { TriggerCheckedEvent, TriggerHostState } from './trigger-check-core.js'

/** The most kept per trigger: a day of a 30-minute trigger; older ones go first. */
export const UNSENT_CHECKS_MAX = 48

/** Keep a report no server is known to have read. */
export function keepUnsentCheck(state: TriggerHostState, checked: TriggerCheckedEvent): void {
  const list = state.unsentChecks ?? []
  if (list.some((c) => c.atMs === checked.atMs)) return
  list.push(checked)
  list.sort((a, b) => a.atMs - b.atMs)
  if (list.length > UNSENT_CHECKS_MAX) list.splice(0, list.length - UNSENT_CHECKS_MAX)
  state.unsentChecks = list
}

/** A report put on the wire: when, and to which sockets (in memory only, like a fire's sent mark). */
export interface CheckOnWire { sentAt: number; to: readonly object[] }

/**
 * How the runtime sees its sockets: still open, and how far one has read (when the newest ping it
 * answered was sent; a server's own ping proves nothing, it may come before it read anything).
 */
export interface CheckWireView { open: (ws: object) => boolean; readThrough: (ws: object) => number | undefined }

/**
 * Drop the kept reports a server is known to have read: a socket each went to is open and answered a
 * ping sent at or after the report. A report whose sockets all closed unanswered loses its mark and is
 * sent again. True when the kept list changed.
 */
export function settleChecksOnWire(state: TriggerHostState, wire: Map<number, CheckOnWire>, view: CheckWireView): boolean {
  if (!wire.size) return false
  const read = new Set<number>()
  for (const [atMs, mark] of wire) {
    const open = mark.to.filter((ws) => view.open(ws))
    if (open.some((ws) => (view.readThrough(ws) ?? -Infinity) >= mark.sentAt)) { read.add(atMs); wire.delete(atMs) }
    else if (!open.length) wire.delete(atMs)
  }
  const list = state.unsentChecks
  if (!read.size || !list) return false
  const left = list.filter((c) => !read.has(c.atMs))
  if (left.length === list.length) return false
  if (left.length) state.unsentChecks = left
  else delete state.unsentChecks
  return true
}

/** The kept reports to put on the wire now, oldest first: those on no open socket. `except`: the latest, sent on its own. */
export function checksToResend(state: TriggerHostState, wire: Map<number, CheckOnWire>, view: Pick<CheckWireView, 'open'>, except?: number): TriggerCheckedEvent[] {
  return (state.unsentChecks ?? []).filter((c) => c.atMs !== except && !(wire.get(c.atMs)?.to.some((ws) => view.open(ws)) ?? false))
}
