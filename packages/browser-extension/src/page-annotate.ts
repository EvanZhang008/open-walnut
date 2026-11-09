/**
 * The page's part of an annotated screenshot (`screenshot {annotate}`, agent-shot.ts): every
 * element a person could act on that is on screen now, numbered top to bottom, with its ref and
 * its box. The background draws the numbers on the picture; the page draws nothing. A number
 * stands for its element in this document until the next annotated screenshot (`click {label}`).
 */
import * as pa from './page-agent'
import type { LabelBox } from './input-math'

export const ANNOTATE_MAX = 150

let labels = new Map<number, WeakRef<Element>>()

export function annotate(): { boxes: LabelBox[]; vw: number; vh: number; more?: number } {
  const seen = new Set<Element>()
  const found: Array<{ el: Element; r: DOMRect }> = []
  for (const el of pa.all(document, pa.INTERACTIVE)) {
    if (seen.has(el) || !pa.visible(el)) continue
    seen.add(el)
    const r = el.getBoundingClientRect()
    // On screen, and what a person would hit there (not something under a banner).
    if (r.bottom <= 0 || r.right <= 0 || r.top >= innerHeight || r.left >= innerWidth) continue
    const cx = Math.min(Math.max(r.left + r.width / 2, 0), innerWidth - 1)
    const cy = Math.min(Math.max(r.top + r.height / 2, 0), innerHeight - 1)
    const top = document.elementFromPoint(cx, cy)
    if (top && top !== el && !el.contains(top) && !top.contains(el)) continue
    if (pa.roleOf(el) === 'generic' && !pa.nameOf(el).trim()) continue
    found.push({ el, r })
  }
  found.sort((a, b) => (Math.abs(a.r.top - b.r.top) > 4 ? a.r.top - b.r.top : a.r.left - b.r.left))
  labels = new Map()
  const boxes = found.slice(0, ANNOTATE_MAX).map(({ el, r }, i) => {
    labels.set(i + 1, new WeakRef(el))
    return { label: i + 1, ref: pa.refFor(el), role: pa.roleOf(el), name: pa.clip(pa.nameOf(el), 80), x: r.left, y: r.top, w: r.width, h: r.height }
  })
  return { boxes, vw: innerWidth, vh: innerHeight, ...(found.length > ANNOTATE_MAX ? { more: found.length - ANNOTATE_MAX } : {}) }
}

/** The ref of a numbered element of the last annotated screenshot. */
export function refOfLabel(label: unknown): string {
  const n = typeof label === 'number' ? label : NaN
  if (!labels.size) throw new pa.PageError('No annotated screenshot of this page yet: take one (screenshot with annotate), then click its label.', 'no_labels')
  const el = labels.get(n)?.deref()
  if (!el || !el.isConnected) throw new pa.PageError(`Label ${String(label)} is not on the page now: take an annotated screenshot again.`, 'stale_ref')
  return pa.refFor(el)
}
