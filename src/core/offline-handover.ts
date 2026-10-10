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
import { VALID_SESSION_EFFORT_IDS, VALID_SESSION_MODE_IDS, type SessionEffort, type SessionMode } from './types.js';

/** What the handover needs from a daemon connection. */
export interface HandoverConnection {
  hostKey: string;
  send(cmd: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>;
  /**
   * Look at these sessions again as a reconnect does, as if their records did
   * not say stopped: the host started them while this server was away.
   */
  rescue?(sessionIds: string[]): Promise<void>;
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

/**
 * Hosts that said they journaled something we have not drained yet (the
 * offline-journal nudge). A host delivers messages between its own sessions
 * itself even while we answer, so its reply to a request can be in its journal
 * when the asker's turn-end hook asks "did anyone answer?": that hook waits for
 * the drain, as it waits for a running one.
 */
const due = new Map<string, { at: number; done: Promise<void>; resolve: () => void }>();

export function noteHandoverDue(hostKey: string): void {
  if (due.has(hostKey)) return;
  let resolve!: () => void;
  const done = new Promise<void>((r) => { resolve = r; });
  due.set(hostKey, { at: Date.now(), done, resolve });
}

/** A nudge nobody drained this long ago (the host went away first) is dropped: its records wait for the next connect. */
const DUE_TTL_MS = 60_000;

function pruneDue(): void {
  const now = Date.now();
  for (const [host, d] of due) {
    if (now - d.at > DUE_TTL_MS) { due.delete(host); d.resolve(); }
  }
}

/** The handover of this host that is running now, if any. */
export function runningHandover(hostKey: string): Promise<HandoverResult> | undefined {
  return running.get(hostKey);
}

/** Resolves when every running or due handover has finished (or after HANDOVER_WAIT_MS). */
export async function waitForOfflineHandovers(maxMs = HANDOVER_WAIT_MS): Promise<void> {
  pruneDue();
  if (running.size === 0 && due.size === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.allSettled([...running.values(), ...[...due.values()].map((d) => d.done)]),
    new Promise<void>((resolve) => { timer = setTimeout(resolve, maxMs); timer.unref?.(); }),
  ]).finally(() => clearTimeout(timer));
}

/** One handover per host at a time; a call while one runs joins it. */
export function runOfflineHandover(conn: HandoverConnection): Promise<HandoverResult> {
  const existing = running.get(conn.hostKey);
  if (existing) return existing;
  const startedAt = Date.now();
  const job = handover(conn).finally(() => {
    running.delete(conn.hostKey);
    // Only a drain that began after the nudge has seen what the nudge was about.
    const d = due.get(conn.hostKey);
    if (d && d.at <= startedAt) { due.delete(conn.hostKey); d.resolve(); }
  });
  running.set(conn.hostKey, job);
  return job;
}

/** Tests only. */
export function _resetOfflineHandoverForTesting(): void {
  running.clear();
  resumesToRescue.clear();
  for (const d of due.values()) d.resolve();
  due.clear();
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
        if (record.kind === 'op') unapplied.push({ callerSid: record.callerSid, op: record.op, taskId: String(record.args?.id ?? record.args?.task ?? ''), reason });
      }
      upTo = Math.max(upTo, record.seq);
    }
    // The next drain returns what was written during this round (or nothing).
    await conn.send('offline.ack', { home: WALNUT_HOME, upTo }, RPC_TIMEOUT_MS);
  }
  if (stopsToRun.delete(conn.hostKey)) {
    try {
      await (await import('./sessions/session-stop.js')).sessionStops.flush(conn.hostKey);
    } catch (err) {
      // Each stays pending on its record; the next connect runs it again.
      log.session.warn('offline handover: the stops the companion sent did not run yet', { host: conn.hostKey, error: err instanceof Error ? err.message : String(err) });
    }
  }
  const resumed = resumesToRescue.get(conn.hostKey);
  resumesToRescue.delete(conn.hostKey);
  if (resumed && resumed.size > 0) {
    try {
      await conn.rescue?.([...resumed]);
    } catch (err) {
      // Best effort: the record says stopped until a reconnect looks at the session again.
      log.session.warn('offline handover: could not look at the sessions the host resumed', { host: conn.hostKey, error: err instanceof Error ? err.message : String(err) });
    }
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
      // A Board write made on the host (offline-board-core.ts): replayed through
      // the same op, whose own checks decide (an edit whose text moved on is
      // refused, and the writer is told). There is no updated_at race to judge
      // here: nobody writes a board's html on this side while its team is away.
      if (record.op.startsWith('board_')) {
        const { executeOp } = await import('../ops/index.js');
        const { hostOrigin } = await import('../lib/caller-origin.js');
        const r = await executeOp(record.op, record.args, { callerSid: record.callerSid, callerHost: host, origin: hostOrigin(host) });
        if (!r.ok) throw r.unreachable ? new Error(r.message) : new RefusedWrite(r.message);
        result.replayed++;
        log.session.info('offline handover: board write applied', { host, op: record.op, boardTaskId: String(record.args.task ?? ''), callerSid: record.callerSid });
        return;
      }
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
    case 'settings': {
      // The companion changed a live session's model, effort or permission mode
      // while it led. The CLI already runs with it; the record keeps it for a
      // cold resume.
      const patch: { cliModel?: string; effort?: SessionEffort } = {};
      if (typeof record.cliModel === 'string' && record.cliModel) patch.cliModel = record.cliModel;
      if (typeof record.effort === 'string' && VALID_SESSION_EFFORT_IDS.has(record.effort)) patch.effort = record.effort as SessionEffort;
      const mode = typeof record.mode === 'string' && VALID_SESSION_MODE_IDS.has(record.mode) ? record.mode as SessionMode : undefined;
      if (!patch.cliModel && !patch.effort && !mode) return;
      const { updateSessionRecord, getSessionByClaudeId } = await import('./session-tracker.js');
      if (patch.cliModel || patch.effort) await updateSessionRecord(record.sid, patch);
      if (mode) {
        // The same write as the Mac's own mode change: the task's plan and
        // exec slots follow the mode.
        const existing = await getSessionByClaudeId(record.sid);
        if (existing) await (await import('./sessions/session-lifecycle.js')).persistSessionModeChange(existing, record.sid, mode);
      }
      // A live session object here would write its own (older) values back; it
      // also reads back what the CLI now runs, as the Mac's own change does.
      const { sessionRunner } = await import('../providers/claude-code-session.js');
      const live = sessionRunner.findByClaudeId(record.sid);
      if (live) {
        live.adoptAppliedSettings({ ...patch, ...(mode ? { mode } : {}) });
        if (patch.cliModel || patch.effort) void live.refreshAppliedSettings('companion-settings').catch(() => null);
      }
      result.replayed++;
      log.session.info('offline handover: settings the companion applied are kept', { host, sessionId: record.sid, ...patch, ...(mode ? { mode } : {}) });
      return;
    }
    case 'resume': {
      // The host started a stopped session again to hand it a trigger fire no
      // server claimed (the fire itself is recorded from the trigger's replay).
      // Our record still says stopped; handover() has the connection look at it.
      const set = resumesToRescue.get(host) ?? new Set<string>();
      set.add(record.sid);
      resumesToRescue.set(host, set);
      result.replayed++;
      log.session.info('offline handover: the host resumed a stopped session for a trigger fire', { host, sessionId: record.sid, taskId: record.taskId, messageId: record.messageId });
      return;
    }
    case 'stop': {
      // The user stopped the session through the companion while it led. It
      // becomes this server's own stop request, same id and time, so the phone's
      // next message is fenced by the stop it saw; handover() then runs it
      // through the usual stop path, which parks the queued messages and finds
      // the process already gone.
      const { getSessionByClaudeId, updateSessionRecord } = await import('./session-tracker.js');
      const existing = await getSessionByClaudeId(record.sid);
      if (!existing) return;
      const mine = Date.parse(existing.stopRequest?.requestedAt ?? '');
      if (existing.stopRequest && (existing.stopRequest.id === record.stopRequestId || (Number.isFinite(mine) && mine >= Date.parse(record.requestedAt)))) {
        result.skipped++;
        return;
      }
      await updateSessionRecord(record.sid, { stopRequest: { id: record.stopRequestId, requestedAt: record.requestedAt, state: 'pending' } });
      stopsToRun.add(host);
      result.replayed++;
      log.session.info('offline handover: a stop the companion sent is recorded', { host, sessionId: record.sid, stopRequestId: record.stopRequestId });
      return;
    }
  }
}

/** Hosts whose drained stops this handover still runs (handover()). */
const stopsToRun = new Set<string>();
/** Sessions a host resumed itself, by host, that this handover still looks at (handover()). */
const resumesToRescue = new Map<string, Set<string>>();

/** The session (and task) a record is about, for the log line and the card's lifecycle. */
async function recordScope(record: OfflineRecord): Promise<{ sessionId?: string; taskId?: string }> {
  switch (record.kind) {
    case 'op': return { sessionId: record.callerSid, taskId: String(record.args?.id ?? record.args?.task ?? '') || undefined };
    case 'row': return { sessionId: record.row.fromSessionId };
    case 'delivery': return { sessionId: record.toSessionId };
    case 'settings': return { sessionId: record.sid };
    case 'stop': return { sessionId: record.sid };
    case 'resume': return { sessionId: record.sid, taskId: record.taskId };
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
