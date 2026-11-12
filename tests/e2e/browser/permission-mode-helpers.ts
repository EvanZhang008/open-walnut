import { expect, type Locator } from '@playwright/test'

/** Walnut mode ids, in the menu's order (src/core/types.ts SESSION_MODES). */
export type ModeId = 'plan' | 'default' | 'dontAsk' | 'accept' | 'auto' | 'bypass'

/** The open permission-mode menu (portalled under <body>, one at a time). Found from
 *  the pill's own document, so a pill inside a frame (the extension panel's) finds
 *  the menu in that frame, not in the outer page. */
export const modeMenu = (pill: Locator): Locator =>
  pill.locator('xpath=ancestor::body').locator('.permission-mode-menu')

/** Click a composer's mode pill and choose a mode from its menu; the menu closes. */
export async function pickMode(pill: Locator, mode: ModeId): Promise<void> {
  await pill.click()
  const menu = modeMenu(pill)
  await expect(menu).toBeVisible()
  await menu.locator(`[role="option"][data-mode="${mode}"]`).click()
  await expect(menu).toHaveCount(0)
}
