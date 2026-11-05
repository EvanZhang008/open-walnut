/**
 * Playwright browser tests for clickable entity references.
 *
 * Verifies that <task-ref> and <session-ref> XML tags in chat history
 * render as clickable pill links in the browser, and that a task pill's
 * text is the CURRENT task title resolved from the client task store —
 * the AI-provided label is only a fallback for unresolvable ids.
 *
 * Test data is seeded in test-server.ts: the chat content session (chat-content-helpers.ts) has
 * entity refs in assistant messages.
 */
import { test, expect } from '@playwright/test'
import { openChatContent } from './chat-content-helpers'

test.describe('entity references in chat', () => {
  test('task-ref renders the CURRENT task title, not the AI label', async ({ page }) => {
    await openChatContent(page)

    // The seeded label is "Walnut / Playwright test task" but the pill must
    // show the store-resolved title only (project rides the hover tooltip).
    const taskPill = page.locator('a.task-link[data-task-id="pw-task-001"]')
    await expect(taskPill).toHaveText('Playwright test task', { timeout: 15_000 })
    await expect(taskPill).toHaveAttribute('title', 'Walnut / Playwright test task')
  })

  test('a stale AI label is overridden by the real task title', async ({ page }) => {
    await openChatContent(page)

    // Seeded as label="Totally Wrong Pill Name" for pw-task-in-progress,
    // whose real title is "In progress phase task".
    const stalePill = page.locator('a.task-link', { hasText: 'In progress phase task' }).first()
    await expect(stalePill).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('a.task-link', { hasText: 'Totally Wrong Pill Name' })).toHaveCount(0)
  })

  test('session-ref renders as clickable purple pill with label', async ({ page }) => {
    await openChatContent(page)

    // The session-ref should render as a clickable session-link pill
    const sessionPill = page.locator('a.session-link', { hasText: 'Plan: investigate auth module' })
    await expect(sessionPill).toBeVisible({ timeout: 15_000 })

    // Verify it has the correct data attribute
    await expect(sessionPill).toHaveAttribute('data-session-id', 'pw-plan-session-completed')
  })

  test('unlabeled task-ref resolves to the title; an id that names no task is its alias as plain text', async ({ page }) => {
    await openChatContent(page)

    // Unlabeled ref to an EXISTING task → resolved title (was: raw id).
    const resolvedPill = page.locator('a.task-link[data-task-id="pw-task-in-progress"]').first()
    await expect(resolvedPill).toHaveText('In progress phase task', { timeout: 15_000 })

    // Ref to a task that does not exist → once the lookup says so, the alias as
    // plain text: a pill that opens nothing is never shown (2026-10-31).
    await expect(page.locator('a.task-link[data-task-id="pw-task-ghost-404"]')).toHaveCount(0, { timeout: 15_000 })
    await expect(page.getByText('And a deleted task: Ghost Task Alias.').first()).toBeVisible()
  })

  test('renaming a task updates its pill text live (no reload)', async ({ page }) => {
    await openChatContent(page)

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
    await openChatContent(page)

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

test.describe('a task reference opened from chat keeps the task panel on its tab', () => {
  // 2026-11-04, the user: "we don't auto go to all". A tab that does not show the task stays,
  // and a note says where it is; only its button changes the tab.
  test('the note names the tab, and its button shows the task', async ({ page }) => {
    const stamp = Date.now()
    const made = await page.request.post('/api/focus/tiers', { data: { label: `Quiet ${stamp}` } })
    expect(made.ok(), await made.text()).toBe(true)
    const tier = ((await made.json()) as { tier: { id: string } }).tier.id
    try {
      await page.addInitScript((id) => {
        if (sessionStorage.getItem('ref-tab-seeded')) return
        sessionStorage.setItem('ref-tab-seeded', '1')
        localStorage.setItem('walnut-todo-quick-views-visible', 'true')
        localStorage.setItem('walnut-todo-tab-bar-hidden-tabs', '[]')
        localStorage.setItem('walnut-todo-active-section', id)
      }, tier)
      const chat = await openChatContent(page)
      const nav = page.locator('#home-task-navigation')
      const selected = nav.locator('.todo-section-tabs [role="tab"][aria-selected="true"]')
      await expect(selected).toContainText(`Quiet ${stamp}`, { timeout: 20_000 })
      // The reply naming the task is the first one: scroll the chat back so it sits clear of the
      // panel's header, then click it as a user would.
      const pill = chat.locator('a.task-link[data-task-id="pw-task-001"]').first()
      const hist = (await chat.locator('.session-history').boundingBox())!
      await page.mouse.move(hist.x + hist.width / 2, hist.y + hist.height / 2)
      for (let i = 0; i < 10; i++) await page.mouse.wheel(0, -1500)
      await expect(pill).toBeVisible()
      await pill.click()
      const note = nav.getByTestId('todo-offview-note')
      await expect(note).toBeVisible()
      await expect(note).toContainText(`is not in Quiet ${stamp}.`)
      await expect(selected).toContainText(`Quiet ${stamp}`)
      await note.getByTestId('todo-offview-show').click()
      await expect(note).toHaveCount(0)
      await expect(selected).not.toContainText(`Quiet ${stamp}`)
      // Shown there: the group holding it opens, and the panel scrolls it into view.
      await expect(nav.locator('[data-task-id="pw-task-001"]').first()).toBeInViewport()
    } finally {
      await page.request.delete(`/api/focus/tiers/${tier}`).catch(() => {})
    }
  })
})
