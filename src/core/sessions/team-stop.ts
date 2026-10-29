/**
 * Stop the whole team in one step (2026-10-28, the Grok Bot study, borrow point g: a stop has to
 * reach everyone who took the work over; stopping a lead left the workers it had started running,
 * and their triggers started them again an hour later).
 *
 * `stopTeam(root)` walks the open tasks under `root` (every level, the root itself too unless
 * left out) and for each one turns off everything that would start it again by itself: its
 * enabled routines and triggers (any routine whose session executor targets it), the clocks
 * that would wake it (a WAITING task's `wait_until`, a lead's `promise_alarm`), the asks its
 * sessions hold of other members (their fallback notice would resume the asker), and the Walnut
 * notices queued for it. That is recorded on the root as `Task.team_stop` BEFORE any session is
 * stopped, so a crash mid-stop still leaves a record to resume from. Then its live sessions stop
 * (the host's graceful stop, the same as Stop in the panel; never the caller's own session);
 * with `when: 'turn_end'` a session running a turn finishes it first. `resumeTeam(root)` turns
 * exactly those back on (a session resumes on its next message, as after any stop).
 *
 * A person and an agent use the same core (route POST /api/v1/tasks/:id/team-stop, ops
 * team_stop / team_resume). The subtask notices a stop would cause ("your subtask stopped") are
 * not sent for a short while: the one who stopped the team knows.
 */
import { log } from '../../logging/index.js';
import type { SessionRecord, Task } from '../types.js';

export interface TeamStopMember {
  id: string;
  title: string;
  /** Routines and triggers this stop paused (resume turns them back on). */
  triggers?: string[];
  /** Asks of other members this stop withdrew (resume puts them back to pending). */
  asks?: string[];
  /** The wait clock this stop took off. */
  wait_until?: string;
  /** The follow-up alarm this stop took off. */
  promise_alarm?: NonNullable<Task['promise_alarm']>;
}

export interface TeamStopRecord {
  at: string;
  /** "human" or "task:<id>". */
  by: string;
  when: 'now' | 'turn_end';
  members: TeamStopMember[];
}

export interface TeamStopResult {
  root: { id: string; title: string };
  /** Sessions stopped now. */
  stopped: { taskId: string; sessionId: string }[];
  /** Sessions that stop when their running turn ends. */
  atTurnEnd: { taskId: string; sessionId: string }[];
  /** Sessions left running, and why. */
  kept: { taskId: string; sessionId: string; why: string }[];
  pausedTriggers: number;
  clocksOff: number;
  tasks: number;
}

const DEPTH_CAP = 8;
/** Sessions stopped at once: a host's stop can take seconds. */
const STOP_PARALLEL = 4;
/** How long the subtask notices of a team stop are held back. */
const QUIET_MS = 2 * 60_000;
const SETTLE_MS = 3_000;

const quietUntil = new Map<string, number>();

/** A team stop just stopped this task: its parent is not told "it stopped". */
export function stoppedByTeam(taskId: string, now = Date.now()): boolean {
  const until = quietUntil.get(taskId);
  if (until === undefined) return false;
  if (until > now) return true;
  quietUntil.delete(taskId);
  return false;
}

/** The open tasks under root, root first, every level up to DEPTH_CAP. */
export function teamOf(root: Task, all: readonly Task[], includeRoot = true): Task[] {
  const children = new Map<string, Task[]>();
  for (const t of all) {
    if (t.parent_task_id && t.parent_task_id !== t.id) children.set(t.parent_task_id, [...(children.get(t.parent_task_id) ?? []), t]);
  }
  const out: Task[] = includeRoot ? [root] : [];
  const seen = new Set([root.id]);
  const walk = (id: string, depth: number) => {
    if (depth > DEPTH_CAP) return;
    for (const c of children.get(id) ?? []) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      out.push(c);
      walk(c.id, depth + 1);
    }
  };
  walk(root.id, 1);
  return out.filter((t) => t.phase !== 'COMPLETE' && t.status !== 'done');
}

const LIVE = new Set(['running', 'idle']);

async function stopSession(sessionId: string): Promise<string | null> {
  try {
    // Loaded once by the caller before stops run in parallel (concurrent first imports of one
    // module can resolve differently under bun's test runner).
    const { terminateSession } = await lifecycle();
    const r = await terminateSession(sessionId, { force: false });
    return r.status === 'pending' ? 'its host has not confirmed the stop yet' : null;
  } catch (err) {
    const code = (err as { extra?: { code?: string } }).extra?.code;
    return code === 'cron_owner' ? 'it owns scheduled jobs (stop it by itself with force)' : err instanceof Error ? err.message : String(err);
  }
}

let lifecycleMod: Promise<typeof import('./session-lifecycle.js')> | null = null;
const lifecycle = () => (lifecycleMod ??= import('./session-lifecycle.js'));

// ── Stops at turn end ──

interface TurnEndWait { rootId: string; at: string; taskId: string }
const turnEnd = new Map<string, TurnEndWait>();
const SUBSCRIBER = 'team-stop-turn-end';

async function watchTurnEnds(): Promise<void> {
  const { bus, EventNames } = await import('../event-bus.js');
  bus.subscribe(SUBSCRIBER, (event) => {
    const data = event.data as { sessionId?: string; process_status?: string } | undefined;
    const sid = data?.sessionId;
    const wait = sid ? turnEnd.get(sid) : undefined;
    if (!sid || !wait || !data?.process_status || data.process_status === 'running') return;
    turnEnd.delete(sid);
    void stopAtTurnEnd(sid, wait);
  }, { global: true, interest: [EventNames.SESSION_STATUS_CHANGED] });
}

async function stopAtTurnEnd(sessionId: string, wait: TurnEndWait): Promise<void> {
  try {
    // A background command's follow-up turn starts about 0.1 s after the turn ends.
    await new Promise((r) => setTimeout(r, SETTLE_MS).unref?.());
    const { getTask } = await import('../task-manager.js');
    const root = await getTask(wait.rootId).catch(() => null);
    // Resumed (or stopped again since): this wait is over.
    if (root?.team_stop?.at !== wait.at) return;
    const { getSessionByClaudeId } = await import('../session-tracker.js');
    const rec = await getSessionByClaudeId(sessionId).catch(() => null);
    if (rec?.process_status === 'running') { turnEnd.set(sessionId, wait); return; }
    if (!rec || !LIVE.has(rec.process_status)) return;
    quietUntil.set(wait.taskId, Date.now() + QUIET_MS);
    const why = await stopSession(sessionId);
    log.session.info('team stop: session stopped at its turn end', { rootId: wait.rootId, taskId: wait.taskId, sessionId, ...(why ? { kept: why } : {}) });
  } catch (err) {
    log.session.warn('team stop at turn end failed', { sessionId, error: err instanceof Error ? err.message : String(err) });
  }
}

/** Test seam. */
export function _turnEndStopsForTest(): string[] {
  return [...turnEnd.keys()];
}

export function _resetTeamStopForTest(): void {
  turnEnd.clear();
  quietUntil.clear();
}

// ── Stop / resume ──

/** Every enabled routine (trigger or clock) whose session executor targets one of `ids`. */
async function routinesFor(ids: ReadonlySet<string>): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  try {
    const { listRoutines } = await import('../routines/routines-core.js');
    const { jobs } = await listRoutines(true);
    for (const job of jobs as { id: string; enabled?: boolean; executor?: { type?: string; config?: { target?: unknown } } }[]) {
      const target = job.executor?.type === 'session' && typeof job.executor.config?.target === 'string' ? job.executor.config.target.trim() : '';
      if (!target || !ids.has(target) || job.enabled === false) continue;
      out.set(target, [...(out.get(target) ?? []), job.id]);
    }
  } catch (err) {
    log.session.warn('team stop: routines not listed', { error: err instanceof Error ? err.message : String(err) });
  }
  return out;
}

async function inBatches<T>(items: readonly T[], size: number, run: (item: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(run));
}

export async function stopTeam(rootRef: string, opts: {
  by: string; callerSid?: string; when?: 'now' | 'turn_end'; includeRoot?: boolean;
}): Promise<TeamStopResult> {
  const { getTask, listTasks, updateTaskRaw } = await import('../task-manager.js');
  const root = await getTask(rootRef);
  const members = teamOf(root, await listTasks(), opts.includeRoot !== false);
  const memberIds = new Set(members.map((t) => t.id));
  const when = opts.when ?? 'now';
  const at = new Date().toISOString();
  const result: TeamStopResult = { root: { id: root.id, title: root.title }, stopped: [], atTurnEnd: [], kept: [], pausedTriggers: 0, clocksOff: 0, tasks: members.length };
  const { getSessionsForTask } = await import('../session-tracker.js');
  const { patchRoutine } = await import('../routines/routines-core.js');
  const requests = await import('../session-requests.js');
  const queue = await import('../session-message-queue.js');
  const { noticeSubjects } = await import('./subtask-notices.js');
  const routines = await routinesFor(memberIds);
  const recorded: TeamStopMember[] = [];
  const live: { task: Task; session: SessionRecord }[] = [];

  // 1. Everything that would start a member again by itself.
  for (const task of members) {
    const member: TeamStopMember = { id: task.id, title: task.title };
    for (const id of routines.get(task.id) ?? []) {
      try {
        await patchRoutine(id, { enabled: false }, 'team-stop');
        member.triggers = [...(member.triggers ?? []), id];
        result.pausedTriggers++;
      } catch (err) {
        log.session.warn('team stop: routine not paused', { taskId: task.id, routineId: id, error: err instanceof Error ? err.message : String(err) });
      }
    }
    // null, never undefined: a payload field set to undefined is not written (task-db.ts).
    const clocks: Record<string, unknown> = {};
    if (task.wait_until && task.phase === 'WAITING') { member.wait_until = task.wait_until; clocks.wait_until = null; }
    if (task.promise_alarm) { member.promise_alarm = task.promise_alarm; clocks.promise_alarm = null; }
    if (Object.keys(clocks).length) {
      const res = await updateTaskRaw(task.id, clocks as Partial<Task>, { emitEvent: true, push: false, source: 'team-stop' }).catch(() => null);
      if (res?.changed) result.clocksOff++;
    }
    const sessions = await getSessionsForTask(task.id).catch(() => [] as SessionRecord[]);
    for (const s of sessions) {
      // Its asks of other members: a stopped member's turn end would settle them with a notice
      // that resumes this (stopped) asker. Withdrawn, kept here, put back on resume.
      for (const r of await requests.pendingRequestsFromSession(s.claudeSessionId).catch(() => [])) {
        if (r.toTaskId && memberIds.has(r.toTaskId) && await requests.withdrawRequest(r.id).catch(() => null)) {
          member.asks = [...(member.asks ?? []), r.id];
        }
      }
      // Walnut's notices about its subtasks still queued for it would run on the next drain.
      for (const m of await queue.getQueue(s.claudeSessionId).catch(() => [])) {
        if (m.status === 'pending' && noticeSubjects(m.message).length > 0) await queue.deleteMessage(s.claudeSessionId, m.id).catch(() => false);
      }
      if (LIVE.has(s.process_status)) live.push({ task, session: s });
    }
    if (member.triggers || member.wait_until || member.promise_alarm || member.asks) recorded.push(member);
  }

  // 2. The record, merged with a stop not resumed yet (theirs and ours both come back on resume).
  const record: TeamStopRecord = { at, by: opts.by, when, members: recorded };
  await updateTaskRaw(root.id, (cur) => {
    const byId = new Map((cur.team_stop?.members ?? []).map((m) => [m.id, { ...m }] as const));
    for (const m of recorded) {
      const was = byId.get(m.id);
      byId.set(m.id, was ? {
        ...was, ...m,
        triggers: [...new Set([...(was.triggers ?? []), ...(m.triggers ?? [])])],
        asks: [...new Set([...(was.asks ?? []), ...(m.asks ?? [])])],
        wait_until: was.wait_until ?? m.wait_until,
        promise_alarm: was.promise_alarm ?? m.promise_alarm,
      } : m);
    }
    return { team_stop: { ...record, members: [...byId.values()] } };
  }, { emitEvent: true, push: false, source: 'team-stop' });

  // 3. The sessions.
  await inBatches(live, STOP_PARALLEL, async ({ task, session: s }) => {
    const ref = { taskId: task.id, sessionId: s.claudeSessionId };
    if (s.claudeSessionId === opts.callerSid) { result.kept.push({ ...ref, why: 'it is the session that asked for the stop' }); return; }
    // Its own turn end must not tell its parent "it stopped" either.
    quietUntil.set(task.id, Date.now() + QUIET_MS);
    if (when === 'turn_end' && s.process_status === 'running') {
      turnEnd.set(s.claudeSessionId, { rootId: root.id, at, taskId: task.id });
      result.atTurnEnd.push(ref);
      return;
    }
    const why = await stopSession(s.claudeSessionId);
    if (why) result.kept.push({ ...ref, why }); else result.stopped.push(ref);
  });
  if (result.atTurnEnd.length) await watchTurnEnds();
  log.session.info('team stopped', {
    rootId: root.id, by: opts.by, when, tasks: members.length, stopped: result.stopped.length,
    atTurnEnd: result.atTurnEnd.length, kept: result.kept.length, pausedTriggers: result.pausedTriggers, clocksOff: result.clocksOff,
  });
  return result;
}

export interface TeamResumeResult {
  root: { id: string; title: string };
  resumedTriggers: number;
  clocksOn: number;
  /** Members the stop recorded that are closed or gone now: left alone. */
  skipped: number;
}

export async function resumeTeam(rootRef: string, opts: { by: string }): Promise<TeamResumeResult> {
  const { getTask, listTasksByIds, updateTaskRaw } = await import('../task-manager.js');
  const root = await getTask(rootRef);
  const record = root.team_stop;
  const result: TeamResumeResult = { root: { id: root.id, title: root.title }, resumedTriggers: 0, clocksOn: 0, skipped: 0 };
  if (!record) return result;
  for (const [sid, w] of turnEnd) if (w.rootId === root.id) turnEnd.delete(sid);
  const { patchRoutine } = await import('../routines/routines-core.js');
  const requests = await import('../session-requests.js');
  const byId = new Map((await listTasksByIds(record.members.map((m) => m.id)).catch(() => [] as Task[])).map((t) => [t.id, t] as const));
  for (const m of record.members) {
    const task = byId.get(m.id);
    if (!task || task.phase === 'COMPLETE' || task.status === 'done') { result.skipped++; continue; }
    for (const id of m.triggers ?? []) {
      try {
        await patchRoutine(id, { enabled: true }, 'team-resume');
        result.resumedTriggers++;
      } catch (err) {
        log.session.warn('team resume: trigger not resumed', { taskId: m.id, triggerId: id, error: err instanceof Error ? err.message : String(err) });
      }
    }
    for (const id of m.asks ?? []) await requests.restoreRequest(id).catch(() => null);
    const clocks: Partial<Task> = {};
    // Only onto a task still waiting with no clock of its own; a clock already past fires at once.
    if (m.wait_until && task.phase === 'WAITING' && !task.wait_until) clocks.wait_until = m.wait_until;
    if (m.promise_alarm && !task.promise_alarm) clocks.promise_alarm = m.promise_alarm;
    if (Object.keys(clocks).length) {
      const res = await updateTaskRaw(m.id, clocks, { emitEvent: true, push: false, source: 'team-resume' }).catch(() => null);
      if (res?.changed) result.clocksOn++;
    }
  }
  await updateTaskRaw(root.id, { team_stop: null }, { emitEvent: true, push: false, source: 'team-resume' });
  log.session.info('team resumed', { rootId: root.id, by: opts.by, ...result });
  return result;
}
