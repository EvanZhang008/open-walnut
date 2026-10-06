/**
 * The kanban's chips and search (spec 7.2) as pure logic: which card a chip
 * or a query matches, the live chip counts, the empty and tooltip texts, and
 * the frozen membership of an active chip (G13: a card that stops matching
 * stays, marked Handled, until the chip changes). Unit-pinned in
 * tests/web/kanban-filter-model.test.ts.
 */
import type { KanbanChipId, KanbanFilterKey } from './kanban-contract';
import type { KanbanCardVM } from './kanban-card-model';
import { clockText } from './kanban-time';

type ChipCard = Pick<KanbanCardVM, 'needsYou' | 'sev' | 'laneKind' | 'foot' | 'changed' | 'running' | 'isComplete' | 'loading'>;

/** Open = not in a done kind lane (the user's lanes decide, G7). */
export function isOpenCard(c: Pick<KanbanCardVM, 'laneKind'>): boolean {
  return c.laneKind !== 'done';
}

export function matchesChip(c: ChipCard, chip: KanbanFilterKey): boolean {
  if (c.loading) return false;
  switch (chip) {
    case 'needs': return c.needsYou;
    case 'sev1': return c.sev === '1' && isOpenCard(c);
    case 'stale': return !!c.foot.stale;
    case 'changed': return c.changed;
    case 'running': return c.running;
    case 'still-open': return c.laneKind === 'done' && !c.isComplete;
    default: return false;
  }
}

/** Case-insensitive substring of the title, the ticket value, the summary shown, the waiting on shown. */
export function matchesSearch(c: Pick<KanbanCardVM, 'title' | 'ticket' | 'summary' | 'waiting'>, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = [c.title, c.ticket?.value, c.summary?.text, c.waiting?.kind === 'text' ? c.waiting.text : undefined];
  return hay.some((h) => !!h && h.toLowerCase().includes(q));
}

export function chipCounts(cards: readonly ChipCard[], leaderNeedsYou = false): Record<KanbanChipId, number> {
  const out: Record<KanbanChipId, number> = { needs: leaderNeedsYou ? 1 : 0, sev1: 0, stale: 0, changed: 0, running: 0 };
  for (const c of cards) {
    for (const chip of ['needs', 'sev1', 'stale', 'changed', 'running'] as const) if (matchesChip(c, chip)) out[chip]++;
  }
  return out;
}

/**
 * The Sev 1 chip shows only when an open card is sev:1 and the open cards carry
 * more than one sev value (G20, N13: a team with no Sev 1 never sees a grey `Sev 1 0`).
 */
export function sevChipShown(cards: readonly Pick<KanbanCardVM, 'sev' | 'laneKind' | 'loading'>[]): boolean {
  const values = new Set<string>();
  for (const c of cards) if (!c.loading && c.sev && isOpenCard(c)) values.add(c.sev);
  return values.has('1') && values.size > 1;
}

const CHIP_LABELS: Record<KanbanFilterKey, string> = {
  needs: 'Needs you', sev1: 'Sev 1', stale: 'Stale', changed: 'Changed', running: 'Running', 'still-open': 'Task still open',
};

/** N15: `1 card`, `N cards`. */
export function cardsText(n: number): string {
  return `${n} ${n === 1 ? 'card' : 'cards'}`;
}

export function chipLabel(chip: KanbanFilterKey): string {
  return CHIP_LABELS[chip];
}

/** The centre line of an active chip whose live count is 0. */
export function emptyTextFor(chip: KanbanFilterKey): string {
  switch (chip) {
    case 'needs': return 'Nothing needs you now';
    case 'sev1': return 'No Sev 1 card is open now';
    case 'stale': return 'Nothing is stale now';
    case 'changed': return 'Nothing changed now';
    case 'running': return 'No worker is running now';
    default: return 'No task is still open in a done lane now';
  }
}

export function chipTooltip(chip: KanbanFilterKey, n: number, baselineAt?: string | null, now: number = Date.now()): string {
  const since = baselineAt ? ` (${clockText(baselineAt, now)})` : '';
  const cards = cardsText;
  switch (chip) {
    case 'needs': return n ? `${cards(n)} ${n === 1 ? 'needs' : 'need'} you` : 'Nothing needs you';
    case 'sev1': return n ? `${n} open Sev 1 ${n === 1 ? 'card' : 'cards'}` : 'No open Sev 1 card';
    case 'stale': return n ? `${cards(n)} with no progress in 48h` : 'Nothing is stale';
    case 'changed': return n ? `Changed since you last looked${since}` : `Nothing changed since you last looked${since}`;
    case 'running': return n ? `${n} ${n === 1 ? 'worker' : 'workers'} running` : 'No worker is running';
    default: return n ? `${cards(n)} in a done lane with the task still open` : 'No task is still open in a done lane';
  }
}

/**
 * G13 frozen membership: the cards an active chip shows. The first call
 * (prev null) takes the cards matching now; later calls add new matches and
 * never drop a card that stops matching.
 */
export function nextMembers(prev: ReadonlySet<string> | null, matching: Iterable<string>): Set<string> {
  const out = new Set(prev ?? []);
  for (const id of matching) out.add(id);
  return out;
}

/** Members that no longer match: shown at 50% with `Handled`. */
export function handledIds(members: ReadonlySet<string>, matching: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  for (const id of members) if (!matching.has(id)) out.add(id);
  return out;
}

type LaneCounts = { lane: { kind: string }; cardIds: readonly string[]; total: number; needs: number; openInDone: number; matched?: number };

/**
 * R3-07: a lane's counts under the active chip or search, so the head, the
 * strip, the rail and the red badge never disagree: `matched` = the cards the
 * filter shows, `needs` and `openInDone` count only those. No filter = as is.
 */
export function filteredLane<L extends LaneCounts>(
  lane: L, cards: Readonly<Record<string, Pick<KanbanCardVM, 'needsYou' | 'isComplete' | 'loading'>>>, isVisible: ((id: string) => boolean) | null,
): L {
  if (!isVisible) return lane;
  const ids = lane.cardIds.filter((id) => isVisible(id));
  const needs = ids.filter((id) => cards[id]?.needsYou).length;
  const openInDone = lane.lane.kind === 'done' ? ids.filter((id) => !cards[id]?.isComplete && !cards[id]?.loading).length : 0;
  return { ...lane, matched: ids.length, needs, openInDone };
}

/** A lane's count as every surface writes it: `3 / 13` under a filter (an empty lane is `0`), `24 (1 open)`, `13`. */
export function laneCountText(total: number, matched: number | undefined, openInDone: number): string {
  if (matched !== undefined) return total === 0 ? '0' : `${matched} / ${total}`;
  return openInDone > 0 ? `${total} (${openInDone} open)` : String(total);
}
