import { test, expect, type Page } from '@playwright/test'

/**
 * /plugins/new — the plugin-author onboarding page.
 *
 * Runs on the shared plugin-free fixture, which is exactly the audience this
 * page exists for: someone with zero plugins who wants their first one. Pins:
 *
 *   1. The Apps manager footer reaches it through a real UI click, and a cold
 *      deep link works (the page has no sidebar row of its own).
 *   2. The one command is shown verbatim and the copy button confirms.
 *   3. With no plugins the live panel shows the waiting state; when the app
 *      catalogue answers with an app, the row (not the waiting state) renders.
 *   4. "Open Plugin Store" lands back on Settings with the store section on
 *      screen — in the viewport, not merely mounted.
 */

test.setTimeout(90_000)

async function expandSidebar(page: Page): Promise<void> {
  const sidebar = page.locator('.sidebar')
  await expect(sidebar).toBeVisible({ timeout: 30_000 })
  if ((await page.locator('.sidebar.collapsed').count()) > 0) {
    await page.locator('.sidebar-collapse-btn').click()
    await expect(page.locator('.sidebar.collapsed')).toHaveCount(0)
  }
}

async function openSettings(page: Page): Promise<void> {
  await expandSidebar(page)
  await page.getByTestId('sidebar-core-app-settings').click()
  await expect(page.getByTestId('settings-nav-apps')).toBeVisible({ timeout: 30_000 })
}

test('the Apps manager links to the page, which walks the author through to the store', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-write', 'clipboard-read'])
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  await page.goto('/')
  await openSettings(page)

  // Entry: Settings → Apps → footer link, as a user discovers it.
  await page.getByTestId('settings-nav-apps').click()
  await page.getByRole('button', { name: 'Build a plugin app →' }).click()
  await expect(page).toHaveURL(/\/plugins\/new$/)
  await expect(page.getByTestId('create-plugin-page')).toBeVisible({ timeout: 30_000 })

  // The command is the product: verbatim, and the copy button answers.
  await expect(page.getByTestId('create-plugin-command'))
    .toContainText('npx @open-walnut/plugin-cli new my-plugin --dev')
  await page.getByTestId('create-plugin-copy').click()
  await expect(page.getByTestId('create-plugin-copy')).toHaveText('Copied ✓')
  expect(await page.evaluate(() => navigator.clipboard.readText()))
    .toBe('npx @open-walnut/plugin-cli new my-plugin --dev')

  // Plugin-free install → the live panel waits rather than showing an empty list.
  await expect(page.getByTestId('create-plugin-waiting')).toBeVisible()

  // Step 4 loops back to the store: same Settings page, store section ON SCREEN
  // (toBeVisible would pass with the section scrolled out of the viewport).
  await page.getByTestId('create-plugin-open-store').click()
  await expect(page).toHaveURL(/\/settings#plugin-store$/)
  await expect(page.locator('#plugin-store')).toBeInViewport({ timeout: 30_000 })

  expect(pageErrors).toEqual([])
})

test('when a plugin app exists the live panel lists it instead of waiting', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  // Only the webview catalogue is mocked — the page reads the same app catalog
  // as the sidebar, so one answering app must replace the waiting state.
  await page.route('**/api/apps', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify([
      { id: 'demo', pluginId: 'demo-plugin', title: 'Demo App', icon: null, url: 'http://127.0.0.1:9/never-loaded' },
    ]),
  }))

  // Cold deep link IS the thing under test here: the page has no sidebar entry,
  // so a bookmark/shared URL is a real way to arrive.
  await page.goto('/plugins/new')
  await expect(page.getByTestId('create-plugin-page')).toBeVisible({ timeout: 30_000 })

  await expect(page.getByTestId('create-plugin-app-webview:demo')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('create-plugin-waiting')).toHaveCount(0)
  const row = page.getByTestId('create-plugin-app-webview:demo')
  await expect(row).toContainText('Demo App')
  await row.getByRole('button', { name: 'Open' }).click()
  await expect(page).toHaveURL(/\/apps\/demo$/)

  expect(pageErrors).toEqual([])
})
