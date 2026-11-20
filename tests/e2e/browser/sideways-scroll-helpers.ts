/**
 * Finds the vertical scrollers of a page that are wider inside than their box (2026-11-20, the
 * user on the phone: a page that scrolls up and down must never drag sideways). CSS gives an
 * element with `overflow-y: auto` an `overflow-x: auto` too, so one block wider than its column
 * makes the whole page scroll sideways; on `overflow-x: hidden` the same block is cut off instead.
 * Either is a bug: the block must be laid out to the width (long text wraps, flex and grid
 * children take `min-width: 0`, tables and code scroll inside their OWN box).
 *
 * A scroller is the document's, or any visible element whose computed overflow-y is auto or
 * scroll and whose box is at least 200 px tall. For each one too wide, the report names the
 * deepest element (or text) that reaches furthest past its right edge. A subtree that clips or
 * scrolls on its own (overflow-x not visible) is judged by its own box, never by what it holds.
 */
import type { Page } from '@playwright/test'

/** Boxes meant to scroll both ways: code and editors, terminals, the Board's lanes. */
export const TWO_WAY_SCROLLERS = [
  'pre', '.cm-editor', '.cm-scroller', '.xterm', '.xterm-viewport', '[data-testid="kanban-lanes"]',
].join(', ')

export interface SidewaysScroller {
  scroller: string
  overflowX: string
  scrollWidth: number
  clientWidth: number
  widest: string
  by: number
}

export async function sidewaysScrollers(page: Page, exempt = TWO_WAY_SCROLLERS): Promise<SidewaysScroller[]> {
  return page.evaluate((exemptSel) => {
    const name = (el: Element): string => {
      const h = el as HTMLElement
      const cls = typeof h.className === 'string' && h.className.trim() ? `.${h.className.trim().split(/\s+/).slice(0, 3).join('.')}` : ''
      const tid = h.dataset?.testid ? `[data-testid="${h.dataset.testid}"]` : ''
      return `${h.tagName.toLowerCase()}${h.id ? `#${h.id}` : ''}${cls}${tid}`
    }
    const path = (el: Element): string => {
      const parts: string[] = []
      for (let e: Element | null = el; e && e !== document.body && parts.length < 4; e = e.parentElement) parts.unshift(name(e))
      return parts.join(' > ')
    }
    const visible = (el: Element) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden'
    const doc = (document.scrollingElement ?? document.documentElement) as HTMLElement
    const scrollers: HTMLElement[] = [doc]
    for (const el of Array.from(document.body.querySelectorAll<HTMLElement>('*'))) {
      const oy = getComputedStyle(el).overflowY
      if (oy !== 'auto' && oy !== 'scroll') continue
      if (el.clientHeight < 200 || !visible(el) || el.closest(exemptSel)) continue
      scrollers.push(el)
    }
    const out: SidewaysScroller[] = []
    for (const el of scrollers) {
      const isDoc = el === doc
      const clientWidth = isDoc ? Math.min(el.clientWidth, window.innerWidth) : el.clientWidth
      if (el.scrollWidth <= clientWidth + 1) continue
      const edge = isDoc ? clientWidth : el.getBoundingClientRect().left + el.clientLeft + clientWidth
      const shift = isDoc ? window.scrollX : el.scrollLeft
      let worst = 'unknown (a pseudo-element or a transform)'
      let by = 1
      const walk = (node: Element) => {
        for (const child of Array.from(node.childNodes)) {
          if (child.nodeType === Node.TEXT_NODE) {
            if (!child.textContent?.trim()) continue
            const range = document.createRange()
            range.selectNodeContents(child)
            const over = range.getBoundingClientRect().right + shift - edge
            if (over > by) { by = over; worst = `${path(node)} text "${child.textContent.trim().slice(0, 60)}"` }
            continue
          }
          if (!(child instanceof Element)) continue
          const cs = getComputedStyle(child)
          if (cs.display === 'none' || cs.position === 'fixed') continue
          const r = child.getBoundingClientRect()
          const over = r.right + shift - edge
          // Ties go to the deeper element: it is the one that does not fit.
          if (r.width > 0 && over >= by) { by = over; worst = `${path(child)} "${(child.textContent ?? '').trim().slice(0, 60)}"` }
          if (cs.overflowX === 'visible') walk(child)
        }
      }
      walk(isDoc ? document.body : el)
      out.push({ scroller: isDoc ? 'document' : path(el), overflowX: getComputedStyle(el).overflowX, scrollWidth: el.scrollWidth, clientWidth, widest: worst, by: Math.round(by) })
    }
    return out
  }, exempt)
}

export function describeSideways(where: string, found: SidewaysScroller[]): string[] {
  return found.map((f) => `${where}: ${f.scroller} (overflow-x ${f.overflowX}) is ${f.scrollWidth}px inside a ${f.clientWidth}px box; widest: ${f.widest} (+${f.by}px)`)
}
