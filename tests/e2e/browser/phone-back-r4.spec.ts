/**
 * C24 after a cycle: a session opened from a Home row, closed with the bar's
 * Back, opened again, then its task detail on top: the system back peels the
 * detail, then the session, never the detail a second time.
 * WebKit with devices['iPhone 15'] first, chromium too.
 */
import { expect, test, type Page } from '@playwright/test'
import { PHONE } from './phone-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'

const SID = 'pw-question-recovery-session'
const TASK_ID = 'pw-task-question-recovery'

test.use({
  viewport: PHONE.viewport,
  screen: PHONE.screen,
  deviceScaleFactor: PHONE.deviceScaleFactor,
  isMobile: true,
  hasTouch: true,
  userAgent: PHONE.userAgent,
})
test.setTimeout(180_000)

const topbar = (p: Page) => p.locator('.phone-topbar')
const overlay = (p: Page) => p.locator(`.main-page-session-column.is-mobile-active .session-panel[data-session-id="${SID}"]`)
const detail = (p: Page) => p.locator('.task-detail-modal')
const marker = (p: Page) => p.evaluate(() => (history.state as { walnutOverlay?: { id: string } } | null)?.walnutOverlay?.id ?? null)

async function homeRow(p: Page) {
  const header = p.locator('.todo-panel .todo-group-project-header', { has: p.locator('.todo-group-project-name', { hasText: /^Walnut$/ }) }).first()
  await expect(header).toBeVisible({ timeout: 30_000 })
  await header.scrollIntoViewIfNeeded()
  if (/to expand/.test((await header.getAttribute('title')) ?? '')) await header.tap({ position: { x: 48, y: 22 } })
  const row = p.locator(`.todo-panel .todo-panel-item[data-task-id="${TASK_ID}"]`).first()
  for (let i = 0; i < 8 && await row.count() === 0; i++) {
    const more = p.locator('.todo-panel').getByRole('button', { name: 'Show more' }).first()
    if (!await more.count()) break
    await more.scrollIntoViewIfNeeded(); await more.tap(); await p.waitForTimeout(400)
  }
  await row.scrollIntoViewIfNeeded()
  return row
}

async function openFromRow(p: Page): Promise<void> {
  const row = await homeRow(p)
  await row.locator('.todo-item-title').first().tap()
  await expect(overlay(p)).toBeVisible({ timeout: 20_000 })
}

for (const cycles of [0, 1, 2]) {
  test(`C24: back peels the task detail, then the session, after ${cycles} open and close cycle(s)`, async ({ page }) => {
    await isolateUiPrefs(page)
    await page.addInitScript(() => { try { localStorage.setItem('open-walnut-home-chat-visible', 'false') } catch { /* off */ } })
    await page.goto('/')
    await expect(topbar(page)).toBeVisible({ timeout: 60_000 })
    for (let i = 0; i < cycles; i++) {
      await openFromRow(page)
      await topbar(page).getByRole('button', { name: 'Back' }).tap()
      await expect(overlay(page)).toHaveCount(0, { timeout: 10_000 })
      await page.waitForTimeout(500)
    }
    await openFromRow(page)
    await topbar(page).getByRole('button', { name: 'More actions' }).tap()
    await page.locator('.task-kebab-menu').getByRole('button', { name: /^(Task detail|Details)$/ }).first().tap()
    await expect(detail(page)).toBeVisible({ timeout: 10_000 })
    await page.waitForTimeout(500)
    await page.goBack()
    await expect(detail(page)).toHaveCount(0, { timeout: 5_000 })
    await expect(overlay(page)).toBeVisible()
    await page.goBack()
    await expect(overlay(page)).toHaveCount(0, { timeout: 5_000 })
    await page.waitForTimeout(800)
    expect(await detail(page).count(), 'the detail came back').toBe(0)
    expect(await marker(page), 'history sits on Home').toBeNull()
    expect(new URL(page.url()).searchParams.get('task')).toBeNull()
  })
}
