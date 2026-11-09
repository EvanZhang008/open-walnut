/**
 * Words for a routine's run history and missed runs (server: src/core/cron/run-log.ts).
 * 2026-11-08: the daily org reflection did not run and no surface said so.
 */
import type { RoutineMissedRun, RoutineRunEntry } from '@/api/routines';

/** "Sun, Nov 8, 8:00 AM", in this browser's time. */
export function describeSlotTime(ms: number): string {
  return new Date(ms).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function seconds(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${Math.round(s - m * 60)} s`;
}

/** "Missed Sun, Nov 8, 8:00 AM: Not started: this Mac had no room..." */
export function describeMissed(m: RoutineMissedRun): string {
  return `Missed ${describeSlotTime(m.slotMs)}: ${m.reason}`;
}

/** One History row: "Sun, Nov 8, 8:00 AM · failed after 48 s: <error> · will try again 8:01 AM". */
export function describeRunEntry(e: RoutineRunEntry): string {
  const when = describeSlotTime(e.atMs);
  const tags: string[] = [];
  if (typeof e.catchUpMs === 'number') tags.push(`catch-up for ${describeSlotTime(e.catchUpMs)}`);
  else if (e.manual) tags.push('Run now');
  if (e.attempt && e.attempt > 1) tags.push(`try ${e.attempt}`);
  // A run the schedule started late says for which time it ran.
  if (typeof e.slotMs === 'number' && e.atMs - e.slotMs > 5 * 60_000) tags.push(`for ${describeSlotTime(e.slotMs)}`);
  const head = tags.length ? `${when} (${tags.join(', ')})` : when;
  let verdict: string;
  if (e.status === 'ok') verdict = `ran, ${seconds(e.durationMs)}${e.summary ? `: ${e.summary}` : ''}`;
  else if (e.status === 'error') verdict = `failed after ${seconds(e.durationMs)}: ${e.error ?? 'unknown error'}`;
  else verdict = `skipped${e.error ? `: ${e.error}` : e.summary ? `: ${e.summary}` : ''}`;
  if (e.repeats && e.repeats > 1) verdict += ` (${e.repeats} times in a row since ${describeSlotTime(e.firstAtMs ?? e.atMs)})`;
  const retry = typeof e.willRetryAtMs === 'number'
    ? ` · tries again ${new Date(e.willRetryAtMs).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`
    : '';
  return `${head} · ${verdict}${retry}`;
}

/** Whether a row is a run that did not do its work (the server's runFailed). */
export function runEntryFailed(e: Pick<RoutineRunEntry, 'status' | 'error'>): boolean {
  return e.status === 'error' || (e.status === 'skipped' && !!e.error);
}
