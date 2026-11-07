/**
 * Where the in-page menu goes for a field (pure, unit tested): under the field whenever it fits
 * there, as in Chrome and 1Password, and above it only when it does not; always inside the frame's
 * own viewport, so a frame never cuts it (when neither side holds all of it, the taller side gets
 * it, cut to fit, and its list scrolls). Never beside the field: one predictable spot.
 *
 * It may cover the form's send button under the field until the person picks (review R4-6: the
 * round-3 rule that put it above the form's last field to keep that button clear covered the
 * page's own instruction and the fields just typed instead, with 550 px free below).
 */
export interface Rect { top: number; bottom: number; left: number; right: number }
export interface Spot { top: number; left: number; height: number }

const M = 4
/** The fewest pixels of the list worth showing on one side of the field. */
const MIN_HEIGHT = 60

export function menuSpot(field: Rect, height: number, width: number, view: { w: number; h: number }): Spot {
  const left = Math.max(M, Math.min(field.left, view.w - width - M))
  const down = view.h - field.bottom - 2 * M
  const up = field.top - 2 * M
  if (height <= down) return { top: field.bottom + M, left, height }
  if (height <= up) return { top: field.top - M - height, left, height }
  if (Math.max(down, up) >= MIN_HEIGHT) return down >= up ? { top: field.bottom + M, left, height: down } : { top: M, left, height: up }
  // A frame too short for even a few rows on either side of the field: over the field, as much as
  // the frame holds, never past its edges (round 4 code review, L7).
  return { top: M, left, height: Math.max(1, Math.min(height, view.h - 2 * M)) }
}
