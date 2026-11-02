/**
 * Letters Walnut once wrote and writes no more. An open one asks about something Walnut no longer
 * raises with the user, so the sweep (sweep.ts) settles it with the line below (2026-11-02, the org
 * review: "the letters about a problem Walnut no longer raises must take care of themselves").
 *
 * When a kind stops being sent, move it here: its old subject shape and the line the user reads.
 */
import type { LetterRecord } from '../types.js';
import type { ByLang } from './languages.js';

export interface RetiredLetterKind {
  id: string;
  /** When Walnut stopped sending it, and why. */
  retired: string;
  /** A letter Walnut wrote of this kind (its English subject shape; never a session's or a plugin's). */
  matches: (letter: LetterRecord) => boolean;
  /** The one line the user reads on the settled letter. */
  settleReason: ByLang<string>;
  /** Subjects as they were sent, for the tests. */
  samples: readonly string[];
}

/** Walnut's own: no task, session or plugin wrote it. */
export function walnutSent(letter: LetterRecord): boolean {
  const s = letter.sender;
  return !s || (!s.taskId && !s.pluginId && (!s.sessionId || s.sessionId === 'external'));
}

export const TRIGGER_STOPPED: RetiredLetterKind = {
  id: 'trigger-stopped',
  retired: '2026-11-02: a failing trigger is told to the task it watches for, or that task\'s lead, never the user',
  matches: (l) => walnutSent(l) && /^Trigger ".*" stopped after \d+ failed checks$/s.test(l.subject),
  settleReason: {
    en: 'Walnut no longer writes letters about triggers: a failing trigger is told to the task it watches for, or that task\'s lead.',
    zh: 'Walnut 不再为触发器给你写信：触发器出问题时，会告诉它负责的任务，或那个任务的 lead。',
  },
  samples: ['Trigger "New replies arrived in the ask threads..." stopped after 5 failed checks'],
};

export const RETIRED_LETTER_KINDS: readonly RetiredLetterKind[] = [TRIGGER_STOPPED];

export function retiredKindOf(letter: LetterRecord): RetiredLetterKind | undefined {
  return RETIRED_LETTER_KINDS.find((k) => k.matches(letter));
}
