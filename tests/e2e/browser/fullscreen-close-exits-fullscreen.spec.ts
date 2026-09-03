/**
 * The X in a fullscreen session panel exits fullscreen; it does not close the column.
 *
 * Opening a split view (Files / Changed / Terminal) promotes the panel to a
 * fullscreen overlay. The header X sits at the overlay's top-right, where every
 * modal puts its dismiss button, so a click there used to be read as "dismiss the
 * overlay" and instead destroyed the whole session column: the user came back to
 * the normal layout and the panel was gone (reported 2026-09-03). The X now takes
 * the same path as Escape / backdrop click while fullscreen, and only closes the
 * column in the normal, non-fullscreen view.
 */
import { test, expect, type Page } from '@playwright/test'

const SESSION_ID = 'pw-vscode-session'
const TASK_ID = 'pw-task-vscode'
const SCREENSHOT_DIR = '/tmp/walnut-fullscreen-close'

async function openSessionPanel(page: Page) {
  await page.locator('.todo-search-input').fill(SESSION_ID)
  const task = page.locator(`.todo-panel-item[data-task-id="${TASK_ID}"]`)
  await expect(task).toBeVisible()
  await task.getByRole('button', { name: 'More actions' }).click()
  await page.locator('.task-kebab-menu:visible').locator('.task-kebab-item').first().click()
  const panel = page.locator(`.session-panel[data-session-id="${SESSION_ID}"]`)
  await expect(panel).toBeVisible()
  return panel
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try { localStorage.setItem('open-walnut-file-explorer-tree-collapsed', '0') } catch { /* off */ }
  })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
})

test('X in the fullscreen Files view exits fullscreen and keeps the column; X again closes it', async ({ page }) => {
  const panel = await openSessionPanel(page)

  // Files promotes the panel to fullscreen.
  await panel.getByRole('button', { name: 'Files' }).click()
  await expect(panel.locator('.session-file-explorer')).toBeVisible({ timeout: 15_000 })
  await expect(panel).toHaveClass(/open-walnut-fullscreen/)
  await expect(page.locator('.open-walnut-fullscreen-backdrop')).toHaveCount(1)
  await page.screenshot({ path: `${SCREENSHOT_DIR}/1-files-fullscreen.png` })

  // The X reads as the overlay's dismiss while fullscreen.
  const x = panel.locator('.session-panel-close')
  await expect(x).toHaveAttribute('aria-label', 'Exit full screen')
  await x.click()

  // Fullscreen is gone, the split view closed with it, and the column is STILL here.
  await expect(panel).not.toHaveClass(/open-walnut-fullscreen/)
  await expect(page.locator('.open-walnut-fullscreen-backdrop')).toHaveCount(0)
  await expect(panel.locator('.session-file-explorer')).toHaveCount(0)
  await expect(panel).toBeVisible()
  await expect(panel.locator('.chat-input-textarea').first()).toBeVisible()
  await page.screenshot({ path: `${SCREENSHOT_DIR}/2-after-x-column-kept.png` })

  // Back in the normal view the same button is the column's close again.
  await expect(x).toHaveAttribute('aria-label', 'Close session panel')
  await x.click()
  await expect(page.locator(`.session-panel[data-session-id="${SESSION_ID}"]`)).toHaveCount(0)
  await page.screenshot({ path: `${SCREENSHOT_DIR}/3-after-second-x-column-closed.png` })
})

test('X after the plain Expand button also only collapses back', async ({ page }) => {
  const panel = await openSessionPanel(page)

  await panel.getByRole('button', { name: 'Expand session to full screen' }).click()
  await expect(panel).toHaveClass(/open-walnut-fullscreen/)
  await expect(page.locator('.open-walnut-fullscreen-backdrop')).toHaveCount(1)

  const x = panel.locator('.session-panel-close')
  await expect(x).toHaveAttribute('aria-label', 'Exit full screen')
  await x.click()
  await expect(panel).not.toHaveClass(/open-walnut-fullscreen/)
  await expect(page.locator('.open-walnut-fullscreen-backdrop')).toHaveCount(0)
  await expect(panel).toBeVisible()
  await expect(x).toHaveAttribute('aria-label', 'Close session panel')
})
