/**
 * Settings → Phones & Cloud: "Cloud companion takes over" (cloud_bridge.backup_leader).
 *
 * The row shows only when this Mac has a cloud companion (a `cloud` pairing
 * target). The switch answers the click at once; the save writes the whole
 * cloud_bridge object (a config write replaces top-level keys, so the bridge
 * url must survive); a failed save puts the switch back and says why.
 *
 * GET /api/devices is a page.route fixture with neutral names; the config
 * writes are real, on the fixture server. Navigation is by real clicks.
 * Runs in both engines: Chromium by default, WebKit (the Mac app is a
 * WKWebView) with `PW_WEBKIT=1 ... --project=webkit`.
 */
import { mkdirSync } from 'node:fs'
import { test, expect, type Page, type Route } from '@playwright/test'

test.setTimeout(120_000)

const SHOTS = '/tmp/backup-leader'
const LAN = { kind: 'lan', origin: 'http://192.0.2.10:3456', label: 'This network (Wi-Fi)' }
const CLOUD = { kind: 'cloud', origin: 'https://walnut.example.com', label: 'Cloud (anywhere)' }
const BRIDGE_URL = 'wss://walnut.example.com/bridge'

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })

async function mockDevices(page: Page, targets: unknown[]) {
  await page.route((url) => url.pathname === '/api/devices/tailscale', (route) => json(route, {
    installed: true, running: true, peers: [], install: { brew: false, job: null },
  }))
  await page.route((url) => url.pathname === '/api/devices', (route) => json(route, {
    devices: [{ name: 'Work-phone', createdAt: new Date().toISOString(), role: 'phone' }],
    cloudDevices: [],
    targets,
  }))
}

async function readConfig(page: Page): Promise<Record<string, unknown>> {
  const res = await page.request.get('/api/config')
  expect(res.ok()).toBe(true)
  const body = await res.json() as { config?: Record<string, unknown> } & Record<string, unknown>
  return (body.config ?? body) as Record<string, unknown>
}

async function writeBridge(page: Page, cloudBridge: Record<string, unknown> | undefined) {
  const res = await page.request.put('/api/config', { data: { cloud_bridge: cloudBridge ?? {} } })
  expect(res.ok()).toBe(true)
}

async function openDevices(page: Page) {
  await page.goto('/')
  await page.waitForLoadState('domcontentloaded')
  await page.getByRole('link', { name: /settings/i }).first().click()
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible({ timeout: 30_000 })
  const nav = page.getByTestId('settings-nav-devices')
  await nav.click()
  await expect(nav).toHaveAttribute('aria-current', 'page')
  const section = page.locator('#devices')
  await expect(section).not.toContainText('Loading paired phones...', { timeout: 30_000 })
  return section
}

async function shot(page: Page, name: string, region = page.locator('#devices')) {
  mkdirSync(SHOTS, { recursive: true })
  const engine = page.context().browser()?.browserType().name() ?? 'browser'
  await region.screenshot({ path: `${SHOTS}/${engine}-${name}.png`, scale: 'css' })
}

test.describe('Settings → Phones & Cloud: the cloud companion takes over', () => {
  // One fixture server, one config: these tests write it, so they take turns.
  test.describe.configure({ mode: 'serial' })
  let saved: Record<string, unknown> | undefined

  test.beforeEach(async ({ page }) => {
    saved = (await readConfig(page)).cloud_bridge as Record<string, unknown> | undefined
    await writeBridge(page, { enabled: false, url: BRIDGE_URL })
  })

  test.afterEach(async ({ page }) => {
    await page.unrouteAll({ behavior: 'ignoreErrors' })
    await writeBridge(page, saved)
  })

  test('on by default; off and back on saves the whole cloud_bridge, twice in a row', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await mockDevices(page, [LAN, CLOUD])
    const section = await openDevices(page)
    const row = section.locator('.settings-row', { has: page.locator('#devices-backup-leader') })
    await expect(row).toContainText('Cloud companion takes over')
    await expect(row).toContainText('this Mac takes back over when it wakes')
    await expect(section.getByRole('heading', { name: 'While this Mac is away' })).toBeVisible()
    const toggle = page.locator('#devices-backup-leader')
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    await row.scrollIntoViewIfNeeded()
    await shot(page, 'on', row)
    await shot(page, 'in-section')

    for (const round of [1, 2]) {
      await toggle.click()
      await expect(toggle, `round ${round}: off at once`).toHaveAttribute('aria-checked', 'false')
      await expect.poll(async () => (await readConfig(page)).cloud_bridge, { timeout: 15_000 })
        .toMatchObject({ enabled: false, url: BRIDGE_URL, backup_leader: false })
      if (round === 1) await shot(page, 'off', row)
      await toggle.click()
      await expect(toggle, `round ${round}: on at once`).toHaveAttribute('aria-checked', 'true')
      await expect.poll(async () => (await readConfig(page)).cloud_bridge, { timeout: 15_000 })
        .toMatchObject({ enabled: false, url: BRIDGE_URL, backup_leader: true })
    }

    // Kept across a reload of the page: it is the server's setting, not the page's.
    await toggle.click()
    await expect.poll(async () => ((await readConfig(page)).cloud_bridge as Record<string, unknown>)?.backup_leader).toBe(false)
    await page.reload()
    await page.waitForLoadState('domcontentloaded')
    const again = page.locator('#devices-backup-leader')
    await expect(again).toHaveAttribute('aria-checked', 'false', { timeout: 30_000 })
  })

  test('a failed save puts the switch back and says why', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await mockDevices(page, [LAN, CLOUD])
    const section = await openDevices(page)
    const toggle = page.locator('#devices-backup-leader')
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    const configUrl = (url: URL) => url.pathname === '/api/config'
    await page.route(configUrl, (route) =>
      route.request().method() === 'PUT' ? json(route, { error: 'Config is read-only right now' }, 500) : route.fallback())
    await toggle.click()
    // The row's error sits under it (role=alert).
    const alert = section.getByRole('alert').filter({ hasText: 'Config is read-only right now' })
    await expect(alert).toBeVisible({ timeout: 15_000 })
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    await shot(page, 'save-failed', section.locator('.settings-group', { has: toggle }).last())
    expect(((await readConfig(page)).cloud_bridge as Record<string, unknown>)?.backup_leader).toBeUndefined()

    // Works again once the server takes writes.
    await page.unroute(configUrl)
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await expect.poll(async () => ((await readConfig(page)).cloud_bridge as Record<string, unknown>)?.backup_leader).toBe(false)
    await expect(alert).toHaveCount(0)
  })

  test('no cloud companion: no row', async ({ page }) => {
    await mockDevices(page, [LAN])
    const section = await openDevices(page)
    await expect(section.locator('.settings-row').first()).toBeVisible()
    await expect(page.locator('#devices-backup-leader')).toHaveCount(0)
    await expect(section).not.toContainText('Cloud companion takes over')
  })
})
