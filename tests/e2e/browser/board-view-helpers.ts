/**
 * The Board pane opens on Status, every task of the team by the one user status
 * (web/src/components/board/BoardStatusView.tsx); Cards is the team's kanban
 * (web/src/components/board/kanban/), and the leader's page is the Page view
 * (`board-view-custom`). Specs switch views the way a user does: the bar's segment.
 */
import { expect, type Locator, type Page } from '@playwright/test'

/** Show the leader's page in `pane` (the `task-board-pane`): waits for one to exist, then picks Page. */
export async function showCustomBoard(pane: Locator): Promise<void> {
  const custom = pane.getByTestId('board-view-custom')
  await expect(custom).toBeVisible({ timeout: 15_000 })
  await expect(custom).not.toHaveAttribute('aria-disabled', 'true', { timeout: 15_000 })
  if ((await custom.getAttribute('aria-pressed')) !== 'true') await custom.click()
  await expect(custom).toHaveAttribute('aria-pressed', 'true')
}

/** The phone layout's query (web/src/hooks/usePhoneLayout.ts PHONE_LAYOUT_QUERY). */
export const PHONE_QUERY = '(max-width: 768px), (pointer: coarse) and (max-height: 500px)'

/**
 * Opens the Board of the session in `panel` the way its layout offers it, and returns the
 * `task-board-pane`. A window 768px wide or less is the phone layout (since 2026-10-15), where
 * the Board is a row of the top bar's More actions; a desktop header too narrow for the chip
 * folds it into its "..." menu (2026-10-31: the 520px kanban specs waited up to 240 s on the
 * desktop chip, which a phone keeps hidden).
 */
export async function openSessionBoard(page: Page, panel: Locator, beforeClick?: () => Promise<void>): Promise<Locator> {
  const chip = panel.getByTestId('session-board-chip')
  await expect(chip).toHaveCount(1, { timeout: 30_000 })
  // A chip on the row that turns live (the record loaded) is the one click, whatever the
  // width, as a plain click waits for it: the specs measure the Board as it opens from
  // there. Only a chip that stays folded or hidden takes the layout's other way.
  const onRow = await expect.poll(async () => await chip.isEnabled() && (await chip.getAttribute('data-hidden')) !== 'true' && await chip.isVisible(),
    { timeout: 30_000 }).toBe(true).then(() => true, () => false)
  if (beforeClick) await beforeClick()
  if (onRow) {
    await chip.click()
  } else if (await page.evaluate((q) => window.matchMedia(q).matches, PHONE_QUERY)) {
    await page.locator('.phone-topbar').getByRole('button', { name: 'More actions' }).click()
    const row = page.getByTestId('phone-row-board')
    await expect(row).toBeEnabled({ timeout: 30_000 })
    await row.click()
  } else if ((await chip.getAttribute('data-hidden')) === 'true') {
    await panel.getByTestId('session-header-more-btn').click()
    const row = page.getByTestId('session-header-more-item-board')
    await expect(row).toBeEnabled({ timeout: 30_000 })
    await row.click()
  } else {
    await chip.click()
  }
  const pane = page.getByTestId('task-board-pane')
  await expect(pane).toBeVisible({ timeout: 30_000 })
  return pane
}
