/**
 * One row of the Org list, the same look for every kind (the CEO, a VP, a router, a Director, a
 * topic, an archived project): its avatar, its name and, when something there waits on the user,
 * one red dot. Nothing else (2026-11-22, the user: "just show name of vp icon, read dot for thread
 * ... We need to be super simple"): no time, no line under the name, no count, no unread dot, no
 * state mark on the avatar, and the CEO's row is no card. What those said is one hover away in the
 * row's `title` (rowHover), and the dot's label says the count to a screen reader.
 * Guard: tests/web/org-list-row-plain.test.ts.
 */
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { threadCountLabel } from '@open-walnut/thread-view';
import { stateCountLabel } from '@open-walnut/user-status';
import { timeAgo } from '@/utils/time';
import { askCount, type ChannelRow, shownName } from './org-channels-model';

type RowButton = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'type' | 'className' | 'role' | 'aria-selected'>
  & { [data: `data-${string}`]: string | number | boolean | undefined };

/** What the row's dot says, or null for no dot. On the CEO's and a VP's own row: its threads his view
 *  shows (threadsBadge; 2026-11-03, the user: "the little red should be thread instead of need u").
 *  On any other row: what opening it lets him answer (asks only: a card with only something to read is
 *  no ask). A count of 0 draws nothing. */
export function rowDot(row: Pick<ChannelRow, 'threadsBadge' | 'alerts'>): string | null {
  if (row.threadsBadge !== undefined) return row.threadsBadge > 0 ? threadCountLabel(row.threadsBadge) : null;
  const asks = askCount(row.alerts);
  return asks > 0 ? stateCountLabel('needs', asks) : null;
}

/** A node's state in words for the hover; a parked router is Paused, a parked VP Waiting. */
function stateWord(row: ChannelRow): string {
  switch (row.state) {
    case 'alert': return 'Needs you';
    case 'working': return 'Working';
    case 'parked': return row.kind === 'router' ? 'Paused' : 'Waiting';
    default: return 'Waiting';
  }
}

/** The row's hover: what the row itself no longer draws (its state and last move, its latest news,
 *  its threads or asks, unread, the projects a VP also leads). */
export function rowHover(row: ChannelRow, now: number): string {
  const moved = row.lastAt ? `, moved ${timeAgo(new Date(row.lastAt).toISOString(), { now })}` : '';
  const lines = [`${shownName(row)}: ${stateWord(row)}${moved}${row.unread ? ', unread' : ''}`];
  // A router's line is its own (area, Paused or Active, its VPs): never another field's words, which
  // may be an incoming item's (tests/web/org-router-section.test.ts).
  const news = row.latestTask && row.kind !== 'router' ? `${row.latestTask}: ${row.latest}` : row.latest;
  if (news) lines.push(`${news}${row.latestWatched ? ' (a watched thread)' : ''}`);
  // A node's own threads, 0 included (it draws no grey "0" any more), else its asks; said once.
  const count = row.threadsBadge !== undefined ? threadCountLabel(row.threadsBadge) : rowDot(row);
  if (count && !news.includes(count)) lines.push(count);
  if (row.led?.length) lines.push(`Also leads ${row.led.map((l) => l.name).join(', ')}`);
  return lines.join('\n');
}

/** Inside the list's listbox every row is an option (all a listbox may hold), the archived ones too. */
export function OrgListRow({ avatar, name, dot, selected = false, className = '', ...button }: {
  avatar: ReactNode;
  name: string;
  selected?: boolean;
  /** The dot's label ("3 threads"); no dot without one. */
  dot?: string | null;
  /** Classes beside `org-channel`: its kind (is-router, is-topic, is-director, is-moved). */
  className?: string;
} & RowButton) {
  return (
    <button type="button" role="option" aria-selected={selected} {...button} className={`org-channel${selected ? ' is-selected' : ''}${className ? ` ${className}` : ''}`}>
      {avatar}
      <span className="org-channel-name wn-meta">{name}</span>
      {dot ? <span className="org-channel-dot" role="img" aria-label={dot} data-testid="org-channel-dot" /> : null}
    </button>
  );
}
