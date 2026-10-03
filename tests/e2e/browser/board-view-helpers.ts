/**
 * The Board pane opens on Walnut's Overview of the team (BoardOverview.tsx);
 * the leader's page is the Custom view. Specs about the page switch to it the
 * way a user does: the bar's Custom segment, once the page exists.
 */
import { expect, type Locator } from '@playwright/test'

/** Show the leader's page in `pane` (the `task-board-pane`): waits for one to exist, then picks Custom. */
export async function showCustomBoard(pane: Locator): Promise<void> {
  const custom = pane.getByTestId('board-view-custom')
  await expect(custom).toBeVisible({ timeout: 15_000 })
  await expect(custom).not.toHaveAttribute('aria-disabled', 'true', { timeout: 15_000 })
  if ((await custom.getAttribute('aria-pressed')) !== 'true') await custom.click()
  await expect(custom).toHaveAttribute('aria-pressed', 'true')
}
