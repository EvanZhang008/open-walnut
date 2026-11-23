/**
 * Press one of a session header's tools (Files, Changed, Terminal, Board ...) the way its layout
 * offers it: the key on the row when it shows there, else its row in the header's "..." menu. The
 * header folds keys into that menu when the row is too narrow (useSessionHeaderFit.ts); the keys
 * are the button family's width since 2026-11-22, so a second Home column folds Files, and a click
 * on the hidden key waited out the test (fullscreen-yields-to-column-open, 2026-11-23).
 */
import { expect, type Locator, type Page } from '@playwright/test'

export async function pressHeaderTool(page: Page, panel: Locator, id: string): Promise<void> {
  const key = panel.locator(`.session-panel-header [data-header-id="${id}"]`).first()
  await expect(key).toHaveCount(1, { timeout: 30_000 })
  // The fit settles a frame after a column opens: read where the key is once it stops moving.
  let folded = (await key.getAttribute('data-hidden')) === 'true'
  for (let i = 0; i < 3; i++) {
    await page.waitForTimeout(150)
    const now = (await key.getAttribute('data-hidden')) === 'true'
    if (now === folded && (folded || await key.isVisible())) break
    folded = now
  }
  if (!folded && await key.isVisible()) return key.click()
  await panel.getByTestId('session-header-more-btn').click()
  const row = page.getByTestId(`session-header-more-item-${id}`)
  await expect(row).toBeVisible({ timeout: 15_000 })
  await row.click()
}
