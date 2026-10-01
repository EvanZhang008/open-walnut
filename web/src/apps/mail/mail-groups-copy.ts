/**
 * Every sentence the grouped inbox puts on screen, in one file.
 *
 * Pure strings, no React, so the places that must say the SAME thing about unread mail (the sidebar
 * badge tooltip, the header's count and the IMPORTANT head) all call `unreadExplain()` and cannot drift
 * apart; and so a unit test pins the exact words.
 */
import { formatCount } from './mail-format';

/** The numbers behind every unread sentence; all cached except `providerUnread`. */
export interface UnreadExplainInput {
  importantUnread: number;
  groupedUnread: number;
  providerUnread: number;
  cachedUnread: number;
}

/**
 * `3 unread in Important.`, `16 unread in groups.`, then `19 unread in Inbox as the server reports.`,
 * plus `Walnut's copy holds 17 unread.` when the cache and the provider disagree. One line each.
 */
export function unreadExplain(input: UnreadExplainInput): string {
  const lines = [
    `${formatCount(input.importantUnread)} unread in Important.`,
    `${formatCount(input.groupedUnread)} unread in groups.`,
    `${formatCount(input.providerUnread)} unread in Inbox as the server reports.`,
  ];
  if (input.cachedUnread !== input.providerUnread) {
    lines.push(`Walnut's copy holds ${formatCount(input.cachedUnread)} unread.`);
  }
  return lines.join('\n');
}

export function unreadWord(unread: number): string {
  return `${formatCount(unread)} unread`;
}

/** The header while the model is still sorting new mail (that mail waits in Important meanwhile). */
export function sortingText(pending: number): string {
  return `Sorting ${formatCount(pending)} new`;
}

export const SORTING_TITLE = 'New mail waits in Important until Walnut has sorted it.';
export const SORTED_WITHOUT_AI = 'Sorted without AI';
export const SORTED_WITHOUT_AI_TITLE =
  "Walnut's model did not answer, so mail is grouped by sender for now. Walnut tries again in a few minutes.";

/** `Ticket updates, 6 unread` (the group row's accessible name). */
export function groupRowAria(label: string, unread: number, open: boolean): string {
  return `${label}, ${unreadWord(unread)}. ${open ? 'Close' : 'Open'} group`;
}

/** An open group's `3 more` (the rows it has loaded past the first three). */
export function moreLabel(count: number): string {
  return `${formatCount(count)} more`;
}

export const SHOW_FEWER = 'Show fewer';
export const GROUP_ACTIONS_ARIA = 'Group actions';
export const VIEW_MENU_ARIA = 'List view';
export const GROUPED = 'Grouped';
export const ALL_MAIL = 'All mail';
export const UNREAD_ONLY = 'Unread important mail only';
export const IMPORTANT_MENU = 'These are important…';
export const RENAME_MENU = 'Rename group';
export const FILTER_MENU = 'Keep out of Inbox…';
export const CANT_MARK_HERE = "Can't mark read here";
export const GROUPS_UPDATING_TITLE = 'Groups are updating';
export const UNSUBSCRIBE_ELLIPSIS = 'Unsubscribe…';
export const STALE_COUNTS = 'Counts may be a few minutes old.';
export const STALE_GROUP = 'This group changed. Check the new count and try again.';
export const RESTARTED = 'Walnut restarted while marking mail read. Counts are refreshed.';
export const UNDO_EXPIRED = 'Undo is no longer available for this change.';
export const NO_UNREAD_NOW = 'This group has no unread mail now.';
export const ALL_CAUGHT_UP = 'All caught up';
export const ALL_CAUGHT_UP_DETAIL = 'No unread mail. Important mail you have read is below.';
export const ALL_CAUGHT_UP_EMPTY = 'No unread mail.';
export const IMPORTANT_EMPTY = 'Nothing needs you right now.';
export const IMPORTANT_EMPTY_UNREAD = 'No unread important mail.';

/** The `Mark N read` action (the ✓ button's title and the open group's footer). */
export function markLabel(unread: number): string {
  return `Mark ${formatCount(unread)} read`;
}

/** The row while a job runs; `done` absent (or the first second) reads as the bare verb. */
export function progressLabel(kind: 'read' | 'unread', done: number | null, total: number): string {
  const verb = kind === 'read' ? 'Marking' : 'Undoing';
  if (done === null) return `${verb}…`;
  return `${verb} ${formatCount(done)} of ${formatCount(total)}…`;
}

export interface BulkResultInput {
  kind: 'read' | 'unread';
  changed: number;
  failed: number;
  firstReason?: string;
  stopped?: boolean;
  /** Named in the result sentence (`Marked 6 read in Ticket updates.`). */
  groupLabel?: string;
}

function reasonOf(reason: string | undefined): string {
  const text = (reason ?? '').trim().replace(/[.\s]+$/, '');
  return text || 'the server did not say why';
}

/** The sentence the status strip shows when a job ends. Buttons (Undo, Retry N, Try again) are separate. */
export function bulkResultText(input: BulkResultInput): string {
  const n = formatCount(input.changed);
  if (input.kind === 'read') {
    if (input.changed === 0 && input.failed > 0) return `Walnut couldn't mark these read: ${reasonOf(input.firstReason)}.`;
    if (input.stopped) return `Stopped. Marked ${n} read.`;
    if (input.failed > 0) {
      return `Marked ${n} read. ${formatCount(input.failed)} couldn't be changed: ${reasonOf(input.firstReason)}.`;
    }
    return input.groupLabel ? `Marked ${n} read in ${input.groupLabel}.` : `Marked ${n} read.`;
  }
  if (input.changed === 0 && input.failed > 0) return `Walnut couldn't undo this: ${reasonOf(input.firstReason)}.`;
  if (input.stopped) return `Stopped. Marked ${n} unread again.`;
  if (input.failed > 0) {
    return `Marked ${n} unread again. ${formatCount(input.failed)} couldn't be changed: ${reasonOf(input.firstReason)}.`;
  }
  return `Marked ${n} unread again.`;
}

export function retryLabel(failed: number): string {
  return `Retry ${formatCount(failed)}`;
}

/** The state line while the recompute runs; the first backfill reads differently from an update. */
export function sortProgressText(done: number, total: number, firstBackfill: boolean): string {
  const lead = firstBackfill ? 'Sorting your mail…' : 'Updating groups…';
  return `${lead} ${formatCount(done)} of ${formatCount(total)}`;
}

export function groupsErrorText(serverSentence: string): string {
  return `Walnut couldn't sort this inbox: ${reasonOf(serverSentence)}. Showing all mail.`;
}

export function rulesErrorText(line: number | undefined): string {
  const where = line ? ` (line ${line})` : '';
  return `Your rules file has an error${where}, so Walnut is using the last rules that worked.`;
}

export function readOnlyTitle(accounts: string[]): string {
  return accounts.map((one) => `Mail in ${one} can't be marked read from Walnut.`).join('\n');
}

// ── the group cards ──

export function importantCardTitle(label: string): string {
  return `Treat ${label} as important?`;
}

export function importantCardBody(label: string): string {
  return `Mail Walnut groups as ${label} goes to Important from now on. You can change this in Settings, Mail rules.`;
}

export const WHY_LABEL = 'Why? (optional, helps Walnut learn)';
export const RENAME_TITLE = 'Rename group';
export const RENAME_ARIA = 'Group name';

export function importantSavedText(label: string): string {
  return `Saved. Mail in ${label} now goes to Important.`;
}

export function renamedText(label: string): string {
  return `Renamed to ${label}.`;
}

// ── keep out of Inbox (a Walnut-run filter: mail-filter-moves.ts on the server) ──

export function filterCardTitle(label: string): string {
  return `Keep ${label} out of the Inbox?`;
}

export function filterCardBody(label: string): string {
  return `From now on, new mail Walnut sorts into ${label} is moved to Archive as it arrives, and stays unread there.`;
}

export function filterMoveNowLabel(unread: number): string {
  return unread === 1 ? 'Also move the 1 unread mail in it now' : `Also move the ${formatCount(unread)} unread in it now`;
}

export const FILTER_NOTE = 'Walnut moves the mail while it is running, so your phone may still show it first. You can turn this off in Settings, Mail rules.';
export const FILTER_SAVE = 'Keep out of Inbox';

/** Accounts whose mail cannot be moved: it stays in the group, in the Inbox. */
export function filterCannotMoveText(accounts: string[]): string {
  const list = accounts.join(', ');
  return `Mail in ${list} can't be moved from Walnut; it stays in this group.`;
}

export function filterSavedText(label: string, moving: number): string {
  return moving > 0
    ? `New mail in ${label} now skips the Inbox. Moving ${formatCount(moving)} to Archive.`
    : `New mail in ${label} now skips the Inbox.`;
}

// ── the reader head ──

/** `In Ticket updates · Automated ticket status change`. */
export function readerWhyText(label: string, why: string): string {
  return why ? `In ${label} · ${why}` : `In ${label}`;
}

export const NOT_RIGHT = 'Not right?';
