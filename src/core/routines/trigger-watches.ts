/**
 * What a trigger's `watches` names, read the ONE way the server (trigger-api.ts) and a host that
 * arms a trigger while the server is away (providers/offline-host-core.ts) both read it:
 *   "ask"      the task's ask of the user          (sessions/recheck-watch.ts)
 *   lt-...     one of the task's letters           (sessions/recheck-watch.ts)
 *   "own"      the task's own work: a build, test run, CI run, deploy or land of its change
 *              (CronJob.ownWork, 2026-11-18)
 * None of them is a wait outside the task, so a trigger with any never parks it.
 * Pure, no imports: the host bundle carries it.
 */

export const OWN_WORK_WATCH = 'own';

export type TriggerWatch = { kind: 'user'; what: string } | { kind: 'own' };

/** The watch named, null for none, or 'invalid'. */
export function parseTriggerWatch(raw: unknown): TriggerWatch | null | 'invalid' {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') return 'invalid';
  const v = raw.trim();
  if (v === OWN_WORK_WATCH) return { kind: 'own' };
  if (v === 'ask' || /^lt-[a-z0-9-]{4,60}$/i.test(v)) return { kind: 'user', what: v };
  return 'invalid';
}

export const TRIGGER_WATCH_INVALID =
  'watches must be "ask" (your status\'s ask of the user), a letter id (lt-...) or "own" (your own build, test run, CI run, deploy or land)';
