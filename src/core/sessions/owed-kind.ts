/**
 * Which of the user's own kinds a close hold is (result_report.owed, owed-to-user.ts), so an answer
 * in his place (task_send answers_ask) settles one of the kinds only he decides only on his own words,
 * as every other ask does (2026-11-19, the Walnut VP, on the user's rule of 11-17 that anything irreversible or that involves
 * other people needs his approval: a hold's ask carried no kind, so a lead could
 * answer a spend or a delete for him with no words of his).
 *
 * Every hold Walnut writes carries its kind (`newHoldKind`): the kind its status's own ask named
 * (FOR_USER_ASK_OWN), else the first approval kind its items' words name, else `none`. A hold written
 * before kinds were kept reads its kind from its words the same way, and one whose words name none
 * reads `unknown`, which needs his words too: better held once more than decided for him.
 * Guard tests: tests/core/owed-kind.test.ts.
 */
import { APPROVAL_KINDS, needsUsersWords } from '../approval-kinds.js';
import type { TaskOwed } from '../peers/structured-reply.js';

/** A stored hold's kind: one of the user's kinds (org/user-kind.ts USER_KINDS), or none of them. */
export type OwedKind = string;
export const OWED_KIND_NONE = 'none';
/** A hold written before kinds were kept whose words name no kind. */
export const OWED_KIND_UNKNOWN = 'unknown';

/**
 * The words that name each approval kind (approval-kinds.ts APPROVAL_KINDS), English and Chinese (as
 * escapes), checked in this order. Broad on purpose: a false hit only asks for his words.
 */
const KIND_WORDS: ReadonlyArray<readonly [string, RegExp]> = [
  ['cloud_delete', /\b(?:delet\w*|remov\w*|drop\w*|destr\w*|terminat\w*|purg\w*|wip(?:e|es|ed|ing)\b|tear(?:s|ing)? down|tore down)|\u5220|\u9500\u6bc1|\u6e05\u7a7a/iu],
  ['spending', /\b(?:pay\w*|paid|purchas\w*|buy\w*|bought|order\w*|invoic\w*|bill\w*|subscri\w*|refund\w*|charg\w*|spen[dt]\w*|cost\w*|pric\w*|budget\w*|renew\w*|checkout)|[$\u00a5\u20ac\u00a3]\s?\d|\u4ed8|\u82b1\u94b1|\u8d2d\u4e70|\u4e70|\u8ba2\u9605|\u53d1\u7968|\u8d26\u5355|\u5145\u503c|\u7eed\u8d39/iu],
  ['credentials', /\b(?:passwords?|passcodes?|credential\w*|api[- ]?keys?|secrets?|tokens?|2fa|mfa|otp|sign(?:s|ed|ing)?[- ]?in|log(?:s|ged|ging)?[- ]?in|ssh[- ]?keys?)\b|\u5bc6\u7801|\u51ed\u636e|\u5bc6\u94a5|\u4ee4\u724c|\u767b\u5f55|\u9a8c\u8bc1\u7801/iu],
  ['permissions', /\b(?:permission\w*|access\w*|grant\w*|roles?|admins?|sudo|allow-?list\w*|whitelist\w*)\b|\u6743\u9650|\u6388\u6743/iu],
  ['outward', /\b(?:send\w*|sent|post\w*|repl(?:y|ies|ied|ying)|e-?mail\w*|messag\w*|ping\w*|slack|tweet\w*|publish\w*|releas\w*|announc\w*|sign(?:s|ed|ing)?[- ]?up|regist\w*|appl(?:y|ies|ied|ying|ication\w*)|invit\w*|meeting\w*|submit\w*|comment\w*|merg\w*|push\w*|upstream)\b|\u53d1\u9001|\u53d1\u7ed9|\u53d1\u5e16|\u56de\u590d|\u90ae\u4ef6|\u53d1\u5e03|\u62a5\u540d|\u6ce8\u518c|\u7533\u8bf7|\u9080\u8bf7|\u4f1a\u8bae|\u63d0\u4ea4/iu],
  ['irreversible', /\b(?:irreversibl\w*|cannot be undone|can't be undone|no undo|permanen\w*)|\u4e0d\u53ef\u9006|\u65e0\u6cd5\u64a4\u9500|\u6c38\u4e45/iu],
];

/** The first approval kind the text's words name, or null (pure). */
export function kindFromWords(text: string | undefined | null): string | null {
  const t = (text ?? '').replace(/\s+/g, ' ');
  if (!t.trim()) return null;
  for (const [kind, re] of KIND_WORDS) if (re.test(t)) return kind;
  return null;
}

/**
 * The kind a new hold is written with, and why (pure): the kind its status's own ask named when that
 * ask is one of its items, else the first approval kind its items' words name, else none.
 */
export function newHoldKind(texts: readonly string[], ownAsk?: { ask?: string | null; kind?: string | null } | null): { kind: OwedKind; why: string } {
  // Its own ask's kind leads when it is one only the user approves; another kind of his (a fact only
  // he has) never hides an item whose words name one (2026-11-19 review: "Which card?" beside "Pay $300").
  const own = ownAsk?.kind && ownAsk.ask && texts.includes(ownAsk.ask.replace(/\s+/g, ' ').trim()) ? ownAsk.kind : null;
  if (own && APPROVAL_KINDS.has(own)) return { kind: own, why: 'the kind its own ask of the user named' };
  for (const t of texts) {
    const k = kindFromWords(t);
    if (k) return { kind: k, why: `its words name it: "${t.slice(0, 120)}"` };
  }
  if (own) return { kind: own, why: 'the kind its own ask of the user named' };
  return { kind: OWED_KIND_NONE, why: 'no item names spending, an outward step, a credential, a permission, a delete or an irreversible step' };
}

/** A hold's kind: the one it was written with, else read once from its words, else unknown (pure). */
export function holdKind(owed: Pick<TaskOwed, 'items' | 'ask' | 'kind'>): OwedKind {
  if (owed.kind) return owed.kind;
  for (const t of [owed.ask, ...owed.items]) {
    const k = kindFromWords(t);
    if (k) return k;
  }
  return OWED_KIND_UNKNOWN;
}

/** The kind a hold written again with the same items keeps: a kind only he approves found now wins (pure). */
export function keptHoldKind(stored: Pick<TaskOwed, 'kind' | 'kind_why'>, now: { kind: OwedKind; why: string }): Pick<TaskOwed, 'kind' | 'kind_why'> {
  if (stored.kind && (APPROVAL_KINDS.has(stored.kind) || !APPROVAL_KINDS.has(now.kind))) return { kind: stored.kind, ...(stored.kind_why ? { kind_why: stored.kind_why } : {}) };
  return { kind: now.kind, kind_why: now.why };
}

/** Whether settling the hold in the user's place needs his own words (pure). */
export function holdNeedsUsersWords(owed: Pick<TaskOwed, 'items' | 'ask' | 'kind'>, askMe: boolean): boolean {
  const kind = holdKind(owed);
  return kind === OWED_KIND_UNKNOWN || needsUsersWords(kind, askMe);
}
