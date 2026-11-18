/**
 * Settings → Phones & Cloud as four tabs, the layout the user picked (2026-11-03,
 * design 1 of 10: "A also for ech option show a descripotion of what itbis in tbhe
 * top"), each way with its own devices (2026-11-18: "why this is in device not in
 * cloud compaion confused", "each section shoud have its own paried devide or
 * conenct devide"):
 *
 *   1. Cloud companion, Tailscale, the tunnel and All devices are tabs; Phones &
 *      Cloud opens the tab the phone uses. Each tab leads with what it is, when to
 *      use it and its state now; the tab in use also says how the phone reaches
 *      Walnut. The sidebar lists Phones & Cloud alone.
 *   2. Each way's tab lists the devices that use it, with their actions, and pairs a
 *      phone through its own address in place: the companion's phones and Macs, the
 *      phones paired with this Mac (Tailscale reaches those), the signed-in browsers
 *      and the extension. All devices lists everything, each row tagged with its ways.
 *   3. A phone shows once in each tab of its ways, and Remove says it removes the
 *      whole phone on every way (one pairing works on all of them), then asks.
 *   4. Show QR and Pair open the code in a dialog in front of the user: a paired
 *      phone's new code asks first (it signs the phone out), the code says how to
 *      scan it, and the dialog cannot be closed while the code is being made.
 *   5. This Mac's own record and simulators stay folded in Advanced on All devices.
 *
 * Real density, the shape of the user's own list: a phone paired through the
 * companion and copied to this Mac, an older phone paired with this Mac only, a third
 * phone, a signed-in browser, the Walnut extension, this Mac's own cloud record,
 * another Mac on the companion and sixteen simulators. The list, the mint, the
 * removal, Tailscale and the tunnel state are page.route fixtures with neutral
 * names; navigation is by clicks.
 *
 * Runs in both engines: Chromium by default, WebKit (the Mac app is a
 * WKWebView) with `PW_WEBKIT=1 ... --project=webkit`.
 */
import { mkdirSync } from 'node:fs'
import { test, expect, type Locator, type Page, type Route } from '@playwright/test'
import { isolateUiPrefs } from './todo-panel-helpers'

test.setTimeout(120_000)

const SHOTS = process.env.PW_SHOTS_DIR ?? '/tmp/devices-ways-and-qr'
const LAN = { kind: 'lan', origin: 'http://192.0.2.10:3456', label: 'This network (Wi-Fi)' }
const CLOUD = { kind: 'cloud', origin: 'https://walnut.example.com', label: 'Cloud (anywhere)' }
const TAILNET = { kind: 'tailnet', origin: 'http://this-mac.tail0000.ts.net:3456', label: 'Tailscale' }

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString()
const day = (n: number) => ago(n * 1440)
const SIMULATORS = Array.from({ length: 16 }, (_, i) => ({ name: `sim-${i + 1}`, createdAt: day(40 + i), role: 'simulator' }))
const DEVICES = [
  { name: 'desk-phone', createdAt: day(100), lastUsedAt: day(60), role: 'phone' },
  { name: 'spare-phone', createdAt: day(50), lastUsedAt: day(50), role: 'phone', info: { model: 'iPhone18,2', os: 'iOS 26.0.1', appVersion: '1.0.0 (57)' } },
  // Paired through the companion and copied here, as the user's own phone is.
  { name: 'pocket-phone', createdAt: ago(60), role: 'phone', adoptedFrom: 'cloud', info: { model: 'iPhone18,2', os: 'iOS 27.0', appVersion: '1.0.2 (165)' } },
  { name: 'browser-1a2b3c', createdAt: day(14), lastUsedAt: day(2), role: 'browser' },
  { name: 'extension-4d5e6f', createdAt: day(14), lastUsedAt: ago(5), role: 'browser', info: { deviceName: 'Walnut extension (Chrome on Mac)', appVersion: '0.6.33' } },
  ...SIMULATORS,
]
const CLOUD_DEVICES = [
  { name: 'pocket-phone', createdAt: ago(60), lastUsedAt: ago(2), role: 'phone' },
  { name: 'this-mac-sync', createdAt: day(90), role: 'self' },
  { name: 'studio-mac', createdAt: day(30), lastUsedAt: day(1), role: 'mac' },
]

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })

interface MintControl {
  mints: Array<Record<string, unknown>>
  /** When set, the next mint waits for this promise (a slow cloud round trip). */
  hold?: Promise<void>
  /** When set, the next mint answers this status with an error body. */
  failWith?: number
  /** Every DELETE /api/devices/:name, as `<name>` or `<name>?target=cloud`. */
  deletes: string[]
  /** Removing a record here also removes its twin on the companion, as the server does by hash. */
  twinRemoval?: boolean
}

async function mockDevices(page: Page, opts: { cloud?: boolean; tailscale?: boolean } = {}): Promise<MintControl> {
  const cloud = opts.cloud ?? true
  const ts = opts.tailscale ?? false
  const ctl: MintControl = { mints: [], deletes: [] }
  // Each test's own copy: a removal takes the row out of this test's list only.
  const local = DEVICES.map((d) => ({ ...d }))
  const remote = CLOUD_DEVICES.map((d) => ({ ...d }))
  const tsState = { installed: ts, running: ts }
  await page.route((url) => url.pathname === '/api/devices/tailscale', (route) => json(route, {
    ...tsState, ...(ts ? { dnsName: 'this-mac.tail0000.ts.net', address: '100.64.0.10' } : {}),
    peers: ts ? [{ hostName: 'pocket-phone', os: 'iOS', online: true }] : [], install: { brew: false, job: null },
  }))
  await page.route((url) => url.pathname.startsWith('/api/devices/') && url.pathname !== '/api/devices/tailscale', (route) => {
    if (route.request().method() !== 'DELETE') return route.fallback()
    const url = new URL(route.request().url())
    const name = decodeURIComponent(url.pathname.slice('/api/devices/'.length))
    const onCloud = url.searchParams.get('target') === 'cloud'
    ctl.deletes.push(onCloud ? `${name}?target=cloud` : name)
    const list = onCloud ? remote : local
    const at = list.findIndex((d) => d.name === name)
    if (at < 0) return json(route, { error: `Device "${name}" not found${onCloud ? ' on the cloud' : ''}.` }, 404)
    list.splice(at, 1)
    if (!onCloud && ctl.twinRemoval) {
      const twin = remote.findIndex((d) => d.name === name)
      if (twin >= 0) remote.splice(twin, 1)
    }
    return json(route, { ok: true })
  })
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
    const targets = [LAN, ...(ts ? [TAILNET] : []), ...(cloud ? [CLOUD] : [])]
    return json(route, { devices: local, cloudDevices: cloud ? remote : [], targets, tailscale: tsState })
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

/** The All devices tab: every device, Add a phone. */
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
const row = (scope: Locator, name: string) => scope.locator(`.devices-row[data-device-name="${name}"]`)
const rowNames = (scope: Locator) => scope.locator('.devices-row').evaluateAll((els) => els.map((e) => e.getAttribute('data-device-name')))

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
  await expect(tabs(page).locator('.pc-tab-label')).toHaveText(['Cloud companion', 'Tailscale', 'Tunnel', 'All devices'])
  await expect(page.getByTestId('pc-tab-cloud')).toHaveAttribute('aria-current', 'page')
  await expect(page.getByTestId('pc-tab-cloud')).toContainText('In use')
  await expect(page.getByTestId('pc-tab-devices-tailscale')).toContainText('Off')
  await expect(page.getByTestId('pc-tab-devices-browser')).toContainText('On')
  // Five phones and browsers, each once: pocket-phone is paired on both boxes.
  await expect(page.getByTestId('pc-tab-devices-phones')).toContainText('5')
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

test('each tab holds its own way and the devices that use it; All devices holds them all; deep links open their tab', async ({ page }) => {
  await mockDevices(page)
  const cloud = await openPhonesCloud(page)

  // Cloud companion: the phones and Macs on the companion. desk-phone and spare-phone are
  // paired with this Mac only, so they are not here.
  const cloudPhones = cloud.getByTestId('way-devices-cloud')
  await expect(cloudPhones).toBeVisible({ timeout: 30_000 })
  await expect(cloudPhones.locator('.settings-group-heading')).toContainText('Phones on this companion')
  expect(await rowNames(cloudPhones)).toEqual(['pocket-phone'])
  // Its other way, by the tab's name; its own way is the tab itself.
  await expect(row(cloudPhones, 'pocket-phone').locator('.settings-tag')).toHaveText(['Wi-Fi'])
  await expect(row(cloudPhones, 'pocket-phone').getByTestId('devices-show-qr')).toBeVisible()
  await expect(row(cloudPhones, 'pocket-phone').getByTestId('devices-remove')).toHaveText('Remove')
  const macs = cloud.getByTestId('devices-macs')
  await expect(macs.locator('.settings-group-heading')).toContainText('Macs on this companion')
  expect(await rowNames(macs)).toEqual(['this-mac-sync', 'studio-mac'])
  await expect(row(macs, 'this-mac-sync')).toContainText('This Mac')
  await expect(row(macs, 'this-mac-sync').getByTestId('devices-unpair-self')).toBeVisible()
  await expect(cloud.getByTestId('way-pair-cloud')).toContainText('Pair a phone this way')
  // Read top to bottom: the way, its devices, pairing one more, then the companion's own settings.
  const top = async (sel: string) => (await cloud.locator(sel).first().boundingBox())!.y
  expect(await top('[data-testid="way-devices-cloud"]')).toBeLessThan(await top('[data-testid="way-pair-cloud"]'))
  expect(await top('[data-testid="way-pair-cloud"]')).toBeLessThan(await top('[data-testid="devices-macs"]'))
  expect(await top('[data-testid="devices-macs"]')).toBeLessThan(await top('[data-testid="devices-way-panel-cloud"]'))
  await shot(page, 'tab-cloud-devices')

  await page.getByTestId('pc-tab-devices-tailscale').click()
  await expect(page).toHaveURL(/#devices-tailscale$/)
  const ts = page.locator('#devices-tailscale')
  await expect(page.getByTestId('pc-tab-devices-tailscale')).toHaveAttribute('aria-current', 'page')
  await expect(ts.getByTestId('pc-intro-devices-tailscale').locator('.pc-intro-what')).toHaveText('A private network between this Mac and your phone. The phone talks to this Mac directly.')
  await expect(ts.getByTestId('pc-intro-devices-tailscale').locator('.pc-intro-now')).toContainText('Not installed on this Mac.')
  await expect(ts.getByTestId('devices-way-panel-tailscale').locator('.remote-access-step[data-step="mac"]')).toContainText('Get Tailscale from the App Store')
  await expect(ts.getByTestId('devices-now')).toHaveCount(0)
  await expect(page.getByTestId('settings-nav-devices')).toHaveAttribute('aria-current', 'page')
  // The phones paired with this Mac, the ones Tailscale reaches; while it is off they say so,
  // and pairing this way waits for it.
  const tsPhones = ts.getByTestId('way-devices-tailscale')
  await expect(tsPhones).toBeVisible({ timeout: 30_000 })
  expect((await rowNames(tsPhones)).sort()).toEqual(['desk-phone', 'pocket-phone', 'spare-phone'])
  await expect(tsPhones).toContainText("Tailscale isn't running on this Mac, so none of these connects this way now.")
  await expect(tsPhones).toContainText('a phone here uses this way once the Tailscale app runs on it too')
  await expect(row(tsPhones, 'pocket-phone').locator('.settings-tag')).toHaveText(['Cloud companion', 'Wi-Fi'])
  await expect(row(tsPhones, 'desk-phone').locator('.settings-tag')).toHaveText(['Wi-Fi'])
  const tsPair = ts.getByTestId('way-pair-tailscale')
  await expect(tsPair).toContainText('Set up Tailscale on this Mac first')
  await ts.locator('#devices-new-name').fill('travel phone')
  await expect(tsPair.getByTestId('devices-pair-new')).toBeDisabled()
  await shot(page, 'tab-tailscale')

  await page.getByTestId('pc-tab-devices-browser').click()
  const br = page.locator('#devices-browser')
  await expect(br.getByTestId('pc-intro-devices-browser').locator('.pc-intro-when')).toContainText('You are on a computer or phone without the Walnut app.')
  await expect(br.getByTestId('pc-intro-devices-browser').locator('.pc-intro-now')).toContainText('Connected through Example tunnel.')
  await expect(br.getByTestId('browser-access')).toBeVisible({ timeout: 30_000 })
  // The browsers and the extension signed in with a code from this tab; no phone, no pairing.
  expect(await rowNames(br.getByTestId('devices-browsers-group'))).toEqual(['browser-1a2b3c'])
  await expect(row(br, 'browser-1a2b3c').getByTestId('devices-remove')).toHaveText('Sign out')
  expect(await rowNames(br.getByTestId('devices-extensions-group'))).toEqual(['extension-4d5e6f'])
  await expect(br.getByTestId('way-devices-browser')).toHaveCount(0)
  await expect(br.locator('#devices-new-name')).toHaveCount(0)
  await expect(br.getByTestId('browser-access-signed-in-row')).toHaveCount(0)
  await shot(page, 'tab-browser')

  await page.getByTestId('pc-tab-devices-phones').click()
  const dev = page.locator('#devices-phones')
  await expect(dev.getByTestId('pc-intro-devices-phones').locator('.pc-intro-what')).toHaveText("Every phone, browser and Mac that can open Walnut, each with the ways it uses, and the servers this Walnut runs on. Each way's own tab lists only the devices that use it.")
  await expect(dev.getByTestId('pc-intro-devices-phones').locator('.pc-intro-now')).toHaveCount(0)
  const phones = dev.getByTestId('devices-phones-group')
  await expect(phones.locator('.devices-row')).toHaveCount(3)
  // Each row tagged with the tabs it shows in.
  await expect(row(phones, 'pocket-phone').locator('.settings-tag')).toHaveText(['Cloud companion', 'Wi-Fi'])
  await expect(row(phones, 'desk-phone').locator('.settings-tag')).toHaveText(['Wi-Fi'])
  await expect(dev.getByText('Direct', { exact: true })).toHaveCount(0)
  expect(await rowNames(dev.getByTestId('devices-extensions-group'))).toEqual(['extension-4d5e6f'])
  expect(await rowNames(dev.getByTestId('devices-macs'))).toEqual(['studio-mac'])
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

// 2026-11-05 (found-hosts.spec.ts in WebKit): Phones & Cloud waits for Tailscale's first probe before
// it opens a tab, and shows the bar meanwhile. A tab pressed in that wait, with the answer coming in
// before the release, did nothing: the page moved to Devices under the held pointer, the press and the
// release landed on two different tabs, and no click happened. The tab the person pressed opens.

/** Opens Phones & Cloud with Tailscale's answer held, presses the tunnel's tab, then lets it answer. */
async function pressWhileItDecides(page: Page) {
  await mockDevices(page, { cloud: false })
  // The first read has no Tailscale answer yet (Phones & Cloud waits for it); the next one, the
  // page's own ask a few seconds later, is held until the pointer is down on a tab.
  let reads = 0
  let answer!: () => void
  const answered = new Promise<void>((r) => { answer = r })
  await page.route((url) => url.pathname === '/api/devices', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    reads++
    if (reads > 1) await answered
    return json(route, { devices: DEVICES, cloudDevices: [], targets: [LAN], ...(reads > 1 ? { tailscale: { installed: false, running: false } } : {}) })
  })
  await openSettings(page)
  await page.getByTestId('settings-nav-devices').click()
  await expect(page).toHaveURL(/#devices$/, { timeout: 30_000 })
  const tab = page.getByTestId('pc-tab-devices-browser')
  await expect(tab).toContainText('On', { timeout: 30_000 })
  // The ask that settles it has gone out (and waits): press the tab now, then let it answer.
  await expect.poll(() => reads, { timeout: 30_000 }).toBeGreaterThanOrEqual(2)
  const box = (await tab.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  answer()
  // The answer is in: Phones & Cloud either waits for the press to end, or (the bug) moved already.
  await expect.poll(() => page.evaluate(() => document.querySelector('[data-landing-waits="press"]') ? 'waits'
    : document.getElementById('devices-phones') ? 'moved' : 'deciding'), { timeout: 30_000 }).not.toBe('deciding')
  return { tab, box }
}

const framesPass = (page: Page, n: number) => page.evaluate((count) => new Promise<void>((done) => {
  let left = count
  const tick = () => (--left <= 0 ? done() : requestAnimationFrame(tick))
  requestAnimationFrame(tick)
}), n)

test('a tab pressed while Phones & Cloud still decides where to open is the tab that opens', async ({ page }) => {
  const { tab } = await pressWhileItDecides(page)
  await page.mouse.up()
  await expect(page).toHaveURL(/#devices-browser$/, { timeout: 10_000 })
  await expect(page.locator('#devices-browser')).toBeVisible()
  await expect(tab).toHaveAttribute('aria-current', 'page')
  // And the landing never takes it back afterwards.
  await framesPass(page, 5)
  await expect(page).toHaveURL(/#devices-browser$/)
})

// WebKit ends a dragged link with dragstart and dragend alone, no pointerup or pointercancel: a wait
// for the press to end must not hang on it.
test('a press dragged off the tab is no pick: Phones & Cloud then opens the tab in use', async ({ page }) => {
  const { box } = await pressWhileItDecides(page)
  await page.mouse.move(box.x + box.width / 2, box.y + box.height + 300, { steps: 4 })
  await page.mouse.up()
  await expect(page).toHaveURL(/#devices-phones$/, { timeout: 10_000 })
  await expect(page.getByTestId('pc-tab-devices-phones')).toHaveAttribute('aria-current', 'page')
})

test('the cloud tab pairs a phone this way in place: the code points at the companion', async ({ page }) => {
  const ctl = await mockDevices(page)
  const cloud = await openPhonesCloud(page)
  const pair = cloud.getByTestId('way-pair-cloud')
  await expect(pair).toContainText('The QR code points the phone at your companion')
  await expect(pair.getByRole('radiogroup')).toHaveCount(0)
  await pair.locator('#devices-new-name').fill('travel phone')
  await pair.locator('#devices-new-name').press('Enter')
  await expect(dialog(page).locator('img')).toBeVisible({ timeout: 30_000 })
  await expect(page).toHaveURL(/#cloud$/)
  expect(ctl.mints[0]).toMatchObject({ name: 'travel-phone', target: 'cloud' })
  await expect(dialog(page)).toContainText('Points at walnut.example.com')
  await dialog(page).getByTestId('devices-qr-done').click()
  await expect(pair.locator('#devices-new-name')).toHaveValue('')
})

test('with Tailscale on, its tab pairs through the tailnet address and step 3 leads to that row', async ({ page }) => {
  const ctl = await mockDevices(page, { tailscale: true })
  await openPhonesCloud(page)
  await page.getByTestId('pc-tab-devices-tailscale').click()
  const ts = page.locator('#devices-tailscale')
  const tsPhones = ts.getByTestId('way-devices-tailscale')
  await expect(tsPhones).toBeVisible({ timeout: 30_000 })
  await expect(tsPhones).not.toContainText("isn't running")
  await expect(row(tsPhones, 'pocket-phone').locator('.settings-tag')).toHaveText(['Cloud companion', 'Wi-Fi'])
  // Show QR here carries this tab's own address.
  await row(tsPhones, 'desk-phone').getByTestId('devices-show-qr').click()
  await dialog(page).getByTestId('devices-show-qr-confirm').click()
  await expect(dialog(page).locator('img')).toBeVisible({ timeout: 30_000 })
  expect(ctl.mints[0]).toMatchObject({ name: 'desk-phone', target: 'tailnet', replace: true })
  await dialog(page).getByTestId('devices-qr-done').click()
  // A phone that is on the companion keeps the companion's address: a tailnet-only code
  // would cut off a phone without Tailscale.
  await row(tsPhones, 'pocket-phone').getByTestId('devices-show-qr').click()
  await dialog(page).getByTestId('devices-show-qr-confirm').click()
  await expect(dialog(page).locator('img')).toBeVisible({ timeout: 30_000 })
  expect(ctl.mints[1]).toMatchObject({ name: 'pocket-phone', target: 'cloud', replace: true })
  await dialog(page).getByTestId('devices-qr-done').click()
  await page.getByTestId('pc-tab-devices-phones').click()
  // Tailscale on this Mac says nothing about the phone: no row is tagged Tailscale.
  await expect(row(page.locator('#devices-phones').getByTestId('devices-phones-group'), 'desk-phone').locator('.settings-tag')).toHaveText(['Wi-Fi'], { timeout: 30_000 })
})

test('Remove on a way tab removes the whole phone, after saying so: every record, every tab', async ({ page }) => {
  const ctl = await mockDevices(page)
  const cloud = await openPhonesCloud(page)
  const pocket = row(cloud.getByTestId('way-devices-cloud'), 'pocket-phone')
  await expect(pocket).toBeVisible({ timeout: 30_000 })

  // The first press only asks: what Remove does, Cancel focused.
  await pocket.getByTestId('devices-remove').click()
  const warning = pocket.getByRole('alert')
  await expect(warning).toContainText('Removing pocket-phone signs it out of this Walnut on every way it uses: the cloud companion and this Mac directly (Wi-Fi, or Tailscale).')
  await expect(warning).toContainText('to use it again, scan a new QR code')
  await expect(pocket.getByTestId('devices-remove-cancel')).toBeFocused()
  await expect(pocket.getByTestId('devices-remove-confirm')).toHaveText('Remove pocket-phone')
  await expect(pocket.getByTestId('devices-show-qr')).toHaveCount(0)
  await shot(page, 'remove-ask', pocket)
  // Cancel, and Escape, change nothing and give the focus back to Remove.
  await pocket.getByTestId('devices-remove-cancel').click()
  await expect(warning).toHaveCount(0)
  await expect(pocket.getByTestId('devices-remove')).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(pocket.getByTestId('devices-remove-cancel')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(pocket.getByRole('alert')).toHaveCount(0)
  await expect(pocket.getByTestId('devices-remove')).toBeFocused()
  // A double click never confirms: the second click lands on the question, not on the answer.
  await pocket.getByTestId('devices-remove').dblclick()
  await expect(pocket.getByTestId('devices-remove-confirm')).toBeVisible()
  expect(ctl.deletes).toEqual([])

  await pocket.getByTestId('devices-remove-confirm').click()
  await expect(pocket).toHaveCount(0, { timeout: 30_000 })
  expect(ctl.deletes).toEqual(['pocket-phone', 'pocket-phone?target=cloud'])
  await expect(cloud.getByTestId('way-devices-cloud')).toContainText('No phone is paired with the companion yet.')
  // Gone from every tab, and the count follows.
  await expect(page.getByTestId('pc-tab-devices-phones')).toContainText('4')
  await page.getByTestId('pc-tab-devices-tailscale').click()
  await expect(page.locator('#devices-tailscale').getByTestId('way-devices-tailscale')).toBeVisible({ timeout: 30_000 })
  expect((await rowNames(page.locator('#devices-tailscale').getByTestId('way-devices-tailscale'))).sort()).toEqual(['desk-phone', 'spare-phone'])
})

test("Remove of a phone whose companion copy went with it is done, not an error", async ({ page }) => {
  // The server removes the companion's copy by hash in the background: the second DELETE
  // finds nothing there (404). That is the phone removed, not a failure to show.
  const ctl = await mockDevices(page)
  ctl.twinRemoval = true
  const cloud = await openPhonesCloud(page)
  const pocket = row(cloud.getByTestId('way-devices-cloud'), 'pocket-phone')
  await pocket.getByTestId('devices-remove').click({ timeout: 30_000 })
  await pocket.getByTestId('devices-remove-confirm').click()
  await expect(pocket).toHaveCount(0, { timeout: 30_000 })
  expect(ctl.deletes).toEqual(['pocket-phone', 'pocket-phone?target=cloud'])
  await expect(cloud.getByText("Couldn't remove")).toHaveCount(0)
})

test('a refused Remove says so on the row and the list is read again at once', async ({ page }) => {
  const ctl = await mockDevices(page)
  const cloud = await openPhonesCloud(page)
  // The companion refuses (it is down): the row says why, and keeps its Remove in focus.
  await page.route((url) => url.pathname === '/api/devices/studio-mac', (route) => json(route, { error: 'The cloud companion did not answer.' }, 502))
  const reads = { n: 0 }
  page.on('request', (r) => { if (r.method() === 'GET' && new URL(r.url()).pathname === '/api/devices') reads.n++ })
  const mac = row(cloud.getByTestId('devices-macs'), 'studio-mac')
  await mac.getByTestId('devices-remove').click({ timeout: 30_000 })
  const before = reads.n
  await mac.getByTestId('devices-remove').click()
  // The row's error line sits right under the row (SettingsRow renders it as its sibling).
  await expect(cloud.locator('.devices-row[data-device-name="studio-mac"] + .settings-row-error')).toContainText("Couldn't remove", { timeout: 30_000 })
  await expect(mac.getByTestId('devices-remove')).toBeFocused()
  await expect.poll(() => reads.n, { timeout: 5_000 }).toBeGreaterThan(before)
  expect(ctl.deletes).toEqual([])
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
