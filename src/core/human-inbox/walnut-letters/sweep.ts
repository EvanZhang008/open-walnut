/**
 * Settle the open letters Walnut wrote itself that nobody needs any more (2026-11-02, the user's org
 * review: "the letters about a problem Walnut no longer raises must take care of themselves"; four
 * "Let ... use the Mac?" letters were closed by hand after tasks on his own hosts stopped needing a
 * grant). Each kind says how it knows (registry.ts, `stillNeeded`); this runs the checks and settles
 * (archivedReason 'settled', one plain line) every open, unanswered letter whose kind says so.
 *
 * Runs at boot and on the letter re-check's clock (sessions/letter-recheck.ts). Older letters
 * without the kind mark are found by their English shape (`matchesUnmarked`).
 */
import { log } from '../../../logging/index.js';
import type { Task } from '../../types.js';
import { walnutLetterLanguage } from './languages.js';
import type { StillNeededContext } from './kind.js';
import { kindOfLetter } from './registry.js';

export async function settleUnneededWalnutLetters(now = Date.now()): Promise<Array<{ id: string; reason: string }>> {
  const { listLetters, settleLettersWhere } = await import('../store.js');
  const open = (await listLetters({ archived: false })).letters.filter((l) => !l.answered && !l.archived);
  const tasks = new Map<string, Promise<Task | undefined>>();
  const ctx: StillNeededContext = {
    lang: await walnutLetterLanguage(),
    now,
    task: (id) => {
      let t = tasks.get(id);
      if (!t) {
        t = import('../../task-manager.js').then((m) => m.listTasksByIds([id])).then(([one]) => one).catch(() => undefined);
        tasks.set(id, t);
      }
      return t;
    },
  };
  const reasons = new Map<string, string>();
  for (const letter of open) {
    const rule = kindOfLetter(letter)?.stillNeeded;
    if (!rule || !('check' in rule)) continue;
    try {
      const why = await rule.check(letter, ctx);
      if (why) reasons.set(letter.id, why);
    } catch (err) {
      log.notif.warn('human-inbox: a Walnut letter check failed; kept', { letterId: letter.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (!reasons.size) return [];
  // Under the store's lock: one answered or closed since is skipped there.
  const settled = await settleLettersWhere((l) => reasons.get(l.id) ?? null);
  if (settled.length) log.notif.info('human-inbox: settled Walnut letters nobody needs any more', { letters: settled });
  return settled;
}
