/**
 * Where the in-page menu goes for a field (pure, unit tested): always under the field, as in
 * Chrome and 1Password, and above it only when there is no room under it; always inside the
 * frame's own viewport, so a frame never cuts it (when neither side holds all of it, the taller
 * side gets it, cut to fit, and its list scrolls).
 */
export interface Rect { top: number; bottom: number; left: number; right: number }
export interface Spot { top: number; left: number; height: number }

export function menuSpot(field: Rect, height: number, width: number, view: { w: number; h: number }): Spot {
  const m = 4
  const left = Math.max(m, Math.min(field.left, view.w - width - m))
  const down = view.h - field.bottom - 2 * m
  const up = field.top - 2 * m
  if (height <= down) return { top: field.bottom + m, left, height }
  if (height <= up) return { top: field.top - m - height, left, height }
  return down >= up || up < 60
    ? { top: field.bottom + m, left, height: Math.max(60, down) }
    : { top: m, left, height: up }
}
