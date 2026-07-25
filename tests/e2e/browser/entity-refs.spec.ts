/**
 * Playwright browser tests for clickable entity references.
 *
 * Verifies that <task-ref> and <session-ref> XML tags in chat history
 * render as clickable pill links in the browser.
 *
 * Test data is seeded in test-server.ts — chat-history.json contains
 * entity refs in assistant messages.
 */
import { test, expect } from '@playwright/test'

test.describe('entity references in chat', () => {
  test('task-ref renders as clickable blue pill with label', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')

    // The task-ref should render as a clickable task-link pill with the label text
    const taskPill = page.locator('a.task-link', { hasText: 'Walnut / Playwright test task' })
    await expect(taskPill).toBeVisible({ timeout: 5000 })

    // Verify it has the correct data attribute
    await expect(taskPill).toHaveAttribute('data-task-id', 'pw-task-001')
  })

  test('session-ref renders as clickable purple pill with label', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')

    // The session-ref should render as a clickable session-link pill
    const sessionPill = page.locator('a.session-link', { hasText: 'Plan: investigate auth module' })
    await expect(sessionPill).toBeVisible({ timeout: 5000 })

    // Verify it has the correct data attribute
    await expect(sessionPill).toHaveAttribute('data-session-id', 'pw-plan-session-completed')
  })

  test('task-ref without label still renders as pill with raw id', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')

    // The unlabeled task-ref in the seeded data should render with the raw id
    const rawPill = page.locator('a.task-link', { hasText: 'pw-task-in-progress' })
    await expect(rawPill).toBeVisible({ timeout: 5000 })
    await expect(rawPill).toHaveAttribute('data-task-id', 'pw-task-in-progress')
  })

  test('clicking session pill opens the session in a home-page session column', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')

    const sessionPill = page.locator('a.session-link', { hasText: 'Plan: investigate auth module' })
    await expect(sessionPill).toBeVisible({ timeout: 5000 })

    // Click the session pill. The dedicated /sessions page was removed:
    // on MainPage the ref opens the session panel inline; a /sessions?id=
    // navigation (non-MainPage surfaces) immediately reroutes back to '/'.
    await sessionPill.click()

    // Session panel for the referenced session should open in a home column
    const panel = page.locator('.main-page-session-column .session-panel[data-session-id="pw-plan-session-completed"]')
    await expect(panel).toBeVisible({ timeout: 10_000 })

    // Final URL is the home page — never a lingering /sessions route
    await expect
      .poll(() => new URL(page.url()).pathname, { timeout: 5000 })
      .toBe('/')
  })
})
