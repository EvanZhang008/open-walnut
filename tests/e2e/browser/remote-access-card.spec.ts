/**
 * Settings → Phones & Cloud: the "Reach Walnut from anywhere" card.
 *
 * Three numbered steps with a status dot each (muted / amber / green), fed by
 * GET /api/devices/tailscale (polled every 5s while step 1 or 2 is open) and
 * the paired-device list. Both endpoints are page.route fixtures with neutral
 * names, so nothing is installed, opened or paired for real; the install and
 * open POSTs are recorded. Navigation is by real clicks.
 *
 * Runs in both engines: Chromium by default, WebKit (the Mac app is a
 * WKWebView) with `PW_WEBKIT=1 ... --project=webkit`.
 */
import { mkdirSync } from 'node:fs'
import { test, expect, type Locator, type Page, type Route } from '@playwright/test'

test.setTimeout(120_000)

const SHOTS = '/tmp/remote-access-card'
const LAN = { kind: 'lan', origin: 'http://192.0.2.10:3456', label: 'This network (Wi-Fi)' }
const TAILNET = { kind: 'tailnet', origin: 'http://100.101.102.103:3456', label: 'Tailscale (anywhere this machine is on)' }
const CLOUD = { kind: 'cloud', origin: 'https://walnut.example.com', label: 'Cloud (anywhere)' }
const APP_STORE = 'https://apps.apple.com/app/tailscale/id1470499037'
const PLAY = 'https://play.google.com/store/apps/details?id=com.tailscale.ipn'

const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString()
const PAIRED_PHONE = { name: 'Work-phone', createdAt: day(30), lastUsedAt: day(0), role: 'phone', info: { model: 'iPhone18,2', os: 'iOS 26.1', appVersion: '1.0 (84)' } }
const SELF = { name: 'this-mac-sync', createdAt: day(60), role: 'self' }

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })

type Detail = Record<string, unknown>
const NOT_INSTALLED: Detail = { installed: false, running: false, peers: [], install: { brew: true, macOS: true, job: null } }
const RUNNING: Detail = {
  installed: true, running: true, dnsName: 'studio-mac.tail1234.ts.net', address: '100.101.102.103',
  peers: [{ hostName: 'build-box', os: 'linux', online: true }],
  install: { brew: true, job: null },
}

interface Fixture {
  /** What GET /api/devices/tailscale answers right now (tests flip it). */
  detail: Detail
  list: { devices: unknown[]; cloudDevices: unknown[]; targets: unknown[] }
}

/** Serve both endpoints from `fx` (read at request time) and count what the card asked. */
async function mockEndpoints(page: Page, fx: Fixture) {
  const calls = { gets: 0, refreshGets: 0, installs: 0, opens: 0, listGets: 0 }
  await page.route((url) => url.pathname.startsWith('/api/devices/tailscale'), async (route) => {
    const req = route.request()
    const url = new URL(req.url())
    if (req.method() === 'GET' && url.pathname === '/api/devices/tailscale') {
      calls.gets += 1
      if (url.searchParams.get('refresh') === '1') calls.refreshGets += 1
      return json(route, fx.detail)
    }
    if (req.method() === 'POST' && url.pathname === '/api/devices/tailscale/install') {
      calls.installs += 1
      const job = { state: 'running', startedAt: new Date().toISOString(), log: [] }
      fx.detail = { ...fx.detail, install: { brew: true, job } }
      return json(route, { job }, 202)
    }
    if (req.method() === 'POST' && url.pathname === '/api/devices/tailscale/open') {
      calls.opens += 1
      return json(route, { opened: true })
    }
    return json(route, { error: 'Not found' }, 404)
  })
  await page.route((url) => url.pathname === '/api/devices', async (route) => {
    if (route.request().method() !== 'GET') return json(route, { error: 'not in this spec' }, 400)
    calls.listGets += 1
    return json(route, fx.list)
  })
  return calls
}

/** Real-user navigation, as devices-qr-pairing.spec.ts does it (no page.goto to /settings). */
async function openDevices(page: Page) {
  await page.goto('/')
  await page.waitForLoadState('domcontentloaded')
  await page.getByRole('link', { name: /settings/i }).first().click()
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible({ timeout: 30_000 })
  const nav = page.getByTestId('settings-nav-devices')
  await nav.click()
  await expect(nav).toHaveAttribute('aria-current', 'page')
  const section = page.locator('#devices')
  await expect(section).toBeVisible()
  await expect(section).not.toContainText('Loading paired phones...', { timeout: 30_000 })
  return section
}

async function shot(page: Page, name: string, region: Locator) {
  mkdirSync(SHOTS, { recursive: true })
  const engine = page.context().browser()?.browserType().name() ?? 'browser'
  await region.scrollIntoViewIfNeeded()
  await region.screenshot({ path: `${SHOTS}/${engine}-${name}.png`, scale: 'css' })
}

const step = (card: Locator, id: 'mac' | 'phone' | 'pair') => card.locator(`.remote-access-step[data-step="${id}"]`)

test.describe('Settings → Phones & Cloud: Reach Walnut from anywhere', () => {
  test.use({ viewport: { width: 1280, height: 900 } })

  test('(a) not installed with Homebrew: both buttons; Install runs, the log shows, then Open, then connected and the picker gains Tailscale', async ({ page }) => {
    const fx: Fixture = { detail: NOT_INSTALLED, list: { devices: [], cloudDevices: [SELF], targets: [LAN] } }
    const calls = await mockEndpoints(page, fx)
    const section = await openDevices(page)

    const card = section.getByTestId('remote-access-card')
    await expect(card).toBeVisible()
    await expect(card).toContainText('Reach Walnut from anywhere')
    // Placed above "Pair a phone", below the paired list.
    const pairHeading = section.getByRole('heading', { name: 'Pair a phone', exact: true })
    expect((await card.boundingBox())!.y).toBeLessThan((await pairHeading.boundingBox())!.y)

    const mac = step(card, 'mac')
    await expect(mac).toHaveAttribute('data-dot', 'action')
    await expect(mac).toContainText('1. Tailscale on this Mac')
    await expect(mac).toContainText('Get Tailscale from the App Store, then come back here.')
    const install = card.getByTestId('remote-access-install')
    await expect(install).toHaveText('Install with Homebrew')
    // The password-free install is the primary: the Mac App Store, not a .pkg or Homebrew.
    const download = card.getByTestId('remote-access-download')
    await expect(download).toHaveText('Get from the App Store')
    await expect(download).toHaveAttribute('href', 'https://apps.apple.com/app/tailscale/id1475387142')
    await expect(download).toHaveAttribute('target', '_blank')
    await expect(step(card, 'phone')).toHaveAttribute('data-dot', 'pending')
    await expect(step(card, 'pair')).toHaveAttribute('data-dot', 'pending')
    // The App Store QR waits until the Mac is on the tailnet.
    await expect(card.getByTestId('remote-access-stores')).toHaveCount(0)
    await shot(page, 'a1-not-installed', card)

    await install.click()
    await expect.poll(() => calls.installs).toBe(1)
    await expect(mac).toHaveAttribute('data-kind', 'installing')
    await expect(mac).toContainText('Installing with Homebrew...')
    await expect(install).toHaveCount(0)

    // The next polls carry the job's output; only the last three lines show.
    fx.detail = {
      ...NOT_INSTALLED,
      install: { brew: true, job: { state: 'running', startedAt: new Date().toISOString(), log: ['==> Downloading Tailscale-1.102.4-macos.pkg', '######## 100.0%', '==> Installing Cask tailscale-app', '==> Running installer for tailscale-app'] } },
    }
    const logBlock = card.getByTestId('remote-access-log')
    await expect(logBlock).toBeVisible({ timeout: 15_000 })
    await expect(logBlock).toHaveText('######## 100.0%\n==> Installing Cask tailscale-app\n==> Running installer for tailscale-app')
    expect(calls.refreshGets).toBeGreaterThan(0)
    await shot(page, 'a2-installing', card)

    fx.detail = { ...NOT_INSTALLED, installed: true, install: { brew: true, job: { state: 'done', startedAt: new Date().toISOString(), log: ['tailscale-app was successfully installed!'] } } }
    const open = card.getByTestId('remote-access-open')
    await expect(open).toBeVisible({ timeout: 15_000 })
    await expect(open).toHaveText('Open Tailscale')
    await expect(mac).toContainText('Open Tailscale and sign in with Apple, Google, or another account. This page updates by itself.')
    await expect(logBlock).toHaveCount(0)
    await shot(page, 'a3-installed-not-running', card)

    // Connected: step 1 turns green, and the pairing picker is re-read and now offers Tailscale.
    const listReadsBefore = calls.listGets
    fx.list = { ...fx.list, targets: [LAN, TAILNET] }
    fx.detail = { ...RUNNING, install: { brew: true, job: { state: 'done', startedAt: new Date().toISOString(), log: [] } } }
    await expect(mac).toHaveAttribute('data-dot', 'done', { timeout: 15_000 })
    await expect(mac).toContainText('Connected as studio-mac.tail1234.ts.net')
    await expect.poll(() => calls.listGets).toBeGreaterThan(listReadsBefore)
    await expect(section.getByTestId('devices-target-tailnet')).toBeVisible()
    await expect(step(card, 'phone')).toHaveAttribute('data-dot', 'action')
  })

  test('(a2) a failed install shows its sentence and keeps both buttons', async ({ page }) => {
    const error = 'Homebrew needs your Mac password to install Tailscale and cannot ask for it from here. Get Tailscale from the App Store instead, or run brew install --cask tailscale-app in Terminal.'
    const fx: Fixture = {
      detail: { ...NOT_INSTALLED, install: { brew: true, job: { state: 'failed', startedAt: day(0), log: ['sudo: a terminal is required to read the password'], error } } },
      list: { devices: [], cloudDevices: [], targets: [LAN] },
    }
    await mockEndpoints(page, fx)
    const section = await openDevices(page)
    const card = section.getByTestId('remote-access-card')
    await expect(card.getByRole('alert')).toHaveText(error)
    await expect(card.getByTestId('remote-access-install')).toBeVisible()
    await expect(card.getByTestId('remote-access-download')).toBeVisible()
    await shot(page, 'a4-install-failed', card)
  })

  test('(b) installed, not running: Open Tailscale posts once; a sign-in link when the CLI printed one; no polling while hidden', async ({ page }) => {
    const fx: Fixture = {
      detail: { ...NOT_INSTALLED, installed: true, loginUrl: 'https://login.tailscale.com/a/1a2b3c4d' },
      list: { devices: [], cloudDevices: [], targets: [LAN, CLOUD] },
    }
    const calls = await mockEndpoints(page, fx)
    const section = await openDevices(page)
    const card = section.getByTestId('remote-access-card')
    const mac = step(card, 'mac')
    await expect(mac).toHaveAttribute('data-dot', 'action')
    await expect(mac).toContainText('Open Tailscale and sign in with Apple, Google, or another account. This page updates by itself.')
    await expect(card.getByTestId('remote-access-install')).toHaveCount(0)
    const signIn = card.getByTestId('remote-access-sign-in')
    await expect(signIn).toHaveAttribute('href', 'https://login.tailscale.com/a/1a2b3c4d')
    await expect(signIn).toHaveAttribute('target', '_blank')
    await shot(page, 'b1-not-running', card)

    await card.getByTestId('remote-access-open').click()
    await expect.poll(() => calls.opens).toBe(1)
    // The answer has landed (the button is back from "Opening..."), and it said nothing went wrong.
    await expect(card.getByTestId('remote-access-open')).toHaveText('Open Tailscale')
    await expect(card.getByTestId('remote-access-open')).toBeEnabled()
    await expect(card.getByRole('alert')).toHaveCount(0)

    // A hidden tab stops asking; coming back asks at once.
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    // A poll that left just before the tab hid may still land: count from after it.
    await page.waitForTimeout(500)
    const hiddenAt = calls.gets
    await page.waitForTimeout(6_500)
    expect(calls.gets, 'no poll while hidden').toBe(hiddenAt)
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await expect.poll(() => calls.gets, { timeout: 3_000 }).toBeGreaterThan(hiddenAt)
  })

  test('(c) running, an iOS phone online, a phone paired: three green rows, polling slows to a minute', async ({ page }) => {
    const fx: Fixture = {
      detail: { ...RUNNING, peers: [{ hostName: 'pocket-phone', os: 'iOS', online: true }, { hostName: 'build-box', os: 'linux', online: true }] },
      list: { devices: [PAIRED_PHONE], cloudDevices: [SELF], targets: [LAN, TAILNET] },
    }
    const calls = await mockEndpoints(page, fx)
    const section = await openDevices(page)
    const card = section.getByTestId('remote-access-card')
    for (const id of ['mac', 'phone', 'pair'] as const) await expect(step(card, id)).toHaveAttribute('data-dot', 'done')
    await expect(step(card, 'mac')).toContainText('Connected as studio-mac.tail1234.ts.net')
    await expect(step(card, 'phone')).toContainText('Your phone is on the tailnet (pocket-phone)')
    await expect(step(card, 'pair')).toContainText('Already paired: open Walnut on the phone once and it learns the Tailscale route by itself.')
    await expect(card.getByTestId('remote-access-stores')).toHaveCount(0)
    await expect(card.getByTestId('remote-access-use-tailnet')).toHaveCount(0)
    // Green dots are the success colour (globals.css --success), never amber.
    const dotColors = await card.locator('.remote-access-dot').evaluateAll((els) => els.map((el) => getComputedStyle(el).backgroundColor))
    expect(dotColors).toEqual(['rgb(52, 199, 89)', 'rgb(52, 199, 89)', 'rgb(52, 199, 89)'])
    await shot(page, 'c1-all-done', card)

    const before = calls.gets
    await page.waitForTimeout(6_500)
    expect(calls.gets, 'all done: no 5s poll').toBe(before)
  })

  test('(d) running, no phone yet: step 2 is your turn with the App Store QR; step 3 picks the Tailscale address below', async ({ page }) => {
    const fx: Fixture = { detail: RUNNING, list: { devices: [], cloudDevices: [SELF], targets: [LAN, TAILNET, CLOUD] } }
    await mockEndpoints(page, fx)
    const section = await openDevices(page)
    const card = section.getByTestId('remote-access-card')
    const phone = step(card, 'phone')
    await expect(step(card, 'mac')).toHaveAttribute('data-dot', 'done')
    await expect(phone).toHaveAttribute('data-dot', 'action')
    await expect(phone).toContainText('2. Tailscale on your phone')
    await expect(phone).toContainText('Install Tailscale on the phone and sign in with the same account.')
    const qr = card.getByTestId('remote-access-app-store-qr')
    await expect(qr).toBeVisible()
    expect(await qr.getAttribute('src')).toMatch(/^data:image\/png;base64,/)
    const qrBox = (await qr.boundingBox())!
    expect(qrBox.width).toBeLessThanOrEqual(120)
    await expect(card.getByRole('link', { name: 'apps.apple.com/app/tailscale/id1470499037' })).toHaveAttribute('href', APP_STORE)
    await expect(card.getByRole('link', { name: 'play.google.com/store/apps/details?id=com.tailscale.ipn' })).toHaveAttribute('href', PLAY)
    // Green above, amber (globals.css --warning) on the step to do now, muted after it.
    const [doneColor, actionColor, pendingColor] = await Promise.all([
      step(card, 'mac').locator('.remote-access-dot').evaluate((el) => getComputedStyle(el).backgroundColor),
      phone.locator('.remote-access-dot').evaluate((el) => getComputedStyle(el).backgroundColor),
      step(card, 'pair').locator('.remote-access-dot').evaluate((el) => getComputedStyle(el).backgroundColor),
    ])
    expect(doneColor).toBe('rgb(52, 199, 89)')
    expect(actionColor).toBe('rgb(255, 149, 0)')
    expect([doneColor, actionColor]).not.toContain(pendingColor)
    await shot(page, 'd1-phone-step', card)

    // The picker starts on this network; the row moves it to Tailscale and puts the cursor in the name.
    await expect(section.getByTestId('devices-target-lan')).toHaveAttribute('aria-checked', 'true')
    const pair = step(card, 'pair')
    await expect(pair).toContainText('Pair the phone below with the Tailscale address')
    await pair.click()
    await expect(section.getByTestId('devices-target-tailnet')).toHaveAttribute('aria-checked', 'true')
    await expect(section.locator('#devices-new-name')).toBeFocused()
    // The button does the same by keyboard.
    await section.getByTestId('devices-target-lan').click()
    await card.getByTestId('remote-access-use-tailnet').focus()
    await page.keyboard.press('Enter')
    await expect(section.getByTestId('devices-target-tailnet')).toHaveAttribute('aria-checked', 'true')
    await shot(page, 'd2-section', section)
  })

  test('(f) real fixture server, no mocks: the card reads this machine\'s own Tailscale state (nothing is clicked)', async ({ page }) => {
    const answers: number[] = []
    page.on('response', (res) => {
      if (new URL(res.url()).pathname === '/api/devices/tailscale') answers.push(res.status())
    })
    const section = await openDevices(page)
    const card = section.getByTestId('remote-access-card')
    await expect(card).toBeVisible()
    const mac = step(card, 'mac')
    // Whatever this machine has, the first answer lands and names a real state.
    await expect(mac).toHaveAttribute('data-kind', /^(not-installed|installing|not-running|running)$/, { timeout: 15_000 })
    expect(answers.length).toBeGreaterThan(0)
    expect(answers.every((s) => s === 200)).toBe(true)
    if ((await mac.getAttribute('data-kind')) === 'not-installed') {
      await expect(card.getByTestId('remote-access-download')).toBeVisible()
    }
    await shot(page, 'f1-real-server', card)
  })

  test('(e) cloud companion: no card, and the card endpoint is never asked', async ({ page }) => {
    await page.route((url) => url.pathname === '/api/config', async (route) => {
      if (route.request().method() !== 'GET') return route.continue()
      const res = await route.fetch()
      const body = (await res.json()) as Record<string, unknown>
      return json(route, { ...body, cloud: true })
    })
    const fx: Fixture = {
      detail: NOT_INSTALLED,
      list: { devices: [PAIRED_PHONE], cloudDevices: [], targets: [{ kind: 'cloud', origin: 'https://walnut.example.com', label: 'This server' }] },
    }
    const calls = await mockEndpoints(page, fx)
    const section = await openDevices(page)
    await expect(section.locator('#devices-new-name')).toBeVisible()
    await expect(section.getByTestId('remote-access-card')).toHaveCount(0)
    await page.waitForTimeout(1_000)
    await expect(section.getByTestId('remote-access-card')).toHaveCount(0)
    expect(calls.gets).toBe(0)
  })
})
