/** Moving an element by px on top of its own `translate` (plugin-bounds.ts, inline-overlay-fit.ts). */

/**
 * An element's own `translate` (a computed value: `none`, or one to three lengths) moved by
 * `x, y` px on top, so a box it centres with `translate: -50% -50%` keeps that.
 */
export function movedBy(translate: string, x: number, y: number): string {
  const parts: string[] = []
  let depth = 0
  let part = ''
  for (const ch of translate.trim() === 'none' ? '' : translate.trim()) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (/\s/.test(ch) && depth === 0) {
      if (part) parts.push(part)
      part = ''
    } else part += ch
  }
  if (part) parts.push(part)
  const [ownX = '0px', ownY = '0px', ownZ] = parts
  const add = (own: string, by: number) => (/^0(px)?$/.test(own) ? `${by}px` : `calc(${own} + ${by}px)`)
  return [add(ownX, x), add(ownY, y), ...(ownZ ? [ownZ] : [])].join(' ')
}
