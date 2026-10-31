/**
 * The panels beside the Org page, as a strip of columns: the same column model as Home's
 * session columns (pages/sessionColumns.ts), with a panel count of one.
 *
 * 2026-10-31, the user: "a lock icon in the org section ... it just lock it in the org
 * section, and second one come it will open next to it". So the strip holds ONE free panel
 * (what `?open=` names: a link, a click, a phone's Back still drive it) plus every panel the
 * user locked; opening another task replaces the free panel and leaves the pins standing,
 * the way a pin on Home works with a panel count of one (panelBudget grants the free slot
 * beside the pins). Slot ids are the `?open=` strings, `task:<id>` / `session:<id>`. The
 * strip is a layout record field (`orgColumns`), so the pins survive a restart.
 */
import { removeSessionColumn, replaceSessionColumn, toggleLockSlot, type SessionSlot } from '@/pages/sessionColumns';

/** Two slot ids that show the same session (`task:<id>` of a task whose session is `session:<sid>`). */
export type SameSession = (a: string, b: string) => boolean;

/** Find the slot that already shows `id` (itself, or another id for the same session). */
function slotFor(cols: readonly SessionSlot[], id: string, same: SameSession): SessionSlot | undefined {
  return cols.find((c) => c.id === id) ?? cols.find((c) => same(c.id, id));
}

/**
 * The strip after `?open=` moved from `prev` to `next`.
 *  - next set: it is the one free panel, leftmost, beside the pins (a pin it names stays where
 *    it is, under the URL's id). Every other free panel goes: the page shows one free panel.
 *  - next gone (× on the free panel, another node picked, Back): the panel `prev` named goes,
 *    unless it is locked.
 */
export function orgStripOnOpen(
  cols: readonly SessionSlot[],
  prev: string | null,
  next: string | null,
  same: SameSession = () => false,
): SessionSlot[] {
  let out = [...cols];
  if (next) {
    const shown = slotFor(out, next, same);
    // A pin keeps the id it was pinned under (a task stays pinned as the task, whichever
    // session it runs next); a free panel takes the URL's id.
    if (shown?.locked) return out.filter((c) => c.locked);
    if (shown && shown.id !== next) out = replaceSessionColumn(out, shown.id, next);
    const pins = out.filter((c) => c.locked);
    return [{ id: next, locked: false }, ...pins];
  }
  if (prev) {
    const shown = slotFor(out, prev, same);
    if (shown && !shown.locked) out = removeSessionColumn(out, shown.id);
  }
  return out;
}

/**
 * One panel per session: two slots that show the same session (a `task:` and a `session:` id,
 * known only once the tasks have loaded) become one, locked when either was, under the id the
 * URL opens when it is one of them, else the first. Returns `cols` itself when nothing merges.
 */
export function orgStripDedupe(cols: readonly SessionSlot[], same: SameSession, open: string | null): readonly SessionSlot[] {
  const out: SessionSlot[] = [];
  let merged = false;
  for (const c of cols) {
    const at = out.findIndex((o) => o.id !== c.id && same(o.id, c.id));
    if (at === -1) { out.push(c); continue; }
    merged = true;
    const o = out[at];
    out[at] = { id: c.id === open ? c.id : o.id, locked: o.locked || c.locked };
  }
  return merged ? out : cols;
}

/** Lock or unlock one panel (a lock sends it to the pins on the right, as on Home). */
export function orgStripToggleLock(cols: readonly SessionSlot[], id: string): SessionSlot[] {
  return toggleLockSlot([...cols], id);
}

/**
 * What the strip shows: the panel `?open=` names, leftmost, beside the pins (one per session).
 * The page keeps only the pins as state and works this out on every render, never a strip
 * state that follows the URL: an update made while React rendered a new URL went away with a
 * render React threw away, and the free panel stayed on screen beside the pin the URL now
 * named (2026-10-31, caught by tests/e2e/browser/layout-record-restart.spec.ts, about 1 run in 5).
 * Picking another node clears `?open=`, so its free panel goes with it and the pins stay.
 */
export function orgStripView(pins: readonly SessionSlot[], open: string | null, same: SameSession = () => false): SessionSlot[] {
  const locked = pins.filter((c) => c.locked);
  return orgStripOnOpen(orgStripDedupe(locked, same, open), null, open, same);
}
