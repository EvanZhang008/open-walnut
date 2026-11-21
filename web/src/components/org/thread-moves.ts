/**
 * A card that leaves the group on screen leaves a line in its place (2026-11-21, a review on his
 * data: his reply, a choice or Reopen moved a card to another group out of view with no word):
 * "Moved to Working “<title>” Show" for a few seconds, Show picking that group's chip. One mechanism for
 * every move (his reply, a click, Reopen, Snooze, the node's own change, a snooze's end): the
 * groups are compared from one read to the next (OrgThreadsByState), never told by each action.
 * Pure but for the hook at the bottom.
 */
import { useEffect, useRef, useState } from 'react';
import { useLeanCallback } from '@/hooks/useLeanCallback';
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

/** What a pane compares the next read of its groups with. */
export interface MoveBase { places: ThreadPlaces; filter: ThreadFilter; epoch: number }

/**
 * The lines on show after the groups are read again (useThreadMoves): none across a chip picked;
 * else the new moves added (none across a read that caught the pane up, `epoch` moved), each
 * replacing an older line of its card. Every line kept names where its card is now: a card that
 * moved on again out of sight (Closed, then the server keeps it open in Acknowledged; a review on
 * his data: the line said Closed while the card sat in Acknowledged) gets its new group, and a card
 * back where it left, or gone from the list, takes its line away. Returns `lines` itself when
 * nothing changed. Pure.
 */
export function stepMoves(was: MoveBase | null, now: MoveBase, lines: ThreadMove[]): ThreadMove[] {
  if (!was) return lines;
  if (was.filter !== now.filter) return lines.length ? [] : lines;
  const found = was.epoch === now.epoch ? movesBetween(was.places, now.places, now.filter) : [];
  const kept = lines.flatMap((m) => {
    const at = now.places.get(m.id);
    if (!at || at.group === m.from || found.some((f) => f.id === m.id)) return [];
    return [at.group === m.to && at.title === m.title ? m : { ...m, to: at.group, title: at.title }];
  });
  const same = kept.length === lines.length && kept.every((m, i) => m === lines[i]);
  return same && !found.length ? lines : [...kept, ...found];
}

/**
 * The lines on show: each new move replaces an older line of the same card, a card back in the
 * group it left takes its line away, and each line goes after MOVE_NOTE_MS (OrgThreadsByState
 * MoveNote). Moves are read only while the filter stays the same: a chip picked is not a move.
 * Nor while `epoch` (useThreadsCatchUp) moves: a read that caught the pane up after it was away
 * (its first read on opening, a reconnect) brings changes he never saw happen, so it only sets
 * where each card stands (a review: reopening Threads showed a burst of lines for old moves).
 */
export function useThreadMoves(groups: Readonly<Record<ThreadGroup, ReadonlyArray<{ id: string; title: string }>>>, filter: ThreadFilter, epoch = 0): {
  moves: ThreadMove[]; dismiss: (id: string) => void;
} {
  const prev = useRef<MoveBase | null>(null);
  const [moves, setMoves] = useState<ThreadMove[]>([]);
  useEffect(() => {
    const was = prev.current;
    const now: MoveBase = { places: placesOf(groups), filter, epoch };
    prev.current = now;
    setMoves((xs) => stepMoves(was, now, xs));
  }, [groups, filter, epoch]);
  const dismiss = useLeanCallback((id: string) => setMoves((xs) => xs.filter((m) => m.id !== id)), []);
  return { moves, dismiss };
}
