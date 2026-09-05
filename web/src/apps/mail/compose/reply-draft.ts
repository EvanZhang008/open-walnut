/**
 * What a Reply starts from: recipients, the `Re:` subject, and the quoted original.
 *
 * Pure, and it takes the message rather than reading the store, so
 * `tests/web/mail-compose-reply.test.ts` can grade the recipient arithmetic (which is the half
 * with a real mistake in it: reply-all that keeps your own address mails you a copy of your own
 * reply, and one that does not dedupe mails somebody twice).
 *
 * The THREADING headers are deliberately not here. `In-Reply-To` and `References` are copied by
 * the server from the cached message, so a client cannot aim a reply into a thread it never read;
 * the composer only sends the pair of ids that names the message being answered.
 */
import type { MailAddress } from '@/api/mail';
import { addressKey } from './mail-address';

/**
 * The parts of a message a reply needs.
 *
 * `cc` and `replyTo` are optional because `MailMessageDto` carries NEITHER today (the server's
 * envelope has `cc`, the DTO drops it, and no layer keeps `Reply-To` at all). They are read here
 * so the arithmetic is already right the day the DTO grows them, and so this file states what a
 * correct reply-all needs.
 */
export interface ReplyTargetMessage {
  from?: MailAddress;
  to?: MailAddress[];
  cc?: MailAddress[];
  replyTo?: MailAddress[];
  subject: string;
  sentAt: number;
  sentAtHeader?: string;
}

export interface ReplyPrefill {
  to: MailAddress[];
  cc: MailAddress[];
  subject: string;
}

/** `Re:` once, whatever the original already carried. Mirrors the server's own rule. */
export function replySubject(subject: string): string {
  const trimmed = (subject ?? '').trim();
  if (!trimmed) return 'Re:';
  return /^re:/i.test(trimmed) ? trimmed : `Re: ${trimmed}`;
}

/**
 * Who a reply goes to.
 *
 * `to` is `Reply-To` when the sender asked for one (that header exists precisely to redirect an
 * answer), the `From` otherwise. Reply-all adds everyone else the message was addressed to, minus
 * this account's own address, minus anybody already in `to`, deduped case-insensitively because a
 * mail server treats `Alice@x` and `alice@x` as one person.
 */
export function replyPrefill(input: {
  message: ReplyTargetMessage;
  /** The address of the account replying, which must never end up in its own recipients. */
  accountAddress: string;
  all: boolean;
}): ReplyPrefill {
  const { message } = input;
  const mine = input.accountAddress.trim().toLowerCase();
  const to = (message.replyTo?.length ? message.replyTo : message.from ? [message.from] : [])
    .filter((one) => one.address);
  const seen = new Set<string>([...(mine ? [mine] : []), ...to.map(addressKey)]);
  const cc: MailAddress[] = [];
  if (input.all) {
    for (const one of [...(message.to ?? []), ...(message.cc ?? [])]) {
      if (!one?.address) continue;
      const key = addressKey(one);
      if (seen.has(key)) continue;
      seen.add(key);
      cc.push(one);
    }
  }
  return { to, cc, subject: replySubject(message.subject) };
}

/**
 * The original, quoted, as markdown.
 *
 * It is REAL BODY TEXT: the composer shows it read-only under the textarea, and it is appended to
 * the draft body on every save, so what the recipient gets is the reply followed by what it
 * answers. An html-only original is not quoted (this console has no html-to-text pass, and
 * inventing one would put a guess in somebody's outgoing mail): the attribution line stands
 * alone, which is honest and is what a mail client shows above a collapsed quote anyway.
 */
export function quoteMarkdown(input: {
  message: ReplyTargetMessage;
  /** The plain-text half of the body, when the reader has one. */
  text?: string;
}): string {
  const who = senderLine(input.message);
  const when = stamp(input.message);
  const attribution = when ? `On ${when}, ${who} wrote:` : `${who} wrote:`;
  const body = (input.text ?? '').replace(/\r\n/g, '\n').trimEnd();
  if (!body) return attribution;
  const quoted = body.split('\n').map((line) => (line ? `> ${line}` : '>')).join('\n');
  return `${attribution}\n\n${quoted}`;
}

/** The body a draft is saved with: what was typed, then the quote it answers. */
export function bodyWithQuote(typed: string, quote: string | null): string {
  if (!quote) return typed;
  return `${typed.replace(/\s+$/, '')}\n\n${quote}\n`;
}

function senderLine(message: ReplyTargetMessage): string {
  const from = message.from;
  if (!from) return 'the sender';
  return from.name?.trim() ? `${from.name.trim()} <${from.address}>` : from.address;
}

/** The original's own `Date` header when it kept one, a local stamp otherwise. */
function stamp(message: ReplyTargetMessage): string {
  if (message.sentAtHeader?.trim()) return message.sentAtHeader.trim();
  if (!Number.isFinite(message.sentAt) || message.sentAt <= 0) return '';
  return new Date(message.sentAt).toLocaleString(undefined, {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}
