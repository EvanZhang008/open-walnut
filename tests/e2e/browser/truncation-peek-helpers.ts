import { expect, type Locator, type Page } from '@playwright/test'

/** The pill web/src/utils/truncation-peek.ts lays over cut-off text while the pointer is on it. */
export const peekPill = (page: Page): Locator => page.getByTestId('truncation-peek')

/**
 * Cut-off text shows its whole text in place on hover, never in a native tooltip (2026-11-12,
 * the user: "make the full line expanded like what we did for side bar"): the element carries
 * no title of its own, hovering it opens the pill with `text`, and leaving it closes that pill.
 * The element is scrolled into view first and hovered again until the pill shows: a scroll
 * ends a pill (truncation-peek.ts), and the one Playwright's hover makes can land after it.
 */
export async function expectPeeksInPlace(el: Locator, text: string, label: string): Promise<void> {
  const page = el.page()
  expect.soft(await el.getAttribute('title'), `${label}: no native title of its own`).toBeNull()
  await el.scrollIntoViewIfNeeded()
  await expect(async () => {
    await page.mouse.move(1, 1)
    await el.hover()
    await expect(peekPill(page)).toContainText(text, { timeout: 2_000 })
  }, `${label}: hovering it shows the whole text in place`).toPass({ timeout: 15_000 })
  await page.mouse.move(1, 1)
  await expect.soft(peekPill(page).filter({ hasText: text }), `${label}: the peek closes when the pointer leaves`).toHaveCount(0)
}
