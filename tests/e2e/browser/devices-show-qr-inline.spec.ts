/**
 * Settings → Phones & Cloud: Show QR on a paired phone opens its code right
 * under that phone, in view, with how to scan it.
 *
 * 2026-10-27 report: Show QR flipped to "Confirm new QR" for 3s with no word on
 * why, Confirm then looked like it did nothing, and the code was rendered at the
 * very bottom of the page under "Pair a phone". The list also opened with
 * "Other entries 17" (this Mac's own cloud link and simulators) inside "Paired
 * phones", as if those were phones.
 *
 * Real density: three phones (one on the cloud), a signed-in browser, this Mac's
 * own cloud record and sixteen simulators. The list and the mint are page.route
 * fixtures with neutral names; navigation is by real clicks.
 *
 * Runs in both engines: Chromium by default, WebKit (the Mac app is a
 * WKWebView) with `PW_WEBKIT=1 ... --project=webkit`.
 */
import { mkdirSync } from 'node:fs'
import { test, expect, type Page, type Route } from '@playwright/test'

test.setTimeout(120_000)

const SHOTS = process.env.PW_SHOTS_DIR ?? '/tmp/devices-show-qr-inline'
const LAN = { kind: 'lan', origin: 'http://192.0.2.10:3456', label: 'This network (Wi-Fi)' }
const CLOUD = { kind: 'cloud', origin: 'https://walnut.example.com', label: 'Cloud (anywhere)' }

const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString()
const SIMULATORS = Array.from({ length: 16 }, (_, i) => ({ name: `sim-${i + 1}`, createdAt: day(40 + i), role: 'simulator' }))
const DEVICES = [
  { name: 'desk-phone', createdAt: day(100), lastUsedAt: day(60), role: 'phone' },
  { name: 'spare-phone', createdAt: day(50), lastUsedAt: day(50), role: 'phone', info: { model: 'iPhone18,2', os: 'iOS 26.0.1', appVersion: '1.0.0 (57)' } },
  { name: 'browser-1', createdAt: day(14), lastUsedAt: day(2), role: 'browser' },
  ...SIMULATORS,
]
const CLOUD_DEVICES = [
  { name: 'pocket-phone', createdAt: day(0), role: 'phone' },
  { name: 'this-mac-sync', createdAt: day(90), role: 'self' },
]

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })

interface MintControl {
  mints: Array<Record<string, unknown>>
  /** When set, the next mint waits for this promise (a slow cloud round trip). */
  hold?: Promise<void>
  /** When set, the next mint answers this status with an error body. */
  failWith?: number
}

async function mockDevices(page: Page): Promise<MintControl> {
  const ctl: MintControl = { mints: [] }
  await page.route((url) => url.pathname === '/api/devices/tailscale', (route) => json(route, {
    installed: false, running: false, peers: [], install: { brew: false, job: null },
  }))
  await page.route((url) => url.pathname === '/api/devices', async (route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as Record<string, unknown>
      ctl.mints.push(body)
      if (ctl.hold) { const h = ctl.hold; ctl.hold = undefined; await h }
      if (ctl.failWith) {
        const status = ctl.failWith
        ctl.failWith = undefined
        return json(route, { error: 'The cloud companion did not answer.' }, status)
      }
      const server = body.target === 'cloud' ? CLOUD.origin : LAN.origin
      const token = `tok-${ctl.mints.length}`
      return json(route, {
        name: body.name, token, target: body.target, server,
        pairingURI: `wn://pair?token=${token}&server=${encodeURIComponent(server)}`,
      })
    }
    return json(route, { devices: DEVICES, cloudDevices: CLOUD_DEVICES, targets: [LAN, CLOUD] })
  })
  return ctl
}

async function openDevices(page: Page) {
  await page.goto('/')
  await page.waitForLoadState('domcontentloaded')
  await page.getByRole('link', { name: /settings/i }).first().click()
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('settings-nav-devices').click()
  const section = page.locator('#devices')
  await expect(section).toBeVisible()
  await expect(section).not.toContainText('Loading paired phones...', { timeout: 30_000 })
  return section
}

async function shot(page: Page, name: string, region = page.locator('#devices')) {
  mkdirSync(SHOTS, { recursive: true })
  const engine = page.context().browser()?.browserType().name() ?? 'browser'
  await region.screenshot({ path: `${SHOTS}/${engine}-${name}.png`, scale: 'css' })
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
})

test('Paired phones lists only phones; this Mac and simulators fold away at the end', async ({ page }) => {
  await mockDevices(page)
  const section = await openDevices(page)
  const phones = section.getByTestId('devices-phones-group')
  await expect(phones.locator('.devices-row')).toHaveCount(3)
  await expect(phones.getByTestId('devices-others')).toHaveCount(0)
  await expect(phones).not.toContainText('simulator')

  const others = section.getByTestId('devices-others')
  await expect(others).toContainText('This Mac and test devices')
  await expect(others).toContainText('17')
  await expect(others).toHaveAttribute('data-open', 'false')
  await expect(section.locator('.devices-row[data-device-role="simulator"]:visible')).toHaveCount(0)
  // The fold is the section's last group, after "Pair a phone".
  const order = await section.evaluate((el) => {
    const pair = Array.from(el.querySelectorAll('.settings-group-heading, h3, h4')).find((h) => h.textContent?.trim().startsWith('Pair a phone'))
    const fold = el.querySelector('[data-testid="devices-others"]')
    return pair && fold ? pair.compareDocumentPosition(fold) & Node.DOCUMENT_POSITION_FOLLOWING : -1
  })
  expect(order).toBeTruthy()
  await others.click()
  await expect(section.locator('.devices-row[data-device-role="simulator"]:visible')).toHaveCount(16)
  await expect(section.locator('.devices-row[data-device-role="self"]')).toBeVisible()
  await others.click()
  await shot(page, 'list')
})

test('Show QR asks on the row, then opens the code under that row, in view', async ({ page }) => {
  const ctl = await mockDevices(page)
  const section = await openDevices(page)
  const pocket = section.locator('.devices-row[data-device-name="pocket-phone"]')

  // Ask: the row says what a new code does; nothing is minted yet, and the ask does not time out.
  await pocket.getByTestId('devices-show-qr').click()
  await expect(pocket.getByRole('alert')).toContainText('A new code replaces the one pocket-phone signed in with')
  // Focus follows the ask (keyboard users): onto the confirm, and back on Cancel.
  await expect(pocket.getByTestId('devices-show-qr-confirm')).toBeFocused()
  await pocket.getByTestId('devices-show-qr-cancel').click()
  await expect(pocket.getByTestId('devices-show-qr')).toBeFocused()
  await expect(pocket.getByRole('alert')).toHaveCount(0)
  await pocket.getByTestId('devices-show-qr').click()
  await page.waitForTimeout(3_500)
  await expect(pocket.getByTestId('devices-show-qr-confirm')).toBeVisible()
  expect(ctl.mints).toEqual([])
  await shot(page, 'ask', section.getByTestId('devices-phones-group'))

  // Confirm on a slow cloud mint: the row says it is working.
  let release!: () => void
  ctl.hold = new Promise<void>((r) => { release = r })
  await pocket.getByTestId('devices-show-qr-confirm').click()
  await expect(pocket.getByTestId('devices-show-qr')).toHaveText('Making QR...')
  release()

  const qr = section.locator('.devices-row[data-device-name="pocket-phone"] + .devices-qr-block img')
  await expect(qr).toBeVisible({ timeout: 30_000 })
  await expect(qr).toBeInViewport()
  expect(ctl.mints[0]).toMatchObject({ name: 'pocket-phone', target: 'cloud', replace: true })
  await expect(section.locator('.devices-qr-block')).toHaveCount(1)
  // Rows of the phones group, never a box inside the box (globals.css loads after the addons sheet).
  expect(await section.locator('.devices-qr-block').evaluate((el) => getComputedStyle(el).display)).toBe('contents')
  await expect(section.locator('.devices-qr-hint')).toContainText('Open the Walnut app on the phone, tap Scan QR from your console')
  await expect(section.locator('.devices-qr-hint')).toContainText('Points at walnut.example.com')
  await shot(page, 'qr-under-row', section.getByTestId('devices-phones-group'))

  // Another row's Show QR: one code at a time, now under that row.
  const spare = section.locator('.devices-row[data-device-name="spare-phone"]')
  await spare.getByTestId('devices-show-qr').click()
  await spare.getByTestId('devices-show-qr-confirm').click()
  await expect(section.locator('.devices-row[data-device-name="spare-phone"] + .devices-qr-block img')).toBeVisible({ timeout: 30_000 })
  await expect(section.locator('.devices-qr-block')).toHaveCount(1)
  expect(ctl.mints[1]).toMatchObject({ name: 'spare-phone', target: 'lan', replace: true })

  // Pair a new device while a row's code is open: the row's code closes at once and
  // never shows at the bottom as if it were the new device's (slow mint held open).
  let releaseNew!: () => void
  ctl.hold = new Promise<void>((r) => { releaseNew = r })
  await section.locator('#devices-new-name').fill('travel phone')
  await section.getByRole('button', { name: /Pair new device/i }).click()
  await expect(section.locator('.devices-qr-block')).toHaveCount(0)
  releaseNew()
  await expect(section.locator('.devices-qr-block img')).toBeVisible({ timeout: 30_000 })
  await expect(section.locator('.devices-qr-block')).toHaveAttribute('data-qr-for', 'travel-phone')
  await expect(section.locator('.devices-row + .devices-qr-block')).toHaveCount(0)
  await expect(section.locator('.devices-qr-hint')).not.toContainText('Disconnect')
})

test('a failed Show QR says so on the row and shows no code', async ({ page }) => {
  const ctl = await mockDevices(page)
  const section = await openDevices(page)
  const pocket = section.locator('.devices-row[data-device-name="pocket-phone"]')
  ctl.failWith = 502
  await pocket.getByTestId('devices-show-qr').click()
  await pocket.getByTestId('devices-show-qr-confirm').click()
  await expect(section.locator('.devices-row[data-device-name="pocket-phone"] + .settings-row-error')).toContainText("Couldn't re-pair", { timeout: 30_000 })
  await expect(section.locator('.devices-qr-block')).toHaveCount(0)
  await expect(pocket.getByTestId('devices-show-qr')).toHaveText('Show QR')
  // Retry works from the same row.
  await pocket.getByTestId('devices-show-qr').click()
  await pocket.getByTestId('devices-show-qr-confirm').click()
  await expect(section.locator('.devices-row[data-device-name="pocket-phone"] + .devices-qr-block img')).toBeVisible({ timeout: 30_000 })
})

test('removing a phone while its new code shows closes the code', async ({ page }) => {
  const ctl = await mockDevices(page)
  const deletes: string[] = []
  await page.route((url) => url.pathname.startsWith('/api/devices/') && url.pathname !== '/api/devices/tailscale', (route) => {
    deletes.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`)
    return json(route, { ok: true })
  })
  const section = await openDevices(page)
  const spare = section.locator('.devices-row[data-device-name="spare-phone"]')
  await spare.getByTestId('devices-show-qr').click()
  await spare.getByTestId('devices-show-qr-confirm').click()
  await expect(section.locator('.devices-row[data-device-name="spare-phone"] + .devices-qr-block img')).toBeVisible({ timeout: 30_000 })
  expect(ctl.mints).toHaveLength(1)
  await spare.getByTestId('devices-remove').click()
  await spare.getByTestId('devices-remove').click()
  await expect.poll(() => deletes).toEqual(['DELETE /api/devices/spare-phone'])
  await expect(section.locator('.devices-qr-block')).toHaveCount(0)
})
