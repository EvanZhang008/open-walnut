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
import { cleanAttachmentName, safeFilename } from '../../../../src/integrations/mail/attachment-name';

/** Past this, an age stops answering "when" and the date is what the reader wants. */
const AGE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** The date a stamp older than a week prints: `5 Sep 2026` (the locale's own order). */
const MAIL_DATE_OPTIONS: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' };

const dateFormats = new Map<string, Intl.DateTimeFormat>();

/**
 * One `Intl.DateTimeFormat` per locale and options, made once and reused.
 *
 * `toLocaleDateString(locale, options)` builds a new formatter on every call, and a formatter is
 * the expensive part: the dense grouped inbox's redraw spent 360 to 460 ms of main-thread CPU in
 * `formatMailTime` alone (2026-11-10, a CPU profile of the 3,000 mail draw). With date fields in
 * `options` both produce the same text (`tests/web/mail-format-cached-date.test.ts` compares them).
 *
 * A formatter keeps the locale and time zone the page had when it was made, so the cache is
 * dropped when the browser's language changes and whenever the page comes back into view (the
 * moment a time zone change, such as a laptop waking up after a flight, can first be seen).
 */
export function cachedDateFormat(locale: string | undefined, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale ?? ''}\u0000${JSON.stringify(options)}`;
  let format = dateFormats.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat(locale, options);
    dateFormats.set(key, format);
  }
  return format;
}

/** Forget every cached formatter (the next stamp makes a fresh one for the page's locale and zone). */
export function resetCachedDateFormats(): void {
  dateFormats.clear();
}

if (typeof window !== 'undefined') {
  window.addEventListener('languagechange', resetCachedDateFormats);
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') resetCachedDateFormats(); });
  }
}

/**
 * A message's stamp: an age inside the last week, a date beyond it.
 *
 * `sentAt` is epoch milliseconds (mail dates are instants). A provider that sent no date at all
 * gets no invented one: an empty string, so the row simply has no stamp.
 */
export function formatMailTime(sentAt: number): string {
  if (!Number.isFinite(sentAt) || sentAt <= 0) return '';
  const age = Date.now() - sentAt;
  if (age >= AGE_WINDOW_MS) return cachedDateFormat(undefined, MAIL_DATE_OPTIONS).format(sentAt);
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
/**
 * An attachment's name as the console shows it: the sender's name with no control character or
 * bidirectional override (`invoice\u202Efdp.exe` would read as `invoiceexe.pdf`), by the same rule
 * the server names the file with (src/integrations/mail/attachment-name.ts).
 */
export function attachmentName(attachment: MailAttachmentMeta): string {
  return cleanAttachmentName(attachment.filename) || 'Attachment';
}

/** The name a browser saves the file under: the name the server's header and Downloads use. */
export function attachmentFileName(attachment: MailAttachmentMeta): string {
  return safeFilename(attachment.filename);
}

export function attachmentLabel(attachment: MailAttachmentMeta): string {
  const name = attachmentName(attachment);
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
