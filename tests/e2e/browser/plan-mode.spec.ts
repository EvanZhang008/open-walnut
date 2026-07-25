/**
 * Playwright browser tests for session plan mode UI.
 *
 * The dedicated /sessions page was removed — the homepage session column
 * (`.main-page-session-column .session-panel`) is the only session surface.
 *
 * Tests:
 * 1. Plan chip + Execute buttons appear in the homepage SessionPanel for a
 *    completed plan session (plan popup shows the Execute actions).
 * 2. Incomplete plan session shows Plan mode but NO Execute button.
 * 3. Normal (non-plan) session shows neither Plan chip nor Execute button.
 */
import { test, expect, type Page } from '@playwright/test'

// Seed the home column queue (sessionStorage) so the SessionPanel for the
// given session mounts on load, then wait for it to render.
async function openSessionOnHome(page: Page, sessionId: string) {
  await page.addInitScript((sid) => {
    sessionStorage.setItem('open-walnut-home-session-columns', JSON.stringify([{ id: sid, locked: false }]))
  }, sessionId)
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  const panel = page.locator(`.main-page-session-column .session-panel[data-session-id="${sessionId}"]`)
  await expect(panel).toBeVisible({ timeout: 10_000 })
  return panel
}

test('completed plan session shows Plan chip and Execute buttons in the homepage panel', async ({ page }) => {
  const panel = await openSessionOnHome(page, 'pw-plan-session-completed')

  // The Plan action chip renders whenever a plan actually exists for the session
  const planChip = panel.locator('.session-action-chip', { hasText: 'Plan' }).first()
  await expect(planChip).toBeVisible({ timeout: 5000 })

  // Open the plan popup → Execute button should be visible (planCompleted=true)
  await planChip.click()
  const popup = page.locator('.plan-popup-container')
  await expect(popup).toBeVisible({ timeout: 3000 })
  await expect(popup.locator('.execute-plan-btn')).toBeVisible({ timeout: 3000 })
})

test('incomplete plan session shows Plan mode but does NOT show Execute button', async ({ page }) => {
  const panel = await openSessionOnHome(page, 'pw-plan-session-incomplete')

  // The mode toggle pill reflects plan mode (it's still a plan session)
  const modePill = panel.locator('.mode-toggle-pill')
  await expect(modePill).toBeVisible({ timeout: 5000 })
  await expect(modePill).toHaveClass(/plan-active/)

  // Execute button should NOT be present (planCompleted=false, process errored)
  await expect(panel.locator('.execute-plan-btn')).not.toBeVisible()
})

test('normal session does NOT show Plan chip or Execute button', async ({ page }) => {
  const panel = await openSessionOnHome(page, 'pw-normal-session')

  // Mode pill renders but is NOT in plan mode (bypass session)
  const modePill = panel.locator('.mode-toggle-pill')
  await expect(modePill).toBeVisible({ timeout: 5000 })
  await expect(modePill).not.toHaveClass(/plan-active/)

  // No Plan chip (no plan exists) and no Execute button
  await expect(panel.locator('.session-action-chip', { hasText: 'Plan' })).not.toBeVisible()
  await expect(panel.locator('.execute-plan-btn')).not.toBeVisible()
})
