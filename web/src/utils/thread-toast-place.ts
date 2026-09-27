/**
 * Where the question toast goes inside its panel (spec 6.8, N14).
 *
 * The toast used to sit centered just above the composer, which is exactly where
 * the rows that just changed are: Done pops to the root page and the Asked-from
 * list under the last answer (with the new takeaway line) ends right above the
 * composer, and the drawer's rows fill the left of the panel. So the toast tries
 * a few spots and takes the one that covers the least of what the user needs to
 * see during the Undo window, in this order on a tie: above the composer
 * (centered, then centered in the free space right of the drawer), then the top
 * of the transcript (same two).
 *
 * Pure: boxes in, one spot out, all in panel coordinates.
 */

export interface PlaceBox { left: number; top: number; right: number; bottom: number }

export interface ToastPlaceInput {
  panel: PlaceBox;
  /** Composer box, or null for a read-only panel. */
  composer: PlaceBox | null;
  /** The transcript's top edge (below the session header and the stack row). */
  contentTop: number;
  toast: { width: number; height: number };
  /** The drawer body when the drawer is open (its free right side is a spot). */
  drawer: PlaceBox | null;
  /** What the toast must not cover: changed rows, takeaways, drawer rows. */
  avoid: readonly PlaceBox[];
  /** What the toast never covers while any other spot is free of it: the
   *  drawer's header (its summary and its only close button, N14). */
  hard?: readonly PlaceBox[];
}

/** `top` is the toast's top edge, `centerX` its horizontal centre (it is
 *  translated -50% in X), both relative to the panel's top-left corner. */
export interface ToastPlace { top: number; centerX: number; maxWidth?: number }

const GAP = 8;
const EDGE = 12;
const DEFAULT_BOTTOM = 16;
/** Narrowest free strip right of the drawer the toast will wrap into. */
const MIN_BESIDE = 220;
const HARD = 1e6;

function overlap(a: PlaceBox, b: PlaceBox): number {
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return w > 0 && h > 0 ? w * h : 0;
}

export function placeToast(input: ToastPlaceInput): ToastPlace {
  const { panel, composer, toast, drawer } = input;
  const width = Math.min(toast.width, panel.right - panel.left - 2 * EDGE);
  const bottomTop = (h: number) => (composer ? composer.top - GAP - h : panel.bottom - DEFAULT_BOTTOM - h);
  const topTop = Math.max(panel.top + EDGE, input.contentTop + GAP);
  // Beside an open drawer the toast may wrap into the free strip (N14): a toast
  // wider than the strip no longer falls back to covering the drawer's header.
  const spots: Array<{ cx: number; w: number; maxWidth?: number }> = [{ cx: (panel.left + panel.right) / 2, w: width }];
  if (drawer) {
    const free = panel.right - EDGE - (drawer.right + GAP);
    if (free >= width) spots.push({ cx: drawer.right + GAP + free / 2, w: width });
    else if (free >= MIN_BESIDE) spots.push({ cx: drawer.right + GAP + free / 2, w: free, maxWidth: Math.floor(free) });
  }
  const tops = [
    { at: (h: number) => bottomTop(h) },
    ...(bottomTop(toast.height) > topTop ? [{ at: () => topTop }] : []),
  ];
  let best: { top: number; centerX: number; maxWidth?: number; cost: number } | null = null;
  for (const t of tops) {
    for (const spot of spots) {
      // A narrowed toast wraps: estimate its height until the next measure.
      const h = spot.w < toast.width ? Math.ceil(toast.width / spot.w) * toast.height : toast.height;
      const top = t.at(h);
      const box = { left: spot.cx - spot.w / 2, right: spot.cx + spot.w / 2, top, bottom: top + h };
      let cost = 0;
      for (const a of input.avoid) cost += overlap(box, a);
      for (const a of input.hard ?? []) cost += overlap(box, a) * HARD;
      if (!best || cost < best.cost) best = { top, centerX: spot.cx, ...(spot.maxWidth ? { maxWidth: spot.maxWidth } : {}), cost };
      if (cost === 0) break;
    }
    if (best && best.cost === 0) break;
  }
  const pick: { top: number; centerX: number; maxWidth?: number } = best ?? { top: bottomTop(toast.height), centerX: spots[0].cx };
  return {
    top: Math.round(pick.top - panel.top),
    centerX: Math.round(pick.centerX - panel.left),
    ...(pick.maxWidth ? { maxWidth: pick.maxWidth } : {}),
  };
}
