/**
 * The one gate between a router and the person's inbox (2026-11-21, the user, on a row of
 * "给你: ..." letters for a bill, a form, a beta invitation, a password reset and two
 * login codes: "I have the email, you forward it to me again, what is the point ... normally don't
 * forward any of it", then "even the verification code gets forwarded to me again, what is the
 * point"). The mail is already in his mailbox, so a router letter that repeats it is noise.
 *
 * So a router's for_user decision sends a letter only when it passes this gate:
 *  - never for the kinds the person named: one-time and sign-in codes, password and account
 *    security notices, bills, statements, receipts and payment requests, invitations, promotions
 *    and newsletters, calendar invitations; whatever the router's words say;
 *  - and only as a question card: something only he can do, with a deadline, that he will not see
 *    anywhere else, put to him as one question with options (the first is the router's pick).
 * Anything else stays in Mail: the item is recorded not routed with the reason, and the mail is
 * never marked read or archived for it (that tidy is for pure noise only).
 *
 * service.ts routeItem calls this before any letter; tests/core/router-person-gate.test.ts keeps
 * every letter path of the router and the mail intake behind it.
 */

export type WithheldKind = 'code' | 'account_security' | 'bill' | 'promotion' | 'calendar' | 'not_a_question';

export interface PersonOption { label: string; description?: string }

export interface PersonLetterInput {
  subject?: string;
  preview?: string;
  reason: string;
  text?: string;
  /** The day by which only the person can act (YYYY-MM-DD). */
  deadline?: string;
  /** Why only the person can do it, and why it reaches them nowhere else. */
  onlyPerson?: string;
  /** The one question put to them. */
  ask?: string;
  /** Two to four answers, the router's pick first. */
  options?: PersonOption[];
}

export interface PersonCard {
  ask: string;
  deadline: string;
  onlyPerson: string;
  options: PersonOption[];
}

export type PersonLetterVerdict =
  | { send: true; card: PersonCard }
  | { send: false; kind: WithheldKind; why: string };

/** What each withheld kind is called on the item's line ("Left in Mail: <words>"). */
export const WITHHELD_WORDS: Record<WithheldKind, string> = {
  code: 'a one-time or sign-in code, expired before anyone reads a letter',
  account_security: 'a password or account security notice',
  bill: 'a bill, statement, receipt or payment request',
  promotion: 'an invitation, promotion or newsletter',
  calendar: 'a calendar invitation, already on the calendar',
  not_a_question: 'no deadline, reason only the person can act, and question with options',
};

/** The kinds that never become a letter, most specific first. */
const NEVER: ReadonlyArray<{ kind: Exclude<WithheldKind, 'not_a_question'>; patterns: RegExp[] }> = [
  { kind: 'code', patterns: [
    /\b(verification|verify|one[- ]?time|security|sign[- ]?in|log[- ]?in|login|access|confirmation|authentication|auth|2fa|mfa|temporary)\s+(code|pin|passcode|password)s?\b/i,
    /\bhere'?s\s+(your|the)\s+code\b/i,
    /\b\d{4,8}\b.{0,40}\bcode\b/i,
    /\bcode\s*[:：]\s*\d{4,8}\b/i,
    /\buse\s+\d{4,8}\s+to\b/i,
    /\b(otp|passcode)\b/i,
    /\b(sign|log)[- ]?in\s+link\b/i,
    /\bverification\s+for\b/i,
    /\bverify\s+(your\s+)?(email|account|identity|sign[- ]?in|login)\b/i,
    /\bmagic\s+link\b/i,
    /验证码|校验码|动态码|登录码|一次性(密码|口令)/,
  ] },
  { kind: 'account_security', patterns: [
    /\bpassword\s+(reset|change|changed|update|updated|expir)/i,
    /\breset\s+(your\s+)?password\b/i,
    /\b(new|unusual|suspicious)\s+(sign[- ]?in|login|activity|device)\b/i,
    /\bsecurity\s+(alert|notice|notification)\b/i,
    /\btwo[- ]step\s+verification\b/i,
    /\bshared\s+(some\s+)?google\s+account\s+data\b/i,
    /密码(重置|修改|已更改|变更)|安全提醒/,
  ] },
  { kind: 'bill', patterns: [
    /\b(statements?|invoices?|bills?|billing|receipts?|autopay|amount\s+due|past\s+due|payment\s+(due|reminder|received|confirmation|failed)|cost\s+anomal\w*)\b(?!\s+of\s+(work|materials|rights))/i,
    /\brequest(s|ed)?\s+\$\s?\d/i,
    /\$\s?\d[\d,]*(\.\d\d)?\s+(is\s+)?due\b/i,
    /账单|发票|缴费/,
  ] },
  { kind: 'calendar', patterns: [
    /^(updated\s+)?invitation(\s+updated)?\s*:/i,
    /^(accepted|declined|tentative|canceled|cancelled)(\s+event)?\s*:/i,
  ] },
  { kind: 'promotion', patterns: [
    /\b(newsletter|webinar|unsubscribe|promo|promotional|special\s+offer|limited\s+time)\b/i,
    /\d\s*%\s*off\b/i,
    /\bbeta\s+(program|invite|invitation|access)\b/i,
    /\bjoin\s+(our|the)?\s*\w*\s*(beta|program|community|waitlist)\b/i,
    /\binvitation\s+to\s+join\b/i,
    /\btime\s+to\s+(order|reorder|renew)\b/i,
  ] },
];

/** The kinds the router's own words may show too (its reason names "a login code"); the others are read from the item only. */
const FROM_ROUTER_WORDS: ReadonlySet<string> = new Set(['code', 'account_security']);

/** The kinds a person may still read in Mail: never marked read or archived by the noise tidy. */
export const KEEP_IN_MAIL_KINDS: ReadonlySet<string> = new Set(['bill', 'account_security', 'calendar']);

const flat = (words: readonly (string | undefined)[]) => words.filter((one): one is string => !!one?.trim()).map((one) => one.replace(/\s+/g, ' ').trim());

/**
 * The kind of item that never becomes a letter, or undefined. Pure: no I/O. `item` is the mail's own
 * subject and preview (never the sender's display name: "Bill Chen" is no bill); `router` is the
 * router's reason and brief, read only for codes and security notices.
 */
export function neverForPerson(item: readonly (string | undefined)[], router: readonly (string | undefined)[] = []): Exclude<WithheldKind, 'not_a_question'> | undefined {
  const own = flat(item);
  const theirs = flat(router);
  for (const rule of NEVER) {
    const lines = FROM_ROUTER_WORDS.has(rule.kind) ? [...own, ...theirs] : own;
    if (lines.some((line) => rule.patterns.some((pattern) => pattern.test(line)))) return rule.kind;
  }
  return undefined;
}

const DAY = 24 * 60 * 60 * 1000;
/** How far ahead a deadline may be: anything later is not urgent enough to interrupt for. */
export const PERSON_DEADLINE_MAX_DAYS = 60;

/** A YYYY-MM-DD deadline from today to PERSON_DEADLINE_MAX_DAYS ahead, or undefined. */
export function validDeadline(value: string | undefined, now = Date.now()): string | undefined {
  const day = value?.trim();
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return undefined;
  const at = Date.parse(`${day}T23:59:59Z`);
  if (!Number.isFinite(at) || at < now || at > now + PERSON_DEADLINE_MAX_DAYS * DAY) return undefined;
  return day;
}

/**
 * Whether a router's for_user decision may become a letter. The item's subject, sender and preview
 * and the router's own reason and brief are all read for the never-kinds; then the card must be whole.
 */
export function personLetterVerdict(input: PersonLetterInput, now = Date.now()): PersonLetterVerdict {
  const kind = neverForPerson([input.subject, input.preview], [input.reason, input.text]);
  if (kind) return { send: false, kind, why: WITHHELD_WORDS[kind] };
  const deadline = validDeadline(input.deadline, now);
  const onlyPerson = input.onlyPerson?.replace(/\s+/g, ' ').trim() ?? '';
  const ask = input.ask?.replace(/\s+/g, ' ').trim() ?? '';
  const options = (input.options ?? [])
    .map((one) => ({ label: one.label?.replace(/\s+/g, ' ').trim() ?? '', ...(one.description?.trim() ? { description: one.description.trim().slice(0, 300) } : {}) }))
    .filter((one) => one.label);
  if (!deadline || onlyPerson.length < 20 || !ask || ask.length > 160 || options.length < 2 || options.length > 4) {
    return { send: false, kind: 'not_a_question', why: WITHHELD_WORDS.not_a_question };
  }
  return { send: true, card: { ask, deadline, onlyPerson: onlyPerson.slice(0, 500), options: options.map((one) => ({ ...one, label: one.label.slice(0, 60) })) } };
}

/** The words in front of a withheld item's reason. */
export function withheldPrefix(why: string): string {
  return `Left in Mail, no letter (${why}): `;
}
