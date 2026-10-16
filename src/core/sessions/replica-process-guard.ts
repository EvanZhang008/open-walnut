/**
 * A host replica never acts on a process (docs/plan/walnut-replica-servers-impl.md,
 * WP4): its sessions.sqlite is a COPY of the Mac's (replication/kinds/sessions.ts),
 * so every session in it belongs to a process the Mac's daemons own. No signal,
 * no existence probe, no stop asked of a daemon, no orphan sweep, no capacity
 * eviction, no stale-record repair. The copy already strips every process field;
 * this guard is the second wall, at each funnel those actions go through
 * (owner-stop.ts, session-tracker.ts, utils/session-liveness.ts). Pinned by
 * tests/core/signal-call-ratchet.test.ts and tests/core/sessions/replica-process-guard.test.ts.
 *
 * Keyed on placement host, not role replica: the companion is a replica too,
 * and with cloud exec on it runs (and stops) its own sessions in its own
 * daemon, exactly as before.
 *
 * TODO(WP12): keyed on placement alone, this refuses every process action on a
 * host server, which is right while every session row there is a copy. When
 * WP12 runs Ask sessions on the host itself (server-role.ts runsSessions), the
 * guard must tell a copied row (it came through the sessions kind, it has no
 * pid and no output file) from a session this server started, or those would
 * never be stopped or reaped. Scope it per row then; keep the ratchet.
 */

import { log } from '../../logging/index.js'
import { isHostReplica } from '../server-role.js'

/** True (and logged, with the full session id) when this server must not do `action`. */
export function refuseProcessAction(action: string, sessionId?: string | null): boolean {
  if (!isHostReplica()) return false
  log.session.warn('replica: refused a process action, sessions here are copies of the Mac\'s', { action, sessionId: sessionId ?? null })
  return true
}

/** The same question, without the log line (a hot read path asks it per row). */
export function processActionsRefused(): boolean {
  return isHostReplica()
}
