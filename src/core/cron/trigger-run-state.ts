/**
 * Whether a walnut-trigger is polling, in the one rule the agent op
 * (trigger_list) and the task card both use. Pure and import-free, because the
 * web bundle imports it too.
 *
 *   armed      : enabled, the daemon checks it on its cadence
 *   paused     : switched off by a person or an agent (state.pausedAtMs), or
 *                switched off before that field existed
 *   stopped    : switched off by the server after its check failed
 *                TRIGGER_STOP_AFTER_ERRORS times in a row (never stamped paused)
 *   wait-ended : switched off by the snooze wait it ended (state.waitEndedAtMs);
 *                task_wait with the same routine_id re-arms it
 */

/**
 * Mirrors MAX_CONSECUTIVE_CHECK_ERRORS in src/providers/trigger-check-core.ts,
 * which imports node built-ins the web bundle cannot load. A test pins the two.
 */
export const TRIGGER_STOP_AFTER_ERRORS = 5;

export type TriggerRunState = 'armed' | 'paused' | 'stopped' | 'wait-ended';

export interface TriggerRunStateInput {
  enabled?: boolean;
  state?: { pausedAtMs?: number; waitEndedAtMs?: number; consecutiveErrors?: number };
}

export function triggerRunState(job: TriggerRunStateInput): TriggerRunState {
  if (job.enabled) return 'armed';
  if (typeof job.state?.pausedAtMs === 'number') return 'paused';
  if (typeof job.state?.waitEndedAtMs === 'number') return 'wait-ended';
  return (job.state?.consecutiveErrors ?? 0) >= TRIGGER_STOP_AFTER_ERRORS ? 'stopped' : 'paused';
}
