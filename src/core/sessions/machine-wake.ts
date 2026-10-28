/**
 * Walnut brings back the tasks that wait on the machine once the machine is fixed.
 *
 * 2026-10-28: the Mac's data disk filled, the server answered 507 to every write, and the agents
 * that hit it asked the user to free space, so their tasks read Needs you. The rule now (the 507's
 * own text, src/ops/executor.ts DISK_FULL_HINT, and the self-report's FOR_USER_STATE): a failure of
 * the machine is "waiting on machine", the lead hears it in its team note, and when the disk has
 * room again Walnut wakes each such task here, so nobody has to remember it.
 *
 * Who is woken: an open task whose current status report (the one of its latest turn) says it waits
 * on the machine, and that is parked or handed back (a running task hears nothing extra). One
 * message each, through the normal queue, a few seconds apart; the source is not an interruption
 * (task-wait-resume.ts), so the wait ends with it as it ends with a trigger's fire.
 */

import { log } from '../../logging/index.js';
import type { Task } from '../types.js';
import { buildWalnutMessage } from '../peers/walnut-message-tag.js';

export const MACHINE_WAKE_SOURCE = 'machine-recovered';
/** At most this many tasks are woken per recovery; the rest still read Waiting on the machine. */
const MAX_WAKES = 20;
const STAGGER_MS = 3_000;
/** A report this old is a wait the task has long moved past by other means. */
const MAX_REPORT_AGE_MS = 7 * 86_400_000;

export type MachineRecovery = 'disk';

const RECOVERED_WORDS: Record<MachineRecovery, string> = {
  disk: 'The Walnut server\'s data disk has room again, and writes work (no more 507).',
};

/** The open tasks whose latest turn reported it waits on the machine. Pure, for tests. */
export function machineWaiters(tasks: readonly Task[], nowMs: number): Task[] {
  return tasks.filter((t) => {
    if (t.phase !== 'WAITING' && t.phase !== 'NEED_ACTION') return false;
    if (t.status === 'done' || t.org_role === 'main') return false;
    const r = t.status_report;
    if (!r || r.state !== 'waiting' || r.waiting_kind !== 'machine') return false;
    const at = Date.parse(r.at);
    if (!Number.isFinite(at) || nowMs - at > MAX_REPORT_AGE_MS) return false;
    // Only the report of the latest turn speaks for the task now (user-status.ts reportIsCurrent).
    const moved = t.phase_changed_at ? Date.parse(t.phase_changed_at) : NaN;
    return !Number.isFinite(moved) || at >= moved - 10 * 60_000;
  });
}

export function machineWakeText(cause: MachineRecovery): string {
  return buildWalnutMessage({
    kind: 'trigger',
    attrs: { from: 'Walnut', note: 'the machine this task waited on is fixed' },
    body: `${RECOVERED_WORDS[cause]} Your last turn said this task waits on the machine. `
      + 'Retry what failed, then carry on. If what you wait on is something else, check it and report your state again.',
  });
}

let sleep = (ms: number) => new Promise<void>((resolve) => { const t = setTimeout(resolve, ms); t.unref?.(); });
/** Tests: no stagger. */
export function _setMachineWakeSleepForTesting(fn: ((ms: number) => Promise<void>) | null): void {
  sleep = fn ?? ((ms: number) => new Promise<void>((resolve) => { const t = setTimeout(resolve, ms); t.unref?.(); }));
}

/** Wake every task waiting on the machine. Returns the ids woken. Never throws. */
export async function wakeMachineWaiters(cause: MachineRecovery, nowMs = Date.now()): Promise<string[]> {
  const woken: string[] = [];
  try {
    const { role } = await import('../server-role.js');
    if (role() !== 'leader') return woken;
    const { listTasks } = await import('../task-manager.js');
    const { getSessionsForTask } = await import('../session-tracker.js');
    const { pickDeliverySession } = await import('../routines/session-target.js');
    const { sendMessageToSession } = await import('../session-message-queue.js');
    const waiters = machineWaiters(await listTasks(), nowMs);
    const text = machineWakeText(cause);
    for (const task of waiters.slice(0, MAX_WAKES)) {
      try {
        const target = pickDeliverySession(await getSessionsForTask(task.id).catch(() => []));
        // A turn running now reads its own failure and needs no extra message.
        if (!target || target.process_status === 'running') continue;
        if (woken.length) await sleep(STAGGER_MS);
        await sendMessageToSession(target.claudeSessionId, text, { source: MACHINE_WAKE_SOURCE, taskId: task.id });
        woken.push(task.id);
        log.task.info('machine fixed: waiting task woken', { taskId: task.id, sessionId: target.claudeSessionId, cause });
      } catch (err) {
        log.task.warn('machine fixed: wake failed', { taskId: task.id, cause, error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (waiters.length > MAX_WAKES) log.task.warn('machine fixed: more waiters than one recovery wakes', { cause, waiters: waiters.length, woken: woken.length });
  } catch (err) {
    log.task.warn('machine fixed: wake pass failed', { cause, error: err instanceof Error ? err.message : String(err) });
  }
  return woken;
}
