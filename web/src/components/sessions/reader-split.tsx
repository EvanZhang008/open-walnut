/**
 * The chat's reading split (2026-11-11, the user: "a split screen of top and bot ...
 * basically it won't touch the main scrolling location, keep it to the top panel,
 * the input box is in the bottom ... something I want to read the text and ask
 * question, and I don't want to use the heavy tree mode").
 *
 * The panel's chat splits in two: the reading pane (SessionReaderPane) keeps the
 * conversation where the reader was, and never follows the tail; the chat under it
 * (or right of it) is the panel's own timeline and composer, which go on as always.
 * Ways in: the Send menu's "Send in split", a message's split button (its hover
 * strip, MessageMetaRow), and its right-click menu (SessionMessage). The panel keeps
 * whether it is open, which way and the share per place (panel-view.ts); the
 * reading pane keeps its own reading place per page (reading-place.ts,
 * `readerPlaceKey`).
 */
import { createContext, useContext } from 'react';
import { readPlace, readerPlaceKey, setPlace, type ReadingPlace } from './reading-place';

export interface SessionReaderApi {
  /** Open the reading pane on `target` (a message in the chat, or an element in one),
   *  or, with none, on what the chat shows now. */
  open: (target?: Element | null) => void;
}

/** Given by the panel to its own timeline; null where the split is not offered
 *  (the reading pane itself, a phone, a narrow or Tree Mode split). */
export const SessionReaderContext = createContext<SessionReaderApi | null>(null);

export function useSessionReader(): SessionReaderApi | null {
  return useContext(SessionReaderContext);
}

/** A row's top this close to the box's top edge (px) when the pane lands on it. */
const LAND_TOP_PX = 8;

/**
 * The reading pane's place in `box` (the chat's scroll box): what the reader sees
 * now, or `target` (a message, or an element in one) near the top; a message
 * already started above the edge keeps the line at the edge where it is. Never
 * "at the bottom": the pane holds this text.
 */
export function readerPlaceFrom(box: HTMLElement, target?: Element | null): ReadingPlace | null {
  const seen = readPlace(box);
  const base = seen ? { ...seen, atBottom: false } : null;
  if (!target) return base && base.rows.length ? base : null;
  const row = messageRowOf(target) ?? (target as HTMLElement);
  const b = box.getBoundingClientRect();
  const r = row.getBoundingClientRect();
  const at = r.top - b.top;
  const want = Math.min(at, LAND_TOP_PX);
  const id = row.dataset?.messageId;
  if (id) {
    return { rows: [{ id, top: Math.round(want), height: Math.round(r.height) }], width: Math.round(box.clientWidth), atBottom: false, at: Date.now() };
  }
  // A part with no id of its own (a reply cut at its tools): the rows on screen,
  // moved together so the part lands where a message would.
  if (!base || !base.rows.length) return null;
  const shift = Math.round(want - at);
  return { ...base, rows: base.rows.map((x) => ({ ...x, top: x.top + shift })) };
}

/** Keep `place` as the reading pane's place for `pageKey` (it lands there when it mounts). */
export function keepReaderPlace(sessionId: string, pageKey: string, place: ReadingPlace): void {
  setPlace(sessionId, readerPlaceKey(pageKey, true), place);
}

/** The message row an element sits in (a top-level row: a merged run's members carry ids inside it). */
export function messageRowOf(el: Element | null | undefined): HTMLElement | null {
  let row = el?.closest<HTMLElement>('[data-message-id]') ?? null;
  while (row?.parentElement?.closest('[data-message-id]')) row = row.parentElement.closest<HTMLElement>('[data-message-id]');
  return row;
}

export { ICON_READ_SPLIT, ICON_READ_SIDE } from '@/components/common/Icons';
