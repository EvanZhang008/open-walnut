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

export function recipientLabel(to: MailAddress[]): string {
  if (to.length === 0) return '';
  return to.map((one) => one.name?.trim() || one.address).filter(Boolean).join(', ');
}

/** True when a message has not been read. IMAP states the POSITIVE, so absence is unread. */
export function isUnread(flags: string[]): boolean {
  return !flags.includes('\\Seen');
}
