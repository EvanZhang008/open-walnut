import { test, expect } from './shortcut-test-fixture'
import { type Page } from '@playwright/test'
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
 *   1. The Apps page's Make your own card reaches it through a real UI click (its
 *      step-by-step guide link), and a cold deep link works (the page has no
 *      sidebar row of its own).
 *   2. The one command is shown verbatim and the copy button confirms.
 *   3. With no plugins the live panel shows the waiting state; when the app
 *      catalogue answers with an app, the row (not the waiting state) renders.
 *   4. "Open Plugin Store" lands on the Apps page (/apps), on screen: in the
 *      viewport, not merely mounted.
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

/** The Apps page, from the sidebar's Apps entry. */
async function openApps(page: Page): Promise<void> {
  await expandSidebar(page)
  await page.getByTestId('sidebar-core-app-apps').click()
  await expect(page.getByTestId('apps-page')).toBeVisible({ timeout: 30_000 })
}

/** The scaffold command the page shows: from a clone, since the CLI is not on npm yet. */
const CREATE_COMMAND = 'npm run build:plugins && node packages/plugin-cli/dist/cli.js new my-plugin --dev --no-install'

test('the Apps page links to the page, which walks the author through to the store', async ({ page, context, browserName }) => {
  // WebKit has no clipboard permissions to grant; there the copy is checked by its label only.
  const canReadClipboard = browserName === 'chromium'
  if (canReadClipboard) await context.grantPermissions(['clipboard-write', 'clipboard-read'])
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  await page.goto('/')
  await openApps(page)

  // Entry: Apps → Make your own → "Rather build it by hand?" → the guide link, as a
  // user discovers it.
  const card = page.getByTestId('apps-make-card')
  await expect(card).toBeVisible({ timeout: 30_000 })
  await card.scrollIntoViewIfNeeded()
  await page.getByTestId('apps-make-manual').locator('summary').click()
  await shoot(page, 'apps-make-card')
  await page.getByTestId('build-plugin-guide').click()
  await expect(page).toHaveURL(/\/plugins\/new$/)
  await expect(page.getByTestId('create-plugin-page')).toBeVisible({ timeout: 30_000 })
  await shoot(page, 'desktop')

  // The command is the product: verbatim, and the copy button answers.
  await expect(page.getByTestId('create-plugin-command')).toContainText(CREATE_COMMAND)
  await page.getByTestId('create-plugin-copy').click()
  await expect(page.getByTestId('create-plugin-copy')).toHaveText('Copied ✓')
  if (canReadClipboard) {
    expect(await page.evaluate(() => navigator.clipboard.readText()))
      .toBe(CREATE_COMMAND)
  }

  // Plugin-free install → the live panel waits rather than showing an empty list.
  await expect(page.getByTestId('create-plugin-waiting')).toBeVisible()

  // Step 4 loops back to the store: the Apps page, ON SCREEN (toBeVisible would pass
  // with the page scrolled out of the viewport).
  await page.getByTestId('create-plugin-open-store').click()
  await expect(page).toHaveURL(/\/apps$/)
  await expect(page.getByTestId('apps-page')).toBeInViewport({ timeout: 30_000 })
  await expect(page.locator('#plugin-store')).toBeAttached()

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
  await openApps(page)
  const card = page.getByTestId('apps-make-card')
  await card.getByTestId('build-plugin-request').fill('a pomodoro timer in the sidebar')
  await card.getByTestId('build-plugin-start').click()

  // Home is where the session column lives; the user watches it build there.
  await expect(page).toHaveURL(/\/$/, { timeout: 30_000 })
  expect(quickStartBody).not.toBeNull()
  expect(quickStartBody!.cwd).toBe('~/walnut-plugins')
  expect(quickStartBody!.createCwd).toBe(true)
  expect(String(quickStartBody!.message)).toContain('a pomodoro timer in the sidebar')
  // The plugin tools are not on npm yet: the session runs the CLI from a checkout.
  expect(String(quickStartBody!.message)).toContain('packages/plugin-cli/dist/cli.js new')
  expect(String(quickStartBody!.message)).not.toContain('npx @open-walnut')

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
