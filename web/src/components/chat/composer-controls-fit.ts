/**
 * Which composer controls fit on ONE row, and which move into the overflow menu.
 *
 * The composer's controls row used to WRAP: in a narrow session column (measured
 * 214px at a 1100px window with two columns, leaving the controls ~130px) its
 * five pills stacked four rows high and pushed the composer up the panel
 * (2026-09-19 report). Wrapping is now replaced by this: keep the most-used
 * controls on the row, in their normal order, and put the rest behind one "..."
 * button.
 *
 * Two rules keep the result from flickering as the column resizes:
 *
 *  - The decision is a pure function of the AVAILABLE width and every control's
 *    NATURAL width, never of what is currently shown. A rule that read the
 *    current state could oscillate: hiding a pill frees room, which then makes it
 *    fit again, which takes the room away.
 *  - The "..." button is priced in exactly when something is hidden, and the
 *    "everything fits" branch is decided BEFORE it, so the button can never be
 *    the reason one more control has to hide.
 */

export interface ControlFitInput {
  id: string;
  /** Lower goes first when space runs out; 1 is the last to leave. */
  priority: number;
  /** Natural width in px, or undefined before it has ever been measured. */
  width?: number;
}

export interface ControlFitResult {
  /** Ids to render on the row, in the caller's original order. */
  visible: string[];
  /** Ids to list in the overflow menu, in the caller's original order. */
  overflow: string[];
}

/**
 * A width to assume for a control that has never been measured (it starts
 * hidden, or the row has not laid out yet). Roughly one short pill: big enough
 * that an unmeasured control does not "fit" a row it would overflow, small
 * enough that the first paint is not needlessly collapsed. The real width
 * replaces it on the next measure pass.
 */
export const ASSUMED_CONTROL_WIDTH = 64;

/**
 * Margin kept free when deciding whether a control's DETAIL (the model pill's
 * context percentage) still fits on a condensed row. A detail that fits only to
 * the last fraction of a pixel is not worth showing: the row wraps as its
 * containment fallback, so a hairline of rounding would put the pill on a
 * second line instead of clipping it.
 */
export const DETAIL_FIT_SLACK = 2;

/**
 * Whether a detail of `detailWidth` px fits on a row that measures
 * `rowWithoutDetail` px with every control in its short form. Stateless on
 * purpose, like pickVisibleControls: the answer depends on natural widths and
 * the available room, never on whether the detail is currently shown. The bar
 * keeps those widths apart (the pill minus its detail while the detail is on
 * the row, the pill alone while it is not; the same number either way), so a
 * resize can only ever move the answer in one direction.
 */
export function detailFits(rowWithoutDetail: number, detailWidth: number, availableWidth: number): boolean {
  if (detailWidth <= 0) return true;
  return rowWithoutDetail + detailWidth + DETAIL_FIT_SLACK <= availableWidth;
}

export function pickVisibleControls(
  controls: ControlFitInput[],
  availableWidth: number,
  options: { gap: number; overflowButtonWidth: number },
): ControlFitResult {
  const order = controls.map((c) => c.id);
  const widthOf = (c: ControlFitInput) => (c.width == null || c.width <= 0 ? ASSUMED_CONTROL_WIDTH : c.width);
  /** What the row costs with `items` on it — plus the button when anything hides.
   *  Only what is ON the row pays for a gap; a hidden control costs nothing. */
  const rowWidth = (items: ControlFitInput[], withButton: boolean) => {
    const slots = items.length + (withButton ? 1 : 0);
    return items.reduce((sum, c) => sum + widthOf(c), 0)
      + Math.max(0, slots - 1) * options.gap
      + (withButton ? options.overflowButtonWidth : 0);
  };

  const byOrder = (ids: string[]) => order.filter((id) => ids.includes(id));

  // Nothing measured / no room reported yet: show everything rather than
  // collapsing a row whose width we do not know (a zero-width bar during mount
  // would otherwise hide every control for one frame).
  if (availableWidth <= 0) return { visible: [...order], overflow: [] };

  if (rowWidth(controls, false) <= availableWidth) return { visible: [...order], overflow: [] };

  // Something has to go, so the button is on the row from here on. The
  // highest-priority control stays even where it does not fit — an empty row
  // beside a "..." button hides the one thing the user reaches for most — and the
  // rest are tried in priority order. A control that does not fit is SKIPPED
  // rather than ending the fill, so a wide model pill cannot push out a narrow
  // note pill that still had room.
  const byPriority = [...controls].sort((a, b) => a.priority - b.priority);
  const kept: ControlFitInput[] = byPriority.slice(0, 1);
  for (const c of byPriority.slice(1)) {
    if (rowWidth([...kept, c], true) <= availableWidth) kept.push(c);
  }
  const keptIds = kept.map((c) => c.id);
  return { visible: byOrder(keptIds), overflow: order.filter((id) => !keptIds.includes(id)) };
}
