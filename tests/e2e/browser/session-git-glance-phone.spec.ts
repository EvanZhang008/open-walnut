/**
 * A task's detail on a phone: each session row keeps its title readable, its time
 * beside it, and no git state of its own. Git status stays out of every task row
 * (9a627232f); the session's branch, uncommitted files and unpushed commits are in
 * its Changed tab (session-git-glance.spec.ts). The fixture session has
 * uncommitted files and an unpushed commit, so a row that drew git state would show it.
 */
import { test, expect, type Page } from '@playwright/test'
import { GIT_GLANCE_BRANCH, GIT_GLANCE_SESSION } from './git-glance-fixture'
import { PHONE } from './phone-helpers'

test.use({
  viewport: PHONE.viewport,
  screen: PHONE.screen,
  deviceScaleFactor: PHONE.deviceScaleFactor,
  isMobile: true,
  hasTouch: true,
  userAgent: PHONE.userAgent,
})

/** The session, by its link, then its task's detail from the session's menu. */
async function openDetail(page: Page): Promise<void> {
  // The session's git state has been read before the detail opens, so a row that
  // still drew it would have it to draw.
  const gitRead = page.waitForResponse((r) => r.url().includes('/api/sessions/git-status') && r.url().includes(GIT_GLANCE_SESSION) && r.ok(), { timeout: 30_000 })
  await page.goto(`/?s1=${GIT_GLANCE_SESSION}`)
  await expect(page.locator(`.main-page-session-column.is-mobile-active .session-panel[data-session-id="${GIT_GLANCE_SESSION}"]`)).toBeVisible({ timeout: 30_000 })
  await gitRead
  await page.locator('.phone-topbar').getByRole('button', { name: 'More actions' }).click()
  await page.locator('.task-kebab-menu').getByText('Details', { exact: true }).click()
  await expect(page.locator('.task-detail-modal')).toBeVisible({ timeout: 10_000 })
}

for (const width of [390, 320]) {
  test(`a session row in a task's detail at ${width} px: the title and its time, no git state, nothing overlapping`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 })
    await openDetail(page)
    const item = page.locator('.task-detail-modal').locator(`.todo-detail-session-item[data-session-id="${GIT_GLANCE_SESSION}"]`)
    const titleEl = item.locator('.tdp-row-title')
    await expect(titleEl).toBeVisible({ timeout: 20_000 })
    await expect(titleEl).not.toHaveClass(/is-loading/)

    // No git state in the row, though the session has uncommitted and unpushed work.
    await expect(item.locator('.git-glance, .tdp-row-gitline')).toHaveCount(0)
    await expect(item).not.toContainText(GIT_GLANCE_BRANCH)

    const rowBox = (await item.boundingBox())!
    const title = (await titleEl.boundingBox())!
    const ago = (await item.locator('.tdp-row-end').boundingBox())!
    // The title reads (not squeezed to nothing), the time sits after it, and both stay in the row.
    expect(title.width).toBeGreaterThan(80)
    expect(ago.x).toBeGreaterThanOrEqual(title.x + title.width - 1)
    expect(ago.x + ago.width).toBeLessThanOrEqual(rowBox.x + rowBox.width + 1)
    expect(title.x).toBeGreaterThanOrEqual(rowBox.x - 1)
  })
}
