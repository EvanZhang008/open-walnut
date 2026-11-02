/**
 * One sender, one letter per question.
 *
 * 2026-11-02 (the org review): a lead sent the user the same decision letter three times in 47
 * seconds and another twice, two of them one second apart, and later posted the same reply in a
 * thread twice. Every copy buzzed the phone. So, for a session's letter (a sender task or session,
 * never an external or a plugin sender):
 *  - a second letter with the same subject inside DUPLICATE_WINDOW_MS is refused (409
 *    `duplicate_letter`) with the first one named, unless `resend_reason` says why it goes again.
 *    The store checks again under its write lock, so two sends at once cannot both pass;
 *  - a letter asking what one of the sender's open decision letters asks (same subject past the
 *    window, or a similar one) goes out with a hint naming that letter: reply to it or settle it;
 *  - a thread reply the same as the sender's latest one there, inside the window, is refused (409
 *    `duplicate_reply`). Only the route and the relay ask for that check: Walnut's own folds into a
 *    thread (away-thread.ts) are not a session repeating itself.
 * Pure functions; the callers read the store.
 */
import type { LetterRecord, LetterSender } from './types.js';

/** A repeat inside this window is a duplicate, not a new question. */
export const DUPLICATE_WINDOW_MS = 10 * 60_000;
/**
 * Character-bigram similarity (Dice) at which two subjects ask the same thing. A reworded copy of
 * one question scores 0.6 to 0.9 (CJK or Latin); the review's two different questions score under
 * 0.1, and short subjects sharing a word about 0.47 (tests/core/duplicate-letter.test.ts). A heavy
 * rewrite can fall under it; a false match only costs a hint, never a letter.
 */
export const SIMILAR_SUBJECT_MIN = 0.6;
/** Two replies this similar are one reply posted twice. */
export const SIMILAR_REPLY_MIN = 0.9;
/** A deliberate resend says why in at least this many characters. */
export const RESEND_REASON_MIN = 10;

/** Who sent it, for this check: its task, else its session; null for external and plugin senders. */
export function senderKey(sender: Pick<LetterSender, 'sessionId' | 'taskId' | 'pluginId'> | undefined): string | null {
  if (!sender || sender.pluginId) return null;
  if (sender.taskId) return `task:${sender.taskId}`;
  const sid = (sender.sessionId ?? '').trim();
  return sid && sid !== 'external' ? `session:${sid}` : null;
}

/** Trimmed, case-folded, one space between words, no trailing punctuation (full-width too). */
export function normalizeText(value: unknown): string {
  return String(value ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim().replace(/[\s\p{P}\p{S}]+$/u, '');
}

function bigrams(value: string): Map<string, number> {
  const chars = [...value.replace(/[\s\p{P}\p{S}]+/gu, '')];
  const out = new Map<string, number>();
  if (chars.length === 1) out.set(chars[0]!, 1);
  for (let i = 0; i + 1 < chars.length; i++) {
    const g = chars[i]! + chars[i + 1]!;
    out.set(g, (out.get(g) ?? 0) + 1);
  }
  return out;
}

/** Dice coefficient over character bigrams of the normalized texts, 0..1. Works for CJK and Latin alike. */
export function textSimilarity(a: string, b: string): number {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (na === nb) return 1;
  const ga = bigrams(na);
  const gb = bigrams(nb);
  let sizeA = 0;
  let sizeB = 0;
  let shared = 0;
  for (const n of ga.values()) sizeA += n;
  for (const [g, n] of gb) { sizeB += n; shared += Math.min(n, ga.get(g) ?? 0); }
  return sizeA + sizeB === 0 ? 0 : (2 * shared) / (sizeA + sizeB);
}

/** A decision letter still waiting on the user: not answered, settled or archived. */
export function isOpenDecision(l: LetterRecord): boolean {
  return l.type === 'action_required' && !l.answered && !l.settled && !l.archived;
}

/** The sender's letter with the same subject sent inside the window, newest first, or null. */
export function findDuplicateLetter(
  input: { subject: string; sender: LetterSender },
  letters: readonly LetterRecord[],
  nowMs: number,
): LetterRecord | null {
  const key = senderKey(input.sender);
  if (!key) return null;
  const subject = normalizeText(input.subject);
  if (!subject) return null;
  let hit: LetterRecord | null = null;
  for (const l of letters) {
    if (senderKey(l.sender) !== key || nowMs - l.createdAt > DUPLICATE_WINDOW_MS) continue;
    // A letter its sender withdrew, or one settled as needed no more, may be sent again.
    if (l.settled || l.answered?.actionId === 'withdrawn') continue;
    if (normalizeText(l.subject) !== subject) continue;
    if (!hit || l.createdAt > hit.createdAt) hit = l;
  }
  return hit;
}

/** The sender's open decision letter that asks what this subject asks (most similar, then newest), or null. */
export function findOpenSameAsk(
  input: { subject: string; sender: LetterSender },
  letters: readonly LetterRecord[],
): { letter: LetterRecord; similarity: number } | null {
  const key = senderKey(input.sender);
  if (!key || !normalizeText(input.subject)) return null;
  let best: { letter: LetterRecord; similarity: number } | null = null;
  for (const l of letters) {
    if (senderKey(l.sender) !== key || !isOpenDecision(l)) continue;
    const similarity = textSimilarity(input.subject, l.subject);
    if (similarity < SIMILAR_SUBJECT_MIN) continue;
    if (!best || similarity > best.similarity || (similarity === best.similarity && l.createdAt > best.letter.createdAt)) {
      best = { letter: l, similarity };
    }
  }
  return best;
}

/** The letter's latest agent turn when `text` repeats it inside the window, or null. */
export function findDuplicateReply(
  letter: Pick<LetterRecord, 'thread'>,
  text: string,
  nowMs: number,
): { at: number; text: string } | null {
  const last = [...letter.thread].reverse().find((t) => t.from === 'agent');
  if (!last || nowMs - last.at > DUPLICATE_WINDOW_MS || !normalizeText(text)) return null;
  return textSimilarity(text, last.text) >= SIMILAR_REPLY_MIN ? { at: last.at, text: last.text } : null;
}

/** The resend reason as given (one line), or '' when absent or too short to count. */
export function resendReasonOf(input: { resendReason?: unknown; resend_reason?: unknown }): string {
  const raw = input.resendReason ?? input.resend_reason;
  const reason = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
  return reason.length >= RESEND_REASON_MIN ? reason : '';
}

const ago = (ms: number) => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} s` : `${Math.round(ms / 60_000)} min`);

/** The refusal's words: which letter, and what to do instead. */
export function duplicateLetterMessage(first: Pick<LetterRecord, 'id' | 'subject' | 'createdAt' | 'answered'>, nowMs: number): string {
  return `Not sent: this task sent the user the letter "${first.subject}" (${first.id}) ${ago(nowMs - first.createdAt)} ago, `
    + 'with the same subject, and every letter buzzes their phone. '
    + (first.answered
      ? 'The user already answered it: read the answer (human_inbox_get) and go on. '
      : `To add to it, reply in its thread (human_inbox_reply with letter "${first.id}"); otherwise wait for the answer. `)
    + `Send it again only if it must be a new letter, with resend_reason: one line (at least ${RESEND_REASON_MIN} characters) saying why.`;
}

/** The refusal's words for a reply posted twice. */
export function duplicateReplyMessage(letterId: string, at: number, nowMs: number): string {
  return `Not sent: you posted this same reply in letter ${letterId} ${ago(nowMs - at)} ago. `
    + 'The user has it; wait for their answer, or reply with something new.';
}

/** What the send answers when the sender already has an open decision letter asking the same thing. */
export interface OpenAskHint {
  letterId: string;
  subject: string;
  sentAt: string;
  hint: string;
}

export function openAskHint(open: Pick<LetterRecord, 'id' | 'subject' | 'createdAt'>): OpenAskHint {
  const sentAt = new Date(open.createdAt).toISOString();
  return {
    letterId: open.id,
    subject: open.subject,
    sentAt,
    hint: `This task already has an unanswered decision letter asking the same thing: "${open.subject}" (${open.id}), sent ${sentAt}. `
      + `Next time reply in its thread (human_inbox_reply with letter "${open.id}") or settle it (human_inbox_mark settled) instead of opening a new letter.`,
  };
}
