/**
 * The reconcile loop for a task's status words (2026-10-31, the user: like Kubernetes, a loop
 * that keeps the actual state where the desired state says, so a missed answer is asked again).
 * The turn-end status question (status-question.ts) can miss: the answer timed out, the server
 * restarted between the turn end and the ask, the CLI was busy. Every RECONCILE_EVERY_MS the
 * primary looks at each open task whose native Claude Code session is alive and idle, and asks
 * again when its stored status is older than that session's last turn end (or there is none).
 *
 * A stopped session is never woken for it: its task keeps its last answer, read with its age (the
 * status's `stale` mark), and the four-hour re-check of an ask (needs-recheck.ts) still runs. One
 * ask per session per RETRY_GAP_MS at most, at most MAX_PER_TURN_END for one turn end (an answer
 * that never reads is not asked all day), at most PER_PASS per pass and one pass at a time, so a
 * host coming back with many sessions is caught up over a few passes, never in one burst. A
 * Personal AI chat lane has no status of its own (the turn-end hook skips it too), and an ACP
 * engine answers a hidden ask with a turn of its own, so neither is asked. The same tick runs out
 * the watches set on tasks (task-watch.ts).
 */
import { log } from '../../logging/index.js';
import type { SessionRecord, Task } from '../types.js';
import { isAcpEngine } from '../agents/engine-registry.js';

export const RECONCILE_EVERY_MS = 5 * 60_000;
/** A session asked by the loop is not asked by it again for this long. */
export const RETRY_GAP_MS = 30 * 60_000;
/** A status this much older than the turn end it should describe is missed (the ask takes seconds). */
const MISSED_AFTER_MS = 2 * 60_000;
const PER_PASS = 4;
/** Asks for one turn end at most; then it waits for the session's next turn. */
const MAX_PER_TURN_END = 2;

const lastAsked = new Map<string, { at: number; ended: number; n: number }>();
let timer: ReturnType<typeof setInterval> | null = null;
let passRunning = false;

/** Whether a task's stored status misses its session's last turn. Pure; exported for tests. */
export function statusMissed(
  task: Pick<Task, 'phase' | 'status' | 'status_report' | 'plugin_only'>,
  session: Pick<SessionRecord, 'process_status' | 'last_status_change' | 'provider' | 'archived' | 'lane' | 'engine'>,
  nowMs: number,
): number | null {
  if (task.phase === 'COMPLETE' || task.status === 'done' || task.plugin_only) return null;
  if (session.archived || session.process_status !== 'idle') return null;
  // An embedded subagent and a Personal AI chat lane have no status of their own.
  if (session.provider === 'embedded' || session.lane?.startsWith('chat:')) return null;
  if (isAcpEngine(session.engine)) return null;
  const ended = Date.parse(session.last_status_change ?? '');
  if (!Number.isFinite(ended) || nowMs - ended < MISSED_AFTER_MS) return null;
  const said = Date.parse(task.status_report?.turn_ended_at ?? task.status_report?.at ?? '');
  return !Number.isFinite(said) || said < ended - MISSED_AFTER_MS ? ended : null;
}

/** One pass. Returns the task ids asked. Exported for tests. */
export async function runStatusReconcile(nowMs = Date.now()): Promise<string[]> {
  const asked: string[] = [];
  if (passRunning) return asked;
  passRunning = true;
  try {
    const { listTasks } = await import('../task-manager.js');
    const { listSessionsForTasks } = await import('../session-tracker.js');
    const { sessionRunner } = await import('../../providers/claude-code-session.js');
    const { askStatus } = await import('./status-question.js');
    const open = (await listTasks()).filter((t) => t.phase !== 'COMPLETE' && t.status !== 'done' && !t.plugin_only);
    const byId = new Map(open.map((t) => [t.id, t] as const));
    const quieted = new Set(open.flatMap((t) => (t.team_stop?.members ?? []).map((m) => m.id)));
    for (const s of await listSessionsForTasks(new Set(byId.keys()))) {
      if (asked.length >= PER_PASS) break;
      const task = s.taskId ? byId.get(s.taskId) : undefined;
      if (!task || quieted.has(task.id)) continue;
      const ended = statusMissed(task, s, nowMs);
      if (ended === null) continue;
      const last = lastAsked.get(s.claudeSessionId);
      if (last && nowMs - last.at < RETRY_GAP_MS) continue;
      if (last && last.ended === ended && last.n >= MAX_PER_TURN_END) continue;
      // After a server restart the runner holds only the sessions it reconnected: attach on
      // demand, as a normal send does. A process that is gone is never started for it.
      if (!(await sessionRunner.getOrAttachLiveSession(s.claudeSessionId).catch(() => undefined))) continue;
      lastAsked.set(s.claudeSessionId, { at: nowMs, ended, n: last?.ended === ended ? last.n + 1 : 1 });
      if (lastAsked.size > 2000) lastAsked.clear();
      asked.push(task.id);
      log.session.info('status reconcile: its status misses its last turn, asked again', { taskId: task.id, sessionId: s.claudeSessionId });
      await askStatus(task.id, s.claudeSessionId, ended, 'reconcile');
    }
  } catch (err) {
    log.session.warn('status reconcile pass failed', { error: err instanceof Error ? err.message : String(err) });
  } finally {
    passRunning = false;
  }
  return asked;
}

let watchRunning = false;

/** One tick: the missed statuses, then the watches that ran out (task-watch.ts). */
async function reconcileTick(): Promise<void> {
  await runStatusReconcile();
  // What the loop cannot ask (a stopped session, an ACP engine): the words its turn ended with.
  const { runLastWordsPass } = await import('./last-words.js');
  await runLastWordsPass();
  if (watchRunning) return;
  watchRunning = true;
  try {
    const { runWatchPass } = await import('./task-watch.js');
    await runWatchPass();
  } catch (err) {
    log.session.warn('task watch pass failed', { error: err instanceof Error ? err.message : String(err) });
  } finally {
    watchRunning = false;
  }
}

/** Primary only. */
export function startStatusReconcile(): void {
  if (timer) return;
  timer = setInterval(() => { void reconcileTick(); }, RECONCILE_EVERY_MS);
  timer.unref?.();
}

export function stopStatusReconcile(): void {
  if (timer) clearInterval(timer);
  timer = null;
  lastAsked.clear();
  passRunning = false;
}
