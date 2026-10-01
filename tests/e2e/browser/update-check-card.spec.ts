/**
 * The "Open Walnut" card in the notification panel's System zone, the System
 * rail's accent dot, and the Settings build line segment: is a newer release
 * published, and which command installs it here.
 *
 * UC-1 runs against the fixture server as it is: a source checkout, so the card
 * says so and nothing asks the registry. The others route GET/POST
 * /api/system/update* in the browser to walk the npm-install states (newer,
 * current, unreachable) and the Check now transition, because the fixture
 * server cannot be made an npm install and the registry is never dialed in tests.
 *
 * Run: PW_TEST_PORT=35993 PW_IGNORE_LOAD=1 npx playwright test update-check-card --project=chromium --workers=1
 *      PW_WEBKIT=1 PW_TEST_PORT=35993 PW_IGNORE_LOAD=1 npx playwright test update-check-card --project=webkit --workers=1
 */
import fs from 'node:fs'
import { test, expect, type Page, type Locator } from '@playwright/test'
import { isolatePrefs } from './host-problems-helpers'
import { loadApp, openBell } from './host-problems-fixture-helpers'
import { healthyGitSync, pickRail, railButton } from './banner-placement-helpers'

const SHOTS = '/tmp/walnut-update/shots'
test.describe.configure({ timeout: 90_000 })
test.beforeAll(() => { fs.mkdirSync(SHOTS, { recursive: true }) })

interface WireUpdate {
  enabled: boolean
  reason?: string
  install: { kind: string; sourceDir: string | null; packageRoot: string | null; manager: string | null; updateCommand: string | null }
  current: string
  channel: 'stable' | 'nightly'
  latest: string | null
  tags: { latest: string | null; nightly: string | null }
  available: boolean
  autoUpdate: boolean
  checkedAt: string | null
  error: string | null
  checking: boolean
  packageUrl: string
}

const NPM_INSTALL = { kind: 'npm', sourceDir: null, packageRoot: '/usr/local/lib/node_modules/open-walnut', manager: 'npm', updateCommand: 'npm install -g open-walnut@latest' }
const base = (over: Partial<WireUpdate>): WireUpdate => ({
  enabled: true, install: NPM_INSTALL, current: '0.5.1', channel: 'stable', latest: '0.5.1', tags: { latest: '0.5.1', nightly: null },
  available: false, autoUpdate: false,
  checkedAt: new Date(Date.now() - 5 * 60_000).toISOString(), error: null, checking: false,
  packageUrl: 'https://www.npmjs.com/package/open-walnut', ...over,
})
const NEWER = base({ latest: '0.9.0', tags: { latest: '0.9.0', nightly: null }, available: true })
const NEWER_AUTO = base({ latest: '0.9.0', tags: { latest: '0.9.0', nightly: null }, available: true, autoUpdate: true })
const CURRENT = base({})
const UNREACHABLE = base({ latest: null, checkedAt: null, error: 'fetch failed' })

/** Route both update routes: GET answers `get`, POST answers `post` (default: the same). */
async function routeUpdate(page: Page, get: WireUpdate, post: WireUpdate = get): Promise<{ posts: () => number }> {
  let posts = 0
  await page.route('**/api/system/update', (route) => route.fulfill({ json: get }))
  await page.route('**/api/system/update/check', (route) => { posts++; return route.fulfill({ json: post }) })
  return { posts: () => posts }
}

const card = (page: Page): Locator => page.getByTestId('nfc-update')
const systemDot = (page: Page): Locator => railButton(page, 'System').locator('.nfc-rail-dot')

async function openSystem(page: Page): Promise<Locator> {
  await openBell(page)
  await pickRail(page, 'System')
  await expect(card(page)).toBeVisible({ timeout: 20_000 })
  return card(page)
}

test.beforeEach(async ({ page }) => {
  await isolatePrefs(page)
  await healthyGitSync(page)
})

test('UC-1: the fixture server is a source checkout: the card says so, no Check now, no registry call, no rail dot', async ({ page, request }) => {
  const live = await request.get('/api/system/update')
  expect(live.ok()).toBe(true)
  expect(await live.json()).toMatchObject({ enabled: false, reason: 'source' })

  await loadApp(page)
  const c = await openSystem(page)
  await expect(c).toHaveAttribute('data-state', 'neutral')
  await expect(c.getByTestId('nfc-update-status')).toHaveText('Source checkout')
  await expect(c.getByTestId('nfc-update-note')).toContainText('Updates with git pull in ')
  await expect(c.getByTestId('nfc-update-check')).toHaveCount(0)
  await expect(c.getByTestId('nfc-update-command')).toHaveCount(0)
  await expect(systemDot(page)).toHaveCount(0)
  await c.screenshot({ path: `${SHOTS}/uc1-source-checkout.png` })
})

test('UC-2: a newer release on an npm install: the System rail wears the accent dot, the card names the version and the command, Copy copies it', async ({ page, browserName }) => {
  await routeUpdate(page, NEWER)
  await loadApp(page)
  await openBell(page)
  // The dot is on before System is looked at (the panel fetched when it opened), and it is not the amber one.
  await expect(systemDot(page)).toHaveCount(1)
  await expect(systemDot(page)).not.toHaveClass(/nfc-warn/)
  await expect(railButton(page, 'System').locator('.nfc-rail-badge')).toHaveCount(0)

  await pickRail(page, 'System')
  const c = card(page)
  await expect(c).toHaveAttribute('data-state', 'update')
  await expect(c.getByTestId('nfc-update-current')).toHaveText('0.5.1')
  await expect(c.getByTestId('nfc-update-status')).toHaveText('0.9.0 available')
  await expect(c.getByTestId('nfc-update-command')).toHaveText('npm install -g open-walnut@latest')
  await expect(c.getByTestId('nfc-update-note')).toHaveText('Restart Walnut after installing')
  await expect(c.getByTestId('nfc-update-check')).toBeVisible()
  await c.screenshot({ path: `${SHOTS}/uc2-newer-${browserName}.png` })
  await page.locator('.notification-panel').screenshot({ path: `${SHOTS}/uc2-panel-${browserName}.png` })

  // The card never grows past the panel: the command chip wraps instead of overflowing.
  const panelBox = await page.locator('.notification-panel .nfc-detail').boundingBox()
  const cardBox = await c.boundingBox()
  expect(cardBox!.x + cardBox!.width).toBeLessThanOrEqual(panelBox!.x + panelBox!.width + 1)

  if (browserName === 'chromium') {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    await c.getByTestId('nfc-update-copy').click()
    await expect(c.getByTestId('nfc-update-copy')).toHaveText('Copied')
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('npm install -g open-walnut@latest')
  }
})

test('UC-3: up to date, then Check now finds a release: the card and the rail dot change in place', async ({ page }) => {
  const r = await routeUpdate(page, CURRENT, NEWER)
  await loadApp(page)
  const c = await openSystem(page)
  await expect(c).toHaveAttribute('data-state', 'ok')
  await expect(c.getByTestId('nfc-update-status')).toHaveText('Up to date')
  await expect(c.getByTestId('nfc-update-note')).toContainText('Checked 5m ago')
  await expect(systemDot(page)).toHaveCount(0)
  await c.screenshot({ path: `${SHOTS}/uc3-up-to-date.png` })

  await c.getByTestId('nfc-update-check').click()
  await expect(c.getByTestId('nfc-update-status')).toHaveText('0.9.0 available', { timeout: 10_000 })
  await expect(c).toHaveAttribute('data-state', 'update')
  await expect(systemDot(page)).toHaveCount(1)
  expect(r.posts()).toBe(1)
  await expect(c.getByTestId('nfc-update-check')).toBeEnabled()
})

test('UC-4: the registry could not be reached: the card says so quietly (no amber), no dot, Check now stays available', async ({ page }) => {
  const r = await routeUpdate(page, UNREACHABLE, CURRENT)
  await loadApp(page)
  const c = await openSystem(page)
  await expect(c).toHaveAttribute('data-state', 'unreachable')
  await expect(c).not.toHaveClass(/warn/)
  await expect(c.getByTestId('nfc-update-status')).toHaveText('Registry unreachable')
  await expect(c.getByTestId('nfc-update-note')).toHaveText('fetch failed')
  await expect(systemDot(page)).toHaveCount(0)
  await c.screenshot({ path: `${SHOTS}/uc4-unreachable.png` })
  // The user retries and the registry answers this time.
  await c.getByTestId('nfc-update-check').click()
  await expect(c.getByTestId('nfc-update-status')).toHaveText('Up to date', { timeout: 10_000 })
  expect(r.posts()).toBe(1)
})

test('UC-5: the Settings build line carries the version segment only when a release is newer', async ({ page }) => {
  await routeUpdate(page, NEWER)
  await loadApp(page, '/settings')
  const seg = page.getByTestId('settings-build-line-update')
  await expect(seg).toHaveText('0.9.0 available', { timeout: 20_000 })
  await expect(seg).toHaveAttribute('title', 'Update with: npm install -g open-walnut@latest')
  await page.getByTestId('settings-build-line').screenshot({ path: `${SHOTS}/uc5-settings-line.png` })
})

test('UC-6: an up-to-date install adds nothing to the Settings build line', async ({ page }) => {
  await routeUpdate(page, CURRENT)
  await loadApp(page, '/settings')
  await expect(page.getByTestId('settings-build-line')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId('settings-build-line-update')).toHaveCount(0)
})

test('UC-7: with update-on-start on, the card says the next start installs it (the command stays for now)', async ({ page }) => {
  await routeUpdate(page, NEWER_AUTO)
  await loadApp(page)
  const c = await openSystem(page)
  await expect(c.getByTestId('nfc-update-note')).toHaveText('Installs itself the next time open-walnut web starts, or run the command now')
  await expect(c.getByTestId('nfc-update-command')).toHaveText('npm install -g open-walnut@latest')
  await c.screenshot({ path: `${SHOTS}/uc7-auto-on.png` })
})

test('UC-8: Settings > General shows "Install updates on start" for an npm install, saves both states, and hides it on a source checkout', async ({ page, request }) => {
  await routeUpdate(page, CURRENT)
  await loadApp(page, '/settings')
  await page.getByTestId('settings-nav-general').click()
  const row = page.getByTestId('settings-updates-auto-row')
  await expect(row).toBeVisible({ timeout: 20_000 })
  const toggle = row.getByRole('switch')
  // Default on: config.yaml has no updates block yet.
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  await row.screenshot({ path: `${SHOTS}/uc8-settings-row.png` })

  const saved = page.waitForResponse((r) => r.url().includes('/api/config') && r.request().method() !== 'GET' && r.ok())
  await toggle.click()
  await saved
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  // The server has it: the real config, read back.
  await expect.poll(async () => ((await (await request.get('/api/config')).json()) as { config: { updates?: { auto?: boolean } } }).config.updates?.auto).toBe(false)

  const savedAgain = page.waitForResponse((r) => r.url().includes('/api/config') && r.request().method() !== 'GET' && r.ok())
  await toggle.click()
  await savedAgain
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  await expect.poll(async () => ((await (await request.get('/api/config')).json()) as { config: { updates?: { auto?: boolean } } }).config.updates?.auto).toBe(true)
})

test('UC-9: the row is absent when Walnut runs from a source checkout (the fixture server as it is)', async ({ page }) => {
  await loadApp(page, '/settings')
  await page.getByTestId('settings-nav-general').click()
  await expect(page.getByTestId('settings-appearance-row')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId('settings-updates-auto-row')).toHaveCount(0)
})
