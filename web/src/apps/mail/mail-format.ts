/**
 * The short strings the mail list and reader put on screen.
 *
 * Pure, and free of anything DOM shaped, so `tests/web/mail-format.test.ts` can grade them
 * directly. Sizes go through the shared `formatSize`, never a private copy, so an attachment
 * chip and a truncation note can never print the same number two ways.
 */
import type { MailAddress, MailAttachmentMeta } from '@/api/mail';
import { formatSize } from '@/utils/format';
import { timeAgo } from '@/utils/time';

/** Past this, an age stops answering "when" and the date is what the reader wants. */
const AGE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * A message's stamp: an age inside the last week, a date beyond it.
 *
 * `sentAt` is epoch milliseconds (mail dates are instants). A provider that sent no date at all
 * gets no invented one: an empty string, so the row simply has no stamp.
 */
export function formatMailTime(sentAt: number): string {
  if (!Number.isFinite(sentAt) || sentAt <= 0) return '';
  const age = Date.now() - sentAt;
  if (age >= AGE_WINDOW_MS) {
    return new Date(sentAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }
  return timeAgo(new Date(sentAt).toISOString());
}

/** The full local date, for the reader's header. `sentAtHeader` rides its title attribute. */
export function formatMailDate(sentAt: number): string {
  if (!Number.isFinite(sentAt) || sentAt <= 0) return '';
  return new Date(sentAt).toLocaleString(undefined, {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

/** An attachment chip. v1 shows metadata only: nothing here is downloadable yet. */
export function attachmentLabel(attachment: MailAttachmentMeta): string {
  const name = attachment.filename?.trim() || 'Attachment';
  return attachment.bytes && attachment.bytes > 0 ? `${name} (${formatSize(attachment.bytes)})` : name;
}

export function truncatedNotice(bytes: number): string {
  return `Body truncated at ${formatSize(bytes)}`;
}

export function senderLabel(from: MailAddress | undefined): string {
  if (!from) return 'Unknown sender';
  return from.name?.trim() || from.address || 'Unknown sender';
}

/**
 * The ROW's answer to the question a sent list is scanned for: who it went to.
 *
 * The first recipient and how many more there were, never the whole list joined: a row has one line for
 * this and a sent list to a mailing list would spend it on eleven names. `senderLabel` is the wrong
 * answer in these folders, and the visible one was worse than wrong: it printed this account's own name
 * on every row, twice per row while the account chip was also a name.
 */
export function rowRecipientLabel(to: MailAddress[] | undefined): string {
  const first = to?.[0];
  // EMPTY, not a stand-in: the row puts the word `To` in front of whatever this returns, and a live sent
  // folder does hold messages whose cached recipients are empty, which read as "To No recipient".
  if (!first) return '';
  const name = first.name?.trim() || first.address || 'Unknown recipient';
  return to && to.length > 1 ? `${name} +${to.length - 1}` : name;
}

export function recipientLabel(to: MailAddress[]): string {
  if (to.length === 0) return '';
  return to.map((one) => one.name?.trim() || one.address).filter(Boolean).join(', ');
}

/**
 * A count as a person reads it: grouped by the browser's own locale, and never capped.
 *
 * The cap was the bug. A folder row reading "Inbox 99+" beside a list header reading "5 unread"
 * cannot be reconciled by looking at it, and the human's conclusion (correctly) was that one of the
 * two numbers is lying. Exact numbers can be compared, so the badge prints 1,284 and the header
 * prints the same figure. Rounded and floored, because it is a provider-declared number: one
 * non-integer would render as "3.0001", and a negative one is not a count of anything.
 */
export function formatCount(count: number): string {
  if (!Number.isFinite(count)) return '0';
  return Math.max(0, Math.round(count)).toLocaleString();
}

/** True when a message has not been read. IMAP states the POSITIVE, so absence is unread. */
export function isUnread(flags: string[]): boolean {
  return !flags.includes('\\Seen');
}
