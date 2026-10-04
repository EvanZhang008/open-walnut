/**
 * Settings → Phones & Cloud: the tailnet pairing address and the Tailscale line.
 *
 * GET /api/devices may list a third pairing target, `tailnet` (this machine's
 * 100.64/10 address), between this network and the cloud, plus a `tailscale`
 * status field. A phone paired through any address learns the others by itself,
 * so the picker only chooses the address in the QR. When the machine has no
 * tailnet address, the guided card above "Pair a phone" says how to get one
 * (its own states: remote-access-card.spec.ts).
 *
 * The device list and the mint are served by page.route fixtures with neutral
 * names (nothing is paired on the fixture server). Navigation is by real clicks.
 *
 * Runs in both engines: Chromium by default, WebKit (the Mac app is a
 * WKWebView) with `PW_WEBKIT=1 ... --project=webkit`.
 */
import { mkdirSync } from 'node:fs'
import { test, expect, type Page, type Route } from '@playwright/test'

test.setTimeout(120_000)

const SHOTS = '/tmp/tailnet-target'
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
  const section = page.locator('#devices')
  await expect(section).toBeVisible()
  if (waitForList) await expect(section).not.toContainText('Loading paired phones...', { timeout: 30_000 })
  return section
}

/** The section (or `region` of it), at most 1280 CSS px wide; one file per engine. */
async function shot(page: Page, name: string, region = page.locator('#devices')) {
  mkdirSync(SHOTS, { recursive: true })
  const engine = page.context().browser()?.browserType().name() ?? 'browser'
  await region.screenshot({ path: `${SHOTS}/${engine}-${name}.png`, scale: 'css' })
}

test.describe('Settings → Phones & Cloud tailnet pairing', () => {
  test('three targets: picker lists Wi-Fi, Tailscale, Cloud; a Tailscale pairing QR points at the 100.x address', async ({ page }) => {
    const mints = await mockDevices(page, {
      targets: [LAN, TAILNET, CLOUD],
      tailscale: { installed: true, running: true, dnsName: 'studio-mac.example.ts.net' },
    })
    const section = await openDevices(page)

    const picker = section.getByRole('radiogroup', { name: 'Pairing target' })
    await expect(picker).toBeVisible()
    const segments = picker.getByRole('radio')
    await expect(segments).toHaveCount(3)
    // Server order, server labels.
    await expect(segments.nth(0)).toContainText('Wi-Fi')
    await expect(segments.nth(1)).toContainText('Tailscale')
    await expect(segments.nth(2)).toContainText('Cloud')
    await expect(section.getByTestId('devices-target-tailnet')).toHaveAttribute('title', '100.101.102.103:3456')
    // The first pick is unchanged: this network, the address a phone next to this machine reaches now.
    await expect(section.getByTestId('devices-target-lan')).toHaveAttribute('aria-checked', 'true')
    await expect(section.getByTestId('devices-target-tailnet')).toHaveAttribute('aria-checked', 'false')
    // Every option is fully on screen: the track scrolls sideways when it overflows, which would hide Cloud.
    const track = (await picker.boundingBox())!
    for (let i = 0; i < 3; i++) {
      const box = (await segments.nth(i).boundingBox())!
      expect(box.x, `segment ${i} left edge`).toBeGreaterThanOrEqual(track.x - 0.5)
      expect(box.x + box.width, `segment ${i} right edge`).toBeLessThanOrEqual(track.x + track.width + 0.5)
    }
    // Tailscale is running and offered: no install line.

    await section.getByTestId('devices-target-tailnet').click()
    await expect(section.getByTestId('devices-target-tailnet')).toHaveAttribute('aria-checked', 'true')
    const pickerRow = section.locator('.settings-row', { has: page.getByRole('radiogroup', { name: 'Pairing target' }) })
    await expect(pickerRow).toContainText('Works anywhere the phone is on the same tailnet as this machine, including cellular.')
    await shot(page, 'three-targets-tailnet-selected')

    await section.locator('#devices-new-name').fill('Travel phone')
    await section.getByRole('button', { name: /Pair new device/i }).click()
    await expect.poll(() => mints.length).toBe(1)
    expect(mints[0]).toMatchObject({ name: 'Travel-phone', target: 'tailnet' })

    const qr = section.locator('.devices-qr-block img')
    await expect(qr).toBeVisible({ timeout: 60_000 })
    expect(await qr.getAttribute('src')).toMatch(/^data:image\/png;base64,/)
    const hint = section.locator('.devices-qr-hint')
    await expect(hint).toContainText('Points at 100.101.102.103:3456')
    // The QR rows are display:contents, so frame the whole "Pair a phone" group.
    const pairGroup = section.locator('.settings-group-block', { hasText: 'Pair a phone' })
    await pairGroup.scrollIntoViewIfNeeded()
    await shot(page, 'three-targets-tailnet-qr', pairGroup)
    await section.getByRole('button', { name: /^Done$/ }).click()
    await expect(section.locator('.devices-qr-block')).toHaveCount(0)
    // The picker keeps the address the user picked for the next pairing.
    await expect(section.getByTestId('devices-target-tailnet')).toHaveAttribute('aria-checked', 'true')
  })

  test('re-pair: a Wi-Fi-only phone gets a tailnet QR, a phone with a cloud credential stays on the cloud', async ({ page }) => {
    const mints = await mockDevices(page, {
      targets: [LAN, TAILNET, CLOUD],
      tailscale: { installed: true, running: true },
    })
    const section = await openDevices(page)

    const local = section.locator('.devices-row[data-device-name="Kitchen-tablet"]').getByTestId('devices-show-qr')
    await local.click()
    await expect(local).toHaveText('Confirm new QR')
    await local.click()
    await expect.poll(() => mints.length).toBe(1)
    expect(mints[0]).toMatchObject({ name: 'Kitchen-tablet', target: 'tailnet', replace: true })
    await expect(section.locator('.devices-qr-hint')).toContainText('Points at 100.101.102.103:3456')
    await expect(section.getByTestId('devices-target-tailnet')).toHaveAttribute('aria-checked', 'true')
    await section.getByRole('button', { name: /^Done$/ }).click()

    const both = section.locator('.devices-row[data-device-name="Work-phone"]').getByTestId('devices-show-qr')
    await both.click()
    await both.click()
    await expect.poll(() => mints.length).toBe(2)
    expect(mints[1]).toMatchObject({ name: 'Work-phone', target: 'cloud', replace: true })
    await expect(section.getByTestId('devices-target-cloud')).toHaveAttribute('aria-checked', 'true')
  })

  test('no tailnet address and Tailscale missing: the guided card says how', async ({ page }) => {
    const mints = await mockDevices(page, {
      targets: [LAN],
      tailscale: { installed: false, running: false },
    })
    const section = await openDevices(page)

    // One target: no picker; the card says what to do.
    await expect(section.getByRole('radiogroup', { name: 'Pairing target' })).toHaveCount(0)
    const macStep = section.locator('.remote-access-step[data-step="mac"]')
    await expect(macStep).toContainText('Get Tailscale from the App Store, then come back here.')
    const link = section.getByTestId('remote-access-download')
    await expect(link).toHaveAttribute('href', 'https://apps.apple.com/app/tailscale/id1475387142')
    await expect(link).toHaveAttribute('target', '_blank')
    await expect(link).toHaveAttribute('rel', /noopener/)
    // Inside the section, never a banner or a notice box.
    await expect(section.locator('.settings-notice')).toHaveCount(0)
    await shot(page, 'install-card-lan-only')

    // Pairing still works on Wi-Fi with the card showing.
    await section.locator('#devices-new-name').fill('Spare phone')
    await section.getByRole('button', { name: /Pair new device/i }).click()
    await expect.poll(() => mints.length).toBe(1)
    expect(mints[0]).toMatchObject({ name: 'Spare-phone', target: 'lan' })
    await expect(section.locator('.devices-qr-block img')).toBeVisible({ timeout: 60_000 })
  })

  test('Tailscale installed but stopped: the card asks to open it, and the picker row carries no extra line', async ({ page }) => {
    await mockDevices(page, {
      targets: [LAN, CLOUD],
      tailscale: { installed: true, running: false },
    })
    const section = await openDevices(page)

    const picker = section.getByRole('radiogroup', { name: 'Pairing target' })
    await expect(picker.getByRole('radio')).toHaveCount(2)
    await expect(section.locator('.remote-access-step[data-step="mac"]')).toContainText('Open Tailscale and sign in')
    await expect(section.getByTestId('remote-access-open')).toBeVisible()
    // Switching target swaps only the target sentence.
    const pickerRow = section.locator('.settings-row', { has: page.getByRole('radiogroup', { name: 'Pairing target' }) })
    await section.getByTestId('devices-target-lan').click()
    await expect(pickerRow).toContainText('Works only while the phone is on the same Wi-Fi as this Mac.')
    await shot(page, 'not-connected-card-picker')
  })

  test('no line when the server does not report Tailscale; the card still reads its own endpoint', async ({ page }) => {
    await mockDevices(page, { targets: [LAN, CLOUD] })
    const section = await openDevices(page)
    await expect(section.getByRole('radiogroup', { name: 'Pairing target' })).toBeVisible()
    await expect(section.locator('.remote-access-step[data-step="mac"]')).toContainText('Get Tailscale from the App Store, then come back here.')
  })

  test('cloud companion: the line stays hidden even if the field comes through', async ({ page }) => {
    // A companion console: /api/config says cloud, the only target is the box itself.
    await page.route((url) => url.pathname === '/api/config', async (route) => {
      if (route.request().method() !== 'GET') return route.continue()
      const res = await route.fetch()
      const body = (await res.json()) as Record<string, unknown>
      return json(route, { ...body, cloud: true })
    })
    await mockDevices(page, {
      targets: [{ kind: 'cloud', origin: 'https://walnut.example.com', label: 'This server' }],
      tailscale: { installed: false, running: false },
    })
    const section = await openDevices(page)
    await expect(section.locator('#devices-new-name')).toBeVisible()
    // The replica flag hides the line and the guided card alike.
    await expect(section.getByTestId('remote-access-card')).toHaveCount(0)
  })

  test('a phone paired while the first list read is still out shows up in the list', async ({ page }) => {
    // The tailnet probe makes the first GET slow on a real server. Each GET answers with the
    // list as it was when the request ARRIVED, so a read that began before the pairing is stale.
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
    const section = await openDevices(page, { waitForList: false })
    await expect(section).toContainText('Loading paired phones...')
    await section.locator('#devices-new-name').fill('Early phone')
    await section.getByRole('button', { name: /Pair new device/i }).click()
    await expect(section.locator('.devices-qr-block img')).toBeVisible({ timeout: 30_000 })
    expect(paired).toEqual(['Early-phone'])
    await expect(section.locator('.devices-row[data-device-name="Early-phone"]')).toHaveCount(1, { timeout: 15_000 })
    // The slow first read lands last and must not wipe the row.
    await expect.poll(() => firstAnswered, { timeout: 15_000 }).toBe(true)
    await page.waitForTimeout(500)
    await expect(section.locator('.devices-row[data-device-name="Early-phone"]')).toHaveCount(1)
    await expect(section).not.toContainText('No phones paired yet.')
  })
})
