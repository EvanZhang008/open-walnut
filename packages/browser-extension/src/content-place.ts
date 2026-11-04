/**
 * Where the in-page menu goes for a field (pure, unit tested): under it, unless that covers the
 * button that sends the form, then beside it, then above it; always inside the frame's own
 * viewport, so a frame never cuts it.
 */
export interface Rect { top: number; bottom: number; left: number; right: number }
export interface Spot { top: number; left: number; height: number }

/**
 * Where the menu goes for a field: the first of below, beside, above that fits in this frame and
 * covers none of the form's send buttons; else the first that fits; else (a frame too short for
 * all of it) the taller side, with the menu cut to it.
 */
export function menuSpot(field: Rect, height: number, width: number, view: { w: number; h: number }, avoid: Rect[]): Spot {
  const m = 4
  const left = Math.max(m, Math.min(field.left, view.w - width - m))
  const below: Spot = { top: field.bottom + m, left, height }
  const above: Spot = { top: field.top - height - m, left, height }
  const beside: Spot = { top: Math.max(m, Math.min(field.top, view.h - height - m)), left: field.right + 8, height }
  const fits = (s: Spot) => s.top >= m && s.top + s.height <= view.h - m && s.left >= m && s.left + width <= view.w - m
  const clear = (s: Spot) => !avoid.some((b) => s.left < b.right && b.left < s.left + width && s.top < b.bottom && b.top < s.top + s.height)
  const order = [below, beside, above]
  const best = order.find((s) => fits(s) && clear(s)) ?? order.find(fits)
  if (best) return best
  const down = view.h - field.bottom - 2 * m
  const up = field.top - 2 * m
  return down >= up || up < 60
    ? { top: field.bottom + m, left, height: Math.max(60, Math.min(height, down)) }
    : { top: Math.max(m, field.top - m - Math.min(height, up)), left, height: Math.min(height, up) }
}
