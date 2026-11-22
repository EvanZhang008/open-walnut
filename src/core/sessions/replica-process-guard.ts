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
 * Per row: a session this host's own service runs and judges (`judge: 'host'` with this host's
 * key, sessions/session-row-owner.ts rowOwnedHere) is no copy, so its process is this host's to
 * probe, stop and reap. Every other row on a host replica is still a copy and still refused. An
 * action that names no row (an orphan sweep, a probe of a bare pid) stays refused: the host's
 * process manager ends the CLIs of its own sessions, and a sweep from here could reach a CLI of a
 * session the leader still runs on this machine through the old path.
 */

import { log } from '../../logging/index.js'
import { isHostReplica } from '../server-role.js'
import { rowOwnedHere, thisHostKey } from './session-row-owner.js'
import type { SessionRecord } from '../types.js'

type RowOwner = Pick<SessionRecord, 'judge' | 'host'>

/** True (and logged, with the full session id) when this server must not do `action` (on `row`, when it names one). */
export function refuseProcessAction(action: string, sessionId?: string | null, row?: RowOwner | null): boolean {
  if (!isHostReplica()) return false
  if (row && rowOwnedHere(row, thisHostKey())) return false
  log.session.warn('replica: refused a process action, sessions here are copies of the Mac\'s', { action, sessionId: sessionId ?? null })
  return true
}

/** The same question, without the log line (a hot read path asks it per row). */
export function processActionsRefused(row?: RowOwner | null): boolean {
  return isHostReplica() && !(row && rowOwnedHere(row, thisHostKey()))
}
