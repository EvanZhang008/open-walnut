/**
 * Playwright browser tests for session plan mode UI.
 *
 * Tests:
 * 1. Plan badge appears on plan-mode sessions in the session tree
 * 2. Plan badge appears in the session detail header
 * 3. "Execute Plan" button appears for completed plan sessions
 * 4. "Execute Plan" button does NOT appear for incomplete plan sessions
 * 5. "Execute Plan" button does NOT appear for non-plan sessions
 */
import { test, expect } from '@playwright/test'

// Navigate to sessions page and ensure "Hide Done" is OFF so all sessions are visible
async function goToSessions(page: import('@playwright/test').Page) {
  await page.goto('/sessions')
  await page.waitForLoadState('networkidle')

  // The "Hide Done" chip uses class "session-tree-chip-active" when active.
  // Default is active (hideCompleted=true). Click to toggle OFF so completed sessions show.
  const hideDoneBtn = page.locator('button', { hasText: 'Hide Done' })
  await expect(hideDoneBtn).toBeVisible({ timeout: 5000 })

  // Check if the button has the active class
  const isActive = await hideDoneBtn.evaluate(
    (el) => el.classList.contains('session-tree-chip-active'),
  )
  if (isActive) {
    await hideDoneBtn.click()
    await page.waitForTimeout(500)
  }
}

test('sessions page shows Plan badge on plan-mode sessions', async ({ page }) => {
  await goToSessions(page)

  // The seeded plan session should show a "Plan" badge in the tree
  const planBadge = page.locator('.session-tree-plan-badge', { hasText: 'Plan' }).first()
  await expect(planBadge).toBeVisible({ timeout: 5000 })
})

test('clicking completed plan session shows detail panel with Plan badge and Execute Plan button', async ({ page }) => {
  await goToSessions(page)

  // Click on the completed plan session in the tree
  const planSession = page.locator('.session-tree-session', { hasText: 'Plan: investigate auth module' })
  await expect(planSession).toBeVisible({ timeout: 5000 })
  await planSession.click()

  // Detail panel should show Plan badge
  const detailPlanBadge = page.locator('.session-detail-badge', { hasText: 'Plan' })
  await expect(detailPlanBadge).toBeVisible({ timeout: 3000 })

  // Execute Plan button should be visible (session is completed plan with planCompleted=true)
  const executeBtn = page.locator('button', { hasText: 'Execute Plan' })
  await expect(executeBtn).toBeVisible({ timeout: 3000 })
})

test('incomplete plan session does NOT show Execute Plan button', async ({ page }) => {
  await goToSessions(page)

  // Click on the incomplete plan session
  const incompleteSession = page.locator('.session-tree-session', { hasText: 'Plan: incomplete session' })
  await expect(incompleteSession).toBeVisible({ timeout: 5000 })
  await incompleteSession.click()

  // Detail panel should show Plan badge (it's still a plan session)
  const detailPlanBadge = page.locator('.session-detail-badge', { hasText: 'Plan' })
  await expect(detailPlanBadge).toBeVisible({ timeout: 3000 })

  // Execute Plan button should NOT be visible (planCompleted is false)
  const executeBtn = page.locator('button', { hasText: 'Execute Plan' })
  await expect(executeBtn).not.toBeVisible()
})

test('normal session does NOT show Plan badge or Execute Plan button', async ({ page }) => {
  await goToSessions(page)

  // Click on the normal session
  const normalSession = page.locator('.session-tree-session', { hasText: 'Normal: fix the bug' })
  await expect(normalSession).toBeVisible({ timeout: 5000 })
  await normalSession.click()

  // Wait for detail panel to render
  await page.waitForTimeout(500)

  // Should NOT show Plan badge in detail (only status badges, not Plan)
  const detailPlanBadge = page.locator('.session-detail-badge', { hasText: 'Plan' })
  await expect(detailPlanBadge).not.toBeVisible()

  // Should NOT show Execute Plan button
  const executeBtn = page.locator('button', { hasText: 'Execute Plan' })
  await expect(executeBtn).not.toBeVisible()
})
