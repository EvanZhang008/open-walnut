/**
 * Settings → Phones & Cloud → Open from a browser, and a browser signing in
 * through the tunnel (docs/plan/walnut-servers-everywhere.md, "Exposure").
 *
 * The built-in `command` provider runs a fake tunnel this spec writes: an HTTP
 * proxy on its own loopback port that sends /api and /ws to Walnut's tunnel
 * port and everything else to the fixture's page server, adding no proxy
 * header (the shape of `ssh -R`). It prints its address first and "Connected!"
 * a moment later, like the real CLI. A page opened at that address is a browser
 * on another device: Walnut must not trust it.
 *
 *   1. turn it on, see the address, make a code (link and QR)
 *   2. through the tunnel: the notice asks for a code; a wrong one says why; the
 *      right one signs the browser in and the board loads
 *   3. a `#pair=` link signs a fresh browser in on open and leaves the address bar
 *   4. the same link again: the notice shows why, with the code filled in
 *   5. a signed-in browser is listed under Signed-in browsers; removing it shows
 *      "This browser was signed out" over the console; a removed phone sees
 *      "This phone was signed out"
 *   6. turning it off ends the tunnel
 *   7. a command that is not installed says so, with Retry
 *
 * Config writes are real, on the fixture server; navigation in Walnut is by
 * clicks. The tunnel browser's first load is a `goto`, because opening a link is
 * what the person does. Runs in both engines: WebKit with
 * `PW_WEBKIT=1 ... --project=webkit`.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { test, expect, devices, type Browser, type Locator, type Page } from '@playwright/test'
import { openWay } from './devices-ways-helpers'
import { browserKindFromUserAgent } from '../../../src/core/browser-kind'

test.setTimeout(180_000)

const SHOTS = '/tmp/browser-access'
const WORK = '/tmp/browser-access/fixture'
const FAKE_TUNNEL = `${WORK}/fake-tunnel.cjs`

const FAKE_TUNNEL_SOURCE = `
const http = require('node:http')
const net = require('node:net')
const walnutPort = Number(process.argv[2])
const pagePort = Number(process.argv[3])
const toWalnut = (url) => url.startsWith('/api') || url.startsWith('/ws')
const server = http.createServer((req, res) => {
  const up = http.request({ host: '127.0.0.1', port: toWalnut(req.url) ? walnutPort : pagePort, method: req.method, path: req.url, headers: req.headers }, (r) => {
    res.writeHead(r.statusCode, r.headers)
    r.pipe(res)
  })
  up.on('error', () => { res.statusCode = 502; res.end() })
  req.pipe(up)
})
server.on('upgrade', (req, socket, head) => {
  const up = net.connect(toWalnut(req.url) ? walnutPort : pagePort, '127.0.0.1', () => {
    let raw = req.method + ' ' + req.url + ' HTTP/1.1\\r\\n'
    for (let i = 0; i < req.rawHeaders.length; i += 2) raw += req.rawHeaders[i] + ': ' + req.rawHeaders[i + 1] + '\\r\\n'
    up.write(raw + '\\r\\n')
    if (head.length) up.write(head)
    socket.pipe(up).pipe(socket)
  })
  up.on('error', () => socket.destroy())
  socket.on('error', () => up.destroy())
})
server.listen(0, '127.0.0.1', () => {
  console.log('Public: http://127.0.0.1:' + server.address().port)
  setTimeout(() => console.log('Connected! Forwarding requests'), 300)
})
process.on('SIGTERM', () => process.exit(0))
`

function pagePort(baseURL: string | undefined): string {
  return new URL(baseURL ?? 'http://localhost:3457').port || '80'
}

async function putConfig(page: Page, partial: Record<string, unknown>) {
  const res = await page.request.put('/api/config', { data: partial })
  expect(res.ok()).toBe(true)
}

async function useFakeTunnel(page: Page, baseURL: string | undefined, command = process.execPath) {
  await putConfig(page, {
    expose: {
      enabled: false,
      provider: 'command',
      command: { command, args: [FAKE_TUNNEL, '{port}', pagePort(baseURL)], url_pattern: 'http://127\\.0\\.0\\.1:\\d+', ready_pattern: 'connected!' },
    },
  })
}

async function openDevices(page: Page) {
  await page.goto('/')
  await page.waitForLoadState('domcontentloaded')
  await page.getByRole('link', { name: /settings/i }).first().click()
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible({ timeout: 30_000 })
  const nav = page.getByTestId('settings-nav-devices')
  await nav.click()
  await expect(nav).toHaveAttribute('aria-current', 'page')
  await openWay(page, 'browser')
  const group = page.getByTestId('browser-access')
  await expect(group).toBeVisible({ timeout: 30_000 })
  await expect(group).not.toContainText('Loading...', { timeout: 30_000 })
  return group
}

async function shot(page: Page, name: string, region?: ReturnType<Page['locator']>) {
  mkdirSync(SHOTS, { recursive: true })
  const engine = page.context().browser()?.browserType().name() ?? 'browser'
  const target = region ?? page
  await target.screenshot({ path: `${SHOTS}/${engine}-${name}.png`, scale: 'css' })
}

async function tunnelPage(browser: Browser): Promise<Page> {
  // A different device: nothing stored, a phone-sized window.
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
  return context.newPage()
}

/** An iPhone in this project's engine (no `defaultBrowserType`: the project picks it). */
function phoneDevice() {
  const { defaultBrowserType: _engine, ...iphone } = devices['iPhone 15']
  return iphone
}

/** The sign-in page is opaque and full screen: whatever booted under it takes no tap. */
async function expectCoversConsole(phone: Page) {
  const vp = phone.viewportSize()!
  const box = (await phone.getByTestId('unpaired-notice').boundingBox())!
  expect(box.x).toBe(0)
  expect(box.y).toBe(0)
  expect(box.width).toBe(vp.width)
  expect(box.height).toBeGreaterThanOrEqual(vp.height - 1)
  const hits = await phone.evaluate(() => {
    const pts: Array<[number, number]> = [[0.5, 0.5], [0.1, 0.1], [0.9, 0.9], [0.5, 0.05]]
    return pts.map(([x, y]) => {
      const el = document.elementFromPoint(innerWidth * x, innerHeight * y)
      return !!el?.closest('[data-testid="unpaired-notice"]')
    })
  })
  expect(hits).toEqual([true, true, true, true])
  const bg = await phone.getByTestId('unpaired-notice').evaluate((el) => getComputedStyle(el).backgroundColor)
  expect(bg).not.toMatch(/rgba\(.*, 0\)|transparent/)
}

/** A finger on the right of the code: the caret lands after its last character. */
async function tapAtEnd(input: Locator) {
  const box = (await input.boundingBox())!
  await input.click({ position: { x: box.width - 6, y: box.height / 2 } })
  await expect(input).toBeFocused()
}

/**
 * The server rate-limits refused tokens per address (10 a minute), and every
 * tunnel client shares the tunnel's address: right after another test's
 * refusals, a fresh sign-in is answered 429 until the minute is over. Wait
 * that out, then start the console again with nothing failed.
 */
async function settleSignedIn(phone: Page) {
  let limited = false
  await expect.poll(async () => {
    const status = await phone.evaluate(async () => (await fetch('/api/tasks', { cache: 'no-store' })).status).catch(() => 0)
    if (status === 429) limited = true
    return status
  }, { timeout: 90_000, intervals: [3_000] }).toBe(200)
  if (limited) {
    await phone.reload()
    await expect(phone.locator('.app-shell').first()).toBeVisible({ timeout: 60_000 })
  }
}

async function mintCode(page: Page): Promise<{ code: string; link?: string }> {
  const res = await page.request.post('/api/devices/browser-code')
  expect(res.ok()).toBe(true)
  return res.json()
}

test.describe('Open from a browser', () => {
  // One fixture server, one tunnel: these tests take turns.
  test.describe.configure({ mode: 'serial' })
  let tunnelUrl = ''
  let link = ''

  test.beforeAll(() => {
    mkdirSync(WORK, { recursive: true })
    writeFileSync(FAKE_TUNNEL, FAKE_TUNNEL_SOURCE)
  })

  test.afterAll(async ({ browser }) => {
    const context = await browser.newContext({ baseURL: test.info().project.use.baseURL })
    await context.request.put('/api/config', { data: { expose: {} } }).catch(() => {})
    await context.request.put('/api/expose', { data: { enabled: false } }).catch(() => {})
    await context.close()
  })

  test('turn it on, see the address, make a code', async ({ page, baseURL }) => {
    await useFakeTunnel(page, baseURL)
    const group = await openDevices(page)
    const state = page.getByTestId('browser-access-state')
    await expect(state).toContainText('Runs Custom command while Walnut runs')
    await shot(page, '1-off', group)

    await page.getByTestId('browser-access-enabled').click()
    await expect(page.getByTestId('browser-access-enabled')).toHaveAttribute('aria-checked', 'true')
    await expect(state).toContainText('Connected through Custom command.', { timeout: 30_000 })
    const url = page.getByTestId('browser-access-url')
    await expect(url).toHaveText(/^127\.0\.0\.1:\d+$/)
    tunnelUrl = (await url.getAttribute('href'))!

    await page.getByTestId('browser-access-make-code').click()
    const value = page.getByTestId('browser-access-code-value')
    await expect(value).toHaveText(/^[2-9A-Z]{4}-[2-9A-Z]{4}$/)
    await expect(page.getByTestId('browser-access-link')).toContainText('#pair=')
    await expect(page.getByTestId('browser-access-code').locator('img')).toBeVisible()
    link = `${tunnelUrl}/#pair=${await value.textContent()}`
    await shot(page, '2-connected-code', group)
  })

  test('through the tunnel: a wrong code says why, the right one signs the browser in', async ({ page, browser }) => {
    expect(tunnelUrl).not.toBe('')
    const phone = await tunnelPage(browser)
    // Every WebSocket this browser opens, and whether the server took it (sent it a frame).
    const sockets: Array<{ url: string; answered: boolean }> = []
    phone.on('websocket', (ws) => {
      const seen = { url: ws.url(), answered: false }
      sockets.push(seen)
      ws.on('framereceived', () => { seen.answered = true })
    })
    await phone.goto(tunnelUrl)
    const notice = phone.getByTestId('unpaired-notice')
    await expect(notice).toBeVisible({ timeout: 30_000 })
    await expect(notice.locator('h1')).toHaveText('Sign in to Walnut')
    await expect(notice).toContainText('Sign in to Walnut')

    const input = phone.getByTestId('unpaired-code-input')
    await input.fill('zzzz-zzzz')
    await phone.getByTestId('unpaired-code-submit').click()
    await expect(phone.getByTestId('unpaired-code-error')).toContainText('That code is wrong or has expired')
    // The code stays to be fixed; editing any character clears the line.
    await expect(input).toHaveValue('ZZZZ-ZZZZ')
    await shot(phone, '3-tunnel-wrong-code')
    await tapAtEnd(input)
    await input.press('Backspace')
    await expect(phone.getByTestId('unpaired-code-error')).toHaveCount(0)

    const { code } = await mintCode(page)
    await input.fill(code.toLowerCase())
    await phone.getByTestId('unpaired-code-submit').click()
    // The page reloads with its new token: no notice, the board answers.
    await expect(notice).toBeHidden({ timeout: 30_000 })
    await expect.poll(() => phone.evaluate(() => localStorage.getItem('walnut.deviceToken')), { timeout: 15_000 }).toMatch(/.{20,}/)
    const tasks = await phone.evaluate(async () => {
      const res = await fetch('/api/tasks', { headers: { authorization: `Bearer ${localStorage.getItem('walnut.deviceToken')}` } })
      return res.status
    })
    expect(tasks).toBe(200)
    // A loader that calls fetch() itself carries the token too (auth-fetch.ts),
    // and a request that cannot send a header (an <img>, here an XHR that nothing
    // patches) gets in on the cookie; a write on the cookie alone does not.
    const raw = await phone.evaluate(async () => (await fetch('/api/quiet')).status)
    expect(raw).toBe(200)
    const xhr = (method: string) => phone.evaluate((m) => new Promise<number>((resolve) => {
      const x = new XMLHttpRequest()
      x.open(m, '/api/tasks')
      x.onload = () => resolve(x.status)
      x.onerror = () => resolve(0)
      x.send(m === 'GET' ? null : '{}')
    }), method)
    expect(await xhr('GET')).toBe(200)
    expect(await xhr('POST')).toBe(401)
    // The live socket gets in through the tunnel, which this server does not trust, with
    // the token in its subprotocol: no URL this browser opened carries it (a tunnel logs URLs).
    // (Only Walnut's /ws: the dev page server's own hot-reload socket is not Walnut's.)
    const walnutSockets = () => sockets.filter((ws) => new URL(ws.url).pathname === '/ws')
    await expect.poll(() => walnutSockets().some((ws) => ws.answered), { timeout: 30_000 }).toBe(true)
    for (const ws of walnutSockets()) {
      expect(ws.url).not.toContain('token=')
      expect(new URL(ws.url).search).toBe('')
    }
    await phone.waitForTimeout(1_500)
    await expect(notice).toBeHidden()
    await shot(phone, '4-tunnel-signed-in')
    await phone.context().close()
  })

  test('a #pair link signs a fresh browser in on open, and the code leaves the address bar', async ({ browser }) => {
    expect(link).toContain('#pair=')
    const phone = await tunnelPage(browser)
    await phone.goto(link)
    // A right code reloads the page with the new token, so a read can land mid-reload
    // ("execution context was destroyed"): that read counts as not yet, and the poll asks again.
    await expect.poll(() => phone.evaluate(() => localStorage.getItem('walnut.deviceToken')).catch(() => null), { timeout: 30_000 }).toMatch(/.{20,}/)
    await phone.waitForLoadState('domcontentloaded')
    expect(phone.url()).not.toContain('#pair')
    await phone.waitForTimeout(1_500)
    await expect(phone.getByTestId('unpaired-notice')).toBeHidden()
    await phone.context().close()
  })

  test('the same link again shows why, with the code filled in', async ({ browser }) => {
    const phone = await tunnelPage(browser)
    await phone.goto(link)
    const notice = phone.getByTestId('unpaired-notice')
    await expect(notice).toBeVisible({ timeout: 30_000 })
    await expect(phone.getByTestId('unpaired-code-error')).toContainText('That code is wrong or has expired')
    await expect(phone.getByTestId('unpaired-code-input')).toHaveValue(link.split('#pair=')[1]!)
    expect(phone.url()).not.toContain('#pair')
    await shot(phone, '5-used-link')
    await phone.context().close()
  })

  test('a signed-in browser is listed under Signed-in browsers; removing it signs that browser out', async ({ page, browser }) => {
    const phone = await tunnelPage(browser)
    await phone.goto(tunnelUrl)
    await expect(phone.getByTestId('unpaired-notice')).toBeVisible({ timeout: 30_000 })
    const { code } = await mintCode(page)
    await phone.getByTestId('unpaired-code-input').fill(code)
    await phone.getByTestId('unpaired-code-submit').click()
    await expect(phone.getByTestId('unpaired-notice')).toBeHidden({ timeout: 30_000 })

    // The newest browser entry is this one.
    const listed = await (await page.request.get('/api/devices')).json() as { devices: Array<{ name: string; createdAt: string; role?: string }> }
    const mine = listed.devices.filter((d) => d.role === 'browser').sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]!
    expect(mine.name).toMatch(/^browser-[0-9a-f]{6}$/)

    await openDevices(page)
    const devices = page.locator('#devices')
    await expect(devices.getByTestId('devices-browsers-group')).toContainText('Signed-in browsers')
    const row = devices.locator(`[data-device-name="${mine.name}"]`)
    await expect(row).toBeVisible()
    // Named by what it is (N2-21), never by its id; the meta says when it signed in.
    const kind = browserKindFromUserAgent(await phone.evaluate(() => navigator.userAgent))
    expect(kind).not.toBe('Browser')
    await expect(row.locator('.devices-name')).toContainText(kind)
    await expect(row.locator('.devices-name')).not.toContainText(mine.name)
    await expect(row.locator('.devices-meta')).toContainText('signed in')
    await expect(row.getByTestId('devices-show-qr')).toHaveCount(0)
    await shot(page, '6-listed', devices)
    await row.getByTestId('devices-remove').click()
    await row.getByTestId('devices-remove').click()
    await expect(row).toHaveCount(0, { timeout: 15_000 })

    await phone.reload()
    const notice = phone.getByTestId('unpaired-notice')
    await expect(notice.locator('h1')).toHaveText('This browser was signed out', { timeout: 30_000 })
    await expectCoversConsole(phone)
    await shot(phone, '7-removed-browser')
    // Try again reloads the page. (What the reload then shows depends on the
    // auth rate limit: within a minute of the refusals above, every request
    // from the tunnel's address gets a bare 429; reported, not this page's.)
    const reloaded = phone.waitForEvent('framenavigated', { timeout: 30_000 })
    await phone.getByTestId('unpaired-retry').click()
    await reloaded
    await phone.context().close()
  })

  test('a removed phone sees This phone was signed out, over a console it cannot reach', async ({ page, browser }) => {
    const context = await browser.newContext({ ...phoneDevice() })
    const phone = await context.newPage()
    await phone.goto(tunnelUrl)
    await expect(phone.getByTestId('unpaired-notice')).toBeVisible({ timeout: 30_000 })
    const { code } = await mintCode(page)
    await phone.getByTestId('unpaired-code-input').fill(code.toLowerCase())
    await phone.getByTestId('unpaired-code-submit').click()
    await expect(phone.getByTestId('unpaired-notice')).toBeHidden({ timeout: 30_000 })
    await settleSignedIn(phone)
    const listed = await (await page.request.get('/api/devices')).json() as { devices: Array<{ name: string; createdAt: string; role?: string }> }
    const mine = listed.devices.filter((d) => d.role === 'browser').sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]!
    expect((await page.request.delete(`/api/devices/${encodeURIComponent(mine.name)}`)).ok()).toBe(true)

    await phone.reload()
    const notice = phone.getByTestId('unpaired-notice')
    await expect(notice.locator('h1')).toHaveText('This phone was signed out', { timeout: 30_000 })
    await expect(notice).toContainText('Walnut no longer accepts this sign-in. It may have been removed on your computer. Sign in again below.')
    const retry = phone.getByTestId('unpaired-retry')
    await expect(retry).toBeVisible()
    expect((await retry.boundingBox())!.height).toBeGreaterThanOrEqual(44)
    await expectCoversConsole(phone)
    await shot(phone, '8-removed-phone')
    await context.close()
  })

  test('a Home Screen app is listed as iPhone Home Screen, apart from a Safari tab (D6)', async ({ page, browser }) => {
    const context = await browser.newContext({ ...phoneDevice() })
    // The page runs as a Home Screen app: display-mode standalone, as iOS reports it.
    await context.addInitScript(() => {
      const real = window.matchMedia.bind(window)
      window.matchMedia = (q: string) => {
        if (!q.includes('display-mode: standalone')) return real(q)
        const noop = () => {}
        return { matches: true, media: q, onchange: null, addEventListener: noop, removeEventListener: noop, addListener: noop, removeListener: noop, dispatchEvent: () => false } as unknown as MediaQueryList
      }
    })
    const phone = await context.newPage()
    await phone.goto(tunnelUrl)
    await expect(phone.getByTestId('unpaired-notice')).toBeVisible({ timeout: 30_000 })
    await phone.getByTestId('unpaired-code-input').fill((await mintCode(page)).code)
    await phone.getByTestId('unpaired-code-submit').click()
    await expect(phone.getByTestId('unpaired-notice')).toBeHidden({ timeout: 30_000 })
    const listed = await (await page.request.get('/api/devices')).json() as { devices: Array<{ name: string; createdAt: string; role?: string; info?: { deviceName?: string } }> }
    const mine = listed.devices.filter((d) => d.role === 'browser').sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]!
    expect(mine.info?.deviceName).toBe('iPhone Home Screen')
    await openDevices(page)
    const row = page.locator('#devices').locator(`[data-device-name="${mine.name}"]`)
    // " 2" only when an earlier run on the same fixture signed one in too.
    await expect(row.locator('.devices-name')).toHaveText(/^iPhone Home Screen( \d+)?$/)
    await shot(page, '8b-home-screen-listed', row)
    await context.close()
  })

  test('turning it off ends the tunnel', async ({ page }) => {
    await openDevices(page)
    await page.getByTestId('browser-access-enabled').click()
    await expect(page.getByTestId('browser-access-state')).toContainText('Runs Custom command while Walnut runs', { timeout: 30_000 })
    await expect(page.getByTestId('browser-access-url')).toHaveCount(0)
    await expect.poll(async () => {
      try { await fetch(`${tunnelUrl}/api/v1/instance`, { signal: AbortSignal.timeout(2_000) }); return 'open' } catch { return 'closed' }
    }, { timeout: 15_000 }).toBe('closed')
  })

  test('a command that is not installed says so, with Retry', async ({ page, baseURL }) => {
    await useFakeTunnel(page, baseURL, `${WORK}/no-such-tunnel`)
    const group = await openDevices(page)
    await page.getByTestId('browser-access-enabled').click()
    const state = page.getByTestId('browser-access-state')
    await expect(state).toContainText('Custom command is not installed here', { timeout: 30_000 })
    await expect(state).toHaveAttribute('data-state', 'missing')
    await expect(page.getByTestId('browser-access-retry')).toBeVisible()
    await shot(page, '7-missing', group)
    await page.getByTestId('browser-access-enabled').click()
    await expect(state).toHaveAttribute('data-state', 'off', { timeout: 15_000 })
  })
})
