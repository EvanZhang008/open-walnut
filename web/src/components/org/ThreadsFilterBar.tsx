/**
 * The row of chips over a node's Threads by state (experiment brief_off, OrgThreadsByState): All and
 * each group that holds a thread, with its count. A click opens that group when it is folded and
 * brings it to the top (the phone's jump bar does the same). All goes back to the top.
 */
import type { ThreadGroup } from '@open-walnut/thread-groups';

/** A chip's word: the group's own name, Waiting / snoozed shortened to fit the row. */
const CHIP_LABEL: Record<ThreadGroup, string> = {
  needs: 'Needs you', read: 'To read', known: 'Known', working: 'Working', waiting: 'Waiting', done: 'Done',
};

export function ThreadsFilterBar({ counts, at, onJump }: {
  /** Each group in the order drawn, with how many threads it holds. */
  counts: ReadonlyArray<{ group: ThreadGroup; n: number }>;
  /** The chip last clicked (null: All). */
  at: ThreadGroup | null;
  onJump: (g: ThreadGroup | null) => void;
}) {
  const shown = counts.filter((c) => c.n > 0);
  const all = shown.reduce((sum, c) => sum + c.n, 0);
  return (
    <div className="org-threads-filter" data-testid="org-threads-filter" role="toolbar" aria-label="Thread groups">
      <button type="button" className="org-threads-chip" data-testid="org-threads-chip" data-group="all" aria-pressed={at === null} onClick={() => onJump(null)}>
        All <span className="org-threads-chip-count">{all}</span>
      </button>
      {shown.map(({ group, n }) => (
        <button key={group} type="button" className="org-threads-chip" data-testid="org-threads-chip" data-group={group} aria-pressed={at === group} onClick={() => onJump(group)}>
          {CHIP_LABEL[group]} <span className="org-threads-chip-count">{n}</span>
        </button>
      ))}
    </div>
  );
}
