/**
 * The short strings the mail list and reader put on screen.
 *
 * Pure, and free of anything DOM shaped, so `tests/web/mail-format.test.ts` can grade them
 * directly. Sizes go through the shared `formatSize`, never a private copy, so an attachment
 * chip and a truncation note can never print the same number two ways.
 */
import type { MailAddress, MailAttachmentMeta } from '@/api/mail';
import { formatSize } from '@/utils/format';
import { dayDate, fullTime, timeAgo } from '@/utils/time';
import { cleanAttachmentName, safeFilename } from '../../../../src/integrations/mail/attachment-name';

/** Past this, an age stops answering "when" and the date is what the reader wants. */
const AGE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The day a stamp older than a week prints (`dayDate`: `Nov 20`, `Nov 20, 2025`), kept per local day.
 *
 * Every row of the dense grouped inbox asks for one, and building the words is the expensive part
 * (2026-11-10, a CPU profile of the 3,000 mail draw: 360 to 460 ms of main-thread CPU in
 * `formatMailTime`, when each call built a new date formatter). `dayDate`'s words depend only on the
 * stamp's local day and today's, so the cache is keyed by both and a few hundred days serve every row.
 * It is dropped when the browser's language changes and whenever the page comes back into view (the
 * moment a time zone change, such as a laptop waking up after a flight, can first be seen).
 */
const dayWords = new Map<string, string>();

const localDay = (ms: number) => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };

/** Forget every cached day (the next stamp makes its words again in the page's zone). */
export function resetMailDayCache(): void {
  dayWords.clear();
}

if (typeof window !== 'undefined') {
  window.addEventListener('languagechange', resetMailDayCache);
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') resetMailDayCache(); });
  }
}

/**
 * A message's stamp: an age inside the last week (`3d ago`), its day beyond it (`Nov 20`).
 *
 * `sentAt` is epoch milliseconds (mail dates are instants). A provider that sent no date at all
 * gets no invented one: an empty string, so the row simply has no stamp.
 */
export function formatMailTime(sentAt: number): string {
  if (!Number.isFinite(sentAt) || sentAt <= 0) return '';
  const now = Date.now();
  if (now - sentAt < AGE_WINDOW_MS) return timeAgo(new Date(sentAt).toISOString(), { now });
  const key = `${localDay(sentAt)}|${localDay(now)}`;
  let words = dayWords.get(key);
  if (words === undefined) {
    words = dayDate(sentAt, { now });
    dayWords.set(key, words);
  }
  return words;
}

/**
 * The whole stamp (`fullTime`: `Fri, Nov 20, 2026, 9:40 PM`) for the reader's head and an ask's
 * `Date:` line, and nothing for a provider that sent no date (never the epoch's `Jan 1, 1970`).
 */
export function formatMailDate(sentAt: number): string {
  return Number.isFinite(sentAt) && sentAt > 0 ? fullTime(sentAt) : '';
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
