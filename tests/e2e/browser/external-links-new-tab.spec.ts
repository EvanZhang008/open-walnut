/**
 * External links in chat open in a NEW tab; in-app links stay in the console.
 *
 * Neither marked nor DOMPurify sets `target`, so a `[guide](https://…)` in an
 * assistant reply used to navigate the whole SPA away (2026-09-03 report). The
 * fix is a DOMPurify hook on the shared singleton (web/src/utils/markdown.ts);
 * this drives the rendered anchor like a user and checks where the click lands.
 *
 * Seed: the entity-refs assistant message in test-server.ts carries one external
 * markdown link and one relative link.
 */
import { test, expect } from '@playwright/test'

test.describe('external links in chat', () => {
  test('external markdown link carries target=_blank and opens a new tab', async ({ page, context }) => {
    await page.goto('/')

    const external = page.locator('a[href="https://example.com/walnut-docs"]').first()
    await expect(external).toBeVisible({ timeout: 15_000 })
    await expect(external).toHaveAttribute('target', '_blank')
    await expect(external).toHaveAttribute('rel', 'noopener noreferrer')

    // The click must NOT navigate this page: a new tab opens and the console
    // (with its sockets and composer state) is still here.
    const before = page.url()
    const [popup] = await Promise.all([
      context.waitForEvent('page', { timeout: 10_000 }),
      external.click(),
    ])
    expect(popup.url()).toContain('example.com/walnut-docs')
    await popup.close()
    expect(page.url()).toBe(before)
  })

  test('in-app links (relative href, task pill) get no target', async ({ page }) => {
    await page.goto('/')

    const board = page.locator('a[href="/tasks"]', { hasText: 'board' }).first()
    await expect(board).toBeVisible({ timeout: 15_000 })
    await expect(board).not.toHaveAttribute('target', /.+/)

    const pill = page.locator('a.task-link[data-task-id="pw-task-001"]').first()
    await expect(pill).toBeVisible()
    await expect(pill).not.toHaveAttribute('target', /.+/)
  })
})
