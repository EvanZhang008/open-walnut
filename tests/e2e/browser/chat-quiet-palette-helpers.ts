/**
 * Helpers for chat-quiet-palette.spec.ts: find every element of a chat that paints a hue.
 * The chat is grey (web/src/styles/chat-palette.css); colour stays only on what needs the
 * user: an error (its red is allowed anywhere) and an ask waiting on him (KEEPS_COLOUR).
 */
import type { Locator } from '@playwright/test'
import { withCssColor } from './css-color'

export interface Painted { cls: string; prop: string; value: string; text: string }

/** Elements allowed to keep the theme's colours: an ask that waits on the user. */
export const KEEPS_COLOUR = ['.permission-request-card.is-pending']

/** Every element inside `root` whose text, fill or border is not grey. */
export async function paintedElements(root: Locator): Promise<Painted[]> {
  return root.evaluate(withCssColor((toRgba) => (el: Element, keeps: string[]) => {
    const out: Array<{ cls: string; prop: string; value: string; text: string }> = []
    /** A hue the eye sees (not grey), leaving out the error red, which a chat keeps. */
    const hued = (v: string): boolean => {
      const [r, g, b, a] = toRgba(v)
      if (a < 0.06) return false
      const max = Math.max(r, g, b)
      const chroma = max - Math.min(r, g, b)
      if (chroma <= 14) return false
      let hue = max === r ? ((g - b) / chroma) % 6 : max === g ? (b - r) / chroma + 2 : (r - g) / chroma + 4
      hue = (hue * 60 + 360) % 360
      return !(hue <= 10 || hue >= 350)
    }
    const kept = (node: Element) => keeps.some((sel) => node.closest(sel))
    const props: Array<[string, string]> = [
      ['color', 'color'], ['background-color', 'backgroundColor'],
      ['border-left-color', 'borderLeftColor'], ['border-top-color', 'borderTopColor'],
      ['border-bottom-color', 'borderBottomColor'], ['text-decoration-color', 'textDecorationColor'],
      ['outline-color', 'outlineColor'], ['fill', 'fill'], ['stroke', 'stroke'],
    ]
    for (const node of Array.from(el.querySelectorAll('*'))) {
      const box = (node as HTMLElement).getBoundingClientRect()
      if (box.width === 0 || box.height === 0) continue
      if (kept(node)) continue
      // Pictures, media and the content's own colours (a diff's added and removed lines,
      // syntax colours in code) are what the content says, not the chat's chrome.
      if (node.closest('img, video, canvas, iframe, .rich-island, .diff-view, .edit-diff-line, [class*="tk-"], .md-code pre code span')) continue
      // An icon's paths inherit the icon's colour: the icon is checked once.
      if (node instanceof SVGElement && !(node instanceof SVGSVGElement)) continue
      const cs = getComputedStyle(node)
      if (cs.visibility === 'hidden' || cs.display === 'none') continue
      for (const [prop, key] of props) {
        if (prop.startsWith('border') && cs[(key.replace('Color', 'Width')) as 'borderLeftWidth'] === '0px') continue
        if (prop === 'outline-color' && cs.outlineStyle === 'none') continue
        if (prop === 'text-decoration-color' && !cs.textDecorationLine.includes('underline')) continue
        if ((prop === 'fill' || prop === 'stroke') && !(node instanceof SVGElement)) continue
        const value = cs[key as 'color']
        if (hued(value)) {
          out.push({
            cls: `${node.tagName.toLowerCase()}.${(node.getAttribute('class') || '').trim().split(/\s+/).join('.')}`,
            prop, value, text: (node.textContent || '').trim().slice(0, 40),
          })
        }
      }
    }
    return out
  }), KEEPS_COLOUR)
}

/** One line per distinct (class, property, value), most frequent first. */
export function summarize(list: Painted[]): string[] {
  const counts = new Map<string, number>()
  for (const p of list) {
    const k = `${p.cls} ${p.prop}=${p.value} «${p.text}»`
    counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n}x ${k}`)
}
