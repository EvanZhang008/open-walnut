/**
 * Full screen is full screen of the TAB, not the whole app (2026-10-27, the user:
 * "during full screen I can still go from home to org for example"). A session
 * panel in full screen fills the page area beside the sidebar; the sidebar stays
 * clickable, another page works as usual, and coming back the panel is still full
 * screen. The column-open yield still drops it (fullscreen-yields-to-column-open).
 * Run both engines: PW_WEBKIT=1 ... for the Mac app.
 */
import { test, expect } from '@playwright/test'
import { enterFilesFullscreen, expectOnTop, openSessionPanel, prepareHome } from './fullscreen-yield-helpers'

if (process.env.PW_WEBKIT) test.use({ browserName: 'webkit' })
test.beforeEach(async ({ page }) => { await prepareHome(page) })

test('the sidebar stays usable in full screen, and the tab is still full screen on the way back', async ({ page }) => {
  const panel = await openSessionPanel(page)
  await enterFilesFullscreen(page, panel)

  // The sheet sits in the page area (a 12px gutter), not over the sidebar.
  const org = page.getByTestId('sidebar-org')
  // Polled: the strip's 320ms slide-in (a transform on the column) holds the
  // sheet inside the column until it settles.
  await expect.poll(() => page.evaluate(() => {
    const side = document.querySelector('.sidebar')!.getBoundingClientRect().right
    const sheet = document.querySelector('.open-walnut-fullscreen')!.getBoundingClientRect().left
    return Math.round(sheet - side)
  })).toBe(12)
  await expectOnTop(org)

  // Home -> Org by a real sidebar click: Org is on top and scrolls.
  await org.click()
  await expect.poll(() => new URL(page.url()).pathname).toBe('/org')
  const orgPage = page.getByTestId('org-page')
  await expect(orgPage).toBeVisible()
  await expect(page.locator('.open-walnut-fullscreen-backdrop')).toHaveCount(0)
  await expect(panel).toBeHidden()
  // Hidden outright while away, descendants too (a fixed sheet is not clipped
  // by the hidden home page, and a child could set its own visibility).
  await expect(panel).toHaveClass(/open-walnut-fullscreen-away/)
  expect(await panel.evaluate((el) => Array.from(el.querySelectorAll('*')).every((c) => getComputedStyle(c).visibility === 'hidden'))).toBe(true)
  await expectOnTop(orgPage)
  await expect.poll(() => page.evaluate(() => document.body.style.overflow)).not.toBe('hidden')
  // Esc on another page is not taken by the hidden sheet.
  await page.keyboard.press('Escape')

  // Back to Home: the panel is full screen again, with its Files tree.
  await page.getByTestId('sidebar-core-app-home').click()
  await expect.poll(() => new URL(page.url()).pathname).toBe('/')
  await expect(panel).toBeVisible()
  await expect(panel).toHaveClass(/open-walnut-fullscreen/)
  await expect(panel).not.toHaveClass(/open-walnut-fullscreen-away/)
  await expect(panel.locator('.session-file-explorer')).toBeVisible()
  await expect(page.locator('.open-walnut-fullscreen-backdrop')).toHaveCount(1)
  await expectOnTop(panel)

  // A click on the backdrop strip beside the sheet still leaves full screen.
  const box = (await panel.boundingBox())!
  await page.mouse.click(box.x + box.width / 2, box.y + box.height + 6)
  await expect(panel).not.toHaveClass(/open-walnut-fullscreen/)
})
