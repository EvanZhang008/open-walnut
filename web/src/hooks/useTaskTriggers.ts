/**
 * The walnut-triggers of ONE task: routines whose `check` script runs on a
 * daemon and whose fires are delivered into this task's session (executor
 * `session`, `config.target` = the task id). Read from the shared routines store,
 * so a task list with hundreds of rows costs one fetch, not one per row.
 *
 * Paused and stopped triggers are returned too: switching one off must not make
 * it vanish from its task (it read as a delete), so the pill shows it as paused
 * with a way back on. The caller hides the one routine that is off for a reason
 * of its own: the trigger behind an ended snooze wait (TriggerPill).
 */
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { Routine } from '@/api/routines';
import { wsClient } from '@/api/ws';
import { getRoutinesSnapshot, loadRoutines, onRoutinesChanged, subscribeRoutines } from '@/stores/routines-store';

export function isTriggerForTask(routine: Routine, taskId: string): boolean {
  if (!routine.check) return false;
  if (routine.executor?.type !== 'session') return false;
  return (routine.executor.config as { target?: unknown }).target === taskId;
}

export function triggersForTask(routines: readonly Routine[], taskId: string | null | undefined): Routine[] {
  if (!taskId) return [];
  return routines.filter((r) => isTriggerForTask(r, taskId));
}

// One live subscription for every mounted pill: the store debounces the refetch,
// but N rows must not mean N listeners on each `cron:job-*` broadcast.
const CRON_EVENTS = ['cron:job-added', 'cron:job-updated', 'cron:job-removed', 'cron:job-started', 'cron:job-finished'];
let liveRefs = 0;
const onCronEvent = () => onRoutinesChanged();
function retainLive(): void {
  if (liveRefs++ === 0) for (const ev of CRON_EVENTS) wsClient.onEvent(ev, onCronEvent);
}
function releaseLive(): void {
  if (--liveRefs === 0) for (const ev of CRON_EVENTS) wsClient.offEvent(ev, onCronEvent);
}

const EMPTY: Routine[] = [];

export function useTaskTriggers(taskId: string | null | undefined): Routine[] {
  const shared = useSyncExternalStore(subscribeRoutines, getRoutinesSnapshot, getRoutinesSnapshot);
  useEffect(() => {
    retainLive();
    void loadRoutines();
    return releaseLive;
  }, []);
  return useMemo(() => {
    const found = triggersForTask(shared.routines, taskId);
    return found.length ? found : EMPTY;
  }, [shared.routines, taskId]);
}
