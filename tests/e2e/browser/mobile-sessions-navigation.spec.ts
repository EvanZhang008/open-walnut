import fs from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import { discoverBrowserFixture, installBrowserAudit } from './codex-test-audit'

const SCREENSHOT_DIR = '/tmp/walnut-mobile-sessions-navigation'
const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const SESSION_ID = 'pw-codex-customer-session'
const PARTIAL_SESSION_ID = 'pw-codex-customer'
let walnutHome = ''

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  ;({ walnutHome } = await discoverBrowserFixture(TEST_PORT))
  await fs.mkdir(SCREENSHOT_DIR, { recursive: true })
})

async function expectSidebarClosed(page: Page): Promise<void> {
  await expect(page.locator('.sidebar')).not.toHaveClass(/\bopen\b/)
  await expect(page.locator('.sidebar-overlay')).toHaveCount(0)
  await expect(page.locator('.main-content')).not.toHaveAttribute('inert', '')
  await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe('')
}

async function openSidebar(page: Page): Promise<void> {
  const toggle = page.getByRole('button', { name: 'Toggle sidebar' })
  await toggle.click()
  await expect(page.locator('.sidebar')).toHaveClass(/\bopen\b/)
  await expect(page.locator('.sidebar')).toHaveAttribute('aria-modal', 'true')
  await expect(page.locator('.sidebar-overlay')).toBeVisible()
  await expect(page.locator('.main-content')).toHaveAttribute('inert', '')
  await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe('hidden')
}

async function navigateToSessions(page: Page): Promise<void> {
  await openSidebar(page)
  const sidebar = page.locator('.sidebar')
  const other = sidebar.getByRole('button', { name: /Other/i })
  if (await other.getAttribute('aria-expanded') !== 'true') await other.click()
  await sidebar.getByRole('link', { name: 'Sessions' }).click()
  await expect(page).toHaveURL(/\/sessions$/)
  await expect(page.getByRole('searchbox', { name: 'Search sessions' })).toBeVisible()
  await expectSidebarClosed(page)
}

for (const viewport of [
  { width: 390, height: 844, slug: '390x844' },
  { width: 768, height: 1024, slug: '768x1024' },
]) {
  test(`mobile Sessions navigation and master/detail stay interactive at ${viewport.slug}`, async ({ page }) => {
    await page.setViewportSize(viewport)
    const audit = await installBrowserAudit(page, walnutHome)
    await page.goto('/')
    await page.waitForLoadState('networkidle')

    const toggle = page.getByRole('button', { name: 'Toggle sidebar' })
    await openSidebar(page)

    // The off-canvas navigation is a keyboard-contained modal while open.
    const notifications = page.locator('.sidebar').getByRole('button', { name: 'Notifications' })
    await notifications.focus()
    await notifications.press('Tab')
    await expect(toggle).toBeFocused()
    await toggle.press('Shift+Tab')
    await expect(notifications).toBeFocused()

    await page.keyboard.press('Escape')
    await expectSidebarClosed(page)
    await expect(toggle).toBeFocused()

    await navigateToSessions(page)

    // A non-exact query leaves a selectable result so pointer and keyboard
    // activation exercise the real mobile master/detail transition.
    const search = page.getByRole('searchbox', { name: 'Search sessions' })
    const partialResponse = page.waitForResponse((response) => {
      const url = new URL(response.url())
      return url.pathname === '/api/sessions/tree'
        && url.searchParams.get('q') === PARTIAL_SESSION_ID
    })
    await search.fill(PARTIAL_SESSION_ID)
    expect((await partialResponse).status()).toBe(200)

    const result = page.locator(`.session-tree-session[data-session-id="${SESSION_ID}"]`)
    await expect(result).toBeVisible()
    await result.click()

    const detail = page.locator('.sessions-detail-pane')
    const back = page.getByRole('button', { name: 'Back to sessions' })
    await expect(detail).toBeVisible()
    await expect(page.locator('.sessions-list-pane')).toBeHidden()
    await expect(back).toBeFocused()

    await back.press('Enter')
    await expect(page.locator('.sessions-list-pane')).toBeVisible()
    await expect(detail).toBeHidden()
    await expect(result).toBeFocused()

    await result.press('Enter')
    await expect(detail).toBeVisible()
    await expect(back).toBeFocused()
    await back.click()
    await expect(result).toBeFocused()

    // Exact ID search auto-selects the sole result and remains reversible.
    const exactResponse = page.waitForResponse((response) => {
      const url = new URL(response.url())
      return url.pathname === '/api/sessions/tree'
        && url.searchParams.get('q') === SESSION_ID
    })
    await search.fill(SESSION_ID)
    expect((await exactResponse).status()).toBe(200)
    await expect(detail).toBeVisible()
    await expect(back).toBeFocused()
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/sessions-${viewport.slug}-exact-detail.png`,
    })
    await back.press('Enter')
    await expect(result).toBeFocused()

    // Backdrop close uses the same cleanup path as Escape and route navigation.
    await openSidebar(page)
    const overlay = page.locator('.sidebar-overlay')
    const overlayBox = await overlay.boundingBox()
    expect(overlayBox).not.toBeNull()
    await overlay.click({
      position: { x: overlayBox!.width - 8, y: Math.floor(overlayBox!.height / 2) },
    })
    await expectSidebarClosed(page)
    await expect(toggle).toBeFocused()

    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await audit.assertClean()
  })
}
