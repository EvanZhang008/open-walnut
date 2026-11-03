/**
 * Work a session started that runs on after its turn ends: the ONE list of what counts
 * (2026-11-03, the user's lead: a worker ran a background subagent for 84 minutes, read as
 * stopped, and its lead nudged it; "list every source of a session's own work that goes on after
 * its turn"). While any of these runs, the session is on the job: its task reads Working
 * (user-status.ts), Walnut's idle reap gives it the long timeout (session-health-monitor.ts), a
 * request to it is not settled by the turn end (request-progress.ts, turn-end-wait.ts), its lead
 * hears no "stopped" (session-hooks/builtins.ts), and the drain of the last piece is no turn end
 * by itself (session-snapshot-apply.ts: the CLI runs a follow-up turn for the notification).
 *
 * The sources, each with the signal Claude Code's stream gives for it (daemon-fold.ts folds the
 * same signals into SessionSnapshot; the live runner keeps its own copy):
 *   background  a run_in_background Bash command, a background Agent subagent, or any other task
 *               the CLI marks `is_backgrounded:true` (task_type local_bash, local_agent, ...).
 *               Whatever its type: the flag, not the type, detaches it from the turn.
 *   team        an agent team (TeamCreate until TeamDelete or the team goes idle).
 *   wakeup      an armed ScheduleWakeup: the turn ended only to be re-invoked by the timer.
 *   loop        a /loop (CronCreate) it armed: the CLI's own scheduler fires it between turns.
 *
 * Not here, because it keeps the turn itself open: a Workflow (task_type local_workflow carries no
 * is_backgrounded, so it gates turn-over and the session stays mid-turn until it ends), and a
 * foreground subagent or command. tests/core/sessions/outliving-work.test.ts lists every field of
 * SessionSnapshot and fails on a new one nobody has classified.
 *
 * Pure and browser-safe (user-status.ts, which the web app imports, names the sources).
 */
export type OutlivingSource = 'background' | 'team' | 'wakeup' | 'loop';

/** Each source in the words a person reads, in the order they are named. */
export const OUTLIVING_SOURCES: Readonly<Record<OutlivingSource, string>> = {
  background: 'a background command or subagent it started',
  team: 'its agent team',
  wakeup: 'a wakeup it scheduled',
  loop: 'a /loop it armed',
};

/** The signals, as a snapshot or the live runner holds them. Every field optional: absent = none. */
export interface OutlivingSignals {
  detachedBgCount?: number | null;
  teamActive?: boolean | null;
  /** An armed ScheduleWakeup: daemon-fold.ts isWakeupArmed(wakeupAt), read by the caller. */
  wakeupArmed?: boolean | null;
  cronActive?: boolean | null;
}

/** What of the session's own work runs on after its turn, now. Pure. */
export function outlivingOf(s: OutlivingSignals): OutlivingSource[] {
  const out: OutlivingSource[] = [];
  if ((s.detachedBgCount ?? 0) > 0) out.push('background');
  if (s.teamActive) out.push('team');
  if (s.wakeupArmed) out.push('wakeup');
  if (s.cronActive) out.push('loop');
  return out;
}

/** One line naming them, e.g. "Its own work goes on after its turn: a background command or subagent it started". */
export function outlivingLine(sources: readonly OutlivingSource[]): string {
  const named = sources.map((s) => OUTLIVING_SOURCES[s]);
  return named.length ? `Its own work goes on after its turn: ${named.join(', ')}` : '';
}
