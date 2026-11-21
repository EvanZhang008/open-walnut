/**
 * Settings > Phones & Cloud > All devices: a browser on the same Wi-Fi signs in with no tunnel
 * (2026-11-20: the only sign-in code was on the tunnel's tab, and only while a tunnel was
 * connected, so a Walnut without one could not sign any browser in).
 *
 *   1. "Sign in a browser on this Wi-Fi" shows under Signed-in browsers, with none signed in yet.
 *      Get a code shows the Wi-Fi address, the code and the QR of the link; a second browser
 *      opening that link is signed in by it, and this page then says so and lists it.
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
import { expect, test, type Page } from '@playwright/test'
import { isolateUiPrefs } from './todo-panel-helpers'
import { mintBrowserCode } from './sign-in-state'

test.setTimeout(120_000)

const SHOTS = process.env.PW_SHOTS_DIR ?? '/tmp/devices-wifi-sign-in'

/** This machine's first IPv4 address on a network, as the Mac's Wi-Fi address (a documentation one when it has none). */
function networkAddress(): string {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) return a.address
  }
  return '192.0.2.10'
}

async function openAllDevices(page: Page) {
  await page.goto('/')
  await page.waitForLoadState('domcontentloaded')
  await page.getByRole('link', { name: /settings/i }).first().click()
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('settings-nav-devices').click()
  await expect(page.getByTestId('pc-tabs')).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('pc-tab-devices-phones').click()
  const section = page.locator('#devices-phones')
  await expect(section).not.toContainText('Loading paired phones...', { timeout: 30_000 })
  return section
}

const shot = (page: Page, name: string) => (mkdirSync(SHOTS, { recursive: true }),
  page.locator('.settings-pane').screenshot({ path: `${SHOTS}/${name}.png`, scale: 'css' }))

test.beforeEach(async ({ page }) => {
  await isolateUiPrefs(page)
  await page.setViewportSize({ width: 1280, height: 900 })
})

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
  const section = await openAllDevices(page)
  const group = section.getByTestId('devices-browsers-group')
  const row = group.getByTestId('devices-wifi-sign-in')
  await expect(row).toContainText('Sign in a browser on this Wi-Fi')
  await expect(row).toContainText(`it opens ${ip}:${port} and types a one-time code`)
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
    const before = (await (await page.request.get('/api/devices')).json() as { devices: Array<{ name: string; role?: string }> }).devices.filter((d) => d.role === 'browser').length
    // The link's code, opened where this fixture answers (see the header).
    await phone.goto(`${baseURL!.replace(/\/+$/, '')}/#pair=${new URL(link).hash.slice('#pair='.length)}`)
    await expect.poll(async () => phone.evaluate(() => localStorage.getItem('walnut.deviceToken')), { timeout: 30_000 }).toBeTruthy()
    await expect(phone.getByRole('link', { name: /settings/i }).first()).toBeVisible({ timeout: 30_000 })
    // This page: the code is used up, and the new browser is listed.
    await expect(section.getByTestId('devices-wifi-signed-in')).toContainText('A browser just signed in', { timeout: 30_000 })
    await expect(row.getByTestId('devices-wifi-code-value')).toHaveCount(0)
    await expect(row.getByTestId('devices-wifi-get-code')).toHaveText('Get a code')
    await expect.poll(async () => section.getByTestId('devices-browsers-group').locator('.devices-row').count(), { timeout: 30_000 }).toBe(before + 1)
    await shot(page, '1-signed-in')
  } finally {
    await other.close()
  }
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
  const section = await openAllDevices(page)
  const row = section.getByTestId('devices-wifi-sign-in')
  await expect(row).toBeVisible()
  refuse = true
  const group = section.getByTestId('devices-browsers-group')
  await row.getByTestId('devices-wifi-get-code').click()
  await expect(group).toContainText('The code could not be made.', { timeout: 30_000 })
  await expect(row.getByTestId('devices-wifi-get-code')).toBeEnabled()
  // And again, once the server makes one.
  refuse = false
  await row.getByTestId('devices-wifi-get-code').click()
  await expect(row.getByTestId('devices-wifi-code-value')).toBeVisible({ timeout: 30_000 })
  await expect(group).not.toContainText('The code could not be made.')

  // No Wi-Fi address in the list: no row (another tab, then this one, reads the list again).
  lan = false
  await page.getByTestId('pc-tab-cloud').click()
  await page.getByTestId('pc-tab-devices-phones').click()
  await expect(section.getByTestId('devices-wifi-sign-in')).toHaveCount(0, { timeout: 30_000 })
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
  const section = await openAllDevices(page)
  await expect(section.getByTestId('devices-browsers-group').locator('.devices-row')).toHaveCount(1, { timeout: 30_000 })
  await expect(section.getByTestId('devices-wifi-sign-in')).toHaveCount(0)
})
