/**
 * "Find on Home" from a session panel that lives OFF Home (2026-09-25: "all the sessions we start not
 * in home page, can have find me, and then directly navigate to home page that task").
 *
 * A session panel mounted by a page that gives it no Locate handler (Notes' Claude Code tab here; an
 * ask drawer and a plugin's SessionView are the same case) used to draw a Locate button that did
 * nothing. It now takes the person to Home, selects the task in the task panel, and opens the session
 * there, because the panel they were reading is not on Home. An ask goes to the chat slot instead of a
 * column; that half is graded in mail-ask-drawer.spec.ts (S4-11).
 */
import { test, expect, type Page } from '@playwright/test'

const NOTE = 'FindOnHome/Locate Note.md'

// The first paint waits on a cold fixture (networkidle), which alone can pass the 30s default when the
// machine is loaded; every step below keeps its own deadline.
test.setTimeout(180_000)

async function seedNote(baseURL: string): Promise<void> {
  await fetch(`${baseURL}/api/notes-v2/content/${NOTE}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: '# Locate Note\n\nbody\n' }),
  })
}

async function gotoNotes(page: Page): Promise<void> {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.locator('a[href="/notes"]').first().click()
  await page.waitForLoadState('networkidle')
}

test('a Notes session panel finds its task on Home and opens the session in a column', async ({ page, baseURL }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  // The fixture's own origin, not a hard-coded :3457: PW_TEST_PORT moves it.
  await seedNote(baseURL!)
  await gotoNotes(page)
  await page.evaluate(() => {
    localStorage.removeItem('open-walnut-notes-cc-session')
    localStorage.removeItem('open-walnut-notes-chat-mode')
  })
  await page.reload()
  await page.waitForLoadState('networkidle')

  const folder = page.locator('.notes-tree-folder', { hasText: 'FindOnHome' })
  const file = page.locator('.notes-tree-file:not(.notes-bookmark-row)', { hasText: 'Locate Note' })
  if (!(await file.isVisible().catch(() => false))) await folder.click()
  await file.click({ button: 'right' })
  await page.locator('.notes-context-menu button', { hasText: 'Start Claude Code session' }).click()

  const panel = page.locator('.notes-chat-pane .session-panel')
  await expect(panel).toBeVisible({ timeout: 30_000 })
  const locate = panel.getByTestId('session-panel-locate')
  await expect(locate).toBeVisible({ timeout: 30_000 })
  await expect(locate).toHaveAttribute('aria-label', 'Find on Home')
  const sessionId = await panel.getAttribute('data-session-id')
  expect(sessionId).toBeTruthy()
  await locate.click()

  await expect(page).toHaveURL(/\/$/)
  await expect(page.locator(`.main-page-session-column [data-session-id="${sessionId}"]`).first())
    .toBeVisible({ timeout: 30_000 })
  // Selected where it is drawn: a pinned task is its active card, a listed one its focused row.
  const selected = page.locator('#home-task-navigation .task-focused, #home-task-navigation .todo-pinned-card-active')
  await expect(selected.first()).toBeVisible({ timeout: 30_000 })
  await expect(selected.first()).toContainText('Session: notes')
  await page.screenshot({ path: '/tmp/mail-ask-ui/find-on-home-notes.png', clip: { x: 0, y: 0, width: 1280, height: 720 } })
  expect(errors).toEqual([])

  // Tidy: the Notes tab is closed so a later spec starts from an empty chat column.
  await page.evaluate(() => {
    localStorage.removeItem('open-walnut-notes-cc-session')
    localStorage.removeItem('open-walnut-notes-chat-mode')
  })
})
