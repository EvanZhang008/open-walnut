import { expect, type Locator, type Page } from '@playwright/test'

/** The pill web/src/utils/truncation-peek.ts lays over cut-off text while the pointer is on it. */
export const peekPill = (page: Page): Locator => page.getByTestId('truncation-peek')

/**
 * Whether the cut-off text `el` (or one inside it) shows whole in its own row right now: a task
 * row expands in place (utils/truncation-peek-row.ts), so the text is marked open and nothing of
 * it is cut any more.
 */
export const openInRow = (el: Locator): Promise<boolean> => el.evaluate((node) => {
  const open = node.closest('[data-peek-open]') ?? node.querySelector('[data-peek-open]')
  return !!open && open.scrollWidth <= open.clientWidth + 1 && open.scrollHeight <= open.clientHeight + 1
})

/**
 * Cut-off text shows its whole text in place on hover, never in a native tooltip (2026-11-12,
 * the user: "make the full line expanded like what we did for side bar"; 2026-11-13: in a task
 * row, the row itself expands): the element carries no title of its own, hovering it shows
 * `text` (its row grown to hold it, or a pill over a text outside a row), and leaving it ends
 * that. The element is scrolled into view first and hovered again until it shows: a scroll ends
 * a peek (truncation-peek.ts), and the one Playwright's hover makes can land after it.
 */
export async function expectPeeksInPlace(el: Locator, text: string, label: string): Promise<void> {
  const page = el.page()
  expect.soft(await el.getAttribute('title'), `${label}: no native title of its own`).toBeNull()
  await el.scrollIntoViewIfNeeded()
  await expect(async () => {
    await page.mouse.move(1, 1)
    await el.hover()
    await expect.poll(async () => (await openInRow(el)) || ((await peekPill(page).filter({ hasText: text }).count()) > 0), { timeout: 2_000 }).toBe(true)
  }, `${label}: hovering it shows the whole text in place`).toPass({ timeout: 15_000 })
  await expect(el).toContainText(text)
  await page.mouse.move(1, 1)
  await expect.soft(peekPill(page).filter({ hasText: text }), `${label}: the peek closes when the pointer leaves`).toHaveCount(0)
  let closed = false
  for (let i = 0; i < 20 && !closed; i++) { closed = !(await openInRow(el)); if (!closed) await page.waitForTimeout(100) }
  expect.soft(closed, `${label}: the row closes when the pointer leaves`).toBe(true)
}
