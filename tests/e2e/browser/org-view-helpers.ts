/**
 * The Org node's views since the side-bar redesign (2026-11-02): the chat is always on screen, and
 * Team and Board are ways the side bar's Tasks draws the node's work (OrgTaskRail's Status | Team |
 * Board). Specs reach them through these, not through the Chat / Team / Board tabs that are gone.
 */
import { expect, type Locator, type Page } from '@playwright/test'

/** The side bar's Tasks, drawn by status, by team or as the lead's Board. */
export async function openTasksBy(scope: Page | Locator, mode: 'status' | 'team' | 'board'): Promise<void> {
  const toggle = scope.getByTestId('org-rail-toggle')
  if (await toggle.getAttribute('aria-pressed') === 'false') await toggle.click()
  await scope.getByTestId('org-top-task').click()
  await scope.getByTestId(`org-task-mode-${mode}`).click()
  await expect(scope.getByTestId('org-task-view')).toHaveAttribute('data-mode', mode)
}

/** The node's chat (or the way to start one) is on screen. */
export async function expectChatShown(scope: Page | Locator): Promise<void> {
  await expect(scope.locator('[data-testid="org-chat"], [data-testid="org-chat-start"]').first()).toBeVisible({ timeout: 30_000 })
}
