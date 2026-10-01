/**
 * The grouped inbox's message pages: one list per (view, group, sender), never shared with the
 * All mail list (spec 9.3a).
 *
 * The key is `<viewKey>|<group>|<sender>` (`smart:inbox|important|`), so a page that holds only
 * Important mail can never be read back as the whole inbox, and the reverse.
 *
 * `mergeFirstPage` is the one rule a live refresh uses: a refetched FIRST page replaces the rows it
 * covers (everything at or above its oldest row, by the server's own order) and keeps every older
 * page the person already paged in, so the scroll position and "Load older" survive the refresh.
 * Pure, so a unit test pins it without a browser.
 */
import type { MailMessageDto } from '@/api/mail';

export interface GroupPageState {
  rows: MailMessageDto[];
  /** The server's opaque cursor for the next page; null when the list ended. */
  nextBefore: string | null;
  /** The first page has landed at least once. */
  loaded: boolean;
  loading: boolean;
  olderLoading: boolean;
  error: string | null;
  /** How many pages were read (first + Load older), for a refetch of "the pages already loaded". */
  pages: number;
}

export const EMPTY_PAGE: GroupPageState = {
  rows: [], nextBefore: null, loaded: false, loading: false, olderLoading: false, error: null, pages: 0,
};

export function pageKey(viewKey: string, group: string, sender = ''): string {
  return `${viewKey}|${group}|${sender}`;
}

/** The pair identity of a row (a message id alone is not unique across accounts). */
export function rowId(one: { accountId: string; messageId: string }): string {
  return JSON.stringify([one.accountId, one.messageId]);
}

/**
 * The server's list order: `sent_at DESC, message_id DESC, account_id DESC`.
 * Negative when `a` is listed before `b`.
 */
export function compareListOrder(a: MailMessageDto, b: MailMessageDto): number {
  if (a.sentAt !== b.sentAt) return b.sentAt - a.sentAt;
  if (a.messageId !== b.messageId) return a.messageId < b.messageId ? 1 : -1;
  if (a.accountId !== b.accountId) return a.accountId < b.accountId ? 1 : -1;
  return 0;
}

/**
 * A refetched first page folded into what is loaded.
 *
 * `fresh` is authoritative for its range: from the top of the list down to its LAST row. When it
 * came back without a cursor (`freshEnded`) it is the whole list. Every loaded row after that
 * boundary is kept, in its place. A row inside the range that the fresh page no longer holds has
 * left the list (read under the unread filter, moved to another group) and goes.
 */
export function mergeFirstPage(
  loaded: MailMessageDto[],
  fresh: MailMessageDto[],
  freshEnded: boolean,
): MailMessageDto[] {
  if (freshEnded || fresh.length === 0) return freshEnded ? [...fresh] : mergeEmpty(loaded, fresh);
  const boundary = fresh[fresh.length - 1]!;
  const seen = new Set(fresh.map(rowId));
  const older = loaded.filter((one) => !seen.has(rowId(one)) && compareListOrder(one, boundary) > 0);
  return [...fresh, ...older];
}

/** An empty page WITH a cursor cannot happen; keep what is loaded rather than guess. */
function mergeEmpty(loaded: MailMessageDto[], fresh: MailMessageDto[]): MailMessageDto[] {
  return fresh.length === 0 ? loaded : fresh;
}

/** An older page appended below; a row already present (a live insert above) is not repeated. */
export function appendOlder(loaded: MailMessageDto[], older: MailMessageDto[]): MailMessageDto[] {
  const seen = new Set(loaded.map(rowId));
  return [...loaded, ...older.filter((one) => !seen.has(rowId(one)))];
}

/** The rows with one message's flags replaced; the same array when that message is not here. */
export function withFlags(
  rows: MailMessageDto[],
  target: { accountId: string; messageId: string },
  flags: (current: string[]) => string[],
): MailMessageDto[] {
  const id = rowId(target);
  let hit = false;
  const next = rows.map((one) => {
    if (rowId(one) !== id) return one;
    hit = true;
    return { ...one, flags: flags(one.flags) };
  });
  return hit ? next : rows;
}

/** The rows minus the given pairs; the same array when none of them is here. */
export function withoutRows(rows: MailMessageDto[], ids: ReadonlySet<string>): MailMessageDto[] {
  const next = rows.filter((one) => !ids.has(rowId(one)));
  return next.length === rows.length ? rows : next;
}

/**
 * An open group's refetched page folded in WITHOUT losing a row already shown: the mail you just
 * opened (now read, so the unread-only page no longer returns it) stays where it was until the
 * group is closed. Fresh rows win for their flags; the result is in the server's list order.
 */
export function mergeKeepShown(loaded: MailMessageDto[], fresh: MailMessageDto[]): MailMessageDto[] {
  const byId = new Map(loaded.map((one) => [rowId(one), one]));
  for (const one of fresh) byId.set(rowId(one), one);
  return [...byId.values()].sort(compareListOrder);
}
