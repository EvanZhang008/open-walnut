/**
 * A node's Threads in their groups (experiment brief_off, core/org/thread-groups.ts): the view that
 * replaces the Brief. A row of chips over them is a filter (ThreadsFilterBar): a group's chip shows
 * only that group's cards, All shows every group under its head but Archived, which shows only when
 * its own chip is picked (2026-11-20, the user: clicking a group still listed the Needs you cards).
 * The pick is kept per node (utils/view-memory.ts). Each thread is drawn by the same card every
 * Threads surface uses (OrgThreads ThreadItem), passed in.
 */
import type { ReactNode } from 'react';
import type { OrgThread } from '@/api/org-threads';
import { ALL_SHOWS, THREAD_GROUPS, THREAD_GROUP_LABELS, type ThreadGroup } from '@open-walnut/thread-groups';
import { ThreadsFilterBar, type ThreadFilter } from './ThreadsFilterBar';

export const isThreadFilter = (v: unknown): v is ThreadFilter =>
  v === 'all' || (THREAD_GROUPS as readonly unknown[]).includes(v);

export function OrgThreadsByState({ groups, filter, onFilter, card, name }: {
  groups: Record<ThreadGroup, OrgThread[]>;
  /** The chip he picked: one group, or all of them. */
  filter: ThreadFilter;
  onFilter: (f: ThreadFilter) => void;
  card: (t: OrgThread) => ReactNode;
  name: string;
}) {
  if (!THREAD_GROUPS.some((g) => groups[g].length > 0)) {
    return (
      <p className="org-threads-empty" data-testid="org-threads-empty">
        {`Nothing open. Each request you send ${name} becomes a thread here; asks about the same thing stay in one thread.`}
      </p>
    );
  }
  const shown = filter === 'all' ? ALL_SHOWS : [filter];
  return (
    <div className="org-thread-groups" data-testid="org-thread-groups" data-filter={filter}>
      <ThreadsFilterBar counts={THREAD_GROUPS.map((g) => ({ group: g, n: groups[g].length }))} all={ALL_SHOWS.reduce((n, g) => n + groups[g].length, 0)} at={filter} onPick={onFilter} />
      {filter === 'all' && !ALL_SHOWS.some((g) => groups[g].length > 0) && (
        <p className="org-threads-empty" data-testid="org-threads-empty">Nothing open. What you closed before is under Archived.</p>
      )}
      {shown.map((g) => {
        const list = groups[g];
        // Under All an empty group has no head; picked alone, it says it is empty.
        if (!list.length) {
          return filter === 'all' ? null : (
            <p key={g} className="org-threads-empty" data-testid="org-thread-group-empty" data-group={g}>{`Nothing in ${THREAD_GROUP_LABELS[g]}.`}</p>
          );
        }
        return (
          <section key={g} className="org-thread-group" data-testid="org-thread-group" data-group={g}>
            <h3 className="org-thread-group-head" data-testid="org-thread-group-head">
              <span className="org-thread-group-label">{THREAD_GROUP_LABELS[g]}</span>
              <span className="org-thread-group-count" data-testid="org-thread-group-count">{list.length}</span>
            </h3>
            <ul className="org-thread-list" data-testid="org-thread-list" data-show={g}>{list.map(card)}</ul>
          </section>
        );
      })}
    </div>
  );
}
