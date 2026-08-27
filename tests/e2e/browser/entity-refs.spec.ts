/**
 * Playwright browser tests for clickable entity references.
 *
 * Verifies that <task-ref> and <session-ref> XML tags in chat history
 * render as clickable pill links in the browser, and that a task pill's
 * text is the CURRENT task title resolved from the client task store —
 * the AI-provided label is only a fallback for unresolvable ids.
 *
 * Test data is seeded in test-server.ts — chat-history.json contains
 * entity refs in assistant messages.
 */
import { test, expect } from '@playwright/test'

test.describe('entity references in chat', () => {
  test('task-ref renders the CURRENT task title, not the AI label', async ({ page }) => {
    await page.goto('/')

    // The seeded label is "Walnut / Playwright test task" but the pill must
    // show the store-resolved title only (project rides the hover tooltip).
    const taskPill = page.locator('a.task-link[data-task-id="pw-task-001"]')
    await expect(taskPill).toHaveText('Playwright test task', { timeout: 15_000 })
    await expect(taskPill).toHaveAttribute('title', 'Walnut / Playwright test task')
  })

  test('a stale AI label is overridden by the real task title', async ({ page }) => {
    await page.goto('/')

    // Seeded as label="Totally Wrong Pill Name" for pw-task-in-progress,
    // whose real title is "In progress phase task".
    const stalePill = page.locator('a.task-link', { hasText: 'In progress phase task' }).first()
    await expect(stalePill).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('a.task-link', { hasText: 'Totally Wrong Pill Name' })).toHaveCount(0)
  })

  test('session-ref renders as clickable purple pill with label', async ({ page }) => {
    await page.goto('/')

    // The session-ref should render as a clickable session-link pill
    const sessionPill = page.locator('a.session-link', { hasText: 'Plan: investigate auth module' })
    await expect(sessionPill).toBeVisible({ timeout: 15_000 })

    // Verify it has the correct data attribute
    await expect(sessionPill).toHaveAttribute('data-session-id', 'pw-plan-session-completed')
  })

  test('unlabeled task-ref resolves to the title; unresolvable id falls back to the alias', async ({ page }) => {
    await page.goto('/')

    // Unlabeled ref to an EXISTING task → resolved title (was: raw id).
    const resolvedPill = page.locator('a.task-link[data-task-id="pw-task-in-progress"]').first()
    await expect(resolvedPill).toHaveText('In progress phase task', { timeout: 15_000 })

    // Ref to a task that does not exist → the alias label is the fallback.
    const ghostPill = page.locator('a.task-link[data-task-id="pw-task-ghost-404"]')
    await expect(ghostPill).toHaveText('Ghost Task Alias')
    // Unresolved hover carries the id for diagnosability.
    await expect(ghostPill).toHaveAttribute('title', 'pw-task-ghost-404')
  })

  test('renaming a task updates its pill text live (no reload)', async ({ page }) => {
    await page.goto('/')

    const taskPill = page.locator('a.task-link[data-task-id="pw-task-001"]')
    await expect(taskPill).toHaveText('Playwright test task', { timeout: 15_000 })

    // Rename through the real API — the WS task:updated event must reach the
    // entity-label store and re-render the pill without a page reload.
    const status = await page.evaluate(async () => {
      const res = await fetch('/api/tasks/pw-task-001', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Renamed live by spec' }),
      })
      return res.status
    })
    expect(status).toBe(200)

    await expect(taskPill).toHaveText('Renamed live by spec', { timeout: 10_000 })

    // Restore for spec-order independence.
    await page.evaluate(async () => {
      await fetch('/api/tasks/pw-task-001', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Playwright test task' }),
      })
    })
  })

  test('clicking session pill opens the session in a home-page session column', async ({ page }) => {
    await page.goto('/')

    const sessionPill = page.locator('a.session-link', { hasText: 'Plan: investigate auth module' })
    await expect(sessionPill).toBeVisible({ timeout: 15_000 })

    // Click the session pill. The dedicated /sessions page was removed:
    // on MainPage the ref opens the session panel inline; a /sessions?id=
    // navigation (non-MainPage surfaces) immediately reroutes back to '/'.
    await sessionPill.click()

    // Session panel for the referenced session should open in a home column
    const panel = page.locator('.main-page-session-column .session-panel[data-session-id="pw-plan-session-completed"]')
    await expect(panel).toBeVisible({ timeout: 10_000 })

    // Final URL is the home page — never a lingering /sessions route
    await expect
      .poll(() => new URL(page.url()).pathname, { timeout: 15_000 })
      .toBe('/')
  })
})
