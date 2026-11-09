/**
 * The arithmetic of an agent's input and pictures, apart from any browser API so a test can check
 * it as a table: how far a wheel scrolls, typing one key at a time, where a screenshot's numbered
 * labels go, and which pixels a zoom crops.
 */

/** `slowly`: at most this many characters, a key every SLOW_KEY_MS (well inside one command's time). */
export const SLOW_MAX = 200
export const SLOW_KEY_MS = 50
/** A drag shorter than this is a click (page-input.ts refuses it as drag_too_short). */
export const DRAG_MIN_PX = 8

/** A wheel's travel for a scroll: `by` px, else `amount` screens of WHEEL_SCREEN_PX, or to the top or bottom. */
export const WHEEL_SCREEN_PX = 500
export function wheelDelta(a: Record<string, unknown>): { x: number; y: number; said: string } {
  if (a.to === 'top' || a.to === 'bottom') return { x: 0, y: a.to === 'top' ? -100_000 : 100_000, said: `to the ${a.to}` }
  const sideways = a.direction === 'left' || a.direction === 'right'
  const sign = a.direction === 'up' || a.direction === 'left' ? -1 : 1
  const n = typeof a.amount === 'number' && a.amount > 0 ? Math.min(a.amount, 20) : 1
  const px = typeof a.by === 'number' && a.by > 0 ? Math.min(a.by, 100_000) : n * WHEEL_SCREEN_PX
  const way = sideways ? (sign < 0 ? 'left' : 'right') : (sign < 0 ? 'up' : 'down')
  return { x: sideways ? sign * px : 0, y: sideways ? 0 : sign * px, said: `${way} ${Math.round(px)} px` }
}

/** An element the page numbered for an annotated screenshot (page-annotate.ts): CSS pixels of the viewport. */
export interface LabelBox { label: number; ref: string; role: string; name: string; x: number; y: number; w: number; h: number }

/** Where a label's box and its number tag are drawn on the picture (device pixels: `scale` per CSS pixel). */
export interface DrawnLabel { label: number; box: { x: number; y: number; w: number; h: number }; tag: { x: number; y: number; w: number; h: number } }

export function layoutLabels(boxes: LabelBox[], scale: number, imgW: number, imgH: number): DrawnLabel[] {
  const s = scale > 0 && Number.isFinite(scale) ? scale : 1
  const tagH = Math.round(14 * s)
  return boxes.map((b) => {
    const box = { x: Math.round(b.x * s), y: Math.round(b.y * s), w: Math.max(1, Math.round(b.w * s)), h: Math.max(1, Math.round(b.h * s)) }
    const tagW = Math.round((8 + 7 * String(b.label).length) * s)
    // The tag sits on the box's top left corner, above it when there is room, kept inside the picture.
    const x = Math.min(Math.max(0, box.x), Math.max(0, imgW - tagW))
    const y = Math.min(Math.max(0, box.y - tagH >= 0 ? box.y - tagH : box.y), Math.max(0, imgH - tagH))
    return { label: b.label, box, tag: { x, y, w: tagW, h: tagH } }
  })
}

/** The most CSS pixels a zoom takes on each side (one screen of a large display). */
export const ZOOM_MAX_CSS = 4000

/**
 * The pixels of a zoom: the region (CSS pixels of the viewport) on the captured picture, at the
 * picture's own resolution (`imgW / viewportW` device pixels per CSS pixel), clipped to the
 * picture. Null when nothing of it is on screen.
 */
export function zoomCrop(region: { x: number; y: number; width: number; height: number }, viewportW: number, imgW: number, imgH: number): { sx: number; sy: number; sw: number; sh: number; scale: number } | null {
  const scale = viewportW > 0 ? imgW / viewportW : 1
  const x0 = Math.max(0, Math.floor(region.x * scale))
  const y0 = Math.max(0, Math.floor(region.y * scale))
  const x1 = Math.min(imgW, Math.ceil((region.x + region.width) * scale))
  const y1 = Math.min(imgH, Math.ceil((region.y + region.height) * scale))
  if (x1 - x0 < 1 || y1 - y0 < 1) return null
  return { sx: x0, sy: y0, sw: x1 - x0, sh: y1 - y0, scale }
}
