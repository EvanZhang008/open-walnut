/**
 * What a trigger's `watches` names, read the ONE way the server (trigger-api.ts) and a host that
 * arms a trigger while the server is away (providers/offline-host-core.ts) both read it:
 *   "ask"      the task's ask of the user          (sessions/recheck-watch.ts)
 *   lt-...     one of the task's letters           (sessions/recheck-watch.ts)
 *   "own"      the task's own work: a build, test run, CI run, deploy or land of its change
 *              (CronJob.ownWork, 2026-11-18)
 * None of them is a wait outside the task, so a trigger with any never parks it.
 *
 * The host gets it as a factory whose body holds everything it uses: the source twin
 * (daemon-source.ts) inlines it with toString() and hands it to the offline host as a dep, so
 * nothing in it may reach outside the function.
 */

export type TriggerWatch = { kind: 'user'; what: string } | { kind: 'own' };

export interface TriggerWatches {
  /** The `watches` value that names the task's own work. */
  own: string;
  /** The refusal for a value that names nothing. */
  invalid: string;
  /** The watch named, null for none, or 'invalid'. */
  parse(raw: unknown): TriggerWatch | null | 'invalid';
}

export function createTriggerWatches(): TriggerWatches {
  const own = 'own';
  return {
    own,
    invalid: 'watches must be "ask" (your status\'s ask of the user), a letter id (lt-...) or "own" (your own build, test run, CI run, deploy or land)',
    parse(raw) {
      if (raw === undefined || raw === null || raw === '') return null;
      if (typeof raw !== 'string') return 'invalid';
      const v = raw.trim();
      if (v === own) return { kind: 'own' };
      if (v === 'ask' || /^lt-[a-z0-9-]{4,60}$/i.test(v)) return { kind: 'user', what: v };
      return 'invalid';
    },
  };
}

const watches = createTriggerWatches();

export const OWN_WORK_WATCH = watches.own;
export const TRIGGER_WATCH_INVALID = watches.invalid;
export const parseTriggerWatch = watches.parse;
