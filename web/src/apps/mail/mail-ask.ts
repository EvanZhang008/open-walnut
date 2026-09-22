/**
 * What Walnut is TOLD about one mail, and what each of the row menu's three Walnut rows asks it.
 *
 * Pure (no DOM, no fetch, no store), so the block's shape is graded directly
 * (`tests/web/mail-ask-context-block.test.ts`). The three answers it owns:
 *
 * - `mailAskKey` is the object identity the conversation is remembered under. The PAIR, never the
 *   message id alone: a merged list holds two accounts, and a provider's message ids are only unique
 *   inside one account, so `shared-8042` on two accounts must be two conversations (the same rule
 *   `pairKey` states in mail-store.ts, and the reason the join is JSON rather than `a:b`).
 * - `mailContextBlock` is the quote the FIRST message carries. It is written for a model that cannot
 *   see the screen, so every field the reader shows is spelled out, and the body is quoted line by
 *   line with `> `. That prefix is also the injection guard: a body line that begins
 *   `<walnut-message` is no longer at the start of its line, so it cannot be read as framing (the
 *   lane takes plain text, but the same body reaches a session through `task_send` later).
 * - `MAIL_ASK_PRESETS` is the question each entry stands for. `Summarize` and `Draft a reply` are
 *   sent on open; `ask` is deliberately EMPTY, because that entry opens the composer and asks
 *   nothing until the person types. The draft-reply preset says in its own words that sending goes
 *   through `mail_request_send` (the approval letter), so the model never reads "reply to this" as
 *   permission to put mail on the wire.
 */
import type { MailAddress, MailMessageDto } from '@/api/mail';
import type { AskObjectQuote } from '@/components/chat/AskObjectDrawer';
import { mailRowLink } from './mail-context-items';
import { formatMailDate, senderLabel } from './mail-format';

/** Which of the three rows opened the drawer. */
export type MailAskKind = 'summarize' | 'draft-reply' | 'ask';

/**
 * The first message each row sends, or '' for the row that sends nothing.
 *
 * Each one names the SHAPE of the answer rather than a length: "a few lines" survives a model
 * change, "under 60 words" is a rule the next model keeps differently.
 */
export const MAIL_ASK_PRESETS: Record<MailAskKind, string> = {
  summarize:
    'Summarize this mail: what it is about, what it asks of me, and any date, number or name that'
    + ' matters. A few lines, no preamble. If it touches work I already have, say which and why.',
  'draft-reply':
    'Draft a reply to this mail for me. Write it as me, plain and short, and answer everything it'
    + ' asks. Show the draft here and stop: do not send it, and do not save it anywhere. If I say to'
    + ' send it, use mail_request_send, which puts the send behind my approval. You never send mail'
    + ' yourself.',
  // '' means "open and wait". The drawer only auto-sends a preset that is non-empty, so this is the
  // whole implementation of "Ask… sends nothing" and a test pins it as a fact rather than an absence.
  ask: '',
};

/** How much of the body rides along. Enough for a real mail, small against a lane window. */
const BODY_CHARS = 4000;

/** Recipients named in full before the count takes over. A mailing list must not fill the block. */
const RECIPIENTS_SHOWN = 6;

/** A subject is attacker-controlled text; the block states one, it does not carry a paragraph. */
const SUBJECT_CHARS = 300;

/** Stable identity of one mail, for the conversation store. */
export function mailAskKey(accountId: string, messageId: string): string {
  return `mail:${JSON.stringify([accountId, messageId])}`;
}

function oneLine(text: string, max: number): string {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** `Name <address>`, or whichever half the provider gave. */
function addressLine(who: MailAddress | undefined): string {
  if (!who) return 'unknown';
  const name = who.name?.trim() ?? '';
  const address = who.address?.trim() ?? '';
  if (name && address) return `${name} <${address}>`;
  return name || address || 'unknown';
}

/** The first few recipients and how many were left out. */
function addressList(people: MailAddress[] | undefined): string {
  const rows = (people ?? []).filter((one) => one && (one.name || one.address));
  if (rows.length === 0) return '';
  const shown = rows.slice(0, RECIPIENTS_SHOWN).map(addressLine).join(', ');
  const rest = rows.length - Math.min(rows.length, RECIPIENTS_SHOWN);
  return rest > 0 ? `${shown} (+${rest} more)` : shown;
}

/**
 * The body, quoted.
 *
 * `null` is a body read that FAILED, which is not the same answer as a mail holding no words: the
 * block says so in words, because a model handed an empty quote would otherwise summarize the
 * headers and present that as the mail.
 */
function bodyLines(bodyText: string | null): string {
  if (bodyText === null) {
    return 'Body: Walnut could not read this message\'s body, so only the headers above are known.';
  }
  const text = bodyText.trim();
  if (!text) return 'Body: (this message has no text to quote)';
  const clipped = text.length > BODY_CHARS ? text.slice(0, BODY_CHARS) : text;
  const quoted = clipped.split('\n').map((line) => `> ${line}`).join('\n');
  const note = text.length > BODY_CHARS
    ? `\n(quote cut here; the mail is ${text.length} characters long)`
    : '';
  return `Body:\n${quoted}${note}`;
}

/**
 * The block prepended to the first message about this mail.
 *
 * `accountLabel` is which of the person's accounts holds it (a merged list shows several at once),
 * and `origin` is this console's own origin: the link is a Walnut deep link, never a provider
 * permalink (see `mailRowLink`). Ends with a blank line, so whatever the person typed reads as their
 * own sentence and not as a continuation of the quote.
 */
export function mailContextBlock(
  message: MailMessageDto,
  accountLabel: string,
  bodyText: string | null,
  origin: string,
): string {
  const to = addressList(message.to);
  const cc = addressList(message.cc);
  // The `Date` header VERBATIM when the provider kept one: it carries the sender's own offset, which
  // a local render throws away. The local render is the fallback, never both.
  const when = message.sentAtHeader?.trim() || formatMailDate(message.sentAt) || 'unknown';
  const lines = [
    'The mail I am looking at in Walnut:',
    '',
    `From: ${addressLine(message.from)}`,
    ...(to ? [`To: ${to}`] : []),
    ...(cc ? [`Cc: ${cc}`] : []),
    `Date: ${when}`,
    `Subject: ${oneLine(message.subject || '(no subject)', SUBJECT_CHARS)}`,
    ...(accountLabel ? [`Account: ${accountLabel}`] : []),
    `Link: ${mailRowLink(message.accountId, message.messageId, origin)}`,
    '',
    bodyLines(bodyText),
    '',
    '',
  ];
  return lines.join('\n');
}

/** The drawer's quote card: the same four facts, short enough for three lines of pane. */
export function mailAskQuote(
  message: MailMessageDto,
  accountLabel: string,
  bodyText: string | null,
): AskObjectQuote {
  const preview = bodyText === null
    ? 'Walnut could not read this message.'
    : (bodyText.trim() || message.snippet || '');
  return {
    who: senderLabel(message.from),
    when: message.sentAtHeader?.trim() || formatMailDate(message.sentAt),
    where: accountLabel,
    preview: oneLine(message.subject || '(no subject)', 120)
      + (preview ? `\n${oneLine(preview, 300)}` : ''),
  };
}
