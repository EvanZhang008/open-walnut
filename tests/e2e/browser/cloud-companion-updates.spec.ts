/**
 * Settings → Phones & Cloud → Cloud Companion → "Updates": whether the
 * companion runs this Mac's build (docs/plan/walnut-companion-unified-replica.md,
 * stage 1). One row: a sentence for where the update stands, Retry after a
 * failure, and the switch for `cloud_bridge.auto_update`.
 *
 * GET/PUT /api/cloud/companion-build and POST .../retry are page.route
 * fixtures (what the Mac's driver would report), and so is the pairing the
 * section reads from /api/devices (a `cloud` target: the configured view).
 * Navigation is by real clicks. Runs in both engines: Chromium by default,
 * WebKit (the Mac app is a WKWebView) with `PW_WEBKIT=1 ... --project=webkit`.
 */
import { mkdirSync } from 'node:fs'
import { test, expect, type Page, type Route } from '@playwright/test'

test.setTimeout(120_000)

const SHOTS = '/tmp/companion-updates'
const MINE = '0.6.14-5408d5875'
const OLD = '0.6.13-1a2b3c4d5'

type View = Record<string, unknown>

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })

interface Door { view: View; puts: unknown[]; retries: number }

async function mockDoor(page: Page, first: View): Promise<Door> {
  const door: Door = { view: first, puts: [], retries: 0 }
  await page.route((url) => url.pathname === '/api/devices', async (route) => {
    const real = await route.fetch()
    const body = await real.json() as Record<string, unknown>
    const targets = Array.isArray(body.targets) ? body.targets as unknown[] : []
    return json(route, { ...body, targets: [...targets, { kind: 'cloud', origin: 'https://box.example' }], cloudRefused: false })
  })
  await page.route((url) => url.pathname === '/api/cloud/companion-build', async (route) => {
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON() as { auto_update?: boolean }
      door.puts.push(body)
      door.view = body.auto_update === false
        ? { ...door.view, state: 'off', autoUpdate: false, message: undefined }
        : { ...door.view, state: 'checking', autoUpdate: true }
    }
    return json(route, door.view)
  })
  await page.route((url) => url.pathname === '/api/cloud/companion-build/retry', async (route) => {
    door.retries++
    door.view = { ...door.view, state: 'updating', step: 'uploading', progress: 0, message: undefined }
    return json(route, door.view)
  })
  return door
}

async function openCloud(page: Page) {
  await page.goto('/')
  await page.waitForLoadState('domcontentloaded')
  await page.getByRole('link', { name: /settings/i }).first().click()
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible({ timeout: 30_000 })
  const nav = page.getByTestId('settings-nav-devices')
  await nav.click()
  await expect(nav).toHaveAttribute('aria-current', 'page')
  const section = page.locator('#cloud')
  await expect(section).toContainText('Cloud sync', { timeout: 30_000 })
  await expect(section).not.toHaveAttribute('data-crashed', 'true')
  return section
}

const engine = (page: Page) => page.context().browser()?.browserType().name() ?? 'browser'

async function shot(page: Page, name: string) {
  mkdirSync(SHOTS, { recursive: true })
  await page.locator('#cloud .cloud-configured').screenshot({ path: `${SHOTS}/${engine(page)}-${name}.png`, scale: 'css' })
}

const row = (page: Page) => page.getByTestId('cloud-companion-updates')

test.describe('Settings → Cloud Companion: updates follow this Mac', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 900 })
  })
  test.afterEach(async ({ page }) => {
    await page.unrouteAll({ behavior: 'ignoreErrors' })
  })

  test('current: one sentence naming the build, the switch on, no Retry', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    await mockDoor(page, { state: 'current', mine: MINE, theirs: MINE, autoUpdate: true, at: Date.now() })
    await openCloud(page)
    await expect(row(page)).toHaveAttribute('data-update-state', 'current')
    await expect(row(page)).toContainText(`Runs this Mac's build (${MINE}).`)
    await expect(page.getByRole('switch', { name: "Keep the companion on this Mac's build" })).toBeChecked()
    await expect(page.getByTestId('cloud-companion-update-retry')).toHaveCount(0)
    await shot(page, 'current')
    expect(errors).toEqual([])
  })

  test('updating: the step and the upload share', async ({ page }) => {
    await mockDoor(page, { state: 'updating', mine: MINE, theirs: OLD, autoUpdate: true, step: 'uploading', progress: 0.4, at: Date.now() })
    await openCloud(page)
    await expect(row(page)).toContainText("Updating to this Mac's build: uploading 40%.")
    await shot(page, 'uploading')
  })

  test('failed: says what failed and what it keeps running, Retry asks again', async ({ page }) => {
    const door = await mockDoor(page, {
      state: 'failed', mine: MINE, theirs: OLD, autoUpdate: true, at: Date.now(),
      message: 'in a test start, the build did not serve /api/v1/instance within 150 s',
      logTail: 'npm warn deprecated something\ninstalled',
    })
    await openCloud(page)
    await expect(row(page)).toHaveAttribute('data-update-state', 'failed')
    await expect(row(page)).toContainText(`The update to ${MINE} failed`)
    await expect(row(page)).toContainText(`It keeps running ${OLD}.`)
    await expect(row(page).getByText('Install log')).toBeVisible()
    await shot(page, 'failed')
    await page.getByTestId('cloud-companion-update-retry').click()
    await expect.poll(() => door.retries).toBe(1)
    await expect(row(page)).toHaveAttribute('data-update-state', 'updating')
    await expect(page.getByTestId('cloud-companion-update-retry')).toHaveCount(0)
  })

  test('the switch turns updates off and on, and says what off means', async ({ page }) => {
    const door = await mockDoor(page, { state: 'current', mine: MINE, theirs: MINE, autoUpdate: true, at: Date.now() })
    await openCloud(page)
    const toggle = page.getByRole('switch', { name: "Keep the companion on this Mac's build" })
    await toggle.click()
    await expect.poll(() => door.puts).toEqual([{ auto_update: false }])
    await expect(row(page)).toHaveAttribute('data-update-state', 'off')
    await expect(row(page)).toContainText('Off: the companion keeps the build it has.')
    await expect(toggle).not.toBeChecked()
    await shot(page, 'off')
    await toggle.click()
    await expect.poll(() => door.puts).toEqual([{ auto_update: false }, { auto_update: true }])
    await expect(toggle).toBeChecked()
  })

  test('an older companion: one-time update with the setup script', async ({ page }) => {
    await mockDoor(page, { state: 'unmanaged', mine: MINE, theirs: null, autoUpdate: true, at: Date.now() })
    await openCloud(page)
    await expect(row(page)).toContainText('Update it once with the cloud setup script; after that it follows this Mac.')
    await shot(page, 'unmanaged')
  })
})
