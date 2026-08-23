/**
 * Agent time — derived from turn results that already exist. No new
 * instrumentation, and never anything from the browser.
 *
 * GO-FORWARD SOURCE: the `session:result` bus event carries the CLI's own
 * `result.duration_ms` for the turn that just finished, for BOTH the claude-code
 * path and the ACP/SDK path. A global subscriber with an interest set never
 * wakes on streaming events.
 *
 * WHAT THE NUMBER MEANS (asked in earnest after a task showed 8h57m of agent time
 * on a day its human touched it for two minutes): `duration_ms` is the WALL TIME
 * OF ONE TURN as the CLI measured it — prompt to result, including tool runs and
 * any stretch the turn sat blocked (a permission prompt, a slow build). It is not
 * "model thinking time", and it is not the human's time. Turns within one session
 * are sequential, so one session can never bank more than the clock; several
 * sessions on the SAME task run in parallel and legitimately sum past it, which
 * is why the panel labels this lane and says agents can run in parallel.
 * Double counting is prevented at two points instead: intermediate results
 * (teamActive / backgroundActive) contribute 0 because the turn is not over, and
 * replayKey drops a re-emit of a turn already banked.
 *
 * BACKFILL: days the collector never observed (before this feature shipped, or
 * a server that was down) fall back to the usage ledger, which stores
 * `duration_ms` per billed turn. That ledger only gets a row when a turn cost
 * money, so it UNDERCOUNTS cache-replayed turns, and its `date` column is UTC
 * while ours is local — the backfill is therefore approximate and is used only
 * for days with no observed agent buckets at all.
 */

import { bus, EventNames } from '../event-bus.js';
import { log } from '../../logging/index.js';
import { addRecord, datesWithAgentTime, localDateKey, mergeIndex } from './rollup.js';
import { recordTime } from './store.js';
import type { RollupIndex, TimeRecord } from './types.js';

const SUBSCRIBER = 'time-tracking-agent';
/** A turn longer than this is a stuck process, not attention. */
const MAX_TURN_MS = 6 * 60 * 60 * 1000;
/** Replay guard: remember recent turn identities (see replayKey). */
const SEEN_LIMIT = 500;

const seenTurns = new Set<string>();

export interface ResultLike {
  sessionId?: string;
  taskId?: string;
  duration?: number;
  turnGen?: number;
  teamActive?: boolean;
  backgroundActive?: boolean;
}

/** Decide whether a result event contributes agent time, and how much. PURE. */
export function agentMsFromResult(ev: ResultLike): number {
  // teamActive / backgroundActive mean the turn is NOT over — counting these
  // intermediate results would bill the same wall time several times.
  if (ev.teamActive || ev.backgroundActive) return 0;
  const ms = typeof ev.duration === 'number' && Number.isFinite(ev.duration) ? Math.round(ev.duration) : 0;
  if (ms <= 0) return 0;
  return Math.min(ms, MAX_TURN_MS);
}

/**
 * Identity of one turn, for the replay guard. `null` when the event carries no
 * turn generation (nothing to dedup on — count it).
 *
 * `turnGen` counts from 0 on the EMITTING INSTANCE, and a resume/restart builds a
 * fresh instance for the same claudeSessionId while `seenTurns` lives as long as
 * the process. On `${sessionId}:${turnGen}` alone, every first turn after a resume
 * looked like a replay of the pre-resume turn 0 and its agent time was silently
 * dropped. The turn's own reported duration separates two different turns (a
 * genuine re-emit of the SAME result repeats it to the millisecond).
 */
export function replayKey(ev: ResultLike): string | null {
  if (typeof ev.turnGen !== 'number' || !ev.sessionId) return null;
  const dur = typeof ev.duration === 'number' && Number.isFinite(ev.duration) ? Math.round(ev.duration) : 0;
  return `${ev.sessionId}:${ev.turnGen}:${dur}`;
}

function alreadySeen(ev: ResultLike): boolean {
  const key = replayKey(ev);
  if (key === null) return false;
  if (seenTurns.has(key)) return true;
  seenTurns.add(key);
  if (seenTurns.size > SEEN_LIMIT) {
    // Drop the oldest insertion — Set preserves insertion order.
    const oldest = seenTurns.values().next().value;
    if (oldest !== undefined) seenTurns.delete(oldest);
  }
  return false;
}

/** Resolve the task a session belongs to. Returns '' when there is none. */
async function resolveTaskId(sessionId: string): Promise<string> {
  try {
    const { getSessionByClaudeId } = await import('../session-tracker.js');
    const record = await getSessionByClaudeId(sessionId);
    return record?.taskId ?? '';
  } catch {
    return '';
  }
}

/**
 * Subscribe the agent-time collector. Idempotent — re-registering under the
 * same subscriber name replaces the previous handler, so a server restart in
 * the same process never doubles up.
 */
export function startAgentTimeCollector(): void {
  bus.subscribe(SUBSCRIBER, (event) => {
    const ev = (event.data ?? {}) as ResultLike;
    const ms = agentMsFromResult(ev);
    if (ms <= 0 || !ev.sessionId) return;
    if (alreadySeen(ev)) return;
    void bank(ev, ms);
  }, { global: true, interest: [EventNames.SESSION_RESULT] });
}

export function stopAgentTimeCollector(): void {
  bus.unsubscribe(SUBSCRIBER);
  seenTurns.clear();
}

async function bank(ev: ResultLike, ms: number): Promise<void> {
  try {
    const sessionId = ev.sessionId!;
    // The ACP/SDK emitter does not carry taskId — one indexed lookup fills it.
    const taskId = ev.taskId || await resolveTaskId(sessionId);
    const now = new Date();
    const rec: TimeRecord = {
      date: localDateKey(now),
      ts: now.toISOString(),
      durationMs: ms,
      kind: 'agent',
      sessionId,
      ...(taskId ? { taskId } : {}),
    };
    await recordTime([rec]);
  } catch (err) {
    log.web.warn('agent time not recorded', {
      sessionId: ev.sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Layer usage-ledger agent time under the observed rollup, for days the
 * collector never saw. Mutates and returns `index`. Best-effort: any failure
 * leaves the observed data untouched.
 */
export async function withLedgerBackfill(index: RollupIndex, days: readonly string[]): Promise<RollupIndex> {
  const observed = datesWithAgentTime(index);
  const missing = days.filter((d) => !observed.has(d));
  if (missing.length === 0) return index;
  try {
    const { usageTracker } = await import('../usage/index.js');
    const earliest = missing.reduce((a, b) => (a < b ? a : b));
    const rows = usageTracker.getTurnDurationsByDay(earliest);
    const backfill: RollupIndex = new Map();
    const wanted = new Set(missing);
    for (const row of rows) {
      if (!wanted.has(row.date) || row.durationMs <= 0) continue;
      addRecord(backfill, {
        date: row.date,
        ts: `${row.date}T12:00:00.000Z`,
        durationMs: row.durationMs,
        kind: 'agent',
        ...(row.taskId ? { taskId: row.taskId } : {}),
      });
    }
    return mergeIndex(index, backfill);
  } catch (err) {
    log.web.warn('time-tracking ledger backfill skipped', {
      error: err instanceof Error ? err.message : String(err),
    });
    return index;
  }
}
