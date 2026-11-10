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
 *
 * The ask itself is no turn (2026-11-09, cost review): the side question's stream lines reach the
 * session record a minute or three after the answer, as a status change with nothing run, so its
 * last_status_change moved past the answer and the next pass read a new turn end to ask about. 124
 * sessions were asked every 30 to 90 minutes for days, each ask on a cold prompt cache rewriting
 * the whole conversation (about $2.40 a time, $700 a day). A turn of the task's work makes a
 * main-loop request; a side question makes none (`promptCache.requestAt` is the last one's start),
 * so a status change within minutes of an answer about the turn that held the last request is that
 * answer's echo, and the per-turn cap counts asks by that request, not by a status change the asks
 * themselves make.
 *
 * The asks are counted on disk (cache/status-reconcile.json, never synced), because production
 * restarts with every deploy, and on 2026-11-10 it restarted every 20 to 30 minutes: a count held
 * in memory started at zero after each one, so the same session was asked about the same turn
 * five minutes after every restart.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { log } from '../../logging/index.js';
import type { SessionRecord, Task } from '../types.js';
import { isAcpEngine } from '../agents/engine-registry.js';
import { STATUS_RULE_VERSION } from '../user-status.js';
import { QUIET_TURN_MAX_MS } from './quiet-turn.js';

export const RECONCILE_EVERY_MS = 5 * 60_000;
/** A session asked by the loop is not asked by it again for this long. */
export const RETRY_GAP_MS = 30 * 60_000;
/** A status this much older than the turn end it should describe is missed (the ask takes seconds). */
const MISSED_AFTER_MS = 2 * 60_000;
const PER_PASS = 4;
/** Asks for one turn end at most; then it waits for the session's next turn. */
const MAX_PER_TURN_END = 2;

type Asked = { at: number; ended: number; n: number };
const lastAsked = new Map<string, Asked>();
/** An ask this old no longer holds anything back (RETRY_GAP_MS and a turn's cap are long past). */
const KEEP_ASKED_MS = 3 * 24 * 3_600_000;
let loaded = false;

async function askedFile(): Promise<string> {
  const { WALNUT_HOME } = await import('../../constants.js');
  return path.join(WALNUT_HOME, 'cache', 'status-reconcile.json');
}

/** The asks counted before a restart. */
async function loadAsked(nowMs: number): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const raw = JSON.parse(await fs.readFile(await askedFile(), 'utf8')) as { asked?: Record<string, Partial<Asked>> };
    for (const [sid, a] of Object.entries(raw.asked ?? {})) {
      if (lastAsked.has(sid) || typeof a?.at !== 'number' || typeof a.ended !== 'number' || typeof a.n !== 'number') continue;
      if (nowMs - a.at > KEEP_ASKED_MS) continue;
      lastAsked.set(sid, { at: a.at, ended: a.ended, n: a.n });
    }
  } catch { /* none yet, or unreadable: start counting afresh */ }
}

async function saveAsked(nowMs: number): Promise<void> {
  try {
    for (const [sid, a] of lastAsked) if (nowMs - a.at > KEEP_ASKED_MS) lastAsked.delete(sid);
    const file = await askedFile();
    await fs.mkdir(path.dirname(file), { recursive: true });
    const { writeFileAtomic } = await import('../config-store.js');
    await writeFileAtomic(file, JSON.stringify({ version: 1, asked: Object.fromEntries(lastAsked) }));
  } catch (err) {
    log.session.warn('status reconcile: asks not saved', { error: err instanceof Error ? err.message : String(err) });
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
let passRunning = false;

/** Whether a task's stored status misses its session's last turn. Pure; exported for tests. */
export function statusMissed(
  task: Pick<Task, 'phase' | 'status' | 'status_report' | 'plugin_only'>,
  session: Pick<SessionRecord, 'process_status' | 'last_status_change' | 'provider' | 'archived' | 'lane' | 'engine' | 'idleCompaction' | 'promptCache'>,
  nowMs: number,
): number | null {
  if (task.phase === 'COMPLETE' || task.status === 'done' || task.plugin_only) return null;
  if (session.archived || session.process_status !== 'idle') return null;
  // An embedded subagent and a Personal AI chat lane have no status of their own.
  if (session.provider === 'embedded' || session.lane?.startsWith('chat:')) return null;
  if (isAcpEngine(session.engine)) return null;
  const ended = lastWorkTurnEnd(session);
  if (!Number.isFinite(ended) || nowMs - ended < MISSED_AFTER_MS) return null;
  const said = Date.parse(task.status_report?.turn_ended_at ?? task.status_report?.at ?? '');
  if ((!Number.isFinite(said) || said < ended - MISSED_AFTER_MS) && !isAnswerEcho(task, session, ended)) return ended;
  // A wait reported under the rules before 2026-11-02 may be the task's own build or test run, which
  // reads Working now: asked once again under the current rules (MAX_PER_TURN_END bounds it).
  return reportUnderOldWaitRule(task.status_report) ? ended : null;
}

/** A side question's own stream lines reach the record within minutes of its answer (3.5 measured under load). */
export const ASK_ECHO_MS = 10 * 60_000;

/**
 * True when the status change at `ended` is the echo of the stored answer rather than a turn: the
 * answer describes a turn that held the session's last main-loop request (a mid-turn answer keeps
 * the turn end before it, so it does not count), and the change came within ASK_ECHO_MS of it. A
 * real turn after the answer makes a new request (the answer no longer covers it), and a record
 * whose request was not stored (a turn replayed after a restart) is only mistaken inside that window.
 * Unknown (no request recorded, no answer time) is false, so the turn-end rule decides.
 */
export function isAnswerEcho(
  task: Pick<Task, 'status_report'>, session: Pick<SessionRecord, 'promptCache'>, ended: number,
): boolean {
  const request = Date.parse(session.promptCache?.requestAt ?? '');
  const answered = Date.parse(task.status_report?.at ?? '');
  const about = Date.parse(task.status_report?.turn_ended_at ?? task.status_report?.at ?? '');
  if (![request, answered, about].every(Number.isFinite)) return false;
  return about >= request && answered >= request && ended <= answered + ASK_ECHO_MS;
}

/** The turn a missed status belongs to: its last main-loop request when known, else its last status change. */
function turnKey(session: Pick<SessionRecord, 'promptCache'>, ended: number): number {
  const request = Date.parse(session.promptCache?.requestAt ?? '');
  return Number.isFinite(request) ? request : ended;
}

/**
 * When the session's last turn that was the task's work ended. Walnut's idle compaction
 * (sessions/idle-compaction.ts) is a quiet turn: its end moves last_status_change, so a status
 * change since it was sent reads as the turn before it.
 */
export function lastWorkTurnEnd(session: Pick<SessionRecord, 'last_status_change' | 'idleCompaction'>): number {
  const ended = Date.parse(session.last_status_change ?? '');
  const ic = session.idleCompaction;
  const sent = Date.parse(ic?.sentAt ?? '');
  if (!Number.isFinite(sent) || !Number.isFinite(ended) || ended < sent) return ended;
  // A change well after the compaction's own end is a later turn of the task's. With no end stored
  // (a restart, a lost write), the quiet turn lasted at most QUIET_TURN_MAX_MS.
  const storedEnd = Date.parse(ic?.endedAt ?? '');
  const quietEnd = Number.isFinite(storedEnd) ? storedEnd : sent + QUIET_TURN_MAX_MS;
  if (ended > quietEnd + QUIET_END_SLACK_MS) return ended;
  return Date.parse(ic?.priorTurnEnd ?? '');
}
/** The runner writes the quiet turn's own status change a moment after its end is stored. */
const QUIET_END_SLACK_MS = 30_000;

/** A self-reported wait (outside or other) asked before STATUS_RULE_VERSION. Pure. */
export function reportUnderOldWaitRule(r: Task['status_report'] | undefined): boolean {
  if (!r || r.by || r.state !== 'waiting' || (r.rule ?? 1) >= STATUS_RULE_VERSION) return false;
  return !r.waiting_kind || r.waiting_kind === 'outside' || r.waiting_kind === 'other';
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
    // The org is off (org/org-enabled.ts): Main and the VPs are asked nothing.
    const { isOrgEnabled, isOrgNode } = await import('../org/org-enabled.js');
    const orgOff = !(await isOrgEnabled());
    await loadAsked(nowMs);
    for (const s of await listSessionsForTasks(new Set(byId.keys()))) {
      if (asked.length >= PER_PASS) break;
      const task = s.taskId ? byId.get(s.taskId) : undefined;
      if (!task || quieted.has(task.id) || (orgOff && isOrgNode(task))) continue;
      const ended = statusMissed(task, s, nowMs);
      if (ended === null) continue;
      const last = lastAsked.get(s.claudeSessionId);
      if (last && nowMs - last.at < RETRY_GAP_MS) continue;
      const turn = turnKey(s, ended);
      if (last && last.ended === turn && last.n >= MAX_PER_TURN_END) continue;
      // After a server restart the runner holds only the sessions it reconnected: attach on
      // demand, as a normal send does. A process that is gone is never started for it.
      if (!(await sessionRunner.getOrAttachLiveSession(s.claudeSessionId).catch(() => undefined))) continue;
      lastAsked.set(s.claudeSessionId, { at: nowMs, ended: turn, n: last?.ended === turn ? last.n + 1 : 1 });
      await saveAsked(nowMs);
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
  // As a restart does: the counted asks are read back from disk at the next pass.
  lastAsked.clear();
  loaded = false;
  passRunning = false;
}

/** Tests: forget every counted ask, on disk too. */
export async function __resetStatusReconcile(): Promise<void> {
  stopStatusReconcile();
  await fs.rm(await askedFile(), { force: true }).catch(() => {});
}
