/**
 * What "Filter mails like these…" starts with: who the mail is from, the words its subjects share,
 * and the folder it goes to. Pure, so the card and its tests read the same answer.
 *
 * - From: the sender most of the rows come from (a letter's own sender).
 * - Subject: the head every subject of that sender's rows shares, cut back to a whole word and
 *   without trailing punctuation. CI mail reads `[acme/ferry] Run failed: Build - main (1a2b3c)`, so
 *   the rows share `[acme/ferry] Run failed`, which keeps out the same sender's review comments.
 *   One row, or a head under MIN_SUBJECT characters, says nothing about a series: empty.
 * - Folder: the group's name (a letter's own group), else the sender's name.
 */
import type { MailMessageDto } from '@/api/mail';

export const MIN_SUBJECT = 6;
const MAX_SUBJECT = 120;
export const MAX_FOLDER = 40;

export interface FilterDefaults {
  fromContains: string;
  subject: string;
  folder: string;
}

type Row = Pick<MailMessageDto, 'from' | 'subject'>;

const addressOf = (row: Row) => (row.from?.address ?? '').trim().toLowerCase();

/** The longest head all `subjects` share, cut back to a whole word, trailing punctuation dropped. */
export function sharedSubjectHead(subjects: readonly string[]): string {
  if (subjects.length < 2) return '';
  let head = subjects[0]!;
  for (const one of subjects.slice(1)) {
    let n = 0;
    while (n < head.length && n < one.length && head[n] === one[n]) n += 1;
    head = head.slice(0, n);
    if (!head) return '';
  }
  // Cut back to a word end unless every subject ends here or goes on with a separator.
  const boundary = (text: string) => /^[\s:;,.\-|/([{]/.test(text);
  if (!/\s$/.test(head) && !subjects.every((one) => one.length === head.length || boundary(one.slice(head.length)))) {
    const cut = head.search(/\s\S*$/);
    head = cut >= 0 ? head.slice(0, cut) : '';
  }
  const trim = (text: string) => text.replace(/[\s:;,.\-|/([{]+$/, '').trim();
  head = trim(head);
  if (head.length > MAX_SUBJECT) {
    // Over the cap: cut at the last whole word inside it, never mid-word.
    const capped = head.slice(0, MAX_SUBJECT + 1);
    const cut = capped.search(/\s\S*$/);
    head = trim(cut > 0 ? capped.slice(0, cut) : head.slice(0, MAX_SUBJECT));
  }
  return head.length >= MIN_SUBJECT ? head : '';
}

/** The card's starting values for these rows (a group's loaded mail, or one letter with its group's). */
export function filterDefaultsFor(rows: readonly Row[], options: { label?: string; sender?: string } = {}): FilterDefaults {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const address = addressOf(row);
    if (address) counts.set(address, (counts.get(address) ?? 0) + 1);
  }
  const sender = options.sender?.trim().toLowerCase()
    || [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0]
    || '';
  const own = rows.filter((row) => addressOf(row) === sender);
  const subject = sharedSubjectHead(own.map((row) => row.subject ?? ''));
  const name = own.find((row) => row.from?.name?.trim())?.from?.name?.trim() ?? '';
  const folder = (options.label?.trim() || name || sender.split('@')[0] || '').slice(0, MAX_FOLDER).trim();
  return { fromContains: sender, subject, folder };
}
