/**
 * The text-overlap check: finds two lines of text drawn over each other inside one root (a card,
 * a panel). Every line of every text node under the root is one rectangle (its range's client
 * rects), cut to what its scrolling or clipping ancestors show; two of them from different text
 * nodes that cover each other by more than a sliver are an overlap (2026-11-23, the user's top
 * card: the thread's summary line drawn over the "Conversation · 1 message" toggle, unreadable).
 *
 * The members are found on the live page, never from a list of class names, so a line added to a
 * card later is checked by the same sweep. `findTextOverlaps` runs in the page (locator.evaluate)
 * and so takes nothing from this module's scope.
 */
import { expect, type Locator } from '@playwright/test'

export interface TextOverlap {
  /** The two lines' words (cut) and their elements, tag and first class. */
  a: string;
  b: string;
  /** How far they cover each other, in px. */
  width: number;
  height: number;
}

export function findTextOverlaps(root: Element): TextOverlap[] {
  type Box = { l: number; t: number; r: number; b: number }
  const cut = (x: Box, y: Box): Box => ({ l: Math.max(x.l, y.l), t: Math.max(x.t, y.t), r: Math.min(x.r, y.r), b: Math.min(x.b, y.b) })
  const nameOf = (el: Element): string => {
    const cls = (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean)[0]
    return `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''}`
  }
  // What an element's scrolling or clipping ancestors (and itself) let show: their inner boxes.
  const shownBox = (el: Element): Box => {
    let box: Box = { l: -Infinity, t: -Infinity, r: Infinity, b: Infinity }
    for (let e: Element | null = el; e; e = e.parentElement) {
      const cs = getComputedStyle(e)
      if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue
      const r = e.getBoundingClientRect()
      const l = r.left + e.clientLeft
      const t = r.top + e.clientTop
      box = cut(box, { l, t, r: l + e.clientWidth, b: t + e.clientHeight })
    }
    return box
  }
  const lines: Array<{ node: Text; label: string; box: Box }> = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const range = document.createRange()
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    const words = (n.textContent ?? '').trim()
    const el = n.parentElement
    if (!words || !el) continue
    // Hidden, transparent or folded away (a closed <details>, display: none up the tree): not drawn.
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue
    if (el.getClientRects().length === 0) continue
    const shown = shownBox(el)
    range.selectNodeContents(n)
    for (const r of range.getClientRects()) {
      const box = cut({ l: r.left, t: r.top, r: r.right, b: r.bottom }, shown)
      if (box.r - box.l < 2 || box.b - box.t < 2) continue
      lines.push({ node: n, label: `${nameOf(el)} "${words.slice(0, 40)}"`, box })
    }
  }
  const out: TextOverlap[] = []
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const x = lines[i]!
      const y = lines[j]!
      if (x.node === y.node) continue
      const c = cut(x.box, y.box)
      const width = c.r - c.l
      const height = c.b - c.t
      // Lines set tight (a CJK font's glyph box taller than its line height) touch by a pixel or
      // two; a line drawn over another covers most of its height.
      const lower = Math.min(x.box.b - x.box.t, y.box.b - y.box.t)
      if (width > 2 && height > lower * 0.4) out.push({ a: x.label, b: y.label, width: Math.round(width), height: Math.round(height) })
    }
  }
  return out
}

/**
 * No two lines under `root` are drawn over each other, once its layout settled: the room's fit
 * (SessionActionStrip useTopRoom) runs a ResizeObserver and a frame after a resize, so a read right
 * after one can still see the old, taller layout. It waits for two frames and for the room's level
 * (data-room, data-share) to stay the same over two reads, then reads once and fails on any overlap.
 */
export async function expectNoTextOverlap(root: Locator, what: string, timeout = 5_000): Promise<void> {
  const frames = () => root.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))))
  const level = () => root.evaluate((el) => `${el.getAttribute('data-room') ?? ''}|${el.getAttribute('data-share') ?? ''}|${el.getBoundingClientRect().height}`)
  let last = ''
  await expect.poll(async () => { await frames(); const now = await level(); const same = now === last; last = now; return same }, { message: `the layout never settled: ${what}`, timeout }).toBe(true)
  const room = await root.getAttribute('data-room')
  expect(await root.evaluate(findTextOverlaps), `text drawn over other text: ${what} (room ${room})`).toEqual([])
}
