/**
 * The attention card's undo rows (spec 5.1). A row x, the local x and Dismiss
 * all do not make their row vanish: the row turns, in place and at the same
 * height, into 'Hidden until it changes.' with a text button 'Undo' next to
 * the words (never where the x was). Clicks are ignored for 400ms after it
 * appears, so a double click on the x never lands on Undo. It collapses in
 * 150ms (instantly under reduced motion) after the LATER of 5s and the
 * pointer leaving the card, 10s at most. Undo takes the stored keys out again.
 *
 * The entries live in this module, not in the card: the card moving to
 * another mount (the task panel hidden or shown again) keeps a live undo line.
 * A line keeps the dismissed entry's height until it collapses, in every
 * mount: holding it only under the pointer made the line grow when the
 * pointer came back after an owner switch, and moved Dismiss all away from
 * the click aimed at it (N3-1). The words name what was hidden (N3-13).
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react';

export const UNDO_ROW_TEXT = 'Hidden until it changes.';
export const UNDO_ALL_TEXT = 'Hidden until they change.';
export const UNDO_LABEL = 'Undo';
/** Clicks on Undo within this long of it appearing are ignored. */
export const UNDO_GUARD_MS = 400;
export const UNDO_MIN_MS = 5_000;
export const UNDO_MAX_MS = 10_000;
export const UNDO_COLLAPSE_MS = 150;

/** 'Cert box hidden until it changes.' (several hosts in one row: '2 hosts hidden until they change.'). */
export function undoRowText(labels: readonly string[]): string {
  if (labels.length === 1) return `${labels[0]} hidden until it changes.`;
  if (labels.length > 1) return `${labels.length} hosts hidden until they change.`;
  return UNDO_ROW_TEXT;
}

/** Dismiss all's line: '4 hosts hidden until they change.' */
export function undoAllText(hostCount: number, onlyLabel?: string): string {
  if (hostCount === 1 && onlyLabel) return `${onlyLabel} hidden until it changes.`;
  if (hostCount > 0) return `${hostCount} hosts hidden until they change.`;
  return UNDO_ALL_TEXT;
}

export interface UndoEntry {
  /** 'row:<rowId>', 'all' or 'local'. */
  id: string;
  kind: 'row' | 'all' | 'local';
  /** row: where it stood among the rows on screen. */
  index: number;
  /** The dismissed row's height (the undo row keeps it). */
  height: number;
  /** The line's words (else the generic 'Hidden until it changes.'). */
  text?: string;
  shownAt: number;
  collapsing: boolean;
  /** Put the keys back (and the row back in place). */
  restore: () => void;
}

/** When an undo row starts to collapse: the later of 5s and the pointer leaving, capped at 10s. */
export function undoCollapseAt(shownAt: number, pointerInside: boolean, now: number): number {
  const cap = shownAt + UNDO_MAX_MS;
  if (pointerInside) return cap;
  return Math.min(cap, Math.max(shownAt + UNDO_MIN_MS, now));
}

/** Is a click on Undo this long after it appeared a real one (not the tail of a double click on the x)? */
export function undoClickCounts(shownAt: number, now: number): boolean {
  return now - shownAt >= UNDO_GUARD_MS;
}

interface UndoOptions {
  pointerInside: boolean;
  reducedMotion: () => boolean;
  /** An undo row is about to leave; `hadFocus` = focus was inside it. */
  onGone: (entry: UndoEntry, hadFocus: boolean) => void;
  /** The card's root, to find the row's element. */
  root: HTMLElement | null;
}

// ── The page's undo lines (one card on screen at a time, so one list) ──
let undoEntries: UndoEntry[] = [];
const undoListeners = new Set<() => void>();
function setUndoEntries(next: UndoEntry[] | ((list: UndoEntry[]) => UndoEntry[])): void {
  const value = typeof next === 'function' ? next(undoEntries) : next;
  if (value === undoEntries) return;
  undoEntries = value;
  for (const l of undoListeners) l();
}
function subscribeUndo(cb: () => void): () => void {
  undoListeners.add(cb);
  return () => { undoListeners.delete(cb); };
}
const getUndo = (): UndoEntry[] => undoEntries;
/** Test seam. */
export function __resetBannerUndoForTests(): void { undoEntries = []; undoListeners.clear(); }

export function useBannerUndo({ pointerInside, reducedMotion, onGone, root }: UndoOptions) {
  const all = useSyncExternalStore(subscribeUndo, getUndo, getUndo);
  const setEntries = setUndoEntries;
  // A line whose window ended while no card was on screen never comes back.
  const entries = all.some((e) => Date.now() - e.shownAt >= UNDO_MAX_MS + UNDO_COLLAPSE_MS)
    ? all.filter((e) => Date.now() - e.shownAt < UNDO_MAX_MS + UNDO_COLLAPSE_MS) : all;
  useEffect(() => { if (entries !== all) setEntries(entries); }, [entries, all, setEntries]);
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const onGoneRef = useRef(onGone);
  onGoneRef.current = onGone;

  const add = useCallback((e: Omit<UndoEntry, 'shownAt' | 'collapsing'>) => {
    setEntries((list) => [...list.filter((x) => x.id !== e.id), { ...e, shownAt: Date.now(), collapsing: false }]);
  }, [setEntries]);

  const remove = useCallback((id: string) => {
    const gone = undoEntries.find((x) => x.id === id);
    if (!gone) return;
    const el = root?.querySelector(`[data-undo-id="${id.replace(/["\\]/g, '')}"]`);
    const active = typeof document !== 'undefined' ? document.activeElement : null;
    const hadFocus = !!el && !!active && el.contains(active);
    // A collapsed row slot no longer takes a place: the later ones move up one.
    const drop = (list: UndoEntry[]) => list.filter((x) => x.id !== id)
      .map((x) => (gone.kind === 'row' && x.kind === 'row' && x.index > gone.index ? { ...x, index: x.index - 1 } : x));
    entriesRef.current = drop(entriesRef.current);
    setEntries(drop);
    onGoneRef.current(gone, hadFocus);
  }, [root, setEntries]);

  const undo = useCallback((id: string) => {
    const e = undoEntries.find((x) => x.id === id);
    if (!e || !undoClickCounts(e.shownAt, Date.now())) return;
    entriesRef.current = entriesRef.current.filter((x) => x.id !== id);
    setEntries((list) => list.filter((x) => x.id !== id));
    e.restore();
  }, [setEntries]);

  // The collapse clock: the earliest entry due, then 150ms of collapse.
  useEffect(() => {
    const now = Date.now();
    const open = entries.filter((e) => !e.collapsing);
    const timers: ReturnType<typeof setTimeout>[] = [];
    for (const e of open) {
      const due = undoCollapseAt(e.shownAt, pointerInside, now);
      timers.push(setTimeout(() => {
        if (reducedMotion()) { remove(e.id); return; }
        setEntries((list) => list.map((x) => (x.id === e.id ? { ...x, collapsing: true } : x)));
      }, Math.max(0, due - now)));
    }
    for (const e of entries.filter((x) => x.collapsing)) timers.push(setTimeout(() => remove(e.id), UNDO_COLLAPSE_MS));
    return () => { for (const t of timers) clearTimeout(t); };
  }, [entries, pointerInside, reducedMotion, remove, setEntries]);

  return { entries, add, undo, remove };
}

/**
 * One undo line in a dismissed entry's place. Focus moves to its Undo on
 * mount (the x that had it is gone); the words come first, Undo right after
 * them, never where the x was.
 */
export function UndoLine({ entry, text, as = 'li', onUndo }: {
  entry: UndoEntry; text: string; as?: 'li' | 'div'; onUndo: (id: string) => void;
}) {
  const btn = useRef<HTMLButtonElement | null>(null);
  // Focus follows a fresh line only (the x that had it is gone); a line that
  // moved here with the card from another mount leaves focus where it is.
  useLayoutEffect(() => { if (Date.now() - entry.shownAt < 300) btn.current?.focus({ preventScroll: true }); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const Tag = as;
  return (
    <Tag
      className={`hpb-undo-row${entry.collapsing ? ' hpb-undo-collapsing' : ''}`}
      data-undo-id={entry.id}
      data-testid="hpb-undo-row"
      style={{ minHeight: entry.height }}
    >
      <span className="hpb-undo-text">{entry.text ?? text}</span>
      <button type="button" tabIndex={0} ref={btn} className="hpb-undo" onClick={() => onUndo(entry.id)}>
        {UNDO_LABEL}
      </button>
    </Tag>
  );
}

/** Rows on screen with each row-undo line put back where its row stood. */
export function withUndoSlots<R extends { id: string }>(
  rows: readonly R[],
  entries: readonly UndoEntry[],
): Array<{ row: R } | { undo: UndoEntry }> {
  const out: Array<{ row: R } | { undo: UndoEntry }> = rows.map((row) => ({ row }));
  const rowUndos = entries.filter((e) => e.kind === 'row').sort((a, b) => a.index - b.index);
  for (const e of rowUndos) out.splice(Math.min(Math.max(0, e.index), out.length), 0, { undo: e });
  return out;
}
