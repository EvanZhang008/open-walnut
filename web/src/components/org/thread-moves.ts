/**
 * A card that leaves a group on screen leaves a line in its place (2026-11-21, a review on his
 * data: his reply, a choice or Reopen moved a card to another group out of view with no word):
 * "Moved to Working “<title>” Show" for a few seconds, Show opening that group's fold and bringing
 * the card into view. On screen: Needs you and Done always, a folded group only while he opened it
 * (OrgThreadsByState). One mechanism for
 * every move (his reply, a click, Reopen, Snooze, the node's own change, a snooze's end): the
 * groups are compared from one read to the next (OrgThreadsByState), never told by each action.
 * Pure but for the hook at the bottom.
 *
 * His own Acknowledge leaves no line (2026-11-25, the user, of "Moved to Acknowledged ... Show"
 * under a card he had just acknowledged: "直接消失就好了，不要再显示一个很烦"): he made that move
 * himself, so the card just goes. Read from the card (its `ackedAt` newer, or closed acked by him),
 * so his Acknowledge on another screen counts too.
 */
import { useLayoutEffect, useRef, useState } from 'react';
import { useLeanCallback } from '@/hooks/useLeanCallback';
import { FOLDED_GROUPS, FOR_HIM_GROUPS, type ThreadGroup } from '@open-walnut/thread-groups';

/** Where a card stood: its group and its place in that group's list, and his last Acknowledge of it. */
export interface ThreadPlace { group: ThreadGroup; index: number; title: string; acked?: string }

/** A card as the groups hold it: what a place reads of it. */
export interface PlacedCard { id: string; title: string; ackedAt?: string; closed?: { how?: string; by?: string; at?: string }; choice?: unknown; letter?: unknown }

/**
 * His last Acknowledge of a card: when it went to Acknowledged, or when his Acknowledge closed it.
 * A choice's or a letter's card has no Acknowledge (OrgThreads ThreadCard): his answer there closes
 * it the same way, and that move keeps its line ("Moved to Closed", thread-groups-folds.spec.ts). Pure.
 */
export function ackMark(t: PlacedCard): string | undefined {
  if (t.closed?.how === 'acked' && t.closed.by === 'human' && t.closed.at && !t.choice && !t.letter) return t.closed.at;
  return t.ackedAt;
}

/** He acknowledged the card between two reads: a move it made then is his own. Pure. */
export function ackedBetween(was: ThreadPlace | undefined, now: ThreadPlace | undefined): boolean {
  return !!now?.acked && now.acked !== was?.acked;
}
export type ThreadPlaces = ReadonlyMap<string, ThreadPlace>;

/** A card that left a group he was looking at, and where to. */
export interface ThreadMove { id: string; title: string; from: ThreadGroup; to: ThreadGroup; index: number }

/** How long the line stays (it fades over its last second, org-threads.css). */
export const MOVE_NOTE_MS = 6_000;

/** The groups whose cards are on screen: Needs you and Done always, a folded one while open. Pure. */
export function shownGroups(opened: ReadonlySet<ThreadGroup>): ReadonlySet<ThreadGroup> {
  return new Set([...FOR_HIM_GROUPS, ...FOLDED_GROUPS.filter((g) => opened.has(g))]);
}

/** Every card's place, read from the groups as drawn. Pure. */
export function placesOf(groups: Readonly<Record<ThreadGroup, ReadonlyArray<PlacedCard>>>): Map<string, ThreadPlace> {
  const out = new Map<string, ThreadPlace>();
  for (const g of Object.keys(groups) as ThreadGroup[]) {
    groups[g].forEach((t, index) => {
      const acked = ackMark(t);
      out.set(t.id, { group: g, index, title: t.title, ...(acked ? { acked } : {}) });
    });
  }
  return out;
}

/**
 * The cards that left a group on screen (`shown`), between two reads of the groups. A card new to
 * the list, one gone from it (deleted), one moved between two groups he was not looking at, and one
 * his own Acknowledge moved leave no line. Pure.
 */
export function movesBetween(prev: ThreadPlaces, next: ThreadPlaces, shown: ReadonlySet<ThreadGroup>): ThreadMove[] {
  const out: ThreadMove[] = [];
  for (const [id, was] of prev) {
    const now = next.get(id);
    if (!now || now.group === was.group || !shown.has(was.group) || ackedBetween(was, now)) continue;
    out.push({ id, title: now.title, from: was.group, to: now.group, index: was.index });
  }
  return out;
}

/** What a pane compares the next read of its groups with. */
export interface MoveBase { places: ThreadPlaces; shown: ReadonlySet<ThreadGroup>; epoch: number }

/**
 * The lines on show after the groups are read again (useThreadMoves): the new moves from a group on
 * screen in both reads added (none across a read that caught the pane up, `epoch` moved), each
 * replacing an older line of its card. Every line kept names where its card is now: a card that
 * moved on again out of sight (Closed, then the server keeps it open in Acknowledged; a review on
 * his data: the line said Closed while the card sat in Acknowledged) gets its new group, and a card
 * back where it left, or gone from the list, takes its line away, and so does folding the group
 * the line stands in (opening another group keeps it). Returns `lines` itself when nothing changed.
 * Pure.
 */
export function stepMoves(was: MoveBase | null, now: MoveBase, lines: ThreadMove[]): ThreadMove[] {
  if (!was) return lines;
  const both = new Set([...now.shown].filter((g) => was.shown.has(g)));
  const found = was.epoch === now.epoch ? movesBetween(was.places, now.places, both) : [];
  const kept = lines.flatMap((m) => {
    const at = now.places.get(m.id);
    if (!at || at.group === m.from || !now.shown.has(m.from) || found.some((f) => f.id === m.id) || ackedBetween(was.places.get(m.id), at)) return [];
    return [at.group === m.to && at.title === m.title ? m : { ...m, to: at.group, title: at.title }];
  });
  const same = kept.length === lines.length && kept.every((m, i) => m === lines[i]);
  return same && !found.length ? lines : [...kept, ...found];
}

/**
 * The lines on show: each new move replaces an older line of the same card, a card back in the
 * group it left takes its line away, and each line goes after MOVE_NOTE_MS (OrgThreadsByState
 * MoveNote). A fold opened or closed is not a move: only a group on screen in both reads gives lines.
 * Nor while `epoch` (useThreadsCatchUp) moves: a read that caught the pane up after it was away
 * (its first read on opening, a reconnect) brings changes he never saw happen, so it only sets
 * where each card stands (a review: reopening Threads showed a burst of lines for old moves).
 */
export function useThreadMoves(groups: Readonly<Record<ThreadGroup, ReadonlyArray<PlacedCard>>>, shown: ReadonlySet<ThreadGroup>, epoch = 0): {
  moves: ThreadMove[]; dismiss: (id: string) => void;
} {
  const prev = useRef<MoveBase | null>(null);
  const [moves, setMoves] = useState<ThreadMove[]>([]);
  // A layout effect: the line is drawn in the frame its card leaves. A passive one drew it a commit
  // later, so a frame could show neither, and the focus the card held was handed on before its line
  // was there to take it (OrgThreadsByState keepFocusHome; 2026-11-25, a group's head got it).
  useLayoutEffect(() => {
    const was = prev.current;
    const now: MoveBase = { places: placesOf(groups), shown, epoch };
    prev.current = now;
    setMoves((xs) => stepMoves(was, now, xs));
  }, [groups, shown, epoch]);
  const dismiss = useLeanCallback((id: string) => setMoves((xs) => xs.filter((m) => m.id !== id)), []);
  return { moves, dismiss };
}
