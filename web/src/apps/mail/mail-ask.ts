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
 * - `finishUnsubscribePreset` is the LAST rung of the unsubscribe ladder, and the only one a person
 *   starts by hand. A constant could not carry the two facts that make it useful (the page Walnut
 *   opened and why it stopped), so it is a function.
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

/**
 * Why the ladder stopped, in the words of somebody describing it out loud.
 *
 * The ledger's reason is a vocabulary (`confirm-form`, `unclear`, `http-403`), and handing that string
 * to a model as the whole explanation would make it guess at what happened. Each one it can be is
 * spelled out; anything else falls back to naming the code, which is still better than silence.
 */
const UNSUBSCRIBE_REASONS: Record<string, string> = {
  'confirm-form': 'the page loaded but it wants a confirmation pressed, so nothing is final yet',
  unclear: 'the page loaded and said nothing either way, so Walnut cannot tell whether it worked',
  'not-a-page': 'the link answered with a file rather than a page, so its words were never read',
  // The mailto rung's own reasons (S8). `mailto-pending` was the stub's placeholder and is gone.
  'mailto-many-recipients': 'this list takes an unsubscribe by mail, but its address names more than one'
    + ' recipient, so Walnut would not send it',
  'mailto-unusable': 'this list takes an unsubscribe by mail, but Walnut could not read the address it gave',
  'cannot-send': 'this list only takes an unsubscribe by mail, and this account has no outgoing mail set up',
  'send-failed': 'the unsubscribe mail was not sent, so nothing left the mailbox',
  'send-refused': 'the unsubscribe mail was not sent, so nothing left the mailbox',
  'send-unknown': 'the unsubscribe mail was sent but the server never confirmed it',
  'mailto-console-only': 'this list only takes an unsubscribe by mail, which Walnut sends only from a click',
  timeout: 'the page did not answer in time',
  unreachable: 'the page could not be reached',
  'too-many-redirects': 'the link kept redirecting, so Walnut stopped following it',
};

/** How much of a url rides the preset. Long enough for a real unsubscribe token. */
const URL_CHARS = 600;

export interface FinishUnsubscribeAsk {
  /** The page Walnut opened and could not finish, when there is one. */
  url?: string;
  /** The ledger's reason the ladder stopped (`confirm-form`, `unclear`, `http-403`, …). */
  reason?: string;
  /** What the person is leaving: the sender's `List-Id` when it published one, else its address. */
  listName?: string;
}

/**
 * The first message of the human-initiated fallback: "Walnut got this far, you finish it."
 *
 * The last rung of the ladder and the only one that is not programmatic. It exists because the
 * programmatic rungs have an honest failure mode — a page that wants a button pressed, or one that says
 * nothing — and the answer to that is a person (or the model they ask) reading the page, not a green
 * tick over a page nobody read.
 *
 * Parametric, so it is a function rather than a member of `MAIL_ASK_PRESETS`: the url and the reason are
 * what make it useful, and a constant could carry neither. Both are named explicitly in the text
 * because the model cannot see the console's status line and has no other way to learn them.
 *
 * It does NOT tell the model to unsubscribe "somehow". It tells it what Walnut already did, so it does
 * not repeat the request that already failed, and it asks for the final page's own words back, which is
 * the only evidence that would let the person believe the list is really gone.
 */
export function finishUnsubscribePreset(ask: FinishUnsubscribeAsk = {}): string {
  const url = (ask.url ?? '').replace(/\s+/g, '').slice(0, URL_CHARS);
  const why = ask.reason ? (UNSUBSCRIBE_REASONS[ask.reason] ?? `it stopped with "${ask.reason}"`) : '';
  const listName = (ask.listName ?? '').replace(/\s+/g, ' ').trim();
  return [
    `I want off this ${listName ? `list (${oneLine(listName, 200)})` : 'mailing list'}, and Walnut could`
    + ` not finish it on its own${why ? `: ${why}` : ''}.`,
    url
      ? `The unsubscribe page is ${url} . Open it, do whatever it actually takes to unsubscribe me, and`
        + ' then tell me the final page\'s own words so I know it worked.'
      : 'Look in the message for the way out (an unsubscribe link, a preferences page, an address to'
        + ' write to), do what it takes, and tell me exactly what you found.',
    'If you cannot finish it, say precisely what is left for me to do and where. Do not tell me I am'
    + ' unsubscribed unless the page said so.',
  ].join(' ');
}

/** How much of the body rides along. Enough for a real mail, small against a lane window. */
const BODY_CHARS = 4000;

/** Recipients named in full before the count takes over. A mailing list must not fill the block. */
const RECIPIENTS_SHOWN = 6;

/** A subject is attacker-controlled text; the block states one, it does not carry a paragraph. */
const SUBJECT_CHARS = 300;

/**
 * The row this mail is drawn as, as a CSS selector, for the drawer's focus return.
 *
 * A QUOTED attribute value, and escaped as one: only `"` and `\` mean anything inside it. Deliberately
 * NOT `CSS.escape`, which is for identifiers and would turn `fixture:ctx-writer@example.invalid` into
 * `fixture\:ctx-writer\@example\.invalid` — a string no row's attribute holds, so the selector would
 * quietly match nothing. Both halves are provider strings full of `:` and `@`, which is why this is
 * worth stating rather than guessing at.
 */
export function mailRowSelector(accountId: string, messageId: string): string {
  const quoted = (value: string): string => value.replace(/["\\]/g, '\\$&');
  return `.mail-row[data-account-id="${quoted(accountId)}"][data-message-id="${quoted(messageId)}"]`;
}

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
