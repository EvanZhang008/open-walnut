/**
 * A card that leaves the group on screen leaves a line in its place (2026-11-21, a review on his
 * data: his reply, a choice or Reopen moved a card to another group out of view with no word):
 * "Moved to Working “<title>” Show" for a few seconds, Show picking that group's chip. One mechanism for
 * every move (his reply, a click, Reopen, Snooze, the node's own change, a snooze's end): the
 * groups are compared from one read to the next (OrgThreadsByState), never told by each action.
 * Pure but for the hook at the bottom.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ALL_SHOWS, type ThreadGroup } from '@open-walnut/thread-groups';
import type { ThreadFilter } from './ThreadsFilterBar';

/** Where a card stood: its group and its place in that group's list. */
export interface ThreadPlace { group: ThreadGroup; index: number; title: string }
export type ThreadPlaces = ReadonlyMap<string, ThreadPlace>;

/** A card that left a group he was looking at, and where to. */
export interface ThreadMove { id: string; title: string; from: ThreadGroup; to: ThreadGroup; index: number }

/** How long the line stays (it fades over its last second, org-threads.css). */
export const MOVE_NOTE_MS = 6_000;

/** Does the filter show this group's cards? All shows every group but Archived. Pure. */
export function filterShows(filter: ThreadFilter, g: ThreadGroup): boolean {
  return filter === 'all' ? ALL_SHOWS.includes(g) : filter === g;
}

/** Every card's place, read from the groups as drawn. Pure. */
export function placesOf(groups: Readonly<Record<ThreadGroup, ReadonlyArray<{ id: string; title: string }>>>): Map<string, ThreadPlace> {
  const out = new Map<string, ThreadPlace>();
  for (const g of Object.keys(groups) as ThreadGroup[]) groups[g].forEach((t, index) => out.set(t.id, { group: g, index, title: t.title }));
  return out;
}

/**
 * The cards that left a group the filter shows, between two reads of the groups. A card new to the
 * list, one gone from it (deleted) and one moved between two groups he was not looking at leave no
 * line. Pure.
 */
export function movesBetween(prev: ThreadPlaces, next: ThreadPlaces, filter: ThreadFilter): ThreadMove[] {
  const out: ThreadMove[] = [];
  for (const [id, was] of prev) {
    const now = next.get(id);
    if (!now || now.group === was.group || !filterShows(filter, was.group)) continue;
    out.push({ id, title: now.title, from: was.group, to: now.group, index: was.index });
  }
  return out;
}

/**
 * The lines on show: each new move replaces an older line of the same card, a card back in the
 * group it left takes its line away, and each line goes after MOVE_NOTE_MS (OrgThreadsByState
 * MoveNote). Moves are read only while the filter stays the same: a chip picked is not a move.
 */
export function useThreadMoves(groups: Readonly<Record<ThreadGroup, ReadonlyArray<{ id: string; title: string }>>>, filter: ThreadFilter): {
  moves: ThreadMove[]; dismiss: (id: string) => void;
} {
  const prev = useRef<{ places: ThreadPlaces; filter: ThreadFilter } | null>(null);
  const [moves, setMoves] = useState<ThreadMove[]>([]);
  useEffect(() => {
    const places = placesOf(groups);
    const was = prev.current;
    prev.current = { places, filter };
    if (!was || was.filter !== filter) { if (was) setMoves([]); return; }
    const found = movesBetween(was.places, places, filter);
    setMoves((xs) => {
      const kept = xs.filter((m) => !found.some((f) => f.id === m.id) && places.get(m.id)?.group !== m.from);
      return kept.length === xs.length && !found.length ? xs : [...kept, ...found];
    });
  }, [groups, filter]);
  const dismiss = useCallback((id: string) => setMoves((xs) => xs.filter((m) => m.id !== id)), []);
  return { moves, dismiss };
}
