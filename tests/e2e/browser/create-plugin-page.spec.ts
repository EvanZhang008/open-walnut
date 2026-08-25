import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs/promises'

const SCREENSHOT_DIR = '/tmp/walnut-create-plugin'

async function shoot(page: Page, name: string): Promise<void> {
  await fs.mkdir(SCREENSHOT_DIR, { recursive: true })
  await page.screenshot({ path: `${SCREENSHOT_DIR}/${name}.png` })
}

/**
 * /plugins/new — the plugin-author onboarding page.
 *
 * Runs on the shared plugin-free fixture, which is exactly the audience this
 * page exists for: someone with zero plugins who wants their first one. Pins:
 *
 *   1. The Plugins section's Build card reaches it through a real UI click, and
 *      a cold deep link works (the page has no sidebar row of its own).
 *   2. The one command is shown verbatim and the copy button confirms.
 *   3. With no plugins the live panel shows the waiting state; when the app
 *      catalogue answers with an app, the row (not the waiting state) renders.
 *   4. "Open Plugin Store" lands back on Settings with the Plugins section on
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
  await expect(page.getByTestId('settings-nav-plugin-store')).toBeVisible({ timeout: 30_000 })
}

test('the Plugins section links to the page, which walks the author through to the store', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-write', 'clipboard-read'])
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  await page.goto('/')
  await openSettings(page)

  // Entry: Settings → Plugins → Build card's guide link, as a user discovers it.
  await page.getByTestId('settings-nav-plugin-store').click()
  await expect(page.getByTestId('build-plugin-card')).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('build-plugin-card').scrollIntoViewIfNeeded()
  await shoot(page, 'plugins-panel-build-card')
  await page.getByTestId('build-plugin-guide').click()
  await expect(page).toHaveURL(/\/plugins\/new$/)
  await expect(page.getByTestId('create-plugin-page')).toBeVisible({ timeout: 30_000 })
  await shoot(page, 'desktop')

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

test('Build it starts an AI session that builds the plugin, and lands on home', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  // Intercepted at the edge: the UI contract under test is the REQUEST (one
  // quick-start with createCwd into the plugins folder, carrying the user's
  // words) and the landing. The server side of quick-start has its own tests,
  // and a real call would mkdir ~/walnut-plugins on the dev machine.
  let quickStartBody: Record<string, unknown> | null = null
  await page.route('**/api/sessions/quick-start', async (route) => {
    quickStartBody = route.request().postDataJSON() as Record<string, unknown>
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      // Echo the client-owned session id like the real route does, so the test
      // drives the production branch (openSessionOnHome), not the fallback.
      body: JSON.stringify({
        taskId: 'task-build-1',
        task: { id: 'task-build-1' },
        ...(typeof quickStartBody.sessionId === 'string' ? { sessionId: quickStartBody.sessionId } : {}),
      }),
    })
  })

  await page.goto('/')
  await openSettings(page)
  await page.getByTestId('settings-nav-plugin-store').click()
  await page.getByTestId('build-plugin-request').fill('a pomodoro timer in the sidebar')
  await page.getByTestId('build-plugin-start').click()

  // Home is where the session column lives; the user watches it build there.
  await expect(page).toHaveURL(/\/$/, { timeout: 30_000 })
  expect(quickStartBody).not.toBeNull()
  expect(quickStartBody!.cwd).toBe('~/walnut-plugins')
  expect(quickStartBody!.createCwd).toBe(true)
  expect(String(quickStartBody!.message)).toContain('a pomodoro timer in the sidebar')
  expect(String(quickStartBody!.message)).toContain('@open-walnut/plugin-cli new')

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
