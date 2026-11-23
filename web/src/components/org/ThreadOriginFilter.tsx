/**
 * A node's Threads filtered by where each came from (thread-origin.ts; 2026-11-23, the user: a VP
 * or a leader "able to see different threads. So doing the list, there can be a filter by ... By
 * default, at least all"). One row of chips, the standard filter over a list (standard.md, "Choice
 * controls"): All, This task, then each task below with a thread here, each with its count. It is
 * there only while a task below has a thread in the list; a node with its own threads alone shows no
 * row. The pick is kept per node (usePageViewOf); one no longer offered (that task's threads left)
 * reads All until it is offered again.
 */
import { useMemo } from 'react';
import { Chip, ChipGroup } from '@/components/controls';
import { usePageViewOf } from '@/utils/view-memory';
import type { OrgThread } from '@/api/org-threads';
import type { ThreadGroup } from '@open-walnut/thread-groups';
import { ORIGIN_ALL, fromOrigin, originChoices, shownOrigin, type OriginChoice } from './thread-origin';

const isPick = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200;

export interface ThreadOriginPick {
  /** The chips; null when every thread is the node's own (no row). */
  choices: OriginChoice[] | null;
  /** The pick on show (ORIGIN_ALL, ORIGIN_OWN or a task's id). */
  pick: string;
  setPick: (pick: string) => void;
  /** The threads of `xs` the pick shows; `xs` itself under All. */
  only: <T extends OrgThread>(xs: T[]) => T[];
  /** The same over every group of the grouped view. */
  onlyGroups: <T extends OrgThread>(groups: Record<ThreadGroup, T[]>) => Record<ThreadGroup, T[]>;
}

/** The filter of `node`'s Threads over `threads`, counting the ones the view lists for him (`listed`). */
export function useThreadOrigin(node: string, threads: readonly OrgThread[] | null, listed: ReadonlySet<string>): ThreadOriginPick {
  const [kept, setPick] = usePageViewOf('org', 'threads.origin', node, ORIGIN_ALL, isPick);
  const choices = useMemo(() => originChoices(threads ?? [], listed), [threads, listed]);
  const pick = shownOrigin(kept, choices);
  return useMemo(() => {
    const only = <T extends OrgThread>(xs: T[]): T[] => (pick === ORIGIN_ALL ? xs : xs.filter((t) => fromOrigin(t, pick)));
    const onlyGroups = <T extends OrgThread>(groups: Record<ThreadGroup, T[]>): Record<ThreadGroup, T[]> => (pick === ORIGIN_ALL
      ? groups
      : Object.fromEntries(Object.entries(groups).map(([g, xs]) => [g, only(xs)])) as Record<ThreadGroup, T[]>);
    return { choices, pick, setPick, only, onlyGroups };
  }, [choices, pick, setPick]);
}

export function ThreadOriginFilter({ choices, pick, onPick }: { choices: readonly OriginChoice[]; pick: string; onPick: (pick: string) => void }) {
  return (
    <ChipGroup className="org-threads-origin" role="group" aria-label="Show the threads from" data-testid="org-threads-origin">
      {choices.map((c) => (
        <Chip key={c.id} pressed={pick === c.id} count={c.count > 0 ? c.count : undefined} title={c.hover}
          data-testid="org-threads-origin-chip" data-origin={c.id} onClick={() => onPick(c.id)}>
          {c.label}
        </Chip>
      ))}
    </ChipGroup>
  );
}
