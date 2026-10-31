/**
 * The standing check that every surface shows a task as its facts say (2026-10-30, the user, after a
 * snoozed task still showed as a red Needs you card on the Org page: "why is it still showing here?
 * That doesn't make sense ... fix the real root cause, the foundation").
 *
 * Every surface reads one stored value, `task.user_status` (user-status.ts derives it, user-status-sync.ts
 * stores it); a surface only falls back to the phase for a task with none. So what can go wrong is the
 * stored value against the facts, and the facts against the rules. Read-only, over every open task:
 *
 *   - `missing`        an open task with no stored status (every surface falls back to its phase);
 *   - `drift`          the stored state is not what the facts derive now (an event the sync missed);
 *   - `snoozed-needs`  a snoozed task (snooze.ts) stored as Needs you, a live prompt aside;
 *   - `parked-on-nothing` a WAITING task with nothing outside Walnut and the user armed or named
 *                      (sessions/outside-wait.ts): it may need the user while it is off their list.
 *
 * `runStatusCheck` (primary only, every CHECK_MS) re-derives the first three, which are Walnut's own
 * to fix, and sends a `parked-on-nothing` to the task's own session, once per park, to check it and
 * set NEED_ACTION when the next move is the user's: the task fixes itself and the user is never the
 * one who finds it. Only a park its own session's report made is told (`notify`): a park a person or
 * its lead set, or one that named its wait in `waiting_on`, is listed and left alone. Which parks
 * were told is kept on disk (WALNUT_HOME/status-check-told.json), so a restart tells none twice.
 * `status_check` (src/ops/work.ts) reads the same list.
 */
import path from 'node:path';
import fsp from 'node:fs/promises';
import { WALNUT_HOME } from '../constants.js';
import { log } from '../logging/index.js';
import type { Task } from './types.js';
import { deriveUserStatus, reportIsCurrent, type UserStatus } from './user-status.js';
import { snoozedUntil } from './snooze.js';

export type StatusMismatchKind = 'missing' | 'drift' | 'snoozed-needs' | 'parked-on-nothing';

export interface StatusMismatch {
  kind: StatusMismatchKind;
  taskId: string;
  title: string;
  /** One plain line: what each side says. */
  detail: string;
  /** parked-on-nothing: its own session's report of the latest turn made the park, so it is told. */
  notify?: boolean;
  /** parked-on-nothing: the park it is about (the phase move), so each is told once. */
  parkedAt?: string;
}

/** A task whose status moved this recently is still settling (the sync's debounce and hand-back hold). */
export const SETTLING_MS = 2 * 60_000;
const CHECK_MS = 60 * 60_000;

const open = (t: Task) => t.phase !== 'COMPLETE' && t.status !== 'done' && !t.plugin_only;
const sameShape = (a: UserStatus | undefined, b: UserStatus) => a?.state === b.state && (a?.kind ?? '') === (b.kind ?? '') && !!a?.snoozed === !!b.snoozed;

/**
 * The mismatches of the given tasks. `derive` gives what the facts say now (statusInputOf + derive);
 * `outside` whether a WAITING task has an outside wait as Walnut's facts hold it. Pure but for those.
 */
export async function findStatusMismatches(
  tasks: readonly Task[],
  deps: { derive: (t: Task) => UserStatus; outside: (t: Task) => Promise<boolean> },
  nowMs = Date.now(),
  settleMs = SETTLING_MS,
): Promise<StatusMismatch[]> {
  const out: StatusMismatch[] = [];
  const byId = new Map(tasks.map((t) => [t.id, t] as const));
  // A team stopped or quieted in one step (team-stop.ts) is not woken until it is resumed, as the
  // re-checks skip it: its triggers are paused on purpose, so its parks are no news.
  const quieted = new Set(tasks.flatMap((t) => (t.team_stop?.members ?? []).map((m) => m.id)));
  for (const t of tasks) {
    if (!open(t)) continue;
    const moved = Math.max(...[t.updated_at, t.phase_changed_at].map((v) => Date.parse(v ?? '')).filter(Number.isFinite), 0);
    if (nowMs - moved < settleMs) continue;
    const stored = t.user_status;
    if (!stored) { out.push({ kind: 'missing', taskId: t.id, title: t.title, detail: `phase ${t.phase}, no status stored` }); continue; }
    if (stored.transient) continue;
    const snoozed = snoozedUntil(t, byId, nowMs);
    if (snoozed && stored.state === 'needs' && stored.source !== 'prompt' && t.org_role !== 'main') {
      out.push({ kind: 'snoozed-needs', taskId: t.id, title: t.title, detail: `snoozed until ${snoozed} but stored as Needs you (${stored.ask ?? ''})` });
      continue;
    }
    let now: UserStatus;
    try { now = deps.derive(t); } catch { continue; }
    if (!sameShape(stored, now)) {
      out.push({ kind: 'drift', taskId: t.id, title: t.title, detail: `stored ${stored.state}${stored.kind ? `/${stored.kind}` : ''}, the facts say ${now.state}${now.kind ? `/${now.kind}` : ''}` });
      continue;
    }
    if (t.phase === 'WAITING' && t.org_role !== 'main' && t.org_role !== 'lead' && !snoozed && !quieted.has(t.id) && !(await deps.outside(t).catch(() => true))) {
      const own = !!t.status_report && t.status_report.state === 'waiting' && reportIsCurrent({ report: t.status_report, phaseChangedAt: t.phase_changed_at });
      out.push({
        kind: 'parked-on-nothing', taskId: t.id, title: t.title,
        detail: `WAITING (${stored.waitingOn ?? 'no words'}) with no trigger, request, working subtask or named outside wait`,
        ...(own ? { notify: true } : {}), ...(t.phase_changed_at ? { parkedAt: t.phase_changed_at } : {}),
      });
    }
  }
  return out;
}

/** Whether a WAITING task waits on something outside Walnut and the user, from Walnut's facts. */
async function hasOutsideWait(t: Task): Promise<boolean> {
  const { reportNamesOutsideWait, outsideWaitEvidence, OUTSIDE_WAIT_KINDS } = await import('./sessions/outside-wait.js');
  // What the status already names: another task, its lead (a done worker), the machine, an outside thing.
  const kind = t.user_status?.kind;
  if (kind && OUTSIDE_WAIT_KINDS.has(kind) && (kind !== 'lead' || !!t.parent_task_id)) return true;
  const report = t.status_report && reportIsCurrent({ report: t.status_report, phaseChangedAt: t.phase_changed_at }) ? t.status_report : null;
  if (report && reportNamesOutsideWait(report, t)) return true;
  return !!(await outsideWaitEvidence(t));
}

/** The live check: every open task, with the server's own facts. Read-only. */
export async function checkStatuses(nowMs = Date.now(), opts: { settleMs?: number } = {}): Promise<StatusMismatch[]> {
  const { listTasks } = await import('./task-manager.js');
  const { readStatusFacts, statusInputOf, completeStatusFacts } = await import('./user-status-sync.js');
  const all = await listTasks();
  const facts = await readStatusFacts(all.filter(open), all.map((t) => t.id));
  completeStatusFacts(facts, all);
  return findStatusMismatches(all, { derive: (t) => deriveUserStatus(statusInputOf(t, facts, nowMs), nowMs), outside: hasOutsideWait }, nowMs, opts.settleMs);
}

/** The note a park with nothing outside brings into its task's session. */
export function parkNoteBody(m: StatusMismatch): string {
  return [
    `This task is parked as WAITING, but Walnut holds nothing outside Walnut and the user that it waits on (${m.detail}).`,
    'A task parks only for an outside wait (a pipeline, a build, a deploy, a review, a reply from someone else, another task). Check what it waits on now:',
    '- The next move is the user\'s (their input, review or decision): set phase NEED_ACTION (task_update) so it is on their list.',
    '- It waits on an outside thing: arm a trigger on it (trigger_create), with a short wait_until.',
    '- Nothing is left: finish the work, or complete the task if it is done.',
  ].join('\n');
}

const TOLD_FILE = () => path.join(WALNUT_HOME, 'status-check-told.json');

/** Task id -> the park (phase move) it was told about. */
async function readTold(): Promise<Record<string, string>> {
  try {
    const v = JSON.parse(await fsp.readFile(TOLD_FILE(), 'utf8')) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, string> : {};
  } catch { return {}; }
}

let timer: ReturnType<typeof setInterval> | null = null;
let startedAt = 0;

/** One pass: re-derive what is Walnut's to fix, and tell a park on nothing to its task. Exported for tests. */
export async function runStatusCheck(nowMs = Date.now(), opts: { send?: boolean } = {}): Promise<StatusMismatch[]> {
  let found: StatusMismatch[] = [];
  try {
    found = await checkStatuses(nowMs);
    if (!found.length) return found;
    log.task.warn('status check: mismatches', { count: found.length, mismatches: found.map((m) => `${m.kind}:${m.taskId}`) });
    const resync = new Set(found.filter((m) => m.kind !== 'parked-on-nothing').map((m) => m.taskId));
    if (resync.size) {
      const { syncUserStatuses } = await import('./user-status-sync.js');
      await syncUserStatuses(resync, nowMs);
    }
    if (opts.send === false) return found;
    const tell = found.filter((m) => m.kind === 'parked-on-nothing' && m.notify);
    if (!tell.length) return found;
    const told = await readTold();
    // Only parks still open: a task that moved on drops out of the record. Read from the task, not from
    // this pass's list: a park skipped this pass (still settling, drift) is the same park next pass.
    const { listTasks } = await import('./task-manager.js');
    const byId = new Map((await listTasks()).map((t) => [t.id, t] as const));
    const keep: Record<string, string> = {};
    for (const [id, park] of Object.entries(told)) {
      const t = byId.get(id);
      if (t && t.phase === 'WAITING' && (t.phase_changed_at ?? '') === park) keep[id] = park;
    }
    for (const m of tell) {
      const park = m.parkedAt ?? '';
      if (keep[m.taskId] === park) continue;
      const { getSessionsForTask } = await import('./session-tracker.js');
      const { pickDeliverySession } = await import('./routines/session-target.js');
      const target = pickDeliverySession(await getSessionsForTask(m.taskId).catch(() => []));
      if (!target) continue;
      // Recorded first: a failed send never repeats every pass.
      keep[m.taskId] = park;
      await fsp.writeFile(TOLD_FILE(), JSON.stringify(keep)).catch(() => {});
      const { buildWalnutMessage } = await import('./peers/walnut-message-tag.js');
      const { sendMessageToSession } = await import('./session-message-queue.js');
      const { WAIT_UNTIL_SEND_SOURCE } = await import('./task-wait-until.js');
      await sendMessageToSession(target.claudeSessionId, buildWalnutMessage({
        kind: 'trigger',
        attrs: { from: 'Walnut: status check', note: 'your park waits on nothing outside' },
        body: parkNoteBody(m),
      }), { source: WAIT_UNTIL_SEND_SOURCE, taskId: m.taskId }).catch((err) => {
        log.task.warn('status check: park note not delivered', { taskId: m.taskId, error: err instanceof Error ? err.message : String(err) });
      });
    }
  } catch (err) {
    log.task.warn('status check pass failed', { error: err instanceof Error ? err.message : String(err) });
  }
  return found;
}

/** Primary only. An ephemeral server checks but never sends: its tasks are a copy of the real ones. */
export function startStatusCheck(opts: { ephemeral?: boolean } = {}): void {
  if (timer) return;
  startedAt = Date.now();
  timer = setInterval(() => { void runStatusCheck(Date.now(), { send: !opts.ephemeral && Date.now() - startedAt > 10 * 60_000 }); }, CHECK_MS);
  timer.unref?.();
}

export function stopStatusCheck(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
