/**
 * A letter about a snoozed task goes out only with a stated reason (2026-10-30, the user: "don't
 * remind me again, unless you have a particular reason"; core/snooze.ts).
 *
 * The letter's own task (the sender's) and every task it names (`task_refs`) count. When one of them
 * is snoozed, the letter needs `snooze_reason` (SNOOZE_REASON_MIN characters or more): what makes it
 * worth the user's attention before the date they chose. Without one it is refused (409
 * `task_snoozed`). With one, the reason leads the letter's body, so the user reads why. Never throws
 * on a read it cannot make: a task that cannot be read counts as not snoozed.
 */
import { log } from '../../logging/index.js';
import { SNOOZE_REASON_MIN, snoozedUntil } from '../snooze.js';
import type { Task } from '../types.js';
import { LetterError } from './store.js';
import type { LetterSender, NewLetter } from './types.js';

type LetterInput = Omit<NewLetter, 'sender'>;

/** The first snoozed task of the letter, with its date, or null. Pure. */
export function snoozedLetterTask(
  ids: readonly string[], byId: ReadonlyMap<string, Pick<Task, 'id' | 'title' | 'start_date' | 'parent_task_id' | 'org_role'>>, nowMs: number,
): { id: string; title: string; until: string } | null {
  for (const id of ids) {
    const t = byId.get(id);
    // Main is never snoozed (user-status.ts): its letters are the user's own channel.
    const until = t && t.org_role !== 'main' ? snoozedUntil(t, byId, nowMs) : null;
    if (t && until) return { id: t.id, title: t.title, until };
  }
  return null;
}

/** The refusal's words. */
export function snoozedLetterMessage(hit: { id: string; title: string; until: string }): string {
  return `Not sent: "${hit.title}" (${hit.id}) is snoozed until ${hit.until}, and the user asked not to be reminded of a `
    + 'snoozed task before its date. Send it only if it cannot wait, with snooze_reason: one line the user reads '
    + `(at least ${SNOOZE_REASON_MIN} characters) saying why it matters before ${hit.until}. Otherwise keep it for that date.`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The letter as it may go out (the reason leading its body), or a 409. */
export async function admitSnoozedLetter(input: LetterInput, sender: LetterSender, nowMs = Date.now()): Promise<LetterInput> {
  const refs = input.taskRefs ?? input.task_refs ?? [];
  const ids = [...new Set([sender.taskId, ...(Array.isArray(refs) ? refs : [])].filter((v): v is string => typeof v === 'string' && !!v))];
  if (!ids.length) return input;
  let hit: ReturnType<typeof snoozedLetterTask> = null;
  try {
    const { listTasks } = await import('../task-manager.js');
    const all = await listTasks();
    hit = snoozedLetterTask(ids, new Map(all.map((t) => [t.id, t] as const)), nowMs);
  } catch (err) {
    log.notif.debug('human-inbox: snooze check skipped', { error: err instanceof Error ? err.message : String(err) });
  }
  if (!hit) return input;
  const raw = input.snoozeReason ?? input.snooze_reason;
  const reason = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
  if (reason.length < SNOOZE_REASON_MIN) {
    log.notif.info('human-inbox: letter about a snoozed task refused', { taskId: hit.id, until: hit.until, senderTaskId: sender.taskId });
    throw new LetterError(snoozedLetterMessage(hit), 'task_snoozed', 409);
  }
  log.notif.info('human-inbox: letter about a snoozed task sent with a reason', { taskId: hit.id, until: hit.until, reason });
  const lead = `Snoozed until ${hit.until}; raised now because: ${reason}`;
  const { snoozeReason: _a, snooze_reason: _b, ...rest } = input;
  if (typeof rest.markdown === 'string') return { ...rest, markdown: `_${lead.replace(/([_*\\])/g, '\\$1')}_\n\n${rest.markdown}` };
  if (typeof rest.html === 'string') return { ...rest, html: `<p><em>${escapeHtml(lead)}</em></p>\n${rest.html}` };
  const preview = typeof rest.text === 'string' && rest.text.trim() ? `${lead}. ${rest.text}` : lead;
  return { ...rest, text: preview };
}
