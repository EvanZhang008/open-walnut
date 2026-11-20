/**
 * The row of chips over a node's Threads (experiment brief_off, OrgThreadsByState): All and every
 * group (core/org/thread-groups.ts), always all of them, each with its count. A chip is a filter: a
 * group's shows only that group's cards, All the groups it shows (ALL_SHOWS), counted as many.
 */
import { THREAD_GROUP_LABELS, type ThreadGroup } from '@open-walnut/thread-groups';

/** What the Threads show: one group, or all of them. */
export type ThreadFilter = 'all' | ThreadGroup;

export function ThreadsFilterBar({ counts, all, at, onPick }: {
  /** Each group in the order drawn, with how many threads it holds. */
  counts: ReadonlyArray<{ group: ThreadGroup; n: number }>;
  /** How many cards All shows. */
  all: number;
  /** The chip picked. */
  at: ThreadFilter;
  onPick: (f: ThreadFilter) => void;
}) {
  return (
    <div className="org-threads-filter" data-testid="org-threads-filter" role="toolbar" aria-label="Thread groups">
      <button type="button" className="org-threads-chip" data-testid="org-threads-chip" data-group="all" aria-pressed={at === 'all'} onClick={() => onPick('all')}>
        All <span className="org-threads-chip-count">{all}</span>
      </button>
      {counts.map(({ group, n }) => (
        <button key={group} type="button" className="org-threads-chip" data-testid="org-threads-chip" data-group={group} aria-pressed={at === group} onClick={() => onPick(group)}>
          {THREAD_GROUP_LABELS[group]} <span className="org-threads-chip-count">{n}</span>
        </button>
      ))}
    </div>
  );
}
