import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { openHome } from './home-navigation-helpers'

/**
 * "Open in new window" on a sidebar app (web/src/components/layout/sidebar-app-menu.ts,
 * web/src/popout/PopoutAppView.tsx): a real right-click on the app's rail entry, a real click
 * on the first menu row, and the app opens alone in a popup WINDOW of its own (no Home, no
 * sidebar). Moving inside the app stays in that window and never changes its address (the Mac
 * app finds the window by it, desktop/LinkPolicy.swift), and opening the same app again brings
 * that window forward, as it was, instead of a second one.
 *
 * 2026-11-16, the user: "app right click sould pen a pannel shud open in another window, work in
 * chrome and mac app". Runs in Chromium on a Linux dev host (never the Mac).
 */

const SHOTS = '/tmp/app-popout'
test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })
test.setTimeout(120_000)

/**
 * The shared fixture's ui prefs stay as they are: every window of the context reads its boot
 * shape and drops writes. The rail is docked open, so a right-click lands on the row itself
 * and not on the collapsed rail's name pill (useRailPeek.ts) that grows over it.
 */
async function isolateContextPrefs(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => { localStorage.setItem('open-walnut-sidebar-collapsed', 'false') })
  await context.route('**/api/ui-prefs*', async (route) => {
    const body = route.request().method() === 'GET'
      ? JSON.stringify({ prefs: { 'open-walnut-home-chat-visible': { v: 'false', ts: 1 } } })
      : '{"ok":true}'
    await route.fulfill({ status: 200, contentType: 'application/json', body })
  })
}

/**
 * What a window showed while it loaded: whether the launch logo was on the page when its HTML
 * was read (the view draws after that), so a pop-out that shows the logo is seen.
 */
async function recordBootFrame(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    // The dev server serves every module on its own: more than the default 250 entries.
    performance.setResourceTimingBufferSize(10_000)
    document.addEventListener('DOMContentLoaded', () => {
      const w = window as Window & { __bootFrame?: { splash: boolean; logo: boolean } }
      w.__bootFrame = { splash: !!document.querySelector('[data-testid="boot-splash"]'), logo: !!document.querySelector('[data-testid="boot-splash"] img') }
    })
  })
}

/** The scripts a window fetched, by path (the dev server serves each module at its own path). */
const fetchedScripts = (p: Page) => p.evaluate(() => performance.getEntriesByType('resource').map((r) => new URL(r.name).pathname))

async function openAppMenu(page: Page, testId: string) {
  await page.getByTestId(testId).click({ button: 'right' })
  const menu = page.getByTestId('sidebar-app-ctx-menu')
  await expect(menu).toBeVisible()
  return menu
}

async function openInNewWindow(page: Page, testId: string): Promise<void> {
  const menu = await openAppMenu(page, testId)
  const first = menu.getByRole('menuitem').first()
  await expect(first).toHaveText('Open in new window')
  await first.click()
  await expect(menu).toHaveCount(0)
}

test('Notes opens alone in a window of its own; a second open brings that window forward, as it was', async ({ page, context, baseURL }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await isolateContextPrefs(context)
  await recordBootFrame(context)
  await openHome(page, baseURL!)
  const homeUrl = page.url()
  // The console's own load shows the launch logo (the check below sees a logo where there is one).
  expect(await page.evaluate(() => (window as Window & { __bootFrame?: { logo: boolean } }).__bootFrame?.logo)).toBe(true)

  const popupEvent = page.waitForEvent('popup')
  await openInNewWindow(page, 'sidebar-core-app-notes')
  const popup = await popupEvent
  popup.on('pageerror', (e) => errors.push(`popup: ${e.message}`))
  // The window opens blank (an empty open finds a window of that name without loading it), then
  // goes to the app's address (openPopout.ts openAppWindow).
  await popup.waitForURL((u) => u.pathname === '/popout')
  await popup.waitForLoadState('domcontentloaded')

  // A window named for the app, opened by the console, showing the app's own address.
  expect(new URL(popup.url()).pathname).toBe('/popout')
  expect(new URL(popup.url()).searchParams.get('view')).toBe('app')
  expect(new URL(popup.url()).searchParams.get('app')).toBe('core:notes')
  expect(await popup.evaluate(() => window.name)).toBe('walnut-app-core:notes')
  expect(await popup.evaluate(() => window.opener !== null)).toBe(true)

  // Only the app: the Notes page, no sidebar, no Home.
  const app = popup.getByTestId('popout-app')
  await expect(app).toHaveAttribute('data-app-key', 'core:notes', { timeout: 30_000 })
  await expect(app.locator('.notes-split-view')).toBeVisible({ timeout: 30_000 })
  await expect(popup.locator('#primary-sidebar')).toHaveCount(0)
  await expect(popup.locator('.main-page-wrapper')).toHaveCount(0)
  await expect(popup).toHaveTitle(/Notes · Walnut/)
  await popup.screenshot({ path: `${SHOTS}/notes-window.png` })

  // It drew the app without the launch logo first, and fetched Notes alone: no other built-in
  // screen (tests/web/popout-loads-one-screen.test.ts names the cause).
  expect(await popup.evaluate(() => (window as Window & { __bootFrame?: { logo: boolean } }).__bootFrame?.logo)).toBe(false)
  const scripts = await fetchedScripts(popup)
  expect(scripts).toContain('/src/pages/NotesPage.tsx')
  for (const other of ['/src/pages/DashboardPage.tsx', '/src/pages/SettingsPage.tsx', '/src/pages/RoutinesPage.tsx', '/src/apps/mail/MailApp.tsx']) {
    expect(scripts, `the Notes window fetched ${other}`).not.toContain(other)
  }

  // The console stayed where it was.
  expect(page.url()).toBe(homeUrl)
  await expect(page.locator('#primary-sidebar')).toBeVisible()

  // Again: no second window, and the open one is not reloaded (its page state survives).
  await popup.evaluate(() => { (window as Window & { __kept?: string }).__kept = 'kept' })
  const pagesBefore = context.pages().length
  let secondPopup = false
  page.once('popup', () => { secondPopup = true })
  await openInNewWindow(page, 'sidebar-core-app-notes')
  await page.waitForTimeout(1_000)
  expect(secondPopup).toBe(false)
  expect(context.pages().length).toBe(pagesBefore)
  expect(await popup.evaluate(() => (window as Window & { __kept?: string }).__kept)).toBe('kept')
  expect(new URL(popup.url()).searchParams.get('app')).toBe('core:notes')

  expect(errors).toEqual([])
  await popup.close()
})

test('moving inside the app stays in its window, and the window keeps its address', async ({ page, context, baseURL }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await isolateContextPrefs(context)
  await openHome(page, baseURL!)

  const popupEvent = page.waitForEvent('popup')
  await openInNewWindow(page, 'sidebar-core-app-calendar')
  const popup = await popupEvent
  popup.on('pageerror', (e) => errors.push(`popup: ${e.message}`))
  await popup.waitForURL((u) => u.pathname === '/popout')
  const address = popup.url()
  expect(new URL(address).searchParams.get('app')).toBe('core:calendar')

  const calendar = popup.getByTestId('popout-app').locator('.cal-page')
  await expect(calendar).toBeVisible({ timeout: 30_000 })
  await expect(popup.locator('#primary-sidebar')).toHaveCount(0)

  // A view switch is a move inside the app: drawn here, the address untouched.
  const next = (await calendar.getAttribute('data-view')) === 'month' ? 'Week' : 'Month'
  await popup.getByRole('tablist', { name: 'Calendar view' }).getByRole('tab', { name: next }).click()
  await expect(calendar).toHaveAttribute('data-view', next.toLowerCase())
  expect(popup.url()).toBe(address)
  await expect(popup.locator('#primary-sidebar')).toHaveCount(0)

  // A reload comes back to the same place in the app (the window's session storage).
  await popup.reload()
  await expect(popup.getByTestId('popout-app').locator('.cal-page')).toHaveAttribute('data-view', next.toLowerCase(), { timeout: 30_000 })
  expect(popup.url()).toBe(address)
  await popup.screenshot({ path: `${SHOTS}/calendar-window.png` })

  expect(errors).toEqual([])
  await popup.close()
})

test('every app on the rail offers it first, Home does not', async ({ page, context, baseURL }) => {
  await isolateContextPrefs(context)
  await openHome(page, baseURL!)
  const entries = page.locator('#primary-sidebar [data-app-kind]')
  const ids = await entries.evaluateAll((els) => els.map((el) => el.getAttribute('data-testid') ?? ''))
  expect(ids.length).toBeGreaterThan(2)
  for (const id of ids) {
    const menu = await openAppMenu(page, id)
    const first = menu.getByRole('menuitem').first()
    if (id === 'sidebar-core-app-home') await expect(menu.getByRole('menuitem', { name: 'Open in new window' })).toHaveCount(0)
    else await expect(first, id).toHaveText('Open in new window')
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
  }
})
