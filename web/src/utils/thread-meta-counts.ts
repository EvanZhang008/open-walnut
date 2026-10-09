/**
 * THE count function for questions (spec 7.3) and the labels built from it.
 * The drawer toggle, the drawer summary, the three filter chips and the row
 * pills read only this, so the same fixture can never show two different
 * numbers in two places.
 */
import type { SessionPinnedMessage } from '@/types/session';
import { ROOT_THREAD_KEY, type ThreadTree } from '@/utils/thread-tree';
import { hiddenKeysOf, statusOf, type ThreadLiveState, type ThreadMetaIndex } from '@/utils/thread-meta';

export interface ThreadCounts {
  /** Not hidden, status open (queued / answering / failed are open too). */
  open: number;
  /** Not hidden, the AI thinks it is answered; never folded into open. */
  suggested: number;
  /** Not hidden, resolved. */
  done: number;
  /** Not hidden, no meta or persisted `older`; never counted as open. */
  older: number;
  /** Every visible question (no root row, no pins, no pending or draft rows). */
  all: number;
  /** Pins whose question is visible. */
  pinned: number;
}

export const ZERO_COUNTS: ThreadCounts = { open: 0, suggested: 0, done: 0, older: 0, all: 0, pinned: 0 };

/** The thread key a pin lives in: the row's thread, root when the row is not in
 *  the loaded window (a pin is never lost from the count by a tail window). */
export function pinThreadKey(tree: ThreadTree, pin: Pick<SessionPinnedMessage, 'msgId'>): string {
  return tree.byRow.get(pin.msgId)?.key ?? ROOT_THREAD_KEY;
}

/**
 * Counts per spec 7.3. `live` never moves a question between buckets (a live
 * state only overlays an open question), it is accepted so every caller passes
 * the same inputs to the one function.
 */
export function counts(
  tree: ThreadTree,
  index: ThreadMetaIndex,
  pins: readonly Pick<SessionPinnedMessage, 'msgId'>[] = [],
  live?: ReadonlyMap<string, ThreadLiveState>,
  hidden: ReadonlySet<string> = hiddenKeysOf(tree, index),
): ThreadCounts {
  void live;
  const c: ThreadCounts = { ...ZERO_COUNTS };
  for (const node of tree.threads) {
    if (node.key === ROOT_THREAD_KEY || hidden.has(node.key)) continue;
    c.all += 1;
    const s = statusOf(node, index);
    if (s === 'open') c.open += 1;
    else if (s === 'suggested') c.suggested += 1;
    else if (s === 'resolved') c.done += 1;
    else c.older += 1;
  }
  for (const pin of pins) {
    if (!hidden.has(pinThreadKey(tree, pin))) c.pinned += 1;
  }
  return c;
}

/** `follow-up` / `follow-ups`: the UI never shows a `(s)`. */
export function pluralFollowUps(n: number): string {
  return `${n} ${n === 1 ? 'follow-up' : 'follow-ups'}`;
}

/** `question` / `questions`. */
export function pluralQuestions(n: number): string {
  return `${n} ${n === 1 ? 'question' : 'questions'}`;
}

/** Questions still to settle: open plus to check (the Open filter lists
 *  both kinds, the toggle's `All done` needs both at zero). */
export function openChipCount(c: ThreadCounts): number {
  return c.open + c.suggested;
}

/** `9 open, 4 to check` when some to check, else undefined (the Open
 *  chip's tooltip, N43). */
export function openChipTitle(c: ThreadCounts): string | undefined {
  return c.suggested > 0 ? `${c.open} open, ${c.suggested} to check` : undefined;
}

/**
 * The drawer toggle's text (the list icon is an SVG sibling, not part of this):
 * `3 open`, `3 open · 2 to check`, `None open`. Narrow keeps a word on its
 * one number (bare `3 · 2` said nothing, N28): `3 open`, or `2 to check` when
 * every open question looks answered; the tooltip carries the full text.
 */
export function toggleLabel(c: ThreadCounts, opts: { narrow?: boolean } = {}): string {
  if (c.open + c.suggested === 0) return 'None open';
  if (c.suggested === 0) return `${c.open} open`;
  if (opts.narrow) return c.open > 0 ? `${c.open} open` : `${c.suggested} to check`;
  return `${c.open} open · ${c.suggested} to check`;
}

/** The drawer shortcut as text. Spelled out, never the Shift arrow glyph: it
 *  sits in the Unicode Arrows block, which the new UI keeps free entirely. */
export function drawerShortcutText(mac: boolean): string {
  return mac ? 'Cmd+Shift+E' : 'Ctrl+Shift+E';
}

/** The toggle tooltip: `All questions (Cmd+Shift+E)` (spec 10); a narrow label
 *  drops a count, so there the full text leads. */
export function toggleTitle(c: ThreadCounts, opts: { mac?: boolean; narrow?: boolean } = {}): string {
  const key = drawerShortcutText(opts.mac !== false);
  const dropped = opts.narrow && c.suggested > 0 && c.open + c.suggested > 0;
  return dropped ? `${toggleLabel(c)}. All questions (${key})` : `All questions (${key})`;
}

/** Drawer summary: `3 open · 2 to check · 5 archived · 4 pinned`, zero
 *  segments omitted; empty string when every segment is zero. */
export function summaryText(c: ThreadCounts): string {
  const parts: string[] = [];
  if (c.open) parts.push(`${c.open} open`);
  if (c.suggested) parts.push(`${c.suggested} to check`);
  if (c.done) parts.push(`${c.done} archived`);
  if (c.pinned) parts.push(`${c.pinned} pinned`);
  return parts.join(' · ');
}

/** Filter chip labels (`All <n>` · `Open <n>` · `Pinned <n>`). `Open` counts
 *  the same set the toggle and the summary call open (N43: one meaning of
 *  "open" per screen); the filter also lists the ones that to check, each
 *  labelled so, and the chip's tooltip names both numbers. */
export function chipCounts(c: ThreadCounts): { all: number; open: number; pinned: number } {
  return { all: c.all, open: c.open, pinned: c.pinned };
}
