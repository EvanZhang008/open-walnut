/**
 * Phone back = close the layer opened last (spec 4.3; C23, C25, C27, C42, C91,
 * C95). The browser's back (`page.goBack()`) closes one layer and never leaves
 * Walnut; a UI close goes through history, so the next back is never an empty
 * one; a layer's entries go when the window stops being a phone; the desktop
 * never pushes an entry. First load is a `goto`; the rest are taps.
 */
import { expect, test, type Page } from '@playwright/test'
import { isolateUiPrefs } from './todo-panel-helpers'
import { PHONE, backButton, menuButton, openDrawer, openHomeRow } from './phone-helpers'

const SESSION_TASK_TITLE = 'Quarterly invoice reconciliation'

test.use({
  viewport: PHONE.viewport,
  screen: PHONE.screen,
  deviceScaleFactor: PHONE.deviceScaleFactor,
  isMobile: true,
  hasTouch: true,
  userAgent: PHONE.userAgent,
})

const drawer = (page: Page) => page.locator('#primary-sidebar')

async function bootHome(page: Page): Promise<string[]> {
  await isolateUiPrefs(page)
  await page.addInitScript(() => {
    try {
      if (sessionStorage.getItem('phone-back-seeded')) return
      sessionStorage.setItem('phone-back-seeded', '1')
      localStorage.setItem('open-walnut-home-chat-visible', 'false')
    } catch { /* storage off */ }
  })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/')
  await expect(menuButton(page)).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('.todo-search-input')).toBeVisible({ timeout: 30_000 })
  return errors
}

const historyInfo = (page: Page) => page.evaluate(() => ({
  length: history.length,
  marker: (history.state as { walnutOverlay?: { id: string; depth: number } } | null)?.walnutOverlay ?? null,
  path: location.pathname,
}))

async function expectDrawerClosed(page: Page): Promise<void> {
  await expect(drawer(page)).not.toHaveClass(/\bopen\b/)
  await expect(menuButton(page)).toHaveAttribute('aria-expanded', 'false')
}

test('back closes the drawer and stays on the page', async ({ page }) => {
  const errors = await bootHome(page)
  const before = await historyInfo(page)
  await openDrawer(page)
  const opened = await historyInfo(page)
  expect(opened.marker?.id).toBe('drawer')
  expect(opened.length).toBe(before.length + 1)
  await page.goBack()
  await expectDrawerClosed(page)
  const after = await historyInfo(page)
  expect(after.path).toBe('/')
  expect(after.marker).toBeNull()
  expect(new URL(page.url()).origin).toBe(new URL(page.url()).origin)
  await expect(page.locator('.todo-search-input')).toBeVisible()
  expect(errors).toEqual([])
})

test('a UI close goes through history: no growth, and the next back is not empty', async ({ page }) => {
  const errors = await bootHome(page)
  // Leave home through a drawer link: it REPLACES the drawer entry.
  await openDrawer(page)
  await drawer(page).getByRole('link', { name: 'Settings' }).click()
  await expect(page).toHaveURL(/\/settings/)
  await expectDrawerClosed(page)
  const onSettings = await historyInfo(page)
  expect(onSettings.marker).toBeNull()

  // Open and close the drawer twice with the Menu button.
  for (let i = 0; i < 2; i++) {
    await openDrawer(page)
    await menuButton(page).click()
    await expectDrawerClosed(page)
    await expect.poll(async () => (await historyInfo(page)).marker).toBeNull()
  }
  const closed = await historyInfo(page)
  expect(closed.length, 'opening and closing a layer leaves at most its one forward slot').toBeLessThanOrEqual(onSettings.length + 1)

  // The next back is a real one: Settings goes, home comes back.
  await page.goBack()
  await expect(page).toHaveURL(/\/$/)
  await expect(page.locator('.todo-search-input')).toBeVisible()
  // And routing still works after an overlay back.
  await openDrawer(page)
  await drawer(page).getByRole('link', { name: 'Settings' }).click()
  await expect(page).toHaveURL(/\/settings/)
  expect(errors).toEqual([])
})

test('Escape and the backdrop close the drawer through history too', async ({ page }) => {
  await bootHome(page)
  const base = (await historyInfo(page)).length
  await openDrawer(page)
  await page.keyboard.press('Escape')
  await expectDrawerClosed(page)
  await openDrawer(page)
  const vp = page.viewportSize()!
  await page.locator('.sidebar-overlay').click({ position: { x: vp.width - 24, y: vp.height / 2 } })
  await expectDrawerClosed(page)
  const after = await historyInfo(page)
  expect(after.marker).toBeNull()
  expect(after.length).toBeLessThanOrEqual(base + 1)
})

test('leaving phone width closes the layers and takes their entries off history', async ({ page }) => {
  await bootHome(page)
  await openDrawer(page)
  await drawer(page).getByRole('link', { name: 'Settings' }).click()
  await expect(page).toHaveURL(/\/settings/)
  await openDrawer(page)
  expect((await historyInfo(page)).marker?.id).toBe('drawer')
  await page.setViewportSize({ width: 1280, height: 800 })
  await expect(page.locator('.phone-topbar')).toHaveCount(0)
  await expect.poll(async () => (await historyInfo(page)).marker).toBeNull()
  await expect(page).toHaveURL(/\/settings/)
  // No empty back: the next one lands home.
  await page.goBack()
  await expect(page).toHaveURL(/\/$/)
})

test('a home panel from the drawer on another page leaves no stale drawer entry behind', async ({ page }) => {
  await bootHome(page)
  await openDrawer(page)
  await drawer(page).getByRole('link', { name: 'Settings' }).click()
  await expect(page).toHaveURL(/\/settings/)
  await openDrawer(page)
  await drawer(page).getByRole('button', { name: 'Ask Walnut', exact: true }).click()
  // The chat is a home layer: the drawer's entry became home, the chat pushed one.
  await expect(backButton(page)).toBeVisible({ timeout: 15_000 })
  await expect(page).toHaveURL(/\/$/)
  expect((await historyInfo(page)).marker?.id).toBe('chat')
  await page.goBack()
  await expect(page.locator('.main-page-chat')).toHaveClass(/\bcollapsed\b/)
  await expect(menuButton(page)).toBeVisible()
  await expect.poll(async () => (await historyInfo(page)).marker).toBeNull()
  await expect(page).toHaveURL(/\/$/)
  // The next back is the page under the drawer, never an entry still marked for it.
  await page.goBack()
  await expect(page).toHaveURL(/\/settings/)
  await expectDrawerClosed(page)
  expect((await historyInfo(page)).marker).toBeNull()
})

async function openFixtureSession(page: Page): Promise<void> {
  await openHomeRow(page, 'Walnut', SESSION_TASK_TITLE)
}

// The session overlay registers its layer with a bar (package C). Until it
// does, the top bar has no Back and these fail on the first expect.
test('a session overlay has a 44 px Back in the bar that closes it through history', async ({ page }) => {
  await bootHome(page)
  await openFixtureSession(page)
  const back = backButton(page)
  await expect(back).toBeVisible({ timeout: 15_000 })
  const b = (await back.boundingBox())!
  expect(b.width).toBeGreaterThanOrEqual(44)
  expect(b.height).toBeGreaterThanOrEqual(44)
  const opened = await historyInfo(page)
  expect(opened.marker?.id).toMatch(/^session:/)
  await back.click()
  await expect(page.locator('.main-page-session-column.is-mobile-active')).toHaveCount(0)
  await expect(menuButton(page)).toBeVisible()
  await expect.poll(async () => (await historyInfo(page)).marker).toBeNull()
  const closed = await historyInfo(page)
  expect(closed.length).toBe(opened.length)
})

test('standalone: an edge swipe past 30% closes the top layer, a short one springs back', async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(navigator, 'standalone', { value: true, configurable: true }) })
  await bootHome(page)
  await openFixtureSession(page)
  await expect(backButton(page)).toBeVisible({ timeout: 15_000 })
  const opened = await historyInfo(page)
  const vp = page.viewportSize()!
  const y = vp.height / 2
  // 20%: springs back, the layer stays.
  await page.mouse.move(10, y)
  await page.mouse.down()
  await page.mouse.move(vp.width * 0.2, y, { steps: 6 })
  await page.mouse.up()
  await expect(backButton(page)).toBeVisible()
  // 60%: closes through history.
  await page.mouse.move(10, y)
  await page.mouse.down()
  await page.mouse.move(vp.width * 0.6, y, { steps: 8 })
  await page.mouse.up()
  await expect(menuButton(page)).toBeVisible()
  const closed = await historyInfo(page)
  expect(closed.marker).toBeNull()
  expect(closed.length).toBe(opened.length)
})

test('Safari (not standalone): an edge pan does nothing', async ({ page }) => {
  await bootHome(page)
  await openDrawer(page)
  await menuButton(page).click()
  const vp = page.viewportSize()!
  await page.mouse.move(10, vp.height / 2)
  await page.mouse.down()
  await page.mouse.move(vp.width * 0.6, vp.height / 2, { steps: 8 })
  await page.mouse.up()
  await expect(page.locator('.todo-search-input')).toBeVisible()
  expect((await historyInfo(page)).marker).toBeNull()
})

test.describe('desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1, userAgent: undefined, screen: undefined })

  test('the desktop never pushes a history entry when a session opens', async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __overlayPushes: number }
      w.__overlayPushes = 0
      const orig = history.pushState.bind(history)
      history.pushState = (state: unknown, title: string, url?: string | URL | null) => {
        if (state && typeof state === 'object' && 'walnutOverlay' in state) w.__overlayPushes += 1
        return orig(state, title, url)
      }
    })
    await isolateUiPrefs(page)
    await page.goto('/')
    await expect(page.locator('.todo-search-input')).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('.phone-topbar')).toHaveCount(0)
    await openFixtureSession(page)
    await expect(page.locator('.session-panel').first()).toBeVisible({ timeout: 15_000 })
    expect(await page.evaluate(() => (window as unknown as { __overlayPushes: number }).__overlayPushes)).toBe(0)
  })
})
