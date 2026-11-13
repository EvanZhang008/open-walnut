/**
 * Keeping clock placement fresh (clock-placement.ts): the state the bus watch reads and the
 * throttled re-push it causes. A routine's session can appear on a host later, a session
 * routine's target can move, and an offline routine's owner conversation (sampled into the
 * start armed on the host) can change; each of those re-places clocks soon.
 *
 * One copy of the state lives here: the placement code reports into it through functions
 * (watchTask, setWatchedTasks, setOwner, dropOwner) and never holds a set of its own. This
 * file imports nothing from clock-placement.ts statically (the stranded sweep loads it when it runs).
 */

import { log } from '../../logging/index.js';
import { isQuietTurn } from '../sessions/quiet-turn.js';

let watchStarted = false;
let timer: ReturnType<typeof setTimeout> | null = null;
/** Task ids a session routine targets (and the tasks they moved to), refreshed on each schedule. */
let watchedTasks = new Set<string>();
/** Offline routine id to the owner task whose conversation its start samples, kept across pushes. */
const ownerOfJob = new Map<string, string>();
const REPLACE_DEBOUNCE_MS = 3_000;

/** A task a push found (a transfer's target): watched until the next schedule replaces the set. */
export function watchTask(taskId: string): void { watchedTasks.add(taskId); }
/** The tasks session routines target, as the latest schedule names them. */
export function setWatchedTasks(next: Set<string>): void { watchedTasks = next; }
export function setOwner(jobId: string, ownerTaskId: string): void { ownerOfJob.set(jobId, ownerTaskId); }
export function dropOwner(jobId: string): void { ownerOfJob.delete(jobId); }
export function ownerJobIds(): string[] { return [...ownerOfJob.keys()]; }

/** Re-place every connected host's clocks soon (a burst becomes one push per host). */
export function scheduleClockPlacement(): void {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    void import('../../providers/daemon-connection.js')
      .then(({ pushTriggersToAllHosts }) => pushTriggersToAllHosts())
      .catch((err) => log.cron.warn('clock placement: re-push failed', { error: err instanceof Error ? err.message : String(err) }));
    void strandedSweep().catch((err) => log.cron.warn('clock placement: stranded sweep failed', { error: err instanceof Error ? err.message : String(err) }));
  }, REPLACE_DEBOUNCE_MS);
  timer.unref?.();
}

async function strandedSweep(): Promise<void> {
  const [{ getCronService }, { takeBackStrandedClocks }] = await Promise.all([import('../../web/routes/cron.js'), import('./clock-placement.js')]);
  const service = getCronService();
  if (!service) return;
  const back = await takeBackStrandedClocks(service, await service.list({ includeDisabled: true, recompute: false }));
  if (back.length > 0) log.cron.info('clock routines back on the server timer: they left their unreachable host', { jobIds: back });
}

function taskIdOf(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const d = data as { taskId?: unknown; task?: { id?: unknown }; id?: unknown };
  if (typeof d.taskId === 'string') return d.taskId;
  if (d.task && typeof d.task.id === 'string') return d.task.id;
  return typeof d.id === 'string' ? d.id : undefined;
}

/** The least time between two pushes caused by an offline owner's conversation moving (its turns are frequent). */
export const OWNER_REFRESH_MS = 60_000;
let ownerLastAtMs = 0;
let ownerTrail: ReturnType<typeof setTimeout> | null = null;

/** Leading and trailing: the first change pushes now, and the last one in a window pushes when it ends. */
function scheduleOwnerRefresh(now = Date.now()): void {
  const wait = ownerLastAtMs + OWNER_REFRESH_MS - now;
  if (wait <= 0) {
    ownerLastAtMs = now;
    scheduleClockPlacement();
  } else if (!ownerTrail) {
    ownerTrail = setTimeout(() => {
      ownerTrail = null;
      ownerLastAtMs = Date.now();
      scheduleClockPlacement();
    }, wait);
    ownerTrail.unref?.();
  }
}

/** Started once at boot: a session that starts on a watched task, or a task that moves, re-places its routine. */
export function startClockPlacementWatch(): void {
  if (watchStarted) return;
  watchStarted = true;
  void import('../event-bus.js').then(({ bus }) => {
    bus.subscribe('clock-placement', (event) => {
      if (watchedTasks.size === 0 && ownerOfJob.size === 0) return;
      const taskId = taskIdOf(event.data);
      if (!taskId) return;
      // Walnut's own upkeep (an idle compaction) says nothing new about the owner's work.
      if (event.name === 'session:result') {
        const d = event.data as { sessionId?: unknown; turnGen?: unknown };
        if (typeof d.sessionId === 'string' && isQuietTurn(d.sessionId, d.turnGen)) return;
      }
      if (event.name !== 'session:started' && [...ownerOfJob.values()].includes(taskId)) scheduleOwnerRefresh();
      else if (watchedTasks.has(taskId)) scheduleClockPlacement();
    }, { global: true, interest: ['session:started', 'session:result', 'task:updated', 'task:completed', 'task:deleted'] });
  });
}

export function _ownerWatchForTest(): { owners: Map<string, string>; refresh: (now: number) => void } {
  return { owners: ownerOfJob, refresh: scheduleOwnerRefresh };
}

/** Tests: forget the watch state. */
export function _resetClockWatchForTest(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  watchedTasks = new Set();
  ownerOfJob.clear();
  ownerLastAtMs = 0;
  if (ownerTrail) clearTimeout(ownerTrail);
  ownerTrail = null;
}
