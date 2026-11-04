/**
 * A task's detail on a phone: each session row keeps its title readable and puts
 * its git state (branch, uncommitted files, +/- lines, unpushed commits) on a
 * line of its own, clear of the title and of the time. Beside the title it took
 * the whole width and ran into the time.
 */
import { test, expect, type Page } from '@playwright/test'
import { GIT_GLANCE_SESSION } from './git-glance-fixture'
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
  await page.goto(`/?s1=${GIT_GLANCE_SESSION}`)
  await expect(page.locator(`.main-page-session-column.is-mobile-active .session-panel[data-session-id="${GIT_GLANCE_SESSION}"]`)).toBeVisible({ timeout: 30_000 })
  await page.locator('.phone-topbar').getByRole('button', { name: 'More actions' }).click()
  await page.locator('.task-kebab-menu').getByText('Details', { exact: true }).click()
  await expect(page.locator('.task-detail-modal')).toBeVisible({ timeout: 10_000 })
}

for (const width of [390, 320]) {
  test(`a session row in a task's detail at ${width} px: the title, then the git state, nothing overlapping`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 })
    await openDetail(page)
    const item = page.locator('.task-detail-modal').locator(`.todo-detail-session-item[data-session-id="${GIT_GLANCE_SESSION}"]`)
    const line = item.locator('.tdp-row-gitline .git-glance-line')
    await expect(line).toBeVisible({ timeout: 20_000 })
    // The words, or (short of room) the pill's icons: the numbers stay either way.
    await expect(line.getByTestId('git-glance-files')).toHaveText(/^\d+( uncommitted)?$/)
    await expect(line.getByTestId('git-glance-ahead')).toHaveText(/^\u21911( unpushed)?$/)

    const box = async (sel: string) => (await item.locator(sel).first().boundingBox())!
    const rowBox = (await item.boundingBox())!
    const title = await box('.tdp-row-title')
    const ago = await box('.tdp-row-end')
    const git = (await line.boundingBox())!
    // The title reads (not squeezed to nothing), and the git line starts below it.
    expect(title.width).toBeGreaterThan(80)
    expect(git.y).toBeGreaterThanOrEqual(title.y + title.height - 1)
    expect(git.y).toBeGreaterThanOrEqual(ago.y + ago.height - 1)
    // It stays inside its row, and every part of it is inside the line's own box.
    expect(git.x + git.width).toBeLessThanOrEqual(rowBox.x + rowBox.width + 1)
    const parts = await line.evaluate((el) => {
      const r = el.getBoundingClientRect()
      return [...el.children].map((c) => { const b = c.getBoundingClientRect(); return b.width === 0 || (b.right <= r.right + 1 && b.left >= r.left - 1) })
    })
    expect(parts.every(Boolean)).toBe(true)
  })
}
