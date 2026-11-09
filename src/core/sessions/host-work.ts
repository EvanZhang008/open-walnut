/**
 * Whether a session's CLI is at work, as its HOST's daemon knows it: the one source that a
 * server restart or a dropped daemon link cannot leave stale. The daemon folds the CLI's own
 * stream (daemon-fold.ts), and after its own restart it rebuilds that fold from the stream file.
 *
 * 2026-11-08: two "not taken" notices went to an asker about a task that had read
 * the ask in 10 seconds and was in one turn from 04:02 to 05:43. A server restart and two dropped
 * daemon links had left the server's runner reading "not in a turn" and the session record
 * "stopped", while the daemon's fold said turnActive the whole time. Before Walnut tells an asker
 * that a target shows nothing, it asks the host (session-request-notify.ts remindSilent,
 * targetAtWork).
 */
import type { SessionRecord } from '../types.js';
import type { SessionSnapshot } from '../../providers/daemon-fold.js';

/** The host's word on one session. */
export interface HostWork {
  /** Its CLI process runs. */
  alive: boolean;
  /** It runs a turn, or work of its own that outlives its turn (background commands, a team, a wakeup). */
  working: boolean;
}

/** A `getState` answer read as HostWork; null when it says nothing (an error, no record, an empty stream). */
export function hostWorkFrom(
  resp: { ok?: unknown; exists?: unknown; alive?: unknown; snapshot?: SessionSnapshot | null } | null | undefined,
  now = Date.now(),
): HostWork | null {
  if (!resp || resp.ok !== true || resp.exists === false) return null;
  const snap = resp.snapshot;
  if (!snap || !(snap.v > 0)) return typeof resp.alive === 'boolean' ? { alive: resp.alive, working: false } : null;
  const alive = resp.alive !== false && snap.cliState !== 'dead';
  if (!alive) return { alive: false, working: false };
  // A turn stopped on a permission prompt waits on a person, not on its asker.
  if (snap.pendingPermission) return { alive: true, working: false };
  const working = snap.turnActive
    || snap.gatingBgCount > 0
    || (snap.detachedBgCount ?? 0) > 0
    || snap.teamActive
    || (typeof snap.wakeupAt === 'number' && snap.wakeupAt > now);
  return { alive: true, working };
}

/** How long the host gets to answer: this is asked only right before telling someone. */
export const HOST_WORK_TIMEOUT_MS = 5_000;

/** The host's word on this session, or null when its daemon cannot be asked or does not answer. Never throws. */
export async function hostWorkOf(record: Pick<SessionRecord, 'claudeSessionId' | 'host'>, now = Date.now()): Promise<HostWork | null> {
  try {
    const { getPooledSnapshotConnection } = await import('../../providers/daemon-connection.js');
    const conn = getPooledSnapshotConnection(record.host);
    if (!conn) return null;
    const resp = await conn.send('getState', { sid: record.claudeSessionId }, HOST_WORK_TIMEOUT_MS) as Parameters<typeof hostWorkFrom>[0];
    return hostWorkFrom(resp, now);
  } catch {
    return null;
  }
}
