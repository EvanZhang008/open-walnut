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

  test('clicking session pill navigates to sessions page', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')

    const sessionPill = page.locator('a.session-link', { hasText: 'Plan: investigate auth module' })
    await expect(sessionPill).toBeVisible({ timeout: 5000 })

    // Click the session pill
    await sessionPill.click()

    // Should navigate to sessions page with id query param
    await page.waitForURL(/\/sessions\?id=pw-plan-session-completed/, { timeout: 5000 })
    expect(page.url()).toContain('/sessions')
    expect(page.url()).toContain('id=pw-plan-session-completed')
  })
})
