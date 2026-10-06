/**
 * Taking back what a host did while this server was away
 * (docs/plan/daemon-first-hosts.md, "Handover").
 *
 * The daemon journals every offline answer that changed something: request rows
 * it created and settled, settles of this server's rows, messages it delivered,
 * task writes it queued. On (re)connect this drains that journal in order:
 *   - rows are imported into session-requests.json (the daemon's state wins
 *     over a pending copy; a row this server settled is never reopened);
 *   - a settle marks this server's row replied, BEFORE any turn-end hook of
 *     ours can call it "finished without replying";
 *   - a peer message into a COMPLETE task reopens it, as the online send does;
 *   - queued writes replay through the op registry with the recorded caller,
 *     unless the task changed after the write was queued (a newer edit wins).
 * Then `offline.ack` lets the daemon drop what was applied. Records written
 * during the handover come back in the next round.
 *
 * notifyRequesterFallback waits on `waitForOfflineHandovers` so a reply the
 * daemon delivered is never followed by our own "no reply" notice.
 */

import { WALNUT_HOME } from '../constants.js';
import { log } from '../logging/index.js';
import type { OfflineRecord } from '../providers/offline-host-core.js';
import type { SessionRequest } from './session-requests.js';

/** What the handover needs from a daemon connection. */
export interface HandoverConnection {
  hostKey: string;
  send(cmd: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>;
}

export interface HandoverResult {
  rounds: number;
  records: number;
  imported: number;
  settled: number;
  replayed: number;
  skipped: number;
  failed: number;
}

/** A queued write that did not land, told to the session that made it. */
interface Unapplied { callerSid: string; op: string; taskId: string; reason: string }

/** A queued write the server answered with a refusal (validation, a guard), not a Walnut failure. */
class RefusedWrite extends Error {}

const MAX_ROUNDS = 10;
/** The daemon connection's own command budget: a loaded host answered a 10s drain too late (2026-09-28). */
const RPC_TIMEOUT_MS = 30_000;
/** Longest a fallback notice waits on a running handover. */
const HANDOVER_WAIT_MS = 5_000;

const running = new Map<string, Promise<HandoverResult>>();

/** Resolves when every running handover has finished (or after HANDOVER_WAIT_MS). */
export async function waitForOfflineHandovers(maxMs = HANDOVER_WAIT_MS): Promise<void> {
  if (running.size === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.allSettled([...running.values()]),
    new Promise<void>((resolve) => { timer = setTimeout(resolve, maxMs); timer.unref?.(); }),
  ]).finally(() => clearTimeout(timer));
}

/** One handover per host at a time; a call while one runs joins it. */
export function runOfflineHandover(conn: HandoverConnection): Promise<HandoverResult> {
  const existing = running.get(conn.hostKey);
  if (existing) return existing;
  const job = handover(conn).finally(() => running.delete(conn.hostKey));
  running.set(conn.hostKey, job);
  return job;
}

async function handover(conn: HandoverConnection): Promise<HandoverResult> {
  const result: HandoverResult = { rounds: 0, records: 0, imported: 0, settled: 0, replayed: 0, skipped: 0, failed: 0 };
  // A task's updated_at as it was BEFORE this handover wrote anything: a second
  // queued write for the same task must not lose to the first one's own stamp.
  const baseline = new Map<string, number>();
  const unapplied: Unapplied[] = [];
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const reply = await conn.send('offline.drain', { home: WALNUT_HOME }, RPC_TIMEOUT_MS);
    if (reply.ok === false) throw new Error(String(reply.error ?? 'offline.drain refused'));
    const records = (Array.isArray(reply.records) ? reply.records : []) as OfflineRecord[];
    if (records.length === 0) break;
    result.rounds++;
    result.records += records.length;
    let upTo = 0;
    for (const record of records) {
      try {
        await applyRecord(conn.hostKey, record, baseline, result, unapplied);
      } catch (err) {
        // Applied or not, a record is acked: a record that fails every time
        // would otherwise pin the host in offline mode forever. The log keeps
        // it, and the session that made a failed write hears about it.
        result.failed++;
        const reason = err instanceof Error ? err.message : String(err);
        if (err instanceof RefusedWrite && record.kind === 'op') {
          // The server's own answer to the caller's write, the one the same call
          // made online gets: the caller's to redo (it is told below), not a fault.
          log.session.warn('offline handover: queued write refused', {
            host: conn.hostKey, seq: record.seq, op: record.op, taskId: String(record.args.id ?? ''),
            callerSid: record.callerSid, error: reason,
          });
        } else {
          // Walnut could not apply its own record. Named by the session it
          // concerns, so the card retires on that session's next clean turn.
          log.session.error('offline handover: record failed', {
            host: conn.hostKey, seq: record.seq, kind: record.kind, error: reason, ...await recordScope(record),
          });
        }
        if (record.kind === 'op') unapplied.push({ callerSid: record.callerSid, op: record.op, taskId: String(record.args?.id ?? ''), reason });
      }
      upTo = Math.max(upTo, record.seq);
    }
    // The next drain returns what was written during this round (or nothing).
    await conn.send('offline.ack', { home: WALNUT_HOME, upTo }, RPC_TIMEOUT_MS);
  }
  if (result.records > 0) log.session.info('offline handover: done', { host: conn.hostKey, ...result });
  if (unapplied.length > 0) await tellCallers(unapplied);
  return result;
}

/**
 * The host answered "saved, applied when the server reconnects"; when that turns
 * out false, the session that made the write is told, once per session, which
 * changes did not land and why. Best effort: a caller that is gone keeps only
 * the log line.
 */
async function tellCallers(unapplied: Unapplied[]): Promise<void> {
  const bySession = new Map<string, Unapplied[]>();
  for (const u of unapplied) bySession.set(u.callerSid, [...(bySession.get(u.callerSid) ?? []), u]);
  const [{ getSessionByClaudeId }, { buildWalnutMessage }, { deliverToSession }] = await Promise.all([
    import('./session-tracker.js'),
    import('./peers/walnut-message-tag.js'),
    import('./sessions/session-send-core.js'),
  ]);
  for (const [sid, items] of bySession) {
    try {
      const session = await getSessionByClaudeId(sid);
      if (!session) continue;
      const text = buildWalnutMessage({
        kind: 'notification',
        attrs: { from: 'Walnut', note: 'automated Walnut status notice' },
        body: [
          'While the Walnut server was away, this host saved changes you made and said they would be applied later. These were NOT applied:',
          ...items.map((u) => `- ${u.op} ${u.taskId}: ${u.reason}`),
          'Read the task (walnut tools call task_get) and redo the change if it still applies.',
        ].join('\n'),
      });
      await deliverToSession(session, { busText: text, enqueueText: text, source: 'walnut-notify', taskId: session.taskId });
    } catch (err) {
      log.session.warn('offline handover: could not tell the caller about unapplied writes', {
        callerSid: sid, error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

function toRequest(row: Extract<OfflineRecord, { kind: 'row' }>['row']): SessionRequest {
  return {
    id: row.id,
    fromSessionId: row.fromSessionId,
    toSessionId: row.toSessionId,
    ...(row.toTaskId ? { toTaskId: row.toTaskId } : {}),
    preview: row.preview,
    status: row.status,
    createdAt: row.createdAt,
    deadlineAt: row.deadlineAt,
    ...(row.settledAt ? { settledAt: row.settledAt } : {}),
    ...(row.outcome ? { outcome: row.outcome } : {}),
  };
}

async function applyRecord(
  host: string,
  record: OfflineRecord,
  baseline: Map<string, number>,
  result: HandoverResult,
  unapplied: Unapplied[],
): Promise<void> {
  switch (record.kind) {
    case 'row': {
      const { importOfflineRequest } = await import('./session-requests.js');
      if (await importOfflineRequest(toRequest(record.row))) result.imported++;
      return;
    }
    case 'settle': {
      const { settleReplied } = await import('./session-requests.js');
      if (await settleReplied(record.requestId)) result.settled++;
      return;
    }
    case 'delivery': {
      // The online send reopens a COMPLETE task a peer writes to; the offline
      // delivery did the same work, so the board says the same thing.
      const taskId = record.reply ? await taskOfSession(record.toSessionId) : (record.toTaskId ?? await taskOfSession(record.toSessionId));
      if (!taskId) return;
      const { getTask } = await import('./task-manager.js');
      const task = await getTask(taskId).catch(() => null);
      if (task?.phase !== 'COMPLETE') return;
      const { applySessionPhase } = await import('./phase.js');
      await applySessionPhase(taskId, 'session:input', 'offline-handover', { sessionId: record.toSessionId, reopenTerminal: true });
      return;
    }
    case 'op': {
      const taskId = String(record.args.id ?? '');
      const { getTask } = await import('./task-manager.js');
      const task = await getTask(taskId).catch(() => null);
      if (!task) {
        result.skipped++;
        log.session.warn('offline handover: queued write skipped, task gone', { host, op: record.op, taskId });
        unapplied.push({ callerSid: record.callerSid, op: record.op, taskId, reason: 'the task no longer exists' });
        return;
      }
      if (!baseline.has(task.id)) baseline.set(task.id, Date.parse(task.updated_at ?? '') || 0);
      // A newer edit wins. "Newer" is judged on BOTH clocks the write carries:
      // the host's own time (`at`) and the server's stamp on the copy the writer
      // read (`base`). A host clock running behind makes `at` look older than a
      // change that came before the copy; `base` is what keeps that write.
      const base = Date.parse(record.base ?? '') || 0;
      if ((baseline.get(task.id) ?? 0) > Math.max(record.at, base)) {
        result.skipped++;
        log.session.warn('offline handover: queued write skipped, the task changed after it was queued', {
          host, op: record.op, taskId: task.id, queuedAt: new Date(record.at).toISOString(), updatedAt: task.updated_at,
          callerSid: record.callerSid,
        });
        unapplied.push({ callerSid: record.callerSid, op: record.op, taskId: task.id, reason: 'the task changed after this change was queued, and the newer change wins' });
        return;
      }
      const { executeOp } = await import('../ops/index.js');
      const { hostOrigin } = await import('../lib/caller-origin.js');
      const r = await executeOp(record.op, record.args, { callerSid: record.callerSid, callerHost: host, origin: hostOrigin(host) });
      // The server's own words; the log line and the caller's notice name the op.
      // A refusal is the server's answer (a 5xx is carded by its route); no
      // answer at all is Walnut failing its own write.
      if (!r.ok) throw r.unreachable ? new Error(r.message) : new RefusedWrite(r.message);
      result.replayed++;
      log.session.info('offline handover: queued write applied', { host, op: record.op, taskId: task.id, callerSid: record.callerSid });
      return;
    }
  }
}

/** The session (and task) a record is about, for the log line and the card's lifecycle. */
async function recordScope(record: OfflineRecord): Promise<{ sessionId?: string; taskId?: string }> {
  switch (record.kind) {
    case 'op': return { sessionId: record.callerSid, taskId: String(record.args?.id ?? '') || undefined };
    case 'row': return { sessionId: record.row.fromSessionId };
    case 'delivery': return { sessionId: record.toSessionId };
    case 'settle': {
      const { getSessionRequest } = await import('./session-requests.js');
      const row = await getSessionRequest(record.requestId).catch(() => undefined);
      return row ? { sessionId: row.fromSessionId } : {};
    }
  }
}

async function taskOfSession(sid: string): Promise<string | undefined> {
  const { getSessionByClaudeId } = await import('./session-tracker.js');
  return (await getSessionByClaudeId(sid).catch(() => null))?.taskId || undefined;
}
