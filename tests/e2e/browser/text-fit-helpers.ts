/**
 * Measures the one truncation rule on a live page (standard.md, "Text that does not fit"; the
 * shared utilities are web/src/styles/text-fit.css). A title, name, subject or summary is cut when
 * an ellipsis or a line clamp hides part of it; metadata may cut, a title never.
 *
 * 2026-11-21, the UI audit on the user's own data: task titles, Org names and notification titles
 * lost the words that tell items apart while the icons and times beside them kept their room.
 */
import type { Page } from '@playwright/test'

/** Same pattern as tests/web/ui-standard-scan.ts TITLE_CLASS. */
export const TITLE_CLASS_SOURCE = '(^|-)(title|name|subject|summary|heading|headline)$'

export interface CutTitle {
  scope: string
  className: string
  text: string
  /** Share of the text's width (or height, for a clamp) that is hidden, 0..1. */
  hidden: number
  /** A metadata sibling in the same row is shown in full while the title is cut. */
  metaKeptRoom: boolean
}

/**
 * Every visible element inside `scopes` whose own class names a title and whose text is cut.
 * Elements inside `[data-text-fit="skip"]` (or matching `skip`) are left out.
 */
export async function findCutTitles(page: Page, scopes: string[], skip: string[] = []): Promise<CutTitle[]> {
  return page.evaluate(({ scopes, skip, source }) => {
    const re = new RegExp(source)
    const out: CutTitle[] = []
    const seen = new Set<Element>()
    const isTitle = (el: Element) => [...el.classList].some((c) => re.test(c))
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect()
      if (r.width < 2 || r.height < 2) return false
      if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return false
      const s = getComputedStyle(el)
      return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0
    }
    const cutOf = (el: HTMLElement) => {
      const s = getComputedStyle(el)
      const clamp = s.getPropertyValue('-webkit-line-clamp')
      if (clamp && clamp !== 'none' && el.scrollHeight > el.clientHeight + 2) return 1 - el.clientHeight / el.scrollHeight
      if (s.textOverflow === 'ellipsis' && s.overflowX !== 'visible' && el.scrollWidth > el.clientWidth + 1) return 1 - el.clientWidth / el.scrollWidth
      return 0
    }
    for (const scopeSel of scopes) {
      for (const scope of document.querySelectorAll(scopeSel)) {
        for (const el of scope.querySelectorAll<HTMLElement>('[class]')) {
          if (seen.has(el) || !isTitle(el) || !visible(el)) continue
          if (el.closest('[data-text-fit="skip"], [data-peek-open], [data-peek-placeholder]')) continue
          if (skip.some((s) => el.matches(s) || el.closest(s))) continue
          seen.add(el)
          // A title is cut by itself or by the box that holds only its text.
          let hidden = cutOf(el)
          const parent = el.parentElement
          if (!hidden && parent && parent.childElementCount === 1 && !isTitle(parent)) hidden = cutOf(parent)
          if (!hidden) continue
          const row = el.closest('[data-peek-row]') ?? parent
          const metaKeptRoom = !!row && [...row.querySelectorAll<HTMLElement>('*')].some((m) => m !== el && !el.contains(m) && !m.contains(el) && !isTitle(m) && (m.textContent ?? '').trim().length > 2 && m.childElementCount === 0 && visible(m) && cutOf(m) === 0)
          out.push({ scope: scopeSel, className: el.className, text: (el.textContent ?? '').trim().slice(0, 120), hidden: Math.round(hidden * 100) / 100, metaKeptRoom })
        }
      }
    }
    return out
  }, { scopes, skip, source: TITLE_CLASS_SOURCE })
}

/** The failing ones: cut while a metadata sibling kept its room, or more than `maxHidden` hidden. */
export function violations(found: CutTitle[], maxHidden = 0.05): CutTitle[] {
  return found.filter((f) => f.metaKeptRoom || f.hidden > maxHidden)
}
