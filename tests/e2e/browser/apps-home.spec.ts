import { expect, test, type Page } from '@playwright/test'
import { appsHome, serverHoldsAppPreferences, useAppsFixture } from './apps-page-fixture'

/**
 * Experiment apps_home (src/core/experimental.ts, off by default; Evan's pick A of 2026-11-23):
 * the Apps page as a home screen. Through real clicks from the sidebar it pins:
 *
 *   1. Installed opens on Recently used, which is empty until something is opened (installing
 *      is not using) and says so, with Show all apps. All holds every built-in app and every
 *      installed plugin together; the Apps page itself is no item.
 *   2. Opening an item from the page opens its screen, and it then leads Recently used. A
 *      plugin with no screen opens its page, and that counts too.
 *   3. Icons and List show the same items, each with ONE main action; a reload keeps the view,
 *      the scope and the chip.
 *   4. The chips: Plugins, Built-in, In the background narrow to their own kind.
 *   5. One menu per item, from its ⋯ (mouse and keyboard), a right-click and a long touch: Show on the
 *      sidebar takes a one-part app off the rail and back; a multi-part app's row opens its page;
 *      Details and settings opens its page and Back returns to the grid.
 *   6. Store: Make your own and Add from a git or npm link open their forms in place; Get on a
 *      plugin you can add opens its page; the store's search is its own.
 */

const fixture = useAppsFixture()

test.setTimeout(240_000)
test.describe.configure({ mode: 'serial' })
test.use({ viewport: { width: 1280, height: 900 } })

async function setAppsHome(page: Page, on: boolean): Promise<void> {
  const res = await page.request.put(`http://127.0.0.1:${fixture.port}/api/config`, { data: { experimental: { apps_home: on } } })
  expect(res.ok()).toBe(true)
}

async function openApps(page: Page): Promise<void> {
  await page.getByTestId('sidebar-core-app-apps').click()
  await expect(page).toHaveURL(/\/apps$/)
  await expect(page.getByTestId('apps-home')).toBeVisible({ timeout: 60_000 })
  // The plugins have answered: a plugin tile or row is drawn (in Recently used there may be none).
  await expect(page.getByTestId('apps-home-loading')).toHaveCount(0, { timeout: 60_000 })
}

const item = (page: Page, id: string) => page.getByTestId(`apps-home-item-${id}`)

/** All, every chip, icons: a view a test before may have left (each choice is kept, and its write may land late). */
async function showAllIcons(page: Page): Promise<void> {
  await page.getByTestId('apps-home-scope-all').click()
  await page.getByTestId('apps-home-chip-all').click()
  await page.getByTestId('apps-home-layout-icons').click()
  await expect(page.getByTestId('apps-home-grid').first()).toBeVisible()
}

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage()
  await page.goto(`http://127.0.0.1:${fixture.port}/`)
  await setAppsHome(page, true)
  await page.close()
})

test('Recently used starts empty, All holds everything installed, and opening an app puts it first', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await appsHome(page, fixture.port)
  await openApps(page)
  await expect(page.getByRole('heading', { level: 1, name: 'Apps' })).toBeVisible()
  await expect(page.getByTestId('apps-home-scope-recent')).toHaveAttribute('aria-checked', 'true')

  // Home is locked to the rail and never recorded, so a fresh page has nothing used yet.
  await expect(page.getByTestId('apps-home-recent-empty')).toBeVisible()
  await page.getByTestId('apps-home-show-all').click()
  await expect(page.getByTestId('apps-home-scope-all')).toHaveAttribute('aria-checked', 'true')

  // Built-in apps and plugins in one grid; the page itself is no item.
  for (const id of ['notes', 'tasks', 'settings', 'walnut-time', 'alpha']) await expect(item(page, id)).toBeVisible()
  await expect(item(page, 'apps')).toHaveCount(0)
  // One main action each: a plugin App opens, a plugin without a screen goes to its page.
  await expect(item(page, 'walnut-time')).toHaveAttribute('data-primary', 'open')
  await expect(item(page, 'alpha')).toHaveAttribute('data-primary', /settings|setup/)

  // Open the Time App from its tile: its screen, then back, and it leads Recently used.
  await page.getByTestId('apps-home-open-walnut-time').click()
  await expect(page).toHaveURL(/\/apps\/walnut-time~main/)
  await openApps(page)
  await page.getByTestId('apps-home-scope-recent').click()
  const recent = page.getByTestId('apps-home-grid').locator('[data-testid^="apps-home-item-"]')
  await expect(recent.first()).toHaveAttribute('data-testid', 'apps-home-item-walnut-time')

  // Notes opened from the rail counts as used too, and moves ahead of Time.
  await page.getByTestId('sidebar-core-app-notes').click()
  await expect(page).toHaveURL(/\/notes/)
  await openApps(page)
  await expect(recent.first()).toHaveAttribute('data-testid', 'apps-home-item-notes')
  await expect(recent.nth(1)).toHaveAttribute('data-testid', 'apps-home-item-walnut-time')

  // A plugin without a screen is used through its page.
  await page.getByTestId('apps-home-scope-all').click()
  await page.getByTestId('apps-home-open-alpha').click()
  await expect(page.getByTestId('plugin-detail')).toBeVisible()
  await page.getByTestId('plugin-detail-back').click()
  await page.getByTestId('apps-home-scope-recent').click()
  await expect(recent.first()).toHaveAttribute('data-testid', 'apps-home-item-alpha')
  expect(pageErrors).toEqual([])
})

test('Icons and List show the same items, chips narrow them, and a reload keeps every choice', async ({ page }) => {
  await appsHome(page, fixture.port)
  await openApps(page)
  await showAllIcons(page)
  const tiles = await page.getByTestId('apps-home-grid').first().locator('[data-testid^="apps-home-item-"]').evaluateAll((els) => els.map((el) => el.getAttribute('data-testid')))
  await page.getByTestId('apps-home-layout-list').click()
  const list = page.getByTestId('apps-home-list')
  await expect(list).toBeVisible()
  const rows = await list.locator('[data-testid^="apps-home-item-"]').evaluateAll((els) => els.map((el) => el.getAttribute('data-testid')))
  expect(rows).toEqual(tiles)
  // Each row has its one main action as a button with words.
  await expect(item(page, 'notes').getByTestId('apps-home-open-notes')).toHaveText('Open')

  await page.getByTestId('apps-home-chip-plugins').click()
  await expect(item(page, 'notes')).toHaveCount(0)
  await expect(item(page, 'walnut-time')).toBeVisible()
  await page.getByTestId('apps-home-chip-builtin').click()
  await expect(item(page, 'walnut-time')).toHaveCount(0)
  await expect(item(page, 'notes')).toBeVisible()
  await page.getByTestId('apps-home-chip-background').click()
  await expect(item(page, 'alpha')).toBeVisible()
  await expect(item(page, 'walnut-time')).toHaveCount(0)
  await expect(item(page, 'notes')).toHaveCount(0)

  await page.reload()
  await expect(page.getByTestId('apps-home')).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId('apps-home-list')).toBeVisible()
  await expect(page.getByTestId('apps-home-scope-all')).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('apps-home-chip-background')).toHaveAttribute('aria-pressed', 'true')

  // Back to the defaults for the next test.
  await page.getByTestId('apps-home-chip-all').click()
  await page.getByTestId('apps-home-layout-icons').click()
  await expect(page.getByTestId('apps-home-grid')).toBeVisible()
})

test('one menu per item: from its ⋯ and a right-click, Show on the sidebar, a multi-part app, details and back', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await appsHome(page, fixture.port)
  await openApps(page)
  await showAllIcons(page)
  const rail = page.getByTestId('sidebar-core-app-tasks')
  await expect(rail).toBeVisible()

  // Tasks has one part: its menu's Show on the sidebar takes it off the rail and puts it back.
  await item(page, 'tasks').hover()
  await page.getByTestId('apps-home-more-tasks').click()
  const menu = page.getByTestId('apps-home-menu')
  await expect(menu).toBeVisible()
  const sidebarRow = menu.getByRole('menuitemcheckbox', { name: 'Show on the sidebar' })
  await expect(sidebarRow).toHaveAttribute('aria-checked', 'true')
  await sidebarRow.click()
  await expect(rail).toHaveCount(0)
  await expect(item(page, 'tasks')).toHaveAttribute('data-on-sidebar', 'false')

  // The same menu from a right-click on the tile, and from the keyboard on its ⋯.
  await item(page, 'tasks').click({ button: 'right' })
  await expect(menu).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await page.getByTestId('apps-home-more-tasks').focus()
  await page.keyboard.press('Enter')
  await expect(menu).toBeVisible()
  await menu.getByRole('menuitemcheckbox', { name: 'Show on the sidebar' }).click()
  await expect(rail).toBeVisible()

  // Settings can never leave the rail: its row is there, ticked and disabled.
  await item(page, 'settings').click({ button: 'right' })
  await expect(menu.getByRole('menuitemcheckbox', { name: 'Show on the sidebar' })).toBeDisabled()
  await page.keyboard.press('Escape')

  // Notes has two parts (its page and the Scratchpad): its row opens its page, where each has a switch.
  await item(page, 'notes').click({ button: 'right' })
  await menu.getByRole('menuitem', { name: 'Choose sidebar entries...' }).click()
  await expect(page.getByTestId('builtin-detail')).toBeVisible()
  await expect(page.getByTestId('apps-parts-notes')).toBeVisible()
  await page.getByTestId('plugin-detail-back').click()
  await expect(page.getByTestId('apps-home-grid')).toBeVisible()

  // A touch screen has no ⋯ on a tile: a long press opens the same menu, and its click does not open the app.
  const tile = page.getByTestId('apps-home-open-walnut-time')
  const box = (await tile.boundingBox())!
  const at = { pointerType: 'touch', isPrimary: true, bubbles: true, clientX: box.x + box.width / 2, clientY: box.y + 20 }
  await tile.dispatchEvent('pointerdown', at)
  await expect(menu).toBeVisible()
  await tile.dispatchEvent('pointerup', at)
  await tile.dispatchEvent('click', at)
  await expect(page).toHaveURL(/\/apps$/)
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)

  // Details and settings of a plugin.
  await item(page, 'walnut-time').click({ button: 'right' })
  await menu.getByRole('menuitem', { name: 'Details and settings' }).click()
  await expect(page.getByTestId('plugin-detail')).toHaveAttribute('data-plugin-id', 'walnut-time')
  await page.getByTestId('plugin-detail-back').click()
  await expect(item(page, 'walnut-time')).toBeVisible()
  await serverHoldsAppPreferences(page, fixture.port)
  expect(pageErrors).toEqual([])
})

test('Store: its two ways to add, a plugin to get, and a search of its own', async ({ page }) => {
  await appsHome(page, fixture.port)
  await openApps(page)
  await page.getByTestId('apps-home-tab-store').click()
  await expect(page.getByTestId('apps-store')).toBeVisible()
  await expect(page.getByTestId('apps-search')).toHaveAttribute('placeholder', 'Search the store')

  // Omega ships with Walnut and is not installed: its Get opens its page, which says where it comes from.
  const omega = page.getByTestId('apps-store-item-omega')
  await expect(omega).toBeVisible({ timeout: 30_000 })
  await expect(omega.getByTestId('apps-store-picture')).toHaveCount(0)
  await page.getByTestId('apps-store-get-omega').click()
  await expect(page.getByTestId('plugin-detail')).toHaveAttribute('data-plugin-id', 'omega')
  await page.getByTestId('plugin-detail-back').click()
  await expect(page.getByTestId('apps-store')).toBeVisible()

  // The two ways to add open in place.
  await page.getByTestId('apps-store-make').click()
  await expect(page.getByTestId('apps-make')).toBeVisible()
  await page.getByTestId('apps-store-make').click()
  await expect(page.getByTestId('apps-make')).toHaveCount(0)
  await page.getByTestId('apps-add-from-link').click()
  await expect(page.locator('#plugin-source-url')).toBeFocused()

  // The store's search is its own: Installed keeps none.
  await page.getByTestId('apps-search').fill('omega')
  await expect(omega).toBeVisible()
  await expect(page.locator('[data-testid^="apps-store-item-"]')).toHaveCount(1)
  await page.getByTestId('apps-search').fill('no such plugin anywhere')
  await expect(page.getByTestId('apps-store-empty')).toBeVisible()
  await page.getByTestId('apps-home-tab-installed').click()
  await expect(page.getByTestId('apps-search')).toHaveValue('')
  await page.getByTestId('apps-home-tab-store').click()
  await page.getByTestId('apps-search').fill('')
  await page.getByTestId('apps-home-tab-installed').click()
})
