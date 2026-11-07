/**
 * Where an icon's ink sits in the box that holds it. An SVG icon can be centered by CSS
 * while its drawing sits off the middle of its viewBox (2026-11-06, the user: "this
 * minimize icon shoudl be middle"; the dash was drawn at y 12 of 16, so it sat low in the
 * header row however the button was aligned). This reads the drawn shapes' own boxes.
 */
import type { Locator } from '@playwright/test'

export interface IconInk {
  /** The holder's data-header-id or data-testid, for the failure message. */
  id: string
  /** Ink center minus holder center, in CSS px (positive = low). */
  dy: number
}

/** For every visible holder matched by `holders` that draws an SVG icon. */
export async function iconInkOffsets(holders: Locator): Promise<IconInk[]> {
  return holders.evaluateAll((els) => {
    const out: { id: string; dy: number }[] = []
    for (const el of els as HTMLElement[]) {
      const box = el.getBoundingClientRect()
      if (box.width === 0 || box.height === 0 || getComputedStyle(el).visibility === 'hidden') continue
      const svg = el.querySelector('svg')
      if (!svg) continue
      let top = Infinity
      let bottom = -Infinity
      for (const shape of Array.from(svg.querySelectorAll('line, path, polyline, polygon, rect, circle, ellipse'))) {
        const r = shape.getBoundingClientRect()
        top = Math.min(top, r.top)
        bottom = Math.max(bottom, r.bottom)
      }
      if (!Number.isFinite(top)) continue
      const id = el.getAttribute('data-header-id') ?? el.getAttribute('data-testid') ?? el.className
      out.push({ id, dy: (top + bottom) / 2 - (box.top + box.height / 2) })
    }
    return out
  })
}

/** How far off its holder's middle an icon may draw: under a pixel and a half. */
export const ICON_CENTER_TOLERANCE_PX = 1.5
