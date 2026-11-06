/**
 * Where the in-page menu goes for a field (pure, unit tested): under the field, as in Chrome and
 * 1Password, and above it only when there is no room under it; always inside the frame's own
 * viewport, so a frame never cuts it (when neither side holds all of it, the taller side gets it,
 * cut to fit, and its list scrolls).
 *
 * It never covers the send button it is given (content-ui.ts gives it the form's send buttons for
 * the form's last field) when there is room above the field (review R3-11: on a sign-up page the
 * menu under the password field hid "Create account"): then it goes above it,
 * still on the field's own edge. Never beside the field: one predictable spot, under or over the
 * field, as the second review asked (a menu to the right on some pages and under on others).
 */
export interface Rect { top: number; bottom: number; left: number; right: number }
export interface Spot { top: number; left: number; height: number }

const M = 4

const overlaps = (s: Spot, width: number, r: Rect) =>
  s.left < r.right && s.left + width > r.left && s.top < r.bottom && s.top + s.height > r.top

export function menuSpot(field: Rect, height: number, width: number, view: { w: number; h: number }, avoid: readonly Rect[] = []): Spot {
  const left = Math.max(M, Math.min(field.left, view.w - width - M))
  const down = view.h - field.bottom - 2 * M
  const up = field.top - 2 * M
  const below: Spot = { top: field.bottom + M, left, height }
  const above: Spot = { top: field.top - M - height, left, height }
  const clear = (s: Spot) => !avoid.some((r) => overlaps(s, width, r))
  if (height <= down && clear(below)) return below
  if (height <= up && clear(above)) return above
  if (height <= down) return below
  if (height <= up) return above
  return down >= up || up < 60
    ? { top: field.bottom + M, left, height: Math.max(60, down) }
    : { top: M, left, height: up }
}
