/**
 * The Board pane opens on Status, every task of the team by the one user status
 * (web/src/components/board/BoardStatusView.tsx); Cards is the team's kanban
 * (web/src/components/board/kanban/), and the leader's page is the Page view
 * (`board-view-custom`). Specs switch views the way a user does: the bar's segment.
 */
import { expect, type Locator } from '@playwright/test'

/** Show the leader's page in `pane` (the `task-board-pane`): waits for one to exist, then picks Page. */
export async function showCustomBoard(pane: Locator): Promise<void> {
  const custom = pane.getByTestId('board-view-custom')
  await expect(custom).toBeVisible({ timeout: 15_000 })
  await expect(custom).not.toHaveAttribute('aria-disabled', 'true', { timeout: 15_000 })
  if ((await custom.getAttribute('aria-pressed')) !== 'true') await custom.click()
  await expect(custom).toHaveAttribute('aria-pressed', 'true')
}
