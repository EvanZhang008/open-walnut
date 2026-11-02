/**
 * Full screen is full screen of the TAB, not the whole app (2026-10-27, the user:
 * "during full screen I can still go from home to org for example"). A session
 * panel in full screen fills the page area beside the sidebar; the sidebar stays
 * clickable, another page works as usual, and coming back the panel is still full
 * screen. The column-open yield still drops it (fullscreen-yields-to-column-open).
 * A second click on the open view's tab closes that view and stays full screen
 * (2026-10-27, the user: "it should make this file panel disappear but not exit
 * the full screen").
 * Run both engines: PW_WEBKIT=1 ... for the Mac app.
 */
import { devices, test, expect } from '@playwright/test'
import { enterFilesFullscreen, expectOnTop, openSessionPanel, prepareHome } from './fullscreen-yield-helpers'

if (process.env.PW_WEBKIT) test.use({ browserName: 'webkit', userAgent: devices['Desktop Safari'].userAgent })
test.beforeEach(async ({ page }) => { await prepareHome(page) })

test('the sidebar stays usable in full screen, and the tab is still full screen on the way back', async ({ page }) => {
  const panel = await openSessionPanel(page)
  await enterFilesFullscreen(page, panel)

  // Full screen fills the page area beside the sidebar, edge to edge: no margin,
  // no rounded sheet, no dimmed page (2026-11-02, the user: "full screen means
  // full screen, not a bigger pop-up").
  const org = page.getByTestId('sidebar-org')
  // Polled: the strip's 320ms slide-in (a transform on the column) holds the
  // sheet inside the column until it settles.
  await expect.poll(() => page.evaluate(() => {
    const side = document.querySelector('.sidebar')!.getBoundingClientRect().right
    const el = document.querySelector('.open-walnut-fullscreen')!
    const sheet = el.getBoundingClientRect()
    const style = getComputedStyle(el)
    const gaps = [sheet.left - side, window.innerWidth - sheet.right, sheet.top, window.innerHeight - sheet.bottom].map((g) => Math.round(g))
    const backdrop = document.querySelector('.open-walnut-fullscreen-backdrop')
    const dim = backdrop ? getComputedStyle(backdrop).display !== 'none' : false
    return gaps.every((g) => Math.abs(g) <= 1) && style.borderTopLeftRadius === '0px' && style.boxShadow === 'none' && !dim
      ? 'fills' : `gaps ${gaps.join(',')} radius ${style.borderTopLeftRadius} shadow ${style.boxShadow} dim ${dim}`
  })).toBe('fills')
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

  // Esc leaves full screen (there is no strip around it to click any more).
  await page.keyboard.press('Escape')
  await expect(panel).not.toHaveClass(/open-walnut-fullscreen/)
})

test('a second click on the open view\'s tab closes that view and stays full screen', async ({ page }) => {
  const panel = await openSessionPanel(page)
  const split = panel.locator('.session-panel-split')
  for (const tab of ['Files', 'Changed'] as const) {
    await panel.getByRole('button', { name: tab, exact: true }).click()
    await expect(split).toHaveClass(/is-changed-open/, { timeout: 15_000 })
    await expect(panel).toHaveClass(/open-walnut-fullscreen/)
    // The same tab again: the view goes, the chat fills the sheet, still full screen.
    await panel.getByRole('button', { name: tab, exact: true }).click()
    await expect(split).not.toHaveClass(/is-changed-open/)
    await expect(panel.locator('.session-file-explorer')).toHaveCount(0)
    await expect(panel).toHaveClass(/open-walnut-fullscreen/)
    await expect(page.locator('.open-walnut-fullscreen-backdrop')).toHaveCount(1)
    await expect(panel.locator('.chat-input-textarea').first()).toBeVisible()
  }
  // Esc still leaves full screen.
  await page.keyboard.press('Escape')
  await expect(panel).not.toHaveClass(/open-walnut-fullscreen/)
})
