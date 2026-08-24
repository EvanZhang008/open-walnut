/**
 * "Which letters did THIS session write?" — the per-session lens on the one
 * letter store.
 *
 * Pure on purpose: the session tab's list and its unread badge are the same
 * derivation, and the badge is the thing a human trusts to tell them a letter is
 * waiting, so the rule lives in a function that can be pinned by a test rather
 * than inline in a component.
 *
 * The match is an EXACT session-id compare: the server stamps
 * `sender.sessionId` from the tracked record's `claudeSessionId` (letter-ops.ts
 * `resolveSenderUnbounded`), which is exactly the id a session panel is keyed
 * on. `external` (a hand-started agent with no session env) therefore belongs to
 * no session tab, which is correct — it has no session to show it in.
 */
import { compareLetters, isAwaitingDecision, type LetterEnvelope } from '@/api/human-inbox';

/** Letters this session sent, pinned first then newest. Archived rows excluded. */
export function lettersForSession(
  letters: readonly LetterEnvelope[],
  sessionId: string,
): LetterEnvelope[] {
  if (!sessionId) return [];
  return letters
    .filter(l => l.sender?.sessionId === sessionId && !l.archived)
    .sort(compareLetters);
}

/** How many of this session's letters are still unread. */
export function unreadLetterCount(letters: readonly LetterEnvelope[]): number {
  return letters.reduce((n, l) => (l.read ? n : n + 1), 0);
}

/** Unanswered decisions — a stronger signal than unread (work is blocked). */
export function decisionLetterCount(letters: readonly LetterEnvelope[]): number {
  return letters.reduce((n, l) => (isAwaitingDecision(l) ? n + 1 : n), 0);
}

/**
 * The tab badge: letters that still want the human — unread OR waiting on a
 * decision, counted as a UNION so each letter counts once.
 *
 * Unread alone was wrong and hid the one case the warning colour exists for:
 * reading an `action_required` letter and deciding later (which is the entire
 * point of an async ask) left unread at 0, so the chip went bare while the agent
 * was still blocked on the answer.
 */
export function attentionLetterCount(letters: readonly LetterEnvelope[]): number {
  return letters.reduce((n, l) => (!l.read || isAwaitingDecision(l) ? n + 1 : n), 0);
}

/**
 * The Inbox chip's tooltip. The badge is one number for two reasons, so the
 * hover has to name BOTH — otherwise a read-but-unanswered decision looks like an
 * unread letter that won't go away.
 */
export function inboxChipTitle(attention: number, unread: number, decisions: number): string {
  const base = 'Letters this session wrote you';
  if (attention <= 0) return `${base} — full-screen alongside the chat`;
  if (decisions > 0) {
    const also = unread > 0 ? `, ${unread} unread` : '';
    return `${base} — ${decisions} waiting on a decision${also}`;
  }
  return `${base} — ${unread} unread`;
}

/**
 * Does a letter id belong to THIS session? `unknown` = not in the live index
 * (still loading, or archived — the tab's list excludes archived rows), which is
 * deliberately NOT a refusal: a deep link to an archived letter still opens.
 *
 * A hand-written or stale deep link can name another session's letter, and
 * rendering it inside this session's tab would mark someone else's letter read,
 * point "← Letters" at a list it isn't in, and route its file paths at the wrong
 * host.
 */
export function letterSessionMatch(
  letters: readonly LetterEnvelope[],
  letterId: string,
  sessionId: string,
): 'match' | 'foreign' | 'unknown' {
  const found = letters.find(l => l.id === letterId);
  if (!found) return 'unknown';
  return found.sender?.sessionId === sessionId ? 'match' : 'foreign';
}
