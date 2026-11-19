/**
 * The stop a completed task decided for its sessions, kept on the session record until it
 * reaches the CLI (`taskCompleteStop`), so neither a restart nor an offline host loses it.
 *
 * 2026-11-18: a session completed its own task mid-turn, so it was to stop when that turn
 * ended, a wait kept only in memory. A deploy restarted the server 20 minutes later and the
 * wait was gone; 19 s after the boot the completed-task migration marked the session stopped,
 * cleared its pid and announced it, while the stop it sent reached nothing ("owner stop: host
 * daemon not connected, nothing signalled"). The CLI kept running, and the task's workspace
 * cleanup, reading the record, removed the node_modules it was using.
 *
 * Two states:
 *  - 'turn_end': the session completed its own task mid-turn (self-complete-stop.ts). The
 *    task's other writes leave it alone, and after a restart the wait is watched again with
 *    its own deadline (resumeTaskCompleteStops).
 *  - 'undelivered': its host's daemon was not connected, or the stop failed on the way. A
 *    record not yet written stopped keeps its state and pid (it is alive as far as anyone
 *    knows); the stop is sent when the host connects (flushTaskCompleteStops, from the
 *    daemon pool's host-connected callback). After TASK_COMPLETE_STOP_UNDELIVERED_MAX_MS
 *    the next completion pass records it stopped without the host, as before; the host's
 *    own idle reaper ends a CLI nobody stopped.
 * A task reopened meanwhile drops the marker: its session goes on.
 */
import { log } from '../../logging/index.js';
import type { SessionRecord } from '../types.js';

type Marker = NonNullable<SessionRecord['taskCompleteStop']>;

/** An undelivered stop waits this long for its host; then the record is converged without it. */
export const TASK_COMPLETE_STOP_UNDELIVERED_MAX_MS = 24 * 60 * 60_000;

/** Whether an undelivered marker still holds its record back (false once its wait ran out). */
export function undeliveredHolds(marker: Marker | undefined, now: number): boolean {
  if (marker?.state !== 'undelivered') return false;
  const at = Date.parse(marker.at);
  return Number.isFinite(at) && now - at < TASK_COMPLETE_STOP_UNDELIVERED_MAX_MS;
}

async function taskStillComplete(rec: SessionRecord): Promise<boolean> {
  const { stillComplete } = await import('./self-complete-stop.js');
  return !!await stillComplete(rec.claudeSessionId);
}

/** The slice of the session database these reads use (session-db.ts's handle). */
interface Db { prepare(sql: string): { all(...args: unknown[]): unknown[] } }

/**
 * The hosts of `sessionIds` (those that still name a process) whose daemon a stop cannot
 * reach now: owner-stop.ts's own test, the pooled connected link, never a dial. A failed
 * lookup counts as reachable: the stop is sent as before, and an answer that it reached
 * nothing is recorded (noteStopUndelivered).
 */
export async function unreachableOwnerHosts(db: Db, sessionIds: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    // By primary key; a session with neither a pid nor a live status has no process to stop.
    const hosts = db.prepare(`SELECT DISTINCT COALESCE(NULLIF(host, ''), '__local__') AS h FROM sessions
      WHERE claude_session_id IN (SELECT value FROM json_each(?)) AND (pid IS NOT NULL OR process_status NOT IN ('stopped', 'error'))`)
      .all(JSON.stringify(sessionIds)) as { h: string }[];
    if (hosts.length === 0) return out;
    const { ownerConnection } = await import('./owner-stop.js');
    for (const { h } of hosts) {
      const conn = await ownerConnection(h).catch(() => null);
      if (!conn?.connected) out.add(h);
    }
  } catch {
    out.clear();
  }
  return out;
}

/**
 * After a pass left stops undelivered: a host that connected while the pass read had its
 * connect's flush look before these markers landed, so it is flushed once more.
 */
export async function recheckUndeliveredHosts(hosts: string[]): Promise<void> {
  try {
    const { ownerConnection } = await import('./owner-stop.js');
    for (const h of hosts) {
      if ((await ownerConnection(h).catch(() => null))?.connected) void flushTaskCompleteStops(h).catch(() => {});
    }
  } catch { /* the host's next connect flushes them */ }
}

/** Drop the marker, only if it is still the one in `state` (a newer decision wins). */
export async function clearTaskCompleteStop(sid: string, state: Marker['state']): Promise<void> {
  const { updateSessionRecordConditionally } = await import('../session-tracker.js');
  await updateSessionRecordConditionally(sid, { taskCompleteStop: undefined },
    (current) => current.taskCompleteStop?.state === state).catch(() => null);
}

/** A stop sent for a record already written stopped did not arrive: send it again on the host's next connect. */
export async function noteStopUndelivered(sid: string, why: string): Promise<void> {
  try {
    const { updateSessionRecordConditionally } = await import('../session-tracker.js');
    const marker: Marker = { at: new Date().toISOString(), state: 'undelivered' };
    const updated = await updateSessionRecordConditionally(sid, { taskCompleteStop: marker },
      (current) => current.taskCompleteStop?.state !== 'turn_end');
    if (updated) log.session.info('task complete stop: not delivered, sent again when its host connects', { sessionId: sid, host: updated.host ?? '__local__', why });
  } catch (err) {
    log.session.warn('task complete stop: the undelivered stop was not recorded', { sessionId: sid, error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * At startup (before the completed-task migration): every session waiting for its own turn's
 * end is watched again, deadline from its `at`; one whose task was reopened goes on.
 */
export async function resumeTaskCompleteStops(): Promise<number> {
  const { listTaskCompleteStops } = await import('../session-tracker.js');
  const { stopWhenTurnEnds } = await import('./self-complete-stop.js');
  let n = 0;
  for (const rec of await listTaskCompleteStops({ state: 'turn_end' })) {
    const sid = rec.claudeSessionId;
    if (!await taskStillComplete(rec)) { await clearTaskCompleteStop(sid, 'turn_end'); continue; }
    const since = Date.parse(rec.taskCompleteStop!.at);
    stopWhenTurnEnds(sid, Number.isFinite(since) ? since : Date.now());
    n++;
  }
  if (n > 0) log.session.info('task complete stop: turn-end waits resumed at startup', { count: n });
  return n;
}

/**
 * A host connected: each stop its completed tasks could not send it goes now. A session
 * still recorded alive goes through completeTaskSessions (it marks it stopped, then asks
 * the daemon); one that completed its own task waits for its turn's end first, asking the
 * daemon (the record may be older than the turn); one already recorded stopped, whose
 * stop failed on the way, is asked again directly.
 */
export async function flushTaskCompleteStops(hostKey: string): Promise<number> {
  const { listTaskCompleteStops, completeTaskSessions } = await import('../session-tracker.js');
  let sent = 0;
  for (const rec of await listTaskCompleteStops({ state: 'undelivered', host: hostKey })) {
    const sid = rec.claudeSessionId;
    try {
      if (!await taskStillComplete(rec)) { await clearTaskCompleteStop(sid, 'undelivered'); continue; }
      sent++;
      if (rec.taskCompleteStop?.actor) {
        const { updateSessionRecordConditionally } = await import('../session-tracker.js');
        const { stopWhenTurnEnds } = await import('./self-complete-stop.js');
        const marker: Marker = { at: rec.taskCompleteStop.at, state: 'turn_end' };
        await updateSessionRecordConditionally(sid, { taskCompleteStop: marker }, (c) => c.taskCompleteStop?.state === 'undelivered');
        const since = Date.parse(marker.at);
        stopWhenTurnEnds(sid, Number.isFinite(since) ? since : Date.now());
        continue;
      }
      const recordedEnded = (rec.process_status === 'stopped' || rec.process_status === 'error') && rec.pid == null;
      if (!recordedEnded) { await completeTaskSessions([sid]); continue; }
      const outcome = await resend(rec);
      if (outcome === 'stopped' || outcome === 'refused') await clearTaskCompleteStop(sid, 'undelivered');
    } catch (err) {
      log.session.warn('task complete stop: sending it on connect failed; the next connect tries again', { sessionId: sid, host: hostKey, error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (sent > 0) log.session.info('task complete stop: undelivered stops sent on connect', { host: hostKey, count: sent });
  return sent;
}

async function resend(rec: SessionRecord): Promise<string> {
  const { stopThroughOwner, stopAcpThroughOwner } = await import('./owner-stop.js');
  const { isAcpEngine } = await import('../agents/engine-registry.js');
  if (isAcpEngine(rec.engine) && rec.acpRuntimeId) return stopAcpThroughOwner(rec, 'task_completed');
  return stopThroughOwner(rec, 'maintenance', 'task_completed');
}
