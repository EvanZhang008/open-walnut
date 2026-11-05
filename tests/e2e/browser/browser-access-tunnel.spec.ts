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
 *   1. turn it on: the phone link (address + one-time code) shows by itself
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
import { backToDevices, openWay } from './devices-ways-helpers'
import { browserKindFromUserAgent } from '../../../src/core/browser-kind'
import { expectQrEncodes } from './phone-link-qr-check'

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

/** A line at the foot of the page for a recorded run, held 2 s so the clip shows it. */
async function demoCaption(page: Page, text: string) {
  await page.evaluate((t) => {
    // A page with no viewport tag (a JSON answer) lays out 980 px wide on a phone: give it one.
    if (!document.querySelector('meta[name="viewport"]')) {
      const meta = document.createElement('meta')
      meta.name = 'viewport'
      meta.content = 'width=device-width, initial-scale=1'
      ;(document.head ?? document.documentElement).appendChild(meta)
    }
    let el = document.getElementById('__demo_cap')
    if (!el) { el = document.createElement('div'); el.id = '__demo_cap'; document.documentElement.appendChild(el) }
    el.setAttribute('style', 'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;background:rgba(20,20,20,.88);color:#fff;font:600 15px/1.35 -apple-system,Helvetica,sans-serif;padding:12px 14px;pointer-events:none')
    el.textContent = t
  }, text).catch(() => {})
  await page.waitForTimeout(2_000)
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

  test('turn it on: the phone link shows by itself', async ({ page, baseURL }) => {
    await useFakeTunnel(page, baseURL)
    const group = await openDevices(page)
    const state = page.getByTestId('browser-access-state')
    await expect(state).toContainText('Runs Custom command while Walnut runs')
    await shot(page, '1-off', group)

    await page.getByTestId('browser-access-enabled').click()
    await expect(page.getByTestId('browser-access-enabled')).toHaveAttribute('aria-checked', 'true')
    await expect(state).toContainText('Connected through Custom command.', { timeout: 30_000 })
    // Once connected, the phone link is there by itself: the tunnel's address with a
    // fresh one-time code after #pair=, nothing to press, one link only, with the QR of
    // that link beside it. The text hides the code; the href and the QR carry it.
    const row = page.getByTestId('browser-access-code')
    const shown = page.getByTestId('browser-access-link')
    await expect(shown).toHaveAttribute('href', /^http:\/\/127\.0\.0\.1:\d+\/#pair=[2-9A-Z]{4}-[2-9A-Z]{4}$/, { timeout: 30_000 })
    link = (await shown.getAttribute('href'))!
    tunnelUrl = link.split('/#pair=')[0]!
    await expect(shown).toHaveText(`${tunnelUrl}/#pair=••••-••••`)
    await expect(row).not.toContainText(link.split('#pair=')[1]!)
    await expect(row.getByTestId('browser-access-link')).toHaveCount(1)
    await expect(row.locator('img')).toHaveCount(1)
    await expectQrEncodes(row.getByTestId('browser-access-qr'), link)
    await expect(page.getByTestId('browser-access-copy-link')).toBeVisible()
    await expect(page.getByTestId('browser-access-code-value')).toHaveCount(0)
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
    await expect(phone.getByTestId('unpaired-code-error')).toContainText('That code is wrong, already used or expired')
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

  test('a #pair link signs a fresh browser in on open, the code leaves the address bar, and Settings shows a new link', async ({ page, browser }) => {
    expect(link).toContain('#pair=')
    // Settings open on this computer while the phone uses the link: it shows its own link now.
    await openDevices(page)
    const shown = page.getByTestId('browser-access-link')
    await expect(shown).toHaveAttribute('href', /#pair=[2-9A-Z]{4}-[2-9A-Z]{4}$/, { timeout: 30_000 })
    const before = (await shown.getAttribute('href'))!
    const phone = await tunnelPage(browser)
    await phone.goto(link)
    // A right code reloads the page with the new token, so a read can land mid-reload
    // ("execution context was destroyed"): that read counts as not yet, and the poll asks again.
    await expect.poll(() => phone.evaluate(() => localStorage.getItem('walnut.deviceToken')).catch(() => null), { timeout: 30_000 }).toMatch(/.{20,}/)
    await phone.waitForLoadState('domcontentloaded')
    expect(phone.url()).not.toContain('#pair')
    await phone.waitForTimeout(1_500)
    await expect(phone.getByTestId('unpaired-notice')).toBeHidden()
    // The server says a browser signed in (browser:signed-in): a fresh link replaces the shown
    // one by itself, with no reload or click.
    await expect.poll(() => shown.getAttribute('href'), { timeout: 15_000 }).not.toBe(before)
    const after = (await shown.getAttribute('href'))!
    expect(after.startsWith(`${tunnelUrl}/#pair=`)).toBe(true)
    expect(after).toMatch(/#pair=[2-9A-Z]{4}-[2-9A-Z]{4}$/)
    // And the computer says the sign-in worked, so the swapped link is no surprise.
    await expect(page.getByTestId('browser-access-signed-in-note')).toContainText('A browser just signed in with the link')
    await phone.context().close()
  })

  // 2026-11-04, the user: "if cookie is cleared need another code"; "how long will cookie
  // usually last"; then he asked for the way a well-known dashboard keeps a phone signed in.
  // The page holds an access token of hours; the server keeps a refresh token in an HttpOnly
  // cookie only the renewal path gets, which Safari's 7-day rules never reach.
  test('a phone stays signed in: it renews by itself, and after Safari cleared its storage the refresh cookie signs it back in', async ({ page, browser }) => {
    // PW_VIDEO=1: the phone's own window is recorded too, with a line saying each step.
    const recorded = process.env.PW_VIDEO ? { recordVideo: { dir: test.info().outputPath('phone'), size: { width: 390, height: 844 } } } : {}
    let context = await browser.newContext({ ...phoneDevice(), ...recorded })
    let phone = await context.newPage()
    const say = (text: string) => process.env.PW_VIDEO ? demoCaption(phone, text) : Promise.resolve()
    await phone.goto(tunnelUrl)
    await say('A phone opens Walnut through the tunnel: not signed in yet')
    await expect(phone.getByTestId('unpaired-notice')).toBeVisible({ timeout: 30_000 })
    await phone.getByTestId('unpaired-code-input').fill((await mintCode(page)).code)
    await phone.getByTestId('unpaired-code-submit').click()
    await expect(phone.getByTestId('unpaired-notice')).toBeHidden({ timeout: 30_000 })
    await settleSignedIn(phone)
    const stored = () => phone.evaluate(() => ({ token: localStorage.getItem('walnut.deviceToken'), until: Number(localStorage.getItem('walnut.deviceTokenUntil')) })).catch(() => ({ token: null, until: 0 }))
    const first = await stored()
    expect(first.token).toMatch(/.{20,}/)
    // An access token of 20 hours.
    expect(first.until).toBeGreaterThan(Date.now() + 19 * 3_600_000)
    expect(first.until).toBeLessThanOrEqual(Date.now() + 20 * 3_600_000)
    await say('Signed in with a code: the page holds a token for 20 hours')

    // The refresh cookie: set by the server, HttpOnly (no script reads it), sent only to the
    // renewal path, Strict, for a year (this WebKit keeps 365 days at most anyway).
    // One per origin (walnut_refresh, _s for https, _<port> for another port): this page's own.
    const refreshCookie = async () => (await context.cookies(`${tunnelUrl}/api/auth/browser/refresh`)).find((c) => c.name.startsWith('walnut_refresh'))
    const c1 = (await refreshCookie())!
    expect(c1.httpOnly).toBe(true)
    expect(c1.path).toBe('/api/auth/browser')
    expect(c1.sameSite).toBe('Strict')
    expect(c1.expires * 1000).toBeGreaterThan(Date.now() + 300 * 86_400_000)
    // Nothing else of the site gets it.
    expect((await context.cookies(`${tunnelUrl}/api/tasks`)).some((c) => c.name.startsWith('walnut_refresh'))).toBe(false)
    expect(await phone.evaluate(() => document.cookie)).not.toContain('walnut_refresh')
    // Beside it, its mark: the page can see it has a refresh cookie, and it holds no secret.
    const mark = (await context.cookies(tunnelUrl)).find((c) => c.name.startsWith('walnut_renews'))!
    expect(mark.value).toBe('1')
    expect(mark.httpOnly).toBe(false)
    expect(await phone.evaluate(() => document.cookie)).toContain(`${mark.name}=1`)

    // Safari quit and opened again (or the phone restarted): it keeps its storage and its
    // cookies, and the page opens signed in, with no code and nothing to renew yet.
    const kept = await context.storageState()
    await context.close()
    context = await browser.newContext({ ...phoneDevice(), ...recorded, storageState: kept })
    phone = await context.newPage()
    let renewals = 0
    phone.on('request', (r) => { if (new URL(r.url()).pathname === '/api/auth/browser/refresh') renewals += 1 })
    await phone.goto(tunnelUrl)
    await say('Safari quit and opened again: still signed in, no code')
    await settleSignedIn(phone)
    await expect(phone.getByTestId('unpaired-notice')).toBeHidden()
    expect((await stored()).token).toBe(first.token)
    expect(renewals).toBe(0)

    // 20 hours on: the token is due, and the page renews it by itself when it comes back.
    await phone.evaluate(() => localStorage.setItem('walnut.deviceTokenUntil', String(Date.now() - 60_000)))
    await phone.reload()
    await expect.poll(async () => (await stored()).token, { timeout: 30_000 }).not.toBe(first.token)
    await settleSignedIn(phone)
    const second = await stored()
    expect(second.until).toBeGreaterThan(Date.now() + 19 * 3_600_000)
    await expect(phone.getByTestId('unpaired-notice')).toBeHidden()
    // The refresh token was traded too, and the old access token no longer opens anything.
    expect((await refreshCookie())!.value).not.toBe(c1.value)
    expect(await phone.evaluate(async (old) => (await fetch('/api/tasks', { headers: { Authorization: `Bearer ${old}` } })).status, first.token)).toBe(401)
    await say('20 hours later: renewed by itself, a new token, no code')

    // What Safari does to a site left alone for 7 days: its script storage is gone, and so
    // is the cookie its script wrote (walnut_device). It happens while the site is not open,
    // so the console is left first (a public JSON page of the same site).
    await phone.goto(`${tunnelUrl}/api/v1/instance`)
    await phone.evaluate(() => { localStorage.clear(); sessionStorage.clear() })
    await context.clearCookies({ name: 'walnut_device' })
    await say('7 days later: Safari wiped the page storage and the script cookie. Open Walnut again…')
    await phone.waitForTimeout(1_100)
    await phone.goto(tunnelUrl)
    await expect.poll(async () => (await stored()).token, { timeout: 30_000 }).toMatch(/.{20,}/)
    await phone.waitForLoadState('domcontentloaded')
    await settleSignedIn(phone)
    await expect(phone.getByTestId('unpaired-notice')).toBeHidden()
    const third = await stored()
    expect(third.token).not.toBe(second.token)
    await say('Still signed in: the refresh cookie gave a new token, no new code')
    // The new token writes too.
    expect(await phone.evaluate(async () => (await fetch('/api/v1/devices/self', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status)).toBeLessThan(300)
    await shot(phone, '4b-storage-cleared-still-signed-in')

    // Both gone (the person cleared the site's data): the sign-in page, as before.
    await context.clearCookies()
    await phone.evaluate(() => localStorage.clear())
    await phone.reload()
    await expect(phone.getByTestId('unpaired-notice').locator('h1')).toHaveText('Sign in to Walnut', { timeout: 30_000 })
    await say('Site data cleared by hand (cookies too): sign in again, as before')
    await context.close()
  })

  // 2026-11-04 review: a phone whose refresh cookie alone was lost kept retrying "Not connected"
  // once its token ran out (the renewal answered 204, "nothing renews here").
  test('a phone that kept its token but lost its refresh cookie reads signed out at its next renewal', async ({ page, browser }) => {
    const context = await browser.newContext(phoneDevice())
    const phone = await context.newPage()
    await phone.goto(tunnelUrl)
    await expect(phone.getByTestId('unpaired-notice')).toBeVisible({ timeout: 30_000 })
    await phone.getByTestId('unpaired-code-input').fill((await mintCode(page)).code)
    await phone.getByTestId('unpaired-code-submit').click()
    await expect(phone.getByTestId('unpaired-notice')).toBeHidden({ timeout: 30_000 })
    await settleSignedIn(phone)
    const own = (await context.cookies(`${tunnelUrl}/api/auth/browser/refresh`)).find((c) => c.name.startsWith('walnut_refresh'))!
    await context.clearCookies({ name: own.name })
    // Its token is due: the page renews when it comes back, and hears it never can.
    await phone.evaluate(() => localStorage.setItem('walnut.deviceTokenUntil', String(Date.now() - 60_000)))
    await phone.reload()
    await expect(phone.getByTestId('unpaired-notice').locator('h1')).toHaveText('This phone was signed out', { timeout: 30_000 })
    // It says why: nobody removed it.
    await expect(phone.getByTestId('unpaired-notice')).toContainText('Its sign-in was cleared from this browser. Sign in again with a new link.')
    await shot(phone, '4c-refresh-cookie-lost')
    await context.close()
  })

  test('a phone signed in before sign-ins renewed carries over at its next open, with no new code', async ({ page, browser }) => {
    // A browser token of the build before: no time, no refresh cookie.
    const made = await page.request.post('/api/devices', { data: { name: `browser-${Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0')}` } })
    expect(made.status()).toBe(201)
    const { token: legacy } = await made.json() as { token: string }
    const context = await browser.newContext(phoneDevice())
    await context.addInitScript((t) => { if (!localStorage.getItem('walnut.deviceToken')) localStorage.setItem('walnut.deviceToken', t) }, legacy)
    const phone = await context.newPage()
    await phone.goto(tunnelUrl)
    await expect.poll(() => phone.evaluate(() => localStorage.getItem('walnut.deviceTokenUntil')).catch(() => null), { timeout: 30_000 }).toMatch(/^\d+$/)
    const now = await phone.evaluate(() => localStorage.getItem('walnut.deviceToken'))
    expect(now).not.toBe(legacy)
    expect((await context.cookies(`${tunnelUrl}/api/auth/browser/refresh`)).some((c) => c.name.startsWith('walnut_refresh') && c.httpOnly)).toBe(true)
    await settleSignedIn(phone)
    await expect(phone.getByTestId('unpaired-notice')).toBeHidden()
    await context.close()
  })

  test('the same link again shows why, with the code filled in', async ({ browser }) => {
    const phone = await tunnelPage(browser)
    await phone.goto(link)
    const notice = phone.getByTestId('unpaired-notice')
    await expect(notice).toBeVisible({ timeout: 30_000 })
    await expect(phone.getByTestId('unpaired-code-error')).toContainText('That code is wrong, already used or expired')
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
    // The list of signed-in browsers is on Phones & Cloud itself.
    const devices = await backToDevices(page)
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
    // In the words of its group: a browser is signed out, never "removed".
    await expect(row.getByTestId('devices-remove')).toHaveText('Sign out')
    await shot(page, '6-listed', devices)
    await row.getByTestId('devices-remove').click()
    await row.getByTestId('devices-remove').click()
    await expect(row).toHaveCount(0, { timeout: 15_000 })

    await phone.reload()
    const notice = phone.getByTestId('unpaired-notice')
    await expect(notice.locator('h1')).toHaveText('This browser was signed out', { timeout: 30_000 })
    await expectCoversConsole(phone)
    await shot(phone, '7-removed-browser')
    // A refused sign-in stays refused: no Try again that would show this page again.
    await expect(phone.getByTestId('unpaired-retry')).toHaveCount(0)
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
    // Its open socket was closed when the computer removed it, and the page kept why across the reload.
    await expect(notice).toContainText('It was signed out from your computer. Sign in again with a new link.')
    await expect(phone.getByTestId('unpaired-retry')).toHaveCount(0)
    await expectCoversConsole(phone)
    await shot(phone, '8-removed-phone')
    // Its cookie never signs it back in: with its storage cleared too, it still reads signed out.
    await phone.evaluate(() => localStorage.clear())
    await phone.reload()
    await expect(phone.getByTestId('unpaired-notice').locator('h1')).toHaveText('This phone was signed out', { timeout: 30_000 })
    expect(await phone.evaluate(() => localStorage.getItem('walnut.deviceToken'))).toBeNull()
    await context.close()
  })

  test('Sign out all browsers ends every browser at once: open phones read signed out without a reload', async ({ page, browser }) => {
    const phones: Page[] = []
    for (let i = 0; i < 2; i++) {
      const context = await browser.newContext({ ...phoneDevice() })
      const phone = await context.newPage()
      await phone.goto(tunnelUrl)
      await expect(phone.getByTestId('unpaired-notice')).toBeVisible({ timeout: 30_000 })
      await phone.getByTestId('unpaired-code-input').fill((await mintCode(page)).code)
      await phone.getByTestId('unpaired-code-submit').click()
      await expect(phone.getByTestId('unpaired-notice')).toBeHidden({ timeout: 30_000 })
      await settleSignedIn(phone)
      phones.push(phone)
    }
    await openDevices(page)
    const devices = await backToDevices(page)
    const group = devices.getByTestId('devices-browsers-group')
    const row = group.getByTestId('devices-sign-out-browsers-row')
    await expect(row).toBeVisible()
    await expect(row).toContainText('Sign out browsers signed in with a link')
    await shot(page, '8b-sign-out-all', group)
    const button = row.getByTestId('devices-sign-out-browsers')
    // Earlier tests on this server signed browsers in too: the row counts every one the list shows.
    const listed = group.locator('[data-device-role="browser"][data-device-name^="browser-"]')
    const names = await listed.evaluateAll((els) => els.map((el) => el.getAttribute('data-device-name') ?? ''))
    const count = names.filter((n) => /^browser-[0-9a-f]{6}$/.test(n)).length
    expect(count).toBeGreaterThanOrEqual(2)
    // Exactly the rows of its group: the Walnut extension has its own (never signed out here).
    expect(await group.locator('[data-device-role="browser"]').count()).toBe(count)
    await expect(row).toContainText(`Signs out the ${count} browsers listed below. Each needs a new link to sign in again.`)
    // The first click asks in words, with Cancel beside it; Cancel puts it back as it was.
    await expect(button).toHaveText('Sign out all')
    // A double-click only asks: its second click lands on Confirm and is not one.
    await button.dblclick()
    await expect(row.getByTestId('devices-sign-out-browsers-confirm')).toBeVisible()
    await row.getByTestId('devices-sign-out-browsers-cancel').click()
    await expect(group.locator('[data-device-role="browser"]')).toHaveCount(count)
    await button.click()
    await expect(row).toContainText(`Sign out the ${count} browsers listed below? Each needs a new link to sign in again.`)
    await row.getByTestId('devices-sign-out-browsers-cancel').click()
    await expect(button).toHaveText('Sign out all')
    await button.click()
    await shot(page, '8c-sign-out-all-confirm', group)
    await row.getByTestId('devices-sign-out-browsers-confirm').click()
    await expect(devices.getByTestId('devices-signed-out-note')).toHaveText(`Signed out ${count} browsers. Each needs a new link to sign in again.`)
    // No signed-in browser is left, so the row goes with them.
    await expect(group.locator('[data-device-role="browser"][data-device-name^="browser-"]')).toHaveCount(0, { timeout: 15_000 })
    await expect(row).toHaveCount(0)
    for (const phone of phones) {
      // Its open socket was closed at the revoke (4401): it says so with no reload, and the
      // console under it goes, with the tasks it showed.
      await expect(phone.getByTestId('unpaired-notice').locator('h1')).toHaveText('This phone was signed out', { timeout: 30_000 })
      await expect(phone.locator('.app-shell')).toHaveCount(0)
      await expect(phone.getByTestId('unpaired-notice')).toContainText('It was signed out from your computer. Sign in again with a new link.')
      await phone.context().close()
    }
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
    // " 2" when an earlier run on the same fixture signed one in too (numberedDeviceName).
    expect(mine.info?.deviceName).toMatch(/^iPhone Home Screen( \d+)?$/)
    await openDevices(page)
    const row = (await backToDevices(page)).locator(`[data-device-name="${mine.name}"]`)
    // " 2" only when an earlier run on the same fixture signed one in too.
    await expect(row.locator('.devices-name')).toHaveText(/^iPhone Home Screen( \d+)?$/)
    await shot(page, '8b-home-screen-listed', row)
    await context.close()
  })

  test('turning it off ends the tunnel', async ({ page }) => {
    await openDevices(page)
    await page.getByTestId('browser-access-enabled').click()
    await expect(page.getByTestId('browser-access-state')).toContainText('Runs Custom command while Walnut runs', { timeout: 30_000 })
    await expect(page.getByTestId('browser-access-link')).toHaveCount(0)
    await expect(page.getByTestId('browser-access-code')).toContainText('The link shows here once the tunnel is connected.')
    await expect.poll(async () => {
      try { await fetch(`${tunnelUrl}/api/v1/instance`, { signal: AbortSignal.timeout(2_000) }); return 'open' } catch { return 'closed' }
    }, { timeout: 15_000 }).toBe('closed')
  })

  test('a command that is not installed says so, with Retry', async ({ page, baseURL }) => {
    await useFakeTunnel(page, baseURL, `${WORK}/no-such-tunnel`)
    const group = await openDevices(page)
    await page.getByTestId('browser-access-enabled').click()
    const state = page.getByTestId('browser-access-state')
    // No "here" (src/core/expose/supervisor.ts): a host's report is read on this computer too.
    await expect(state).toContainText(`Custom command is not installed (${WORK}/no-such-tunnel not found)`, { timeout: 30_000 })
    await expect(state).toHaveAttribute('data-state', 'missing')
    await expect(page.getByTestId('browser-access-retry')).toBeVisible()
    await shot(page, '7-missing', group)
    await page.getByTestId('browser-access-enabled').click()
    await expect(state).toHaveAttribute('data-state', 'off', { timeout: 15_000 })
  })
})
