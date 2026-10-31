/**
 * A turn that folds while the reader is scrolled up into it opens instead, and
 * the row they were reading stays where it was on screen.
 *
 * The answered-turn fold (turn-shape.ts) closes everything before a turn's
 * answer the moment the transcript holds it. For a reader who scrolled up
 * mid-turn to read the steps, that took thousands of px out from under them in
 * one frame and the browser clamped them toward the top (inc-1786553756848,
 * back with the fold: top 4295 -> 1650, scrollHeight 10109 -> 2106). So a fold
 * that takes in rows the reader can see (a new fold, or one that grew) opens,
 * for this panel only; and whenever such a fold forms in or above the viewport,
 * the row the reader sees goes back to where it was before the new rows paint (the
 * history box has `overflow-anchor: none`, and WebKit anchors nothing anyway).
 * Read from the DOM the reader still sees, at render time, as foldAnchor does.
 * Rows are matched by what they show (keysOfElement): a message row by its id,
 * a run by its tool calls, so a reader inside a run of steps counts too.
 */

interface Box { top: number; bottom: number }

/**
 * What a drawn element shows, as keys: `m:<msgId>` for a message row
 * (`data-message-id`, worn by a stream block and its persisted twin alike) and
 * any key in `data-row-keys`: `t:<toolUseId>` for each tool call a run row
 * draws, streamed or from history, and `m:<msgId>` for streamed reasoning.
 */
export function keysOfElement(el: HTMLElement): string[] {
  const keys: string[] = [];
  const id = el.dataset.messageId;
  if (id) keys.push(`m:${id}`);
  const more = el.dataset.rowKeys;
  if (more) for (const k of more.split(' ')) if (k) keys.push(k);
  return keys;
}

/** The `data-row-keys` value for a row drawing these tool calls (and these streamed messages). */
export function rowKeysAttr(toolUseIds: Iterable<string | undefined>, msgIds: Iterable<string | undefined> = []): string | undefined {
  const keys: string[] = [];
  for (const id of toolUseIds) if (id) keys.push(`t:${id}`);
  for (const id of msgIds) if (id) keys.push(`m:${id}`);
  return keys.length > 0 ? keys.join(' ') : undefined;
}

export interface ReaderView {
  top: number;
  bottom: number;
  /** Row key (keysOfElement) -> the box of the first element wearing it. */
  keys: Map<string, Box>;
  /** History index (`data-msg-index`) -> its box. */
  indices: Map<number, Box>;
  /** The row the reader reads: the innermost one across the top edge, else the first below it. */
  anchor: { key: string; top: number } | null;
}

/** A row with less than this in view is not what the reader is reading. */
const MIN_VISIBLE_PX = 24;

const KEYED = '[data-message-id], [data-row-keys]';

export function readReaderView(box: HTMLElement): ReaderView {
  const view = box.getBoundingClientRect();
  const keys = new Map<string, Box>();
  const indices = new Map<number, Box>();
  let across: ReaderView['anchor'] = null;
  let below: ReaderView['anchor'] = null;
  for (const el of Array.from(box.querySelectorAll<HTMLElement>(`${KEYED}, [data-msg-index]`))) {
    const r = el.getBoundingClientRect();
    const at = { top: r.top, bottom: r.bottom };
    const index = el.dataset.msgIndex;
    if (index !== undefined && !indices.has(Number(index))) indices.set(Number(index), at);
    const own = keysOfElement(el);
    for (const k of own) if (!keys.has(k)) keys.set(k, at);
    if (own.length === 0 || r.bottom - view.top < MIN_VISIBLE_PX || r.top >= view.bottom) continue;
    // Nested rows (a run and the rows in it) all cross the top edge; the inner one
    // starts lowest and moves with what the reader sees.
    if (r.top <= view.top) { if (!across || r.top >= across.top) across = { key: own[0], top: r.top }; }
    else if (!below || r.top < below.top) below = { key: own[0], top: r.top };
  }
  return { top: view.top, bottom: view.bottom, keys, indices, anchor: across ?? below };
}

/**
 * Where a fold's rows were last commit: `inside` when one of them is in view,
 * `above` when the ones drawn all sit above it, null when none was drawn (older
 * rows just loaded, rows a closed fold held) or all sit below it.
 */
export function foldPlace(view: ReaderView, rows: { keys: readonly string[]; indices: readonly number[] }): 'inside' | 'above' | null {
  let above = false;
  const boxes = [
    ...rows.keys.map((k) => view.keys.get(k)),
    ...rows.indices.map((i) => view.indices.get(i)),
  ];
  for (const b of boxes) {
    if (!b) continue;
    if (b.bottom <= view.top) above = true;
    else if (b.top < view.bottom) return 'inside';
  }
  return above ? 'above' : null;
}

/** A fold's rows that joined it since last commit: all of them for a new fold. */
export function joinedRows<R>(rows: ReadonlySet<R>, before: ReadonlySet<R> | undefined): R[] {
  return before ? [...rows].filter((r) => !before.has(r)) : [...rows];
}

/**
 * What last commit drew, for rowsAsDrawn: the keys its rows and stream blocks
 * wore, and each history row it drew at its index then. Only the drawn window:
 * rows above it were never on screen.
 */
export interface HeldBefore<R> {
  /** The keys a row's element wears (keysOfElement): its message id only when it
   *  is drawn as its own row, never a derived row's borrowed id. */
  keysOf: (row: R) => readonly string[];
  keys: ReadonlySet<string>;
  indexOf: ReadonlyMap<R, number>;
}

/**
 * Rows named the way last commit drew them, for foldPlace: by key, else by the
 * index the row had THEN (a filled gap or a reorder shifts every index after it,
 * so today's index can name another row's box). Null when last commit drew none
 * of them, so nothing needs the DOM.
 */
export function rowsAsDrawn<R>(rows: readonly R[], then: HeldBefore<R>): { keys: string[]; indices: number[] } | null {
  const keys: string[] = [];
  const indices: number[] = [];
  for (const r of rows) {
    for (const k of then.keysOf(r)) if (then.keys.has(k)) keys.push(k);
    const at = then.indexOf.get(r);
    if (at !== undefined) indices.push(at);
  }
  return keys.length + indices.length > 0 ? { keys, indices } : null;
}

/** Put the held row back where it was; of two copies (a block and its twin), the nearer one. */
export function restoreReaderRow(box: HTMLElement, hold: { key: string; top: number }): void {
  let delta: number | null = null;
  for (const el of Array.from(box.querySelectorAll<HTMLElement>(KEYED))) {
    if (!keysOfElement(el).includes(hold.key)) continue;
    const d = el.getBoundingClientRect().top - hold.top;
    if (delta === null || Math.abs(d) < Math.abs(delta)) delta = d;
  }
  if (delta !== null && Math.abs(delta) >= 1) box.scrollTop += delta;
}
