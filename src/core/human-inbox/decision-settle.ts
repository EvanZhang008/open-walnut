/**
 * A decision letter whose task no longer waits on the answer is settled, not left asking.
 *
 * 2026-10-29: "TestFlight upload blocked: accept the Apple agreement" (action_required) was still
 * unread and open hours after its task had completed and three more builds had shipped. The
 * "needs you" re-check covered the task's status, never its letters. Two rules, both here:
 *
 *   - A task that COMPLETES settles its open decision letters (archived, reason `settled`, with a
 *     one-line reason the user reads), whoever completed it: a completed task waits on nothing.
 *     A pinned letter, a plugin's letter (an approval of a step outside Walnut), an Inbox Triage
 *     run's (its run ends by completing; an answer resumes it), one carrying inbox items, one
 *     whose last turn is the user's (a reply still waiting on the agent), one sent after the
 *     completion and one someone already moved in or out of the archive stay.
 *     A completer that left one open on purpose puts it back (human_inbox_mark archived:false),
 *     and a letter that was ever un-archived is never settled again.
 *   - An open task's decision letter quiet for NEEDS_RECHECK_MS is part of the 4-hour re-check
 *     (sessions/letter-recheck.ts): its session checks whether the ask still stands and settles
 *     the letter itself when it does not (human_inbox_mark settled).
 */
import type { LetterRecord } from './types.js';
import { TRIAGE_AGENT_ID } from '../triage/types.js';

/** A decision the user can still answer: the kind both rules look at. */
export function isOpenDecision(letter: LetterRecord): boolean {
  return letter.type === 'action_required' && !letter.answered && !letter.archived
    && !letter.sender?.pluginId && !letter.items?.length && !!letter.sender?.taskId;
}

/** When anyone last wrote in the letter (its send or its newest turn), epoch ms. */
export function letterActivityAt(letter: LetterRecord): number {
  let at = letter.createdAt;
  for (const t of letter.thread ?? []) if (typeof t.at === 'number' && t.at > at) at = t.at;
  return at;
}

const clipTitle = (t: string) => (t.length > 60 ? `${t.slice(0, 60)}…` : t);

/** The reason a completed task's decision letter is settled, or null when it stays. */
export function completionSettleReason(
  letter: LetterRecord,
  task: { id: string; title?: string; completed_at?: string; agent_id?: string },
): string | null {
  if (!isOpenDecision(letter) || letter.pinned || letter.sender.taskId !== task.id) return null;
  // An Inbox Triage run completes when its run ends and leaves its decisions for the user: an
  // answer cold-resumes that run, and the next run takes back what is left (triage/runs.ts).
  if (task.agent_id === TRIAGE_AGENT_ID) return null;
  if (letter.archivedAt !== undefined) return null;
  const last = letter.thread?.[letter.thread.length - 1];
  if (last?.from === 'human') return null;
  const done = Date.parse(task.completed_at ?? '');
  if (Number.isFinite(done) && letter.createdAt > done) return null;
  const when = Number.isFinite(done) ? ` on ${new Date(done).toISOString().slice(0, 16).replace('T', ' ')} UTC` : '';
  return `Its task "${clipTitle(task.title ?? task.id)}" was completed${when} with this unanswered, so nothing waits on the answer.`;
}
