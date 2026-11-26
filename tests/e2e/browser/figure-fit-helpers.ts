/**
 * Large type is a reading, never a hint: a figure or heading drawn at 20px or more must show in
 * full. 2026-11-26: Usage's four headline amounts read "$15,..." on a 390px phone, an ellipsis on
 * text set at the page-title size. `cutLargeText` lists every visible element on the page whose own
 * text is 20px or larger and wider than its box, so a new big-number card that cuts fails as well.
 */
import type { Page } from '@playwright/test'

export async function cutLargeText(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = []
    for (const el of document.querySelectorAll<HTMLElement>('body *')) {
      if (!el.offsetParent && getComputedStyle(el).position !== 'fixed') continue
      const own = [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent!.trim())
      if (!own) continue
      const cs = getComputedStyle(el)
      if (parseFloat(cs.fontSize) < 20) continue
      // A visually hidden copy (a 1px clip that names the page for screen readers) is not drawn.
      if (el.clientWidth <= 2 || el.clientHeight <= 2) continue
      if (el.scrollWidth > el.clientWidth + 1 && cs.overflowX !== 'visible') out.push(`${el.className || el.tagName}: "${el.textContent!.trim().slice(0, 40)}" ${el.scrollWidth}px in ${el.clientWidth}px`)
    }
    return out
  })
}

/** The Usage headline figures: each one whole and inside its own card. */
export async function usageFigureProblems(page: Page): Promise<string[]> {
  return page.locator('.settings-addons-stat').evaluateAll((cards) => cards.flatMap((card) => {
    const value = card.querySelector<HTMLElement>('.settings-addons-stat-value')!
    const c = card.getBoundingClientRect()
    const v = value.getBoundingClientRect()
    const range = document.createRange(); range.selectNodeContents(value)
    const text = range.getBoundingClientRect()
    const problems: string[] = []
    if (value.scrollWidth > value.clientWidth + 1) problems.push(`${value.textContent} is cut (${value.scrollWidth}px in ${value.clientWidth}px)`)
    if (text.right > c.right + 1 || v.right > c.right + 1) problems.push(`${value.textContent} runs past its card`)
    return problems
  }))
}
