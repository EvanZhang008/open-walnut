/**
 * Settings, Browser extension, Set up in Chrome (ExtensionInstall.tsx ChromeSetupSteps over
 * POST /api/v1/browser/extension/setup): in Chrome on the machine Walnut runs on, the button puts
 * the extension into a folder (the fixture's own data home here), shows the folder and the two
 * steps only the person may take, and that folder is an extension Chrome loads as it is, naming
 * the build Walnut ships (the one it updates itself to).
 */
import { test, expect, chromium } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { bunRuntime } from '../../helpers/bun-runtime'

test.describe.configure({ mode: 'serial' })

let build = ''

test.beforeAll(() => {
  // The zips and walnut-extension.json the server ships (dist/web/static/downloads), as web:build makes them.
  execFileSync(bunRuntime(), ['scripts/build-extension.mjs', '--out', fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-ext-build-'))], { stdio: 'pipe' })
  build = JSON.parse(fs.readFileSync('dist/web/static/downloads/walnut-extension.json', 'utf8')).build
  expect(build).toMatch(/^[0-9a-f]{12}$/)
})

test('Chrome install offers the Chrome Web Store first, and loading it from Walnut after it', async ({ page }) => {
  await page.goto('/settings#browser')
  const install = page.getByTestId('ext-install')
  const store = install.getByTestId('ext-store')
  await expect(store).toBeVisible({ timeout: 30_000 })
  await expect(store).toHaveText('Add from Chrome Web Store')
  await expect(store).toHaveAttribute('href', 'https://chromewebstore.google.com/detail/walnut/ngkloakmnoagffcjhgkjkkmdnomkphgn')
  await expect(store).toHaveAttribute('target', '_blank')
  await expect(install.getByTestId('ext-store-step')).toContainText('Add to Chrome')
  // The store comes first; the Developer mode way follows as the other way.
  const order = await install.evaluate((root) => {
    const a = root.querySelector('[data-testid="ext-store"]')!
    const b = root.querySelector('[data-testid="ext-steps-chrome-setup"]')!
    return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? 'store-first' : 'folder-first'
  })
  expect(order).toBe('store-first')
  await expect(install.getByTestId('ext-or-folder')).toContainText('Developer mode')
  // Clicking it opens the store in a tab of its own, never in place of Walnut.
  await page.context().route('https://chromewebstore.google.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>store</title>' }))
  const [tab] = await Promise.all([page.context().waitForEvent('page'), store.click()])
  await expect(tab).toHaveURL(/chromewebstore\.google\.com\/detail\/walnut\//)
  await tab.close()
  await expect(page).toHaveURL(/\/settings/)
})

test('Set up in Chrome puts the extension in a folder Chrome loads, and shows the two steps left', async ({ page }) => {
  await page.goto('/settings#browser')
  const steps = page.getByTestId('ext-steps-chrome-setup')
  await expect(steps).toBeVisible({ timeout: 30_000 })
  await expect(steps).toContainText('Developer mode')
  await expect(steps).toContainText('Load unpacked')
  await steps.getByTestId('ext-setup').click()
  const done = steps.getByTestId('ext-setup-done')
  await expect(done).toBeVisible({ timeout: 30_000 })
  const dir = (await done.locator('code').first().textContent())?.trim() ?? ''
  expect(dir).toMatch(/browser-extension[/\\]chrome$/)
  // Nothing was opened on a test server: the page gives the address to open instead.
  await expect(done).toContainText('chrome://extensions')
  await expect(steps.getByTestId('ext-setup')).toHaveText('Set up again')

  // The folder is a whole extension: Chrome loads it, and it names the build Walnut ships.
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as { version_name?: string }
  expect(manifest.version_name).toMatch(new RegExp(`build ${build}$`))
  const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-ext-setup-profile-')), {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${dir}`, `--load-extension=${dir}`],
  })
  try {
    const sw = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent('serviceworker', { timeout: 30_000 })
    const named = await sw.evaluate(() => (globalThis as unknown as { chrome: { runtime: { getManifest(): { version_name?: string } } } }).chrome.runtime.getManifest().version_name)
    expect(named).toMatch(new RegExp(`build ${build}$`))
  } finally {
    await ctx.close()
  }
})
