/**
 * Settings → Phones & Cloud: the tailnet pairing address and the Tailscale line.
 *
 * GET /api/devices may list a third pairing target, `tailnet` (this machine's
 * 100.64/10 address), between this network and the cloud, plus a `tailscale`
 * status field. A phone paired through any address learns the others by itself,
 * so the address only decides where the QR points first. Each way's tab pairs
 * through its own address (the Tailscale tab's QR carries the tailnet address, the
 * Cloud companion tab's the companion, the Same Wi-Fi tab's this Mac on the network),
 * and so does each tab's Show QR on a phone's row; All devices on this Mac pairs
 * nothing (only the companion's own console pairs there). When the machine has no tailnet address, the guided card
 * above the Tailscale tab's pairing says how to get one (its own states:
 * remote-access-card.spec.ts).
 *
 * The device list and the mint are served by page.route fixtures with neutral
 * names (nothing is paired on the fixture server). Navigation is by real clicks.
 *
 * Runs in both engines: Chromium by default, WebKit (the Mac app is a
 * WKWebView) with `PW_WEBKIT=1 ... --project=webkit`.
 */
import { mkdirSync } from 'node:fs'
import { test, expect, type Locator, type Page, type Route } from '@playwright/test'
import { backToDevices, openWay, qrDialog } from './devices-ways-helpers'

test.setTimeout(120_000)

const SHOTS = process.env.PW_SHOTS_DIR ?? '/tmp/tailnet-target'
const TAILNET_ORIGIN = 'http://100.101.102.103:3456'

const LAN = { kind: 'lan', origin: 'http://192.0.2.10:3456', label: 'This network (Wi-Fi)' }
const TAILNET = { kind: 'tailnet', origin: TAILNET_ORIGIN, label: 'Tailscale (anywhere this machine is on)' }
const CLOUD = { kind: 'cloud', origin: 'https://walnut.example.com', label: 'Cloud (anywhere)' }

const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString()
/** Realistic density: a phone paired both ways, one paired on Wi-Fi only, this Mac's own credential. */
const DEVICES = [
  { name: 'Work-phone', createdAt: day(30), lastUsedAt: day(0), role: 'phone', info: { model: 'iPhone18,2', os: 'iOS 26.1', appVersion: '1.0 (84)' } },
  { name: 'Kitchen-tablet', createdAt: day(12), lastUsedAt: day(3), role: 'phone' },
]
const CLOUD_DEVICES = [
  { name: 'Work-phone', createdAt: day(30), lastUsedAt: day(1), role: 'phone' },
  { name: 'this-mac-sync', createdAt: day(60), role: 'self' },
]

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })

interface ListFixture {
  targets: unknown[]
  tailscale?: { installed: boolean; running: boolean; dnsName?: string }
}

/** Serve GET /api/devices from `list`; answer every mint for the tailnet address and remember its body. */
async function mockDevices(page: Page, list: ListFixture): Promise<Array<Record<string, unknown>>> {
  const mints: Array<Record<string, unknown>> = []
  // The guided card (remote-access-card.spec.ts) reads its own endpoint: same state, never this Mac's real CLI.
  await page.route((url) => url.pathname === '/api/devices/tailscale', (route) => json(route, {
    installed: list.tailscale?.installed ?? false,
    running: list.tailscale?.running ?? false,
    ...(list.tailscale?.dnsName ? { dnsName: list.tailscale.dnsName } : {}),
    peers: [],
    install: { brew: false, job: null },
  }))
  await page.route((url) => url.pathname === '/api/devices', async (route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as Record<string, unknown>
      mints.push(body)
      const server = body.target === 'tailnet' ? TAILNET_ORIGIN : body.target === 'cloud' ? CLOUD.origin : LAN.origin
      const token = `tok-${mints.length}`
      return json(route, {
        name: body.name, token, target: body.target, server,
        pairingURI: `wn://pair?token=${token}&server=${encodeURIComponent(server)}`,
      })
    }
    return json(route, { devices: DEVICES, cloudDevices: CLOUD_DEVICES, ...list })
  })
  return mints
}

/** Real-user navigation, as devices-qr-pairing.spec.ts does it (no page.goto to /settings). */
async function openDevices(page: Page, { waitForList = true } = {}) {
  await page.goto('/')
  await page.waitForLoadState('domcontentloaded')
  await page.getByRole('link', { name: /settings/i }).first().click()
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible({ timeout: 30_000 })
  const nav = page.getByTestId('settings-nav-devices')
  await nav.click()
  await expect(nav).toHaveAttribute('aria-current', 'page')
  // Phones & Cloud opens the tab in use; every phone is on All devices.
  const section = await backToDevices(page)
  if (waitForList) await expect(section).not.toContainText('Loading paired phones...', { timeout: 30_000 })
  return section
}

/** Pair `name` from a tab's own pairing group; the mint is awaited by the caller. */
async function pairFrom(group: Locator, name: string) {
  await expect(group.getByTestId('devices-pair-new')).toHaveText('Get QR for a new phone')
  await group.locator('#devices-new-name').fill(name)
  await group.getByTestId('devices-pair-new').click()
}

/** The section (or `region` of it), at most 1280 CSS px wide; one file per engine. */
async function shot(page: Page, name: string, region = page.locator('#devices-phones')) {
  mkdirSync(SHOTS, { recursive: true })
  const engine = page.context().browser()?.browserType().name() ?? 'browser'
  await region.screenshot({ path: `${SHOTS}/${engine}-${name}.png`, scale: 'css' })
}

test.describe('Settings → Phones & Cloud tailnet pairing', () => {
  test('three targets: each way pairs on its own tab; the Tailscale QR points at the 100.x address, the companion QR at the companion', async ({ page }) => {
    const mints = await mockDevices(page, {
      targets: [LAN, TAILNET, CLOUD],
      tailscale: { installed: true, running: true, dnsName: 'studio-mac.example.ts.net' },
    })
    const section = await openDevices(page)

    // All devices lists the phones; it has no pairing of its own and no address picker while a way tab can pair.
    await expect(section.getByTestId('devices-phones-group')).toContainText('Work-phone')
    await expect(section.getByTestId('way-pair-all')).toHaveCount(0)
    await expect(section.locator('#devices-new-name')).toHaveCount(0)
    await expect(page.getByRole('radiogroup', { name: 'Pairing target' })).toHaveCount(0)
    await expect(section.getByTestId('devices-phones-group')).toContainText('New phone: Cloud companion, Same Wi-Fi or Tailscale.')
    // Which address would a new QR carry? All devices on this Mac offers none.
    await expect(section.getByTestId('devices-show-qr')).toHaveCount(0)

    // The Tailscale tab pairs through the tailnet address, no picker.
    const ts = await openWay(page, 'tailscale')
    const tsPair = ts.getByTestId('way-pair-tailscale')
    await expect(tsPair).toContainText("The QR code points the phone at this Mac's Tailscale address")
    await expect(tsPair.locator('.settings-notice')).toHaveCount(0)
    await expect(tsPair.getByRole('radiogroup')).toHaveCount(0)
    await pairFrom(tsPair, 'Travel phone')
    await expect.poll(() => mints.length).toBe(1)
    expect(mints[0]).toMatchObject({ name: 'Travel-phone', target: 'tailnet' })

    const qr = qrDialog(page).locator('img')
    await expect(qr).toBeVisible({ timeout: 60_000 })
    expect(await qr.getAttribute('src')).toMatch(/^data:image\/png;base64,/)
    await expect(qrDialog(page)).toContainText('Points at 100.101.102.103:3456')
    await shot(page, 'three-targets-tailnet-qr', qrDialog(page))
    await qrDialog(page).getByTestId('devices-qr-done').click()
    await expect(qrDialog(page)).toHaveCount(0)
    // A pairing ends its typed name.
    await expect(tsPair.locator('#devices-new-name')).toHaveValue('')

    // The Cloud companion tab pairs through the companion's address.
    const cloud = await openWay(page, 'cloud')
    const cloudPair = cloud.getByTestId('way-pair-cloud')
    await expect(cloudPair).toContainText('The QR points the phone at your companion')
    await pairFrom(cloudPair, 'Desk phone')
    await expect.poll(() => mints.length).toBe(2)
    expect(mints[1]).toMatchObject({ name: 'Desk-phone', target: 'cloud' })
    await expect(qrDialog(page).locator('img')).toBeVisible({ timeout: 60_000 })
    await expect(qrDialog(page)).toContainText('Points at walnut.example.com')
    await qrDialog(page).getByTestId('devices-qr-done').click()
  })

  test("re-pair: each way's tab shows a phone's new QR for its own way; Tailscale and All devices show none", async ({ page }) => {
    const mints = await mockDevices(page, {
      targets: [LAN, TAILNET, CLOUD],
      tailscale: { installed: true, running: true },
    })
    const section = await openDevices(page)
    await expect(section.getByTestId('devices-phones-group')).toContainText('Kitchen-tablet')
    await expect(section.getByTestId('devices-show-qr')).toHaveCount(0)

    /** Show QR on `name`'s row of `tab`, confirm, and check the mint and the address it shows. */
    const showQr = async (tab: Locator, name: string, target: string, pointsAt: string) => {
      const before = mints.length
      await tab.locator(`.devices-row[data-device-name="${name}"]`).getByTestId('devices-show-qr').click()
      await qrDialog(page).getByTestId('devices-show-qr-confirm').click()
      await expect.poll(() => mints.length).toBe(before + 1)
      expect(mints[before]).toMatchObject({ name, target, replace: true })
      await expect(qrDialog(page)).toContainText(`Points at ${pointsAt}`, { timeout: 60_000 })
      await qrDialog(page).getByTestId('devices-qr-done').click()
      await expect(qrDialog(page)).toHaveCount(0)
    }

    // The Tailscale tab: none. It lists every phone paired with this Mac, and a tailnet-only code
    // would cut off a Wi-Fi-only phone without Tailscale (a paired phone needs no new code for it).
    const ts = await openWay(page, 'tailscale')
    await expect(ts.locator('.devices-row[data-device-name="Kitchen-tablet"]')).toBeVisible({ timeout: 30_000 })
    await expect(ts.getByTestId('devices-show-qr')).toHaveCount(0)
    // The Cloud companion tab: the companion (it lists only the phone on it).
    const cloud = await openWay(page, 'cloud')
    await expect(cloud.locator('.devices-row[data-device-name="Kitchen-tablet"]')).toHaveCount(0)
    await showQr(cloud, 'Work-phone', 'cloud', 'walnut.example.com')
    // The Same Wi-Fi tab: this Mac on the network.
    const wifi = await openWay(page, 'wifi')
    await showQr(wifi, 'Kitchen-tablet', 'lan', '192.0.2.10:3456')
  })

  test('no tailnet address: the Tailscale tab offers no Show QR, the Same Wi-Fi tab still does', async ({ page }) => {
    await mockDevices(page, {
      targets: [LAN, CLOUD],
      tailscale: { installed: true, running: false },
    })
    await openDevices(page)
    const ts = await openWay(page, 'tailscale')
    // Idle, it lists no phones (its step 3 says a paired phone uses it by itself), so no Show QR either.
    await expect(ts.getByTestId('remote-access-card')).toBeVisible({ timeout: 30_000 })
    await expect(ts.getByTestId('way-devices-tailscale')).toHaveCount(0)
    await expect(ts.locator('.devices-row')).toHaveCount(0)
    await expect(ts.getByTestId('devices-show-qr')).toHaveCount(0)
    const wifi = await openWay(page, 'wifi')
    await expect(wifi.locator('.devices-row[data-device-name="Kitchen-tablet"]').getByTestId('devices-show-qr')).toBeVisible()
  })

  test('no tailnet address and Tailscale missing: the guided card says how, and the Same Wi-Fi tab pairs', async ({ page }) => {
    const mints = await mockDevices(page, {
      targets: [LAN],
      tailscale: { installed: false, running: false },
    })
    const section = await openDevices(page)

    // All devices on this Mac pairs nothing, even when no away tab can.
    await expect(section.getByRole('radiogroup', { name: 'Pairing target' })).toHaveCount(0)
    await expect(section.getByTestId('way-pair-all')).toHaveCount(0)
    await expect(section.locator('#devices-new-name')).toHaveCount(0)
    const ts = await openWay(page, 'tailscale')
    const macStep = ts.locator('.remote-access-step[data-step="mac"]')
    await expect(macStep).toContainText('Get Tailscale from the App Store, then come back here.')
    const link = ts.getByTestId('remote-access-download')
    await expect(link).toHaveAttribute('href', 'https://apps.apple.com/app/tailscale/id1475387142')
    await expect(link).toHaveAttribute('target', '_blank')
    await expect(link).toHaveAttribute('rel', /noopener/)
    // Inside the card, never a banner or a notice box.
    await expect(ts.getByTestId('remote-access-card').locator('.settings-notice')).toHaveCount(0)
    // No pairing box until Tailscale runs: the steps above say what is missing.
    await expect(ts.getByTestId('way-pair-tailscale')).toHaveCount(0)
    await expect(ts.getByTestId('devices-pair-new')).toHaveCount(0)
    await shot(page, 'install-card-lan-only', ts)

    // Pairing still works on Wi-Fi, on its own tab, with no picker.
    const wifi = await openWay(page, 'wifi')
    const wifiPair = wifi.getByTestId('way-pair-wifi')
    await expect(wifiPair).toContainText('Walnut app: pair a phone over Wi-Fi')
    await expect(wifiPair).toContainText("The app tries this Mac's Wi-Fi address first")
    await expect(wifiPair.getByRole('radiogroup')).toHaveCount(0)
    await pairFrom(wifiPair, 'Spare phone')
    await expect.poll(() => mints.length).toBe(1)
    expect(mints[0]).toMatchObject({ name: 'Spare-phone', target: 'lan' })
    await expect(qrDialog(page).locator('img')).toBeVisible({ timeout: 60_000 })
    await expect(qrDialog(page)).toContainText('Points at 192.0.2.10:3456')
  })

  test('Tailscale on this Mac and no companion: the Same Wi-Fi tab still pairs on Wi-Fi (a phone without Tailscale), the Tailscale tab through the tailnet', async ({ page }) => {
    // 2026-11-18 review: a QR carries one address, so a Tailscale address alone must not take
    // away the Wi-Fi code a phone without Tailscale can reach.
    const mints = await mockDevices(page, {
      targets: [LAN, TAILNET],
      tailscale: { installed: true, running: true },
    })
    const section = await openDevices(page)
    await expect(section.getByTestId('devices-phones-group')).toContainText('Work-phone')
    await expect(section.getByTestId('way-pair-all')).toHaveCount(0)
    const wifi = await openWay(page, 'wifi')
    await pairFrom(wifi.getByTestId('way-pair-wifi'), 'Home phone')
    await expect.poll(() => mints.length).toBe(1)
    expect(mints[0]).toMatchObject({ name: 'Home-phone', target: 'lan' })
    await expect(qrDialog(page)).toContainText('Points at 192.0.2.10:3456', { timeout: 60_000 })
    await qrDialog(page).getByTestId('devices-qr-done').click()

    const ts = await openWay(page, 'tailscale')
    const tsPair = ts.getByTestId('way-pair-tailscale')
    await expect(tsPair).toContainText('the phone needs Tailscale on to connect the first time')
    await pairFrom(tsPair, 'Travel phone')
    await expect.poll(() => mints.length).toBe(2)
    expect(mints[1]).toMatchObject({ name: 'Travel-phone', target: 'tailnet' })
    await expect(qrDialog(page)).toContainText('Points at 100.101.102.103:3456', { timeout: 60_000 })
  })

  test('Tailscale installed but stopped: the card asks to open it, and its tab pairs once the address is there', async ({ page }) => {
    await mockDevices(page, {
      targets: [LAN, CLOUD],
      tailscale: { installed: true, running: false },
    })
    const section = await openDevices(page)
    // Each way pairs on its own tab, so All devices has no pairing.
    await expect(section.getByTestId('devices-phones-group')).toContainText('Work-phone')
    await expect(section.getByTestId('way-pair-all')).toHaveCount(0)

    const ts = await openWay(page, 'tailscale')
    await expect(ts.locator('.remote-access-step[data-step="mac"]')).toContainText('Open Tailscale and sign in')
    await expect(ts.getByTestId('remote-access-open')).toBeVisible()
    // No tailnet address yet: no pairing box (the steps say what to do first).
    await expect(ts.getByTestId('way-pair-tailscale')).toHaveCount(0)
    await expect(ts.locator('#devices-new-name')).toHaveCount(0)
    await shot(page, 'not-connected-card-pair', ts)
  })

  test('no line when the server does not report Tailscale; the card still reads its own endpoint', async ({ page }) => {
    await mockDevices(page, { targets: [LAN, CLOUD] })
    const section = await openDevices(page)
    await expect(section.getByTestId('devices-phones-group')).toContainText('Work-phone')
    const ts = await openWay(page, 'tailscale')
    await expect(ts.locator('.remote-access-step[data-step="mac"]')).toContainText('Get Tailscale from the App Store, then come back here.')
  })

  // A companion console, as a current companion answers /api/config (a replica with the public
  // door) and as an older one does (only `cloud: true`, no role or capability list).
  const COMPANION_CONFIG: Array<[string, (body: Record<string, unknown>) => Record<string, unknown>]> = [
    ['current', (body) => ({ ...body, cloud: true, role: 'replica', serverCapabilities: ['public-door', 'bridge-door', 'cloud-exec', 'backup-leader'] })],
    ['older', ({ role: _role, serverCapabilities: _caps, ...body }) => ({ ...body, cloud: true })],
  ]
  for (const [age, configOf] of COMPANION_CONFIG) test(`cloud companion (${age}): the line stays hidden even if the field comes through`, async ({ page }) => {
    // The only target is the box itself.
    await page.route((url) => url.pathname === '/api/config', async (route) => {
      if (route.request().method() !== 'GET') return route.continue()
      const res = await route.fetch()
      return json(route, configOf((await res.json()) as Record<string, unknown>))
    })
    await mockDevices(page, {
      targets: [{ kind: 'cloud', origin: 'https://walnut.example.com', label: 'This server' }],
      tailscale: { installed: false, running: false },
    })
    const section = await openDevices(page)
    await expect(section.getByTestId('devices-phones-group')).toContainText('Work-phone')
    // The companion's own console pairs a phone on All devices, through its own address.
    const pair = section.getByTestId('way-pair-all')
    await expect(pair).toContainText('Walnut app: pair a new phone')
    await expect(pair).toContainText('The QR code points the phone at this server')
    await expect(pair.getByTestId('devices-pair-new')).toBeVisible()
    // The replica flag hides the line and the guided card alike, and the Tailscale and
    // tunnel tabs are not offered there.
    await expect(section.getByTestId('remote-access-card')).toHaveCount(0)
    await expect(page.getByTestId('pc-tab-cloud')).toBeVisible()
    await expect(page.getByTestId('pc-tab-devices-tailscale')).toHaveCount(0)
    await expect(page.getByTestId('pc-tab-devices-browser')).toHaveCount(0)
    await expect(page.getByTestId('pc-tab-devices-wifi')).toHaveCount(0)
  })

  test('a phone paired while the first list read is still out shows up in the list', async ({ page }) => {
    // A reopened page paints the list this browser kept (useDevicesData's last-good view), so
    // its pairing is offered before the first read answers. The tailnet probe makes that read
    // slow on a real server. Each GET answers with the list as it was when the request ARRIVED,
    // so a read that began before the pairing is stale.
    await page.addInitScript((lan) => {
      const value = {
        devices: [], cloudDevices: [], cloudReadAt: null, cloudStale: false, targets: [lan],
        tailscaleStale: false, tailscaleAt: null, cloudError: null, cloudUnpaired: false, cloudWithheld: false,
      }
      localStorage.setItem('walnut:last-good:devices:v1', JSON.stringify({ v: 1, at: Date.now(), value }))
    }, LAN)
    const paired: string[] = []
    let gets = 0
    let firstAnswered = false
    // The first read is held until well after the pairing (and its own read) is done.
    let releaseFirst: () => void = () => {}
    const firstGate = new Promise<void>((r) => { releaseFirst = r })
    await page.route((url) => url.pathname === '/api/devices', async (route) => {
      if (route.request().method() === 'POST') {
        const body = route.request().postDataJSON() as { name: string; target?: string }
        paired.push(body.name)
        setTimeout(releaseFirst, 2_000)
        return json(route, { name: body.name, token: 'tok-race', target: body.target, server: LAN.origin, pairingURI: 'wn://pair?token=tok-race' })
      }
      const snapshot = paired.map((name) => ({ name, createdAt: day(0), role: 'phone' }))
      const first = ++gets === 1
      if (first) await firstGate
      await json(route, { devices: snapshot, cloudDevices: [], targets: [LAN], tailscale: { installed: true, running: true } })
      if (first) firstAnswered = true
    })
    await openDevices(page, { waitForList: false })
    // The kept list shows at once (the Same Wi-Fi tab pairs) while the first read is still out.
    const section = await openWay(page, 'wifi')
    await expect(section.getByTestId('way-pair-wifi')).toBeVisible({ timeout: 30_000 })
    expect(firstAnswered).toBe(false)
    await pairFrom(section.getByTestId('way-pair-wifi'), 'Early phone')
    await expect(qrDialog(page).locator('img')).toBeVisible({ timeout: 30_000 })
    expect(paired).toEqual(['Early-phone'])
    expect(firstAnswered).toBe(false)
    await expect(section.locator('.devices-row[data-device-name="Early-phone"]')).toHaveCount(1, { timeout: 15_000 })
    // The slow first read lands last and must not wipe the row.
    await expect.poll(() => firstAnswered, { timeout: 15_000 }).toBe(true)
    await page.waitForTimeout(500)
    await expect(section.locator('.devices-row[data-device-name="Early-phone"]')).toHaveCount(1)
    await expect(section).not.toContainText('No phone is paired with this Mac yet.')
  })
})
