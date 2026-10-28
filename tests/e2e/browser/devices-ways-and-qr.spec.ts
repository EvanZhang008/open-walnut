/**
 * Settings → Phones & Cloud, the layout the user picked (2026-10-28, "A"):
 *
 *   1. One line on how the phone reaches Walnut now, then the three ways to reach
 *      it away from home side by side (cloud companion, Tailscale, browser link),
 *      the one in use framed. Each card's button opens that way's own settings
 *      right under the cards, one at a time; nothing of them shows until asked.
 *   2. Show QR and Pair new device open the code in a dialog in front of the user:
 *      a paired phone's new code asks first (it signs the phone out), the code says
 *      how to scan it, and the dialog cannot be closed while the code is being made.
 *   3. This Mac's own record and simulators stay folded in Advanced at the end.
 *
 * 2026-10-27 report: Show QR's confirm looked like it did nothing because the code
 * rendered at the very bottom of the page, and "so many ways to connect" with no
 * word on which one was active.
 *
 * Real density: three phones (one on the cloud), a signed-in browser, this Mac's
 * own cloud record and sixteen simulators. The list, the mint, Tailscale and the
 * tunnel state are page.route fixtures with neutral names; navigation is by clicks.
 *
 * Runs in both engines: Chromium by default, WebKit (the Mac app is a
 * WKWebView) with `PW_WEBKIT=1 ... --project=webkit`.
 */
import { mkdirSync } from 'node:fs'
import { test, expect, type Page, type Route } from '@playwright/test'

test.setTimeout(120_000)

const SHOTS = process.env.PW_SHOTS_DIR ?? '/tmp/devices-ways-and-qr'
const LAN = { kind: 'lan', origin: 'http://192.0.2.10:3456', label: 'This network (Wi-Fi)' }
const CLOUD = { kind: 'cloud', origin: 'https://walnut.example.com', label: 'Cloud (anywhere)' }

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString()
const day = (n: number) => ago(n * 1440)
const SIMULATORS = Array.from({ length: 16 }, (_, i) => ({ name: `sim-${i + 1}`, createdAt: day(40 + i), role: 'simulator' }))
const DEVICES = [
  { name: 'desk-phone', createdAt: day(100), lastUsedAt: day(60), role: 'phone' },
  { name: 'spare-phone', createdAt: day(50), lastUsedAt: day(50), role: 'phone', info: { model: 'iPhone18,2', os: 'iOS 26.0.1', appVersion: '1.0.0 (57)' } },
  { name: 'browser-1a2b3c', createdAt: day(14), lastUsedAt: day(2), role: 'browser' },
  ...SIMULATORS,
]
const CLOUD_DEVICES = [
  { name: 'pocket-phone', createdAt: ago(60), lastUsedAt: ago(2), role: 'phone' },
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
  await page.route((url) => url.pathname === '/api/expose', (route) => json(route, {
    status: { enabled: true, provider: 'command', providerTitle: 'Example tunnel', state: 'connected', since: Date.now(), url: 'https://walnut.tunnel.example' },
    providers: [{ id: 'command', title: 'Example tunnel', owner: 'walnut', options: [] }],
    places: [],
    settings: { enabled: true, provider: 'command', options: {} },
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
    return json(route, { devices: DEVICES, cloudDevices: CLOUD_DEVICES, targets: [LAN, CLOUD], tailscale: { installed: false, running: false } })
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

const dialog = (page: Page) => page.locator('.devices-qr-dialog')

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
})

test('the pane says how the phone reaches Walnut now, then the three ways side by side', async ({ page }) => {
  await mockDevices(page)
  const section = await openDevices(page)

  const now = section.getByTestId('devices-now')
  await expect(now).toContainText('pocket-phone reaches Walnut through the cloud companion')
  await expect(now).toContainText('Last seen 2 min ago. Works anywhere, even while this Mac sleeps.')

  const cards = section.locator('.devices-way')
  await expect(cards).toHaveCount(3)
  await expect(cards.locator('.devices-way-title')).toHaveText(['Cloud companion', 'Tailscale', 'Browser link'])
  await expect(section.getByTestId('devices-way-cloud')).toHaveAttribute('data-in-use', 'true')
  await expect(section.getByTestId('devices-way-cloud')).toContainText('On at walnut.example.com')
  await expect(section.getByTestId('devices-way-tailscale')).toContainText('Not installed on this Mac.')
  await expect(section.getByTestId('devices-way-browser')).toContainText('Connected through Example tunnel.')
  // Side by side at desktop width: one row, three columns.
  const tops = await cards.evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)))
  expect(new Set(tops).size).toBe(1)
  await expect(section).toContainText('At home on the same Wi-Fi as this Mac, the app connects directly.')

  // Nothing of the ways' own settings shows until a card asks for it.
  await expect(section.getByTestId('remote-access-card')).toHaveCount(0)
  await expect(section.getByTestId('browser-access')).toHaveCount(0)
  await expect(section.getByRole('heading', { name: 'While this Mac is away' })).toHaveCount(0)

  // Phones: only phones, tagged by how they are paired; the rest folded at the end.
  const phones = section.getByTestId('devices-phones-group')
  await expect(phones.locator('.devices-row')).toHaveCount(3)
  await expect(phones.locator('.devices-row[data-device-name="pocket-phone"] .settings-tag')).toHaveText('Cloud companion')
  await expect(phones.locator('.devices-row[data-device-name="desk-phone"] .settings-tag')).toHaveText('Direct')
  const others = section.getByTestId('devices-others')
  await expect(others).toContainText('This Mac and test devices')
  await expect(others).toContainText('17')
  await expect(others).toHaveAttribute('data-open', 'false')
  // Reading order: now, ways, phones, browsers, add a phone, advanced.
  const order = await section.evaluate((el) => ['devices-now', 'devices-ways', 'devices-phones-group', 'devices-browsers-group', 'devices-add-group', 'devices-others-group']
    .map((id) => el.querySelector(`[data-testid="${id}"]`)?.getBoundingClientRect().top ?? -1))
  expect(order.every((t) => t >= 0)).toBe(true)
  expect([...order].sort((a, b) => a - b)).toEqual(order)
  await shot(page, 'pane')
})

test('each card opens its own settings under the cards, one at a time', async ({ page }) => {
  await mockDevices(page)
  const section = await openDevices(page)

  const tsBtn = section.getByTestId('devices-way-tailscale-action')
  await expect(tsBtn).toHaveText('Set up Tailscale')
  await tsBtn.click()
  await expect(tsBtn).toHaveText('Close')
  await expect(tsBtn).toHaveAttribute('aria-expanded', 'true')
  const tsPanel = section.getByTestId('devices-way-panel-tailscale')
  await expect(tsPanel.getByRole('heading', { name: 'Tailscale', exact: true })).toBeVisible()
  await expect(tsPanel.locator('.remote-access-step[data-step="mac"]')).toContainText('Get Tailscale from the App Store')
  // The panel sits right under the cards, above the phones.
  const panelTop = (await tsPanel.boundingBox())!.y
  expect(panelTop).toBeGreaterThan((await section.getByTestId('devices-way-tailscale').boundingBox())!.y)
  expect(panelTop).toBeLessThan((await section.getByTestId('devices-phones-group').boundingBox())!.y)
  await shot(page, 'tailscale-open')

  // Another card: the first closes.
  await section.getByTestId('devices-way-browser-action').click()
  await expect(section.getByTestId('devices-way-panel-tailscale')).toHaveCount(0)
  const browserPanel = section.getByTestId('devices-way-panel-browser')
  await expect(browserPanel.getByRole('heading', { name: 'Browser link', exact: true })).toBeVisible()
  await expect(browserPanel.getByTestId('browser-access')).toBeVisible()

  // Cloud companion's own settings: the companion is on, so its groups show.
  await section.getByTestId('devices-way-cloud-action').click()
  const cloudPanel = section.getByTestId('devices-way-panel-cloud')
  await expect(cloudPanel.getByRole('heading', { name: 'While this Mac is away' })).toBeVisible()
  await expect(cloudPanel.getByTestId('devices-cloud-open')).toHaveAttribute('href', '#cloud')

  await section.getByTestId('devices-way-cloud-action').click()
  await expect(section.locator('.devices-way-panel')).toHaveCount(0)
})

test('Show QR asks in a dialog, then shows the code with how to scan it', async ({ page }) => {
  const ctl = await mockDevices(page)
  const section = await openDevices(page)
  const pocket = section.locator('.devices-row[data-device-name="pocket-phone"]')
  const showQr = pocket.getByTestId('devices-show-qr')

  // Ask: what a new code does; Cancel mints nothing and gives focus back.
  await showQr.click()
  await expect(dialog(page)).toBeVisible()
  await expect(dialog(page)).toBeInViewport()
  await expect(dialog(page).getByTestId('devices-show-qr-warning')).toContainText('This replaces the code pocket-phone signed in with')
  await expect(dialog(page)).toContainText('Uses the cloud companion, so it works from anywhere.')
  await expect(dialog(page).getByTestId('devices-show-qr-confirm')).toBeFocused()
  await shot(page, 'qr-ask', dialog(page))
  await dialog(page).getByTestId('devices-show-qr-cancel').click()
  await expect(dialog(page)).toHaveCount(0)
  await expect(showQr).toBeFocused()
  expect(ctl.mints).toEqual([])

  // Esc closes the ask too.
  await showQr.click()
  await page.keyboard.press('Escape')
  await expect(dialog(page)).toHaveCount(0)

  // Confirm on a slow cloud mint: the dialog says it is working and does not close.
  let release!: () => void
  ctl.hold = new Promise<void>((r) => { release = r })
  await showQr.click()
  await dialog(page).getByTestId('devices-show-qr-confirm').click()
  await expect(dialog(page).getByTestId('devices-show-qr-confirm')).toHaveText('Making QR...')
  await page.keyboard.press('Escape')
  await page.mouse.click(5, 5)
  await expect(dialog(page)).toBeVisible()
  release()

  const qr = dialog(page).locator('img')
  await expect(qr).toBeVisible({ timeout: 30_000 })
  await expect(qr).toBeInViewport()
  expect(await qr.getAttribute('src')).toMatch(/^data:image\/png;base64,/)
  expect(ctl.mints[0]).toMatchObject({ name: 'pocket-phone', target: 'cloud', replace: true })
  const steps = dialog(page).locator('.devices-qr-dialog-steps li')
  await expect(steps).toHaveText([
    'Open the Walnut app on the phone.',
    'If it is still signed in, tap Settings, then Disconnect.',
    'Tap Scan QR from your console and point the camera at this code.',
  ])
  await expect(dialog(page)).toContainText('Points at walnut.example.com')
  await expect(dialog(page).locator('.devices-token')).not.toBeVisible()
  await dialog(page).getByText("Can't scan it?").click()
  await expect(dialog(page).locator('.devices-token')).toHaveText('tok-1')
  await shot(page, 'qr-shown', dialog(page))
  await dialog(page).getByTestId('devices-qr-done').click()
  await expect(dialog(page)).toHaveCount(0)
  await expect(showQr).toBeFocused()
})

test('Pair new device opens the code straight away; a failed code offers Try again', async ({ page }) => {
  const ctl = await mockDevices(page)
  const section = await openDevices(page)

  await section.locator('#devices-new-name').fill('travel phone')
  await section.getByRole('button', { name: /Pair new device/i }).click()
  await expect(dialog(page).locator('img')).toBeVisible({ timeout: 30_000 })
  await expect(dialog(page)).toHaveAttribute('data-qr-for', 'travel-phone')
  await expect(dialog(page).getByTestId('devices-show-qr-warning')).toHaveCount(0)
  await expect(dialog(page).locator('.devices-qr-dialog-steps li')).toHaveCount(2)
  expect(ctl.mints[0]).toMatchObject({ name: 'travel-phone' })
  expect(ctl.mints[0].replace).toBeUndefined()
  await dialog(page).getByTestId('devices-qr-done').click()
  await expect(section.locator('#devices-new-name')).toHaveValue('')

  // A refusal stays in the dialog with the reason, and Try again works.
  const pocket = section.locator('.devices-row[data-device-name="pocket-phone"]')
  ctl.failWith = 502
  await pocket.getByTestId('devices-show-qr').click()
  await dialog(page).getByTestId('devices-show-qr-confirm').click()
  await expect(dialog(page).getByRole('alert')).toContainText("Couldn't make the code", { timeout: 30_000 })
  await expect(dialog(page).locator('img')).toHaveCount(0)
  await expect(dialog(page).getByTestId('devices-show-qr-confirm')).toHaveText('Try again')
  await dialog(page).getByTestId('devices-show-qr-confirm').click()
  await expect(dialog(page).locator('img')).toBeVisible({ timeout: 30_000 })
  expect(ctl.mints).toHaveLength(3)
})

test('at phone width the cards stack and the dialog fits the screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await mockDevices(page)
  // The phone layout: Menu, Settings, then the pane as its own layer.
  await page.goto('/')
  await page.getByRole('button', { name: 'Menu', exact: true }).click({ timeout: 60_000 })
  await page.locator('#primary-sidebar').getByRole('link', { name: /settings/i }).first().click()
  await expect(page.locator('.settings-layout[data-phone-settings="list"]')).toBeVisible({ timeout: 60_000 })
  await page.getByTestId('settings-nav-devices').click()
  const section = page.locator('#devices')
  await expect(section).not.toContainText('Loading paired phones...', { timeout: 30_000 })
  const cards = section.locator('.devices-way')
  await expect(cards).toHaveCount(3)
  const boxes = await cards.evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => ({ top: r.top, right: r.right })))
  expect(boxes[1].top).toBeGreaterThan(boxes[0].top)
  expect(boxes[2].top).toBeGreaterThan(boxes[1].top)
  for (const b of boxes) expect(b.right).toBeLessThanOrEqual(390)
  await section.locator('.devices-row[data-device-name="pocket-phone"]').getByTestId('devices-show-qr').click()
  await dialog(page).getByTestId('devices-show-qr-confirm').click()
  await expect(dialog(page).locator('img')).toBeVisible({ timeout: 30_000 })
  const box = (await dialog(page).boundingBox())!
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(390)
  await shot(page, 'phone-width', page.locator('body'))
})

test('Find a setting reaches a row inside a folded way: the way opens and the row is shown', async ({ page }) => {
  await mockDevices(page)
  await openDevices(page)
  await expect(page.getByTestId('devices-way-cloud-action')).toHaveAttribute('aria-expanded', 'false')
  await page.getByTestId('settings-filter').fill('take over')
  await page.locator('.settings-nav').getByText('Cloud companion takes over').first().click()
  await expect(page.getByTestId('devices-way-cloud-action')).toHaveAttribute('aria-expanded', 'true')
  await expect(page.locator('#devices-backup-leader')).toBeInViewport({ timeout: 10_000 })
})
