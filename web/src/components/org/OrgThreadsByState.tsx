/**
 * A node's Threads grouped by state (experiment brief_off): the view that replaces the Brief.
 * Needs you, To read and Known are open; Working, Waiting / snoozed and Done fold to one line each
 * until he opens them, and what he opened or folded stays as he left it (utils/view-memory.ts). A
 * row of chips over them jumps to a group (ThreadsFilterBar). Each thread is drawn by the same card
 * every Threads surface uses (OrgThreads ThreadItem), passed in.
 */
import { useRef, useState, type ReactNode } from 'react';
import type { OrgThread } from '@/api/org-threads';
import { THREAD_GROUPS, THREAD_GROUP_LABELS, type ThreadGroup } from '@open-walnut/thread-groups';
import { ThreadsFilterBar } from './ThreadsFilterBar';

/**
 * Open by default: what is for him, and Known (he acknowledged it and must be able to find it, a
 * few lines a card). The rest fold to one line until he opens them.
 */
export const THREAD_GROUP_OPEN: Record<ThreadGroup, boolean> = { needs: true, read: true, known: true, working: false, waiting: false, done: false };

export const isThreadGroups = (v: unknown): v is ThreadGroup[] =>
  Array.isArray(v) && v.every((g) => (THREAD_GROUPS as readonly unknown[]).includes(g));

/** Whether a group is open: its default, flipped when he flipped it. */
export function groupOpen(g: ThreadGroup, flipped: readonly ThreadGroup[]): boolean {
  return THREAD_GROUP_OPEN[g] !== flipped.includes(g);
}

export function OrgThreadsByState({ groups, flipped, onFlip, card, name }: {
  groups: Record<ThreadGroup, OrgThread[]>;
  /** The groups he opened or folded against their default. */
  flipped: readonly ThreadGroup[];
  onFlip: (g: ThreadGroup) => void;
  card: (t: OrgThread) => ReactNode;
  name: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  /** The chip last clicked: a passing place, not a view choice. */
  const [at, setAt] = useState<ThreadGroup | null>(null);
  const any = THREAD_GROUPS.some((g) => groups[g].length > 0);
  const jump = (g: ThreadGroup | null) => {
    setAt(g);
    if (g && !groupOpen(g, flipped)) onFlip(g);
    // After the group has drawn its cards.
    requestAnimationFrame(() => {
      const el = g ? rootRef.current?.querySelector(`section[data-group="${g}"]`) : rootRef.current;
      el?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
  };
  if (!any) {
    return (
      <p className="org-threads-empty" data-testid="org-threads-empty">
        {`Nothing open. Each request you send ${name} becomes a thread here; asks about the same thing stay in one thread.`}
      </p>
    );
  }
  return (
    <div ref={rootRef} className="org-thread-groups" data-testid="org-thread-groups">
      <ThreadsFilterBar counts={THREAD_GROUPS.map((g) => ({ group: g, n: groups[g].length }))} at={at} onJump={jump} />
      {THREAD_GROUPS.map((g) => {
        const list = groups[g];
        if (!list.length) return null;
        const open = groupOpen(g, flipped);
        return (
          <section key={g} className="org-thread-group" data-testid="org-thread-group" data-group={g} data-open={open ? 'true' : 'false'}>
            <button type="button" className="org-threads-closed-toggle org-thread-group-head" data-testid="org-thread-group-head" aria-expanded={open} onClick={() => onFlip(g)}>
              <span className="org-thread-group-label">{THREAD_GROUP_LABELS[g]}</span>
              <span className="org-thread-group-count" data-testid="org-thread-group-count">{list.length}</span>
              <span aria-hidden="true">{open ? ' ▾' : ' ▸'}</span>
            </button>
            {open && <ul className="org-thread-list" data-testid="org-thread-list" data-show={g}>{list.map(card)}</ul>}
          </section>
        );
      })}
    </div>
  );
}
