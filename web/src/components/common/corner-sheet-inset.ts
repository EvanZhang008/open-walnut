/**
 * The room a full-screen sheet gives the notice corner (corner-stack.tsx syncSheetInset): while
 * the corner holds a notice that reaches past the strip left of the sheet, the sheet's left edge
 * moves past it by `--corner-sheet-inset` (fullscreen-tab.css), and goes back when the corner is
 * empty. Its own module (no React, no CSS) so a layout hook can read it without the corner.
 */
export const CORNER_SHEET_INSET_VAR = '--corner-sheet-inset';

/** The inset the full-screen sheet holding `el` has for the corner now, in px (0: none, or no sheet). */
export function cornerSheetInsetOf(el: Element | null | undefined): number {
  const sheet = el?.closest<HTMLElement>('.open-walnut-fullscreen');
  return sheet ? parseFloat(sheet.style.getPropertyValue(CORNER_SHEET_INSET_VAR)) || 0 : 0;
}

/** The sheet each measured pane was in at its last pick (null: none), to tell a pane that moved. */
const sheetAtPick = new WeakMap<Element, Element | null>();

/**
 * A layout mode picked by a pane's width, the corner's inset left out: a notice showing for a few
 * seconds (a kanban move's own toast) never switches the layout under the user (2026-11-07: a card
 * dropped on the wide board's Resolved rail toasted, the toast moved the sheet 126px, and the board
 * fell to its narrow sections, rail gone). While an inset is held the mode stays what it was; with
 * no mode yet it is picked for the width the pane has without the inset. The inset's release
 * resizes the pane again, which picks the mode afresh.
 *
 * A pane that has just gone into a sheet (or out of one) has no mode there yet: the one it had
 * where it was is not held (2026-11-09: a session column 1037px wide went full screen while a
 * notice held the corner, and Tree Mode kept the column's two pages in the 1107px sheet).
 */
export function modeBesideCorner<M>(
  el: Element | null | undefined,
  width: number,
  prev: M | null,
  pick: (width: number, prev: M | null) => M,
): M {
  const sheet = el?.closest<HTMLElement>('.open-walnut-fullscreen') ?? null;
  const moved = !!el && sheetAtPick.has(el) && sheetAtPick.get(el) !== sheet;
  if (el) sheetAtPick.set(el, sheet);
  const held = moved ? null : prev;
  const inset = cornerSheetInsetOf(el);
  if (inset <= 0) return pick(width, prev);
  return held ?? pick(width + inset, held);
}
