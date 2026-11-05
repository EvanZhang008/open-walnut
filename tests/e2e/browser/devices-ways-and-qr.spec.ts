/**
 * Settings → Phones & Cloud as four tabs, the layout the user picked (2026-11-03,
 * design 1 of 10: "A also for ech option show a descripotion of what itbis in tbhe
 * top"):
 *
 *   1. Cloud companion, Tailscale, the browser link and Devices are tabs; Phones &
 *      Cloud opens the tab the phone uses. Each tab leads with what it is, when to
 *      use it and its state now; the tab in use also says how the phone reaches
 *      Walnut. Paired phones and browsers live only on Devices. The sidebar lists
 *      Phones & Cloud alone.
 *   2. Show QR and Pair new device open the code in a dialog in front of the user:
 *      a paired phone's new code asks first (it signs the phone out), the code says
 *      how to scan it, and the dialog cannot be closed while the code is being made.
 *   3. This Mac's own record and simulators stay folded in Advanced at the end.
 *
 * 2026-11-03 report: "there are 3 connection model ... it is 3 different tab and
 * have content below, I am confused why u keep mixing them".
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
import { isolateUiPrefs } from './todo-panel-helpers'

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

async function mockDevices(page: Page, opts: { cloud?: boolean } = {}): Promise<MintControl> {
  const cloud = opts.cloud ?? true
  const ctl: MintControl = { mints: [] }
  await page.route((url) => url.pathname === '/api/devices/tailscale', (route) => json(route, {
    installed: false, running: false, peers: [], install: { brew: false, job: null },
  }))
  await page.route((url) => url.pathname === '/api/expose', (route) => json(route, {
    status: { enabled: true, provider: 'command', providerTitle: 'Example tunnel', state: 'connected', since: Date.now(), url: 'https://walnut.tunnel.example' },
    providers: [{ id: 'command', title: 'Example tunnel', owner: 'core', options: [] }],
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
    return json(route, cloud
      ? { devices: DEVICES, cloudDevices: CLOUD_DEVICES, targets: [LAN, CLOUD], tailscale: { installed: false, running: false } }
      : { devices: DEVICES, cloudDevices: [], targets: [LAN], tailscale: { installed: false, running: false } })
  })
  return ctl
}

async function openSettings(page: Page) {
  await page.goto('/')
  await page.waitForLoadState('domcontentloaded')
  await page.getByRole('link', { name: /settings/i }).first().click()
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible({ timeout: 30_000 })
}

/** Phones & Cloud from the sidebar: it opens the tab in use. */
async function openPhonesCloud(page: Page, landsOn = 'cloud') {
  await openSettings(page)
  await page.getByTestId('settings-nav-devices').click()
  await expect(page).toHaveURL(new RegExp(`#${landsOn}$`), { timeout: 30_000 })
  const section = page.locator(`#${landsOn}`)
  await expect(section).toBeVisible()
  return section
}

/** The Devices tab: paired phones and browsers, Add a phone. */
async function openDevices(page: Page) {
  await openPhonesCloud(page)
  await page.getByTestId('pc-tab-devices-phones').click()
  const section = page.locator('#devices-phones')
  await expect(section).toBeVisible({ timeout: 30_000 })
  await expect(section).not.toContainText('Loading paired phones...', { timeout: 30_000 })
  return section
}

async function shot(page: Page, name: string, region = page.locator('.settings-pane')) {
  mkdirSync(SHOTS, { recursive: true })
  const engine = page.context().browser()?.browserType().name() ?? 'browser'
  await region.screenshot({ path: `${SHOTS}/${engine}-${name}.png`, scale: 'css' })
}

const dialog = (page: Page) => page.locator('.devices-qr-dialog')
const tabs = (page: Page) => page.getByTestId('pc-tabs').locator('.pc-tab')

test.beforeEach(async ({ page }) => {
  // The shared fixture's ui-prefs hold whatever another spec left there: one that opened
  // the chat spot left it open, and a phone opens on that chat (a layer, Back where Menu
  // was), so the phone tests below found no Menu for 60 s (2026-11-04: CI shard 2, both
  // attempts of both). Each test boots on the fixture's own prefs and keeps its writes.
  await isolateUiPrefs(page)
  await page.setViewportSize({ width: 1280, height: 800 })
})

test('Phones & Cloud opens the tab in use: four tabs, what the way is, how the phone gets in now', async ({ page }) => {
  await mockDevices(page)
  const cloud = await openPhonesCloud(page)

  // Four tabs, the one in use open and saying so; the sidebar lists Phones & Cloud alone.
  await expect(tabs(page).locator('.pc-tab-label')).toHaveText(['Cloud companion', 'Tailscale', 'Browser link', 'Devices'])
  await expect(page.getByTestId('pc-tab-cloud')).toHaveAttribute('aria-current', 'page')
  await expect(page.getByTestId('pc-tab-cloud')).toContainText('In use')
  await expect(page.getByTestId('pc-tab-devices-tailscale')).toContainText('Off')
  await expect(page.getByTestId('pc-tab-devices-browser')).toContainText('On')
  await expect(page.getByTestId('pc-tab-devices-phones')).toContainText('4')
  await expect(page.locator('#cloud-title')).toHaveText('Phones & Cloud')
  await expect(page.getByTestId('settings-nav-devices')).toHaveAttribute('aria-current', 'page')
  await expect(page.locator('.settings-nav-subitem')).toHaveCount(0)
  await expect(page.getByTestId('settings-nav-cloud')).toHaveCount(0)
  await expect(page.getByTestId('settings-pane-back')).toHaveCount(0)

  // At the top: what it is, when to use it, its state; then how the phone gets in now.
  const intro = cloud.getByTestId('pc-intro-cloud')
  await expect(intro.locator('.pc-intro-what')).toHaveText('A small server of yours in the cloud. Your phone talks to it, and it talks to this Mac.')
  await expect(intro.locator('.pc-intro-when')).toContainText('You want Walnut on the go, on any network, even while this Mac sleeps.')
  await expect(intro.locator('.pc-intro-now')).toContainText('On at walnut.example.com')
  const now = cloud.getByTestId('devices-now')
  await expect(now).toContainText('pocket-phone reaches Walnut through the cloud companion')
  await expect(now).toContainText('Last seen 2 min ago. Works anywhere, even while this Mac sleeps.')
  // Then its own settings, and nothing of the other tabs.
  const panel = cloud.getByTestId('devices-way-panel-cloud')
  await expect(panel.getByRole('heading', { name: 'While this Mac is away' })).toBeVisible({ timeout: 30_000 })
  await expect(panel.getByTestId('companion-keep')).toBeVisible()
  const top = async (sel: string) => (await cloud.locator(sel).first().boundingBox())!.y
  expect(await top('[data-testid="pc-tabs"]')).toBeLessThan(await top('[data-testid="pc-intro-cloud"]'))
  expect(await top('[data-testid="pc-intro-cloud"]')).toBeLessThan(await top('[data-testid="devices-now"]'))
  expect(await top('[data-testid="devices-now"]')).toBeLessThan(await top('[data-testid="devices-way-panel-cloud"]'))
  for (const id of ['devices-phones-group', 'devices-add-group', 'remote-access-card', 'browser-access']) {
    await expect(page.getByTestId(id)).toHaveCount(0)
  }
  await shot(page, 'tab-cloud')
})

test('each tab holds only its own way; Devices holds the phones; deep links open their tab', async ({ page }) => {
  await mockDevices(page)
  await openPhonesCloud(page)

  await page.getByTestId('pc-tab-devices-tailscale').click()
  await expect(page).toHaveURL(/#devices-tailscale$/)
  const ts = page.locator('#devices-tailscale')
  await expect(page.getByTestId('pc-tab-devices-tailscale')).toHaveAttribute('aria-current', 'page')
  await expect(ts.getByTestId('pc-intro-devices-tailscale').locator('.pc-intro-what')).toHaveText('A private network between this Mac and your phone. The phone talks to this Mac directly.')
  await expect(ts.getByTestId('pc-intro-devices-tailscale').locator('.pc-intro-now')).toContainText('Not installed on this Mac.')
  await expect(ts.getByTestId('devices-way-panel-tailscale').locator('.remote-access-step[data-step="mac"]')).toContainText('Get Tailscale from the App Store')
  await expect(ts.getByTestId('devices-now')).toHaveCount(0)
  await expect(page.getByTestId('settings-nav-devices')).toHaveAttribute('aria-current', 'page')
  await shot(page, 'tab-tailscale')

  await page.getByTestId('pc-tab-devices-browser').click()
  const br = page.locator('#devices-browser')
  await expect(br.getByTestId('pc-intro-devices-browser').locator('.pc-intro-when')).toContainText('You are on a computer or phone without the Walnut app.')
  await expect(br.getByTestId('pc-intro-devices-browser').locator('.pc-intro-now')).toContainText('Connected through Example tunnel.')
  await expect(br.getByTestId('browser-access')).toBeVisible({ timeout: 30_000 })
  await shot(page, 'tab-browser')

  await page.getByTestId('pc-tab-devices-phones').click()
  const dev = page.locator('#devices-phones')
  await expect(dev.getByTestId('pc-intro-devices-phones').locator('.pc-intro-what')).toHaveText('The phones and browsers that can open Walnut, and pairing a new phone.')
  await expect(dev.getByTestId('pc-intro-devices-phones').locator('.pc-intro-now')).toHaveCount(0)
  const phones = dev.getByTestId('devices-phones-group')
  await expect(phones.locator('.devices-row')).toHaveCount(3)
  await expect(phones.locator('.devices-row[data-device-name="pocket-phone"] .settings-tag')).toHaveText('Cloud companion')
  await expect(phones.locator('.devices-row[data-device-name="desk-phone"] .settings-tag')).toHaveText('Direct')
  const others = dev.getByTestId('devices-others')
  await expect(others).toContainText('17')
  await expect(others).toHaveAttribute('data-open', 'false')
  const order = await dev.evaluate((el) => ['pc-tabs', 'pc-intro-devices-phones', 'devices-phones-group', 'devices-browsers-group', 'devices-add-group', 'devices-others-group']
    .map((id) => el.querySelector(`[data-testid="${id}"]`)?.getBoundingClientRect().top ?? -1))
  expect(order.every((t) => t >= 0)).toBe(true)
  expect([...order].sort((a, b) => a - b)).toEqual(order)
  await shot(page, 'tab-devices')

  // Old in-page anchors and rows open the tab that holds them (a link written to the hash).
  for (const [hash, tab] of [['#devices-way-panel-tailscale', 'devices-tailscale'], ['#devices-way-browser', 'devices-browser'], ['#devices-new-name', 'devices-phones'], ['#devices-backup-leader', 'cloud']] as const) {
    await page.evaluate((h) => { window.location.hash = h }, hash)
    await expect(page.getByTestId(`pc-tab-${tab}`)).toHaveAttribute('aria-current', 'page')
  }
  await expect(page.locator('#devices-backup-leader')).toBeInViewport()
  await page.getByTestId('settings-nav-general').click()
  await expect(page.getByTestId('pc-tabs')).toHaveCount(0)
})

test('with nothing for away, Phones & Cloud opens Devices and says the phone cannot get in from outside', async ({ page }) => {
  await mockDevices(page, { cloud: false })
  const dev = await openPhonesCloud(page, 'devices-phones')
  await expect(page.getByTestId('pc-tab-cloud')).toContainText('Off')
  const now = dev.getByTestId('devices-now')
  await expect(now).toHaveAttribute('data-tone', 'warn')
  await expect(now).toContainText("Away from home it can't reach Walnut until the cloud companion or Tailscale is on.")
  await page.getByTestId('pc-tab-cloud').click()
  await expect(page.locator('#cloud').getByTestId('devices-now')).toHaveCount(0)
})

test('the cloud tab pairs a phone this way: Devices opens with the companion picked for the QR', async ({ page }) => {
  await mockDevices(page)
  const cloud = await openPhonesCloud(page)
  await cloud.getByTestId('cloud-pair-phone').click()
  await expect(page).toHaveURL(/#devices-phones$/)
  await expect(page.getByTestId('devices-target-cloud')).toHaveAttribute('aria-checked', 'true', { timeout: 30_000 })
  await expect(page.locator('#devices-new-name')).toBeFocused()
})

test('on a phone, Phones & Cloud opens the tab in use; tabs switch in place and Back returns to the list', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await mockDevices(page)
  await page.goto('/')
  await page.waitForLoadState('domcontentloaded')
  await page.getByRole('button', { name: 'Menu', exact: true }).click({ timeout: 60_000 })
  await page.locator('#primary-sidebar').getByRole('link', { name: /settings/i }).first().click()
  const layout = page.locator('.settings-layout')
  await expect(layout).toHaveAttribute('data-phone-settings', 'list', { timeout: 60_000 })
  const topbar = page.locator('.phone-topbar')
  await page.getByTestId('settings-nav-devices').click()
  await expect(layout).toHaveAttribute('data-phone-settings', 'pane')
  await expect(page.locator('#cloud')).toBeVisible({ timeout: 30_000 })
  // The tab bar fits the screen and scrolls sideways; no tab is cut off unreachably.
  const bar = (await page.getByTestId('pc-tabs').boundingBox())!
  expect(bar.x + bar.width).toBeLessThanOrEqual(390)
  await page.getByTestId('pc-tabs').evaluate((el) => { el.scrollLeft = el.scrollWidth })
  await page.getByTestId('pc-tab-devices-phones').click()
  await expect(page.locator('#devices-phones').getByTestId('devices-phones-group')).toBeVisible({ timeout: 30_000 })
  await expect(layout).toHaveAttribute('data-phone-settings', 'pane')
  // The bar names the entry, not the tab; the open tab is scrolled into the bar.
  await expect(topbar).toContainText('Phones & Cloud')
  const tab = (await page.getByTestId('pc-tab-devices-phones').boundingBox())!
  expect(tab.x).toBeGreaterThanOrEqual(0)
  expect(tab.x + tab.width).toBeLessThanOrEqual(390)
  // Tags and dots come with the data and widen the tabs: the open one is brought into view
  // again then, and an edge with more tabs past it fades (data-more says which).
  await expect.poll(async () => {
    const barBox = (await page.getByTestId('pc-tabs').boundingBox())!
    const open = (await page.getByTestId('pc-tab-devices-phones').boundingBox())!
    return open.x >= barBox.x - 1 && open.x + open.width <= barBox.x + barBox.width + 1
  }).toBe(true)
  const edges = await page.getByTestId('pc-tabs').evaluate((el) => ({ more: el.getAttribute('data-more') ?? '', left: el.scrollLeft > 1, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 1 }))
  expect(edges.more).toBe([edges.left ? 'left' : '', edges.right ? 'right' : ''].filter(Boolean).join(' '))
  await shot(page, 'phone-tab-devices', page.locator('body'))
  await topbar.getByRole('button', { name: 'Back' }).click()
  await expect(layout).toHaveAttribute('data-phone-settings', 'list')
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

test('at phone width the dialog fits the screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await mockDevices(page)
  // The phone layout: Menu, Settings, then the pane as its own layer.
  await page.goto('/')
  await page.getByRole('button', { name: 'Menu', exact: true }).click({ timeout: 60_000 })
  await page.locator('#primary-sidebar').getByRole('link', { name: /settings/i }).first().click()
  await expect(page.locator('.settings-layout[data-phone-settings="list"]')).toBeVisible({ timeout: 60_000 })
  await page.getByTestId('settings-nav-devices').click()
  await expect(page.locator('#cloud')).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('pc-tab-devices-phones').click()
  const section = page.locator('#devices-phones')
  await expect(section).not.toContainText('Loading paired phones...', { timeout: 30_000 })
  await section.locator('.devices-row[data-device-name="pocket-phone"]').getByTestId('devices-show-qr').click()
  await dialog(page).getByTestId('devices-show-qr-confirm').click()
  await expect(dialog(page).locator('img')).toBeVisible({ timeout: 30_000 })
  const box = (await dialog(page).boundingBox())!
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(390)
  await shot(page, 'phone-width', page.locator('body'))
})

test('Find a setting reaches a row on a tab: the tab opens with the row shown', async ({ page }) => {
  await mockDevices(page)
  await openDevices(page)
  await page.getByTestId('settings-filter').fill('take over')
  // The hit is the Cloud companion's own row in the sidebar, named after the row it found.
  await page.locator('.settings-nav').getByText('Cloud companion takes over').first().click()
  await expect(page.getByTestId('pc-tab-cloud')).toHaveAttribute('aria-current', 'page')
  await expect(page.locator('#devices-backup-leader')).toBeInViewport({ timeout: 10_000 })
})
