/**
 * Settings > Phones & Cloud > Same Wi-Fi: a browser on the same Wi-Fi signs in with no tunnel
 * (2026-11-20: the only sign-in code was on the tunnel's tab, and only while a tunnel was
 * connected, so a Walnut without one could not sign any browser in; 2026-11-21 it moved from
 * All devices to its own way's tab).
 *
 *   1. "Sign in a browser on this Wi-Fi" is its own group on the Same Wi-Fi tab, right after the
 *      tab's pairing (what adds a device first), then the phones and the signed-in browsers. Get sign-in code shows the Wi-Fi address,
 *      the code and the QR of the link; a second browser opening that link is signed in by it,
 *      and this tab then says so and lists it (All devices lists it too, and offers no Wi-Fi
 *      code of its own).
 *   1b. Another code's sign-in (the tunnel's, the extension's) leaves the row's code on screen;
 *      New code takes the shown code back, so it no longer signs anyone in.
 *   2. Where it does not belong: a browser signed in with a code (the server refuses it every
 *      code) and a list with no Wi-Fi address show no such row; a refused code says why.
 *
 * Codes are real (minted on the fixture, traded at the real POST /api/v1/browser-pair). The
 * fixture listens on loopback only, so the second browser opens the link's `#pair=` code at the
 * fixture's own address; that an untrusted browser is sent to the sign-in page and trades a code
 * there is sign-in-page.spec.ts and browser-access-tunnel.spec.ts. Navigation in this page is
 * by clicks.
 */
import os from 'node:os'
import { mkdirSync } from 'node:fs'
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { isolateUiPrefs } from './todo-panel-helpers'
import { mintBrowserCode } from './sign-in-state'
import { backToDevices, openWay } from './devices-ways-helpers'
import { dropFakes } from './route-teardown'

test.setTimeout(120_000)

const SHOTS = process.env.PW_SHOTS_DIR ?? '/tmp/devices-wifi-sign-in'

/** This machine's first IPv4 address on a network, as the Mac's Wi-Fi address (a documentation one when it has none). */
function networkAddress(): string {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) return a.address
  }
  return '192.0.2.10'
}

/** Settings > Phones & Cloud by clicks, then the Same Wi-Fi tab; returns its section. */
async function openWifiTab(page: Page) {
  await page.goto('/')
  await page.waitForLoadState('domcontentloaded')
  await page.getByRole('link', { name: /settings/i }).first().click()
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('settings-nav-devices').click()
  await expect(page.getByTestId('pc-tabs')).toBeVisible({ timeout: 30_000 })
  const section = await openWay(page, 'wifi')
  await expect(section).not.toContainText('Loading paired phones…', { timeout: 30_000 })
  return section
}

/** How many browsers the server lists as signed in. */
const browserNames = async (request: APIRequestContext) =>
  ((await (await request.get('/api/devices')).json()) as { devices: Array<{ role?: string, name: string }> }).devices.filter((d) => d.role === 'browser').map((d) => d.name)

const shot = (page: Page, name: string) => (mkdirSync(SHOTS, { recursive: true }),
  page.locator('.settings-pane').screenshot({ path: `${SHOTS}/${name}.png`, scale: 'css' }))

test.beforeEach(async ({ page }) => {
  await isolateUiPrefs(page)
  await page.setViewportSize({ width: 1280, height: 900 })
})

// A list read still in flight through a fake as the test ends must not fail it.
test.afterEach(async ({ page }) => { await dropFakes(page) })

test('1. a browser on this Wi-Fi signs in with the code, no tunnel', async ({ page, browser, baseURL }) => {
  const ip = networkAddress()
  const port = new URL(baseURL!).port
  const lan = `http://${ip}:${port}`
  // The list as this Mac sees it, its Wi-Fi address included; the rest is the real server.
  await page.route((url) => url.pathname === '/api/devices', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    const res = await route.fetch()
    const body = await res.json() as Record<string, unknown>
    await route.fulfill({ response: res, json: { ...body, targets: [{ kind: 'lan', origin: lan, label: 'This network (Wi-Fi)' }] } })
  })
  const section = await openWifiTab(page)
  const group = section.getByTestId('devices-wifi-browser')
  await expect(group.locator('.settings-group-heading')).toContainText('Web browser: sign in')
  const row = group.getByTestId('devices-wifi-sign-in')
  await expect(row).toContainText('One-time sign-in code')
  await expect(row).toContainText(`open ${ip}:${port}`)
  // What adds a device first (pairing the app, this sign-in), then the phones.
  const order = await section.locator('[data-testid="way-pair-wifi"], [data-testid="devices-wifi-browser"], [data-testid="way-devices-wifi"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')))
  expect(order).toEqual(['way-pair-wifi', 'devices-wifi-browser', 'way-devices-wifi'])
  await expect(row).toContainText('sign it out below when done')
  // All devices lists browsers; it offers no Wi-Fi code of its own.
  const all = await backToDevices(page)
  await expect(all.getByTestId('devices-wifi-sign-in')).toHaveCount(0)
  await openWay(page, 'wifi')
  await shot(page, '1-row')

  await row.getByTestId('devices-wifi-get-code').click()
  const value = row.getByTestId('devices-wifi-code-value')
  await expect(value).toHaveText(/^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/, { timeout: 30_000 })
  await expect(row.getByTestId('devices-wifi-address')).toHaveText(lan)
  // The link carries the code as the server wrote it (ABCD-EFGH; the trade reads it with or without the dash).
  const code = (await value.textContent())!
  const link = `${lan}/#pair=${code}`
  await expect(row.getByTestId('devices-wifi-qr')).toHaveAttribute('data-for', link)
  await expect(row.getByTestId('devices-wifi-get-code')).toHaveText('New code')
  await shot(page, '1-code')

  // Another device on the network opens the link: it is signed in and lands in the console.
  const other = await browser.newContext()
  try {
    const phone = await other.newPage()
    // Other specs on this fixture sign browsers in and out meanwhile: follow this one by its name.
    const before = new Set(await browserNames(page.request))
    // The link's code, opened where this fixture answers (see the header).
    await phone.goto(`${baseURL!.replace(/\/+$/, '')}/#pair=${new URL(link).hash.slice('#pair='.length)}`)
    // The page reloads once it traded the code: a read during that reload is no answer yet.
    await expect.poll(async () => phone.evaluate(() => localStorage.getItem('walnut.deviceToken')).catch(() => null), { timeout: 60_000 }).toBeTruthy()
    await expect(phone.getByRole('link', { name: /settings/i }).first()).toBeVisible({ timeout: 30_000 })
    // This tab: the code is used up, and the new browser is listed below it.
    await expect(section.getByTestId('devices-wifi-signed-in')).toContainText('A browser just signed in', { timeout: 30_000 })
    await expect(row.getByTestId('devices-wifi-code-value')).toHaveCount(0)
    await expect(row.getByTestId('devices-wifi-get-code')).toHaveText('Get sign-in code')
    let added = ''
    await expect.poll(async () => (added = (await browserNames(page.request)).find((n) => !before.has(n)) ?? ''), { timeout: 30_000 }).not.toBe('')
    const browsers = section.getByTestId('devices-browsers-group')
    await expect(browsers.locator(`.devices-row[data-device-name="${added}"]`)).toHaveCount(1, { timeout: 60_000 })
    const order = await section.locator('[data-testid="devices-wifi-browser"], [data-testid="devices-browsers-group"], [data-testid="way-devices-wifi"]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')))
    expect(order).toEqual(['devices-wifi-browser', 'way-devices-wifi', 'devices-browsers-group'])
    await shot(page, '1-signed-in')
    // All devices lists it too.
    const all = await backToDevices(page)
    await expect(all.getByTestId('devices-browsers-group').locator(`.devices-row[data-device-name="${added}"]`)).toHaveCount(1, { timeout: 30_000 })
  } finally {
    await other.close()
  }
})

test('1b. another code\'s sign-in leaves the row\'s code; New code takes the shown one back', async ({ page }) => {
  await page.route((url) => url.pathname === '/api/devices', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    const res = await route.fetch()
    const body = await res.json() as Record<string, unknown>
    await route.fulfill({ response: res, json: { ...body, targets: [{ kind: 'lan', origin: 'http://192.0.2.10:3456', label: 'This network (Wi-Fi)' }] } })
  })
  const section = await openWifiTab(page)
  const row = section.getByTestId('devices-wifi-sign-in')
  await row.getByTestId('devices-wifi-get-code').click()
  const value = row.getByTestId('devices-wifi-code-value')
  await expect(value).toHaveText(/^[2-9A-Z]{4}-[2-9A-Z]{4}$/, { timeout: 30_000 })
  const shown = (await value.textContent())!

  // Another code is used (as the tunnel's tab or the extension would): the row keeps its own.
  const other = await mintBrowserCode(page.request)
  const traded = await page.request.post('/api/v1/browser-pair', { data: { code: other.code } })
  expect(traded.ok(), await traded.text()).toBe(true)
  await expect(section.getByTestId('devices-browsers-group').locator('.devices-row')).not.toHaveCount(0, { timeout: 30_000 })
  await page.waitForTimeout(1_000)
  await expect(value).toHaveText(shown)
  await expect(section.getByTestId('devices-wifi-signed-in')).toHaveCount(0)

  // New code: the one shown before no longer signs in.
  await row.getByTestId('devices-wifi-get-code').click()
  await expect(value).not.toHaveText(shown, { timeout: 30_000 })
  await expect(value).toHaveText(/^[2-9A-Z]{4}-[2-9A-Z]{4}$/)
  await expect.poll(async () => (await page.request.post('/api/v1/browser-pair', { data: { code: shown } })).status(), { timeout: 15_000 }).toBe(400)
})

test('2. no row for a browser signed in with a code, none without a Wi-Fi address; a refused code says why', async ({ page }) => {
  let lan = true
  let refuse = false
  await page.route((url) => url.pathname === '/api/devices', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    await route.fulfill({ json: {
      devices: [], cloudDevices: [],
      targets: lan ? [{ kind: 'lan', origin: 'http://192.0.2.10:3456', label: 'This network (Wi-Fi)' }] : [],
    } })
  })
  await page.route((url) => url.pathname === '/api/devices/browser-code', async (route) => {
    if (refuse) return route.fulfill({ status: 500, json: { error: 'The code could not be made.' } })
    return route.fallback()
  })
  const section = await openWifiTab(page)
  const row = section.getByTestId('devices-wifi-sign-in')
  await expect(row).toBeVisible()
  refuse = true
  const group = section.getByTestId('devices-wifi-browser')
  await row.getByTestId('devices-wifi-get-code').click()
  await expect(group).toContainText('The code could not be made.', { timeout: 30_000 })
  await expect(row.getByTestId('devices-wifi-get-code')).toBeEnabled()
  // And again, once the server makes one.
  refuse = false
  await row.getByTestId('devices-wifi-get-code').click()
  await expect(row.getByTestId('devices-wifi-code-value')).toBeVisible({ timeout: 30_000 })
  await expect(group).not.toContainText('The code could not be made.')

  // No Wi-Fi address in the list: no row, and the group says why (another tab, then this one,
  // reads the list again).
  lan = false
  await page.getByTestId('pc-tab-cloud').click()
  await page.getByTestId('pc-tab-devices-wifi').click()
  await expect(section.getByTestId('devices-wifi-sign-in')).toHaveCount(0, { timeout: 30_000 })
  await expect(section.getByTestId('devices-wifi-browser')).toContainText("This Mac's address on the network can't be detected right now")
})

test('2b. a browser signed in with a code is offered no Wi-Fi code', async ({ page }) => {
  // A real browser token, traded for a real code, as a phone's browser holds one.
  const { code } = await mintBrowserCode(page.request)
  const pair = await page.request.post('/api/v1/browser-pair', { data: { code } })
  expect(pair.ok(), await pair.text()).toBe(true)
  const { token } = await pair.json() as { token: string }
  await page.addInitScript((t) => { localStorage.setItem('walnut.deviceToken', t) }, token)
  await page.route((url) => url.pathname === '/api/devices', (route) => route.fulfill({ json: {
    devices: [{ name: 'browser-1a2b3c', createdAt: new Date().toISOString(), role: 'browser' }], cloudDevices: [],
    targets: [{ kind: 'lan', origin: 'http://192.0.2.10:3456', label: 'This network (Wi-Fi)' }],
  } }))
  const section = await openWifiTab(page)
  // Signed in itself (listed), and offered no Wi-Fi code or pairing on its way's tab.
  await expect(section.getByTestId('devices-browsers-group').locator('.devices-row')).toHaveCount(1, { timeout: 30_000 })
  await expect(section.getByTestId('devices-wifi-sign-in')).toHaveCount(0)
  await expect(section.getByTestId('devices-wifi-browser')).toHaveCount(0)
  await expect(section.getByTestId('way-pair-wifi')).toHaveCount(0)
  const all = await backToDevices(page)
  await expect(all.getByTestId('devices-browsers-group').locator('.devices-row')).toHaveCount(1, { timeout: 30_000 })
  await expect(all.getByTestId('devices-wifi-sign-in')).toHaveCount(0)
})
