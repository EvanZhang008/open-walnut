/**
 * Settings on a phone (spec 4.7 Settings; checklist C18, C19, C23, C28, C38,
 * C39, C51, C74, C75) on an iPhone 15.
 *
 *   the computer's own browser (the fixture trusts it): list, pane, back,
 *     rows stacked, Show QR code still offered
 *   a phone through a tunnel (a loopback proxy Walnut does not trust, the
 *     pattern of browser-access-tunnel.spec.ts): no code buttons, its own row
 *     marked, no Remove on other rows, Sign out this phone
 *
 * Config writes are real, on the fixture server only. Navigation is by taps;
 * page.goto only for the first load. Screenshots: /tmp/mobile-web/settings-*.png.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { devices, expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { findSmallTargets, findSmallText } from './phone-helpers'

test.setTimeout(240_000)

const SHOTS = '/tmp/mobile-web'
const WORK = '/tmp/mobile-web/settings-fixture'
const FAKE_TUNNEL = `${WORK}/fake-tunnel.cjs`
const PHONE = devices['iPhone 15']
const { defaultBrowserType: _engine, ...IPHONE } = PHONE

// The same fake tunnel as browser-access-tunnel.spec.ts: /api and /ws to
// Walnut's tunnel port, the page from the fixture, no proxy header.
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

async function shot(page: Page, name: string) {
  const engine = page.context().browser()?.browserType().name() ?? 'browser'
  await page.screenshot({ path: `${SHOTS}/settings-${engine}-${name}.png` })
}

const topbar = (page: Page) => page.locator('.phone-topbar')

/** Home > Menu > Settings, by taps. */
async function openSettings(page: Page) {
  await page.getByRole('button', { name: 'Menu', exact: true }).click({ timeout: 60_000 })
  await page.locator('#primary-sidebar').getByRole('link', { name: /settings/i }).first().click()
  await expect(page.locator('.settings-layout[data-phone-settings="list"]')).toBeVisible({ timeout: 60_000 })
}

/** Tap one Settings row; its pane opens as a layer with Back and its name. */
async function openPane(page: Page, testId: string, name: string) {
  await page.getByTestId(testId).click()
  await expect(page.locator('.settings-layout[data-phone-settings="pane"]')).toBeVisible({ timeout: 30_000 })
  await expect(topbar(page)).toContainText(name)
  await expect(topbar(page).getByRole('button', { name: 'Back' })).toBeVisible()
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

async function mintCode(page: Page): Promise<string> {
  const res = await page.request.post('/api/devices/browser-code')
  expect(res.ok()).toBe(true)
  return ((await res.json()) as { code: string }).code
}

/** The newest browser sign-in on the fixture: the one this test just made. */
async function newestBrowser(page: Page): Promise<string> {
  const listed = await (await page.request.get('/api/devices')).json() as { devices: Array<{ name: string; createdAt: string; role?: string }> }
  return listed.devices.filter((d) => d.role === 'browser').sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]!.name
}

/**
 * Until /api/v1/me names the caller's device (reported to the main agent),
 * answer it with the name the server gave this sign-in, so the client's own
 * row logic is exercised. A server that already says it is left alone.
 */
async function meNamesDevice(page: Page | BrowserContext, name: string) {
  await page.route((url) => url.pathname === '/api/v1/me', async (route) => {
    const res = await route.fetch()
    const body = await res.json().catch(() => ({})) as Record<string, unknown>
    if (res.status() !== 200 || body.device) return route.fulfill({ response: res })
    return route.fulfill({ response: res, json: { ...body, device: { name } } })
  })
}

test.describe('on the computer Walnut runs on, phone sized', () => {
  test.use({ ...IPHONE })

  test('C38 C23: a full-screen list, a pane as a layer, back to the list where it was', async ({ page }) => {
    await page.goto('/')
    await openSettings(page)
    const vp = page.viewportSize()!
    const nav = page.locator('.settings-nav')
    const navBox = (await nav.boundingBox())!
    expect(navBox.x).toBe(0)
    expect(Math.abs(navBox.width - vp.width)).toBeLessThanOrEqual(1)
    // Every row: 48 px at least, its label shown, a chevron for a pane row.
    const rows = await page.locator('.settings-nav-item:not(.settings-nav-placeholder)').evaluateAll((els) => els.map((el) => ({
      h: el.getBoundingClientRect().height,
      label: (el.querySelector('.settings-nav-label') as HTMLElement | null)?.offsetWidth ?? 0,
      chevron: el.classList.contains('settings-nav-page-link') || getComputedStyle(el, '::after').content !== 'none',
    })))
    expect(rows.length).toBeGreaterThan(5)
    for (const r of rows) {
      expect(r.h).toBeGreaterThanOrEqual(48)
      expect(r.label).toBeGreaterThan(0)
      expect(r.chevron).toBe(true)
    }
    await expect(page.getByTestId('settings-filter')).toBeVisible()
    expect(await page.getByTestId('settings-filter').evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16)
    // C28: focusing the field does not zoom the page.
    await page.getByTestId('settings-filter').tap()
    await expect(page.getByTestId('settings-filter')).toBeFocused()
    await page.waitForTimeout(300)
    expect(await page.evaluate(() => window.visualViewport?.scale ?? 1)).toBe(1)
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await shot(page, 'list')

    // Scroll the list, open a pane low in it, come back: the list has not moved.
    const list = page.locator('.settings-nav-list')
    // Phones & Cloud sits low in the list: bring it on screen first, so the
    // tap itself scrolls nothing.
    await page.getByTestId('settings-nav-devices').scrollIntoViewIfNeeded()
    await page.waitForTimeout(300)
    const before = await list.evaluate((el) => el.scrollTop)
    expect(before).toBeGreaterThan(0)
    await openPane(page, 'settings-nav-devices', 'Phones & Cloud')
    const pane = page.locator('.settings-pane')
    const paneBox = (await pane.boundingBox())!
    expect(paneBox.x).toBe(0)
    expect(Math.abs(paneBox.width - vp.width)).toBeLessThanOrEqual(1)
    await expect(nav).toBeHidden()
    await expect(page.locator('#devices')).toBeVisible({ timeout: 30_000 })
    await shot(page, 'pane-devices')
    await page.goBack()
    await expect(page.locator('.settings-layout[data-phone-settings="list"]')).toBeVisible()
    await expect(nav).toBeVisible()
    expect(page.url()).toContain('/settings')
    expect(await list.evaluate((el) => el.scrollTop)).toBe(before)
    // Back once more leaves Settings, not Walnut.
    await openPane(page, 'settings-nav-general', 'General')
    await topbar(page).getByRole('button', { name: 'Back' }).click()
    await expect(page.locator('.settings-layout[data-phone-settings="list"]')).toBeVisible()
  })

  test('C38 C18 C19 C28: a pane at 390 stacks label over control, fits, and takes a finger', async ({ page }) => {
    await page.goto('/')
    await openSettings(page)
    for (const [testId, name] of [['settings-nav-general', 'General'], ['settings-nav-devices', 'Phones & Cloud']] as const) {
      await openPane(page, testId, name)
      await page.waitForTimeout(1_500)
      const stacked = await page.locator('.settings-pane .settings-row').evaluateAll((els) => els
        .filter((el) => el.querySelector(':scope > .settings-row-copy') && el.querySelector(':scope > .settings-row-actions'))
        .filter((el) => (el as HTMLElement).offsetParent !== null)
        .map((el) => {
          const copy = el.querySelector(':scope > .settings-row-copy')!.getBoundingClientRect()
          const actions = el.querySelector(':scope > .settings-row-actions')!.getBoundingClientRect()
          return { below: actions.top >= copy.bottom - 1, cut: copy.right > el.getBoundingClientRect().right + 1 }
        }))
      expect(stacked.length).toBeGreaterThan(0)
      expect(stacked.filter((r) => !r.below || r.cut)).toEqual([])
      const overflow = await page.locator('.settings-pane').evaluate((el) => el.scrollWidth - el.clientWidth)
      expect(overflow, `${name} scrolls sideways`).toBeLessThanOrEqual(0)
      const page_ = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)
      expect(page_).toBeLessThanOrEqual(0)
      const small = await findSmallTargets(page, '.settings-pane')
      expect(small, `${name}: targets under 44 px`).toEqual([])
      expect(await findSmallText(page, 12, '.settings-pane'), `${name}: text under 12 px`).toEqual([])
      const inputs = await page.locator('.settings-pane input[type="text"], .settings-pane input:not([type]), .settings-pane textarea').evaluateAll((els) =>
        els.filter((el) => (el as HTMLElement).offsetParent !== null).map((el) => parseFloat(getComputedStyle(el).fontSize)))
      for (const size of inputs) expect(size).toBeGreaterThanOrEqual(16)
      await shot(page, `stacked-${testId}`)
      await page.goBack()
      await expect(page.locator('.settings-layout[data-phone-settings="list"]')).toBeVisible()
    }
    expect(await findSmallTargets(page, '.settings-nav'), 'list: targets under 44 px').toEqual([])
  })

  for (const size of [{ width: 375, height: 667 }, { width: 320, height: 568 }]) {
    test(`C18 C19: list and Phones & Cloud fit and take a finger at ${size.width}x${size.height}`, async ({ page }) => {
      await page.setViewportSize(size)
      await page.goto('/')
      await openSettings(page)
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0)
      expect(await findSmallTargets(page, '.settings-nav'), 'list targets').toEqual([])
      expect(await findSmallText(page, 12, '.settings-nav'), 'list text').toEqual([])
      await openPane(page, 'settings-nav-devices', 'Phones & Cloud')
      await expect(page.locator('#devices')).toBeVisible({ timeout: 30_000 })
      await page.waitForTimeout(1_500)
      // Walk the pane a screen at a time: only what is on screen can be measured.
      const pane = page.locator('.settings-pane')
      const height = await pane.evaluate((el) => el.scrollHeight)
      for (let top = 0; top < height; top += size.height - 120) {
        await pane.evaluate((el, y) => { el.scrollTop = y }, top)
        await page.waitForTimeout(150)
        expect(await pane.evaluate((el) => el.scrollWidth - el.clientWidth), `sideways at ${top}`).toBeLessThanOrEqual(0)
        expect(await findSmallTargets(page, '.settings-pane'), `targets at ${top}`).toEqual([])
        expect(await findSmallText(page, 12, '.settings-pane'), `text at ${top}`).toEqual([])
      }
      await shot(page, `devices-${size.width}`)
    })
  }

  test('N20: a pane names itself once, its switches take the iOS size and its checkboxes a finger', async ({ page }) => {
    await page.goto('/')
    await openSettings(page)
    await openPane(page, 'settings-nav-sessions', 'Sessions')
    await page.waitForTimeout(1_500)
    // The top bar says Sessions; the pane heading is for screen readers only.
    const heading = page.locator('.settings-pane .settings-pane-header .settings-pane-title').first()
    await expect(heading).toHaveCount(1)
    const hb = (await heading.boundingBox())!
    expect(hb.width * hb.height).toBeLessThanOrEqual(1)
    await expect(page.locator('.settings-pane .settings-pane-header .settings-pane-tile')).toBeHidden()
    const pane = page.locator('.settings-pane')
    const toggle = pane.locator('.toggle-switch.settings-switch').first()
    await toggle.scrollIntoViewIfNeeded()
    const tb = (await toggle.boundingBox())!
    expect([Math.round(tb.width), Math.round(tb.height)]).toEqual([51, 31])
    const box = pane.locator('.settings-checkbox-input').first()
    await box.scrollIntoViewIfNeeded()
    const bb = (await box.boundingBox())!
    expect(Math.round(bb.width)).toBe(22)
    const row = pane.locator('.settings-row.settings-checkbox-row').first()
    expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(44)
    expect(await findSmallTargets(page, '.settings-pane'), 'checkbox rows').toEqual([])
    await shot(page, 'n20-sessions')
  })

  test('C39 C51 N2-36: the computer itself still makes codes; the Home Screen line is only for a Safari signed in with a token', async ({ page }) => {
    await page.goto('/')
    await openSettings(page)
    await openPane(page, 'settings-nav-devices', 'Phones & Cloud')
    await expect(page.getByTestId('browser-access-make-code')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('browser-access-codes-elsewhere')).toHaveCount(0)
    // N2-36: this tab is on the computer's own address and holds no device token,
    // so nothing can sign it out after a week: no Home Screen tip here.
    await expect(page.getByTestId('devices-pane-loaded').or(page.getByTestId('browser-access-make-code')).first()).toBeVisible()
    await expect(page.getByTestId('devices-home-screen-hint')).toHaveCount(0)
    await expect(page.getByText('Add Walnut to your Home Screen', { exact: false })).toHaveCount(0)
  })
})

test.describe('a phone signed in through a tunnel', () => {
  test.describe.configure({ mode: 'serial' })
  let tunnelUrl = ''

  test.beforeAll(async ({ browser }) => {
    mkdirSync(WORK, { recursive: true })
    writeFileSync(FAKE_TUNNEL, FAKE_TUNNEL_SOURCE)
    const baseURL = test.info().project.use.baseURL
    const context = await browser.newContext({ baseURL })
    const pagePort = new URL(baseURL ?? 'http://localhost:3457').port || '80'
    const put = await context.request.put('/api/config', { data: { expose: {
      enabled: false,
      provider: 'command',
      command: { command: process.execPath, args: [FAKE_TUNNEL, '{port}', pagePort], url_pattern: 'http://127\\.0\\.0\\.1:\\d+', ready_pattern: 'connected!' },
    } } })
    expect(put.ok()).toBe(true)
    expect((await context.request.put('/api/expose', { data: { enabled: true, provider: 'command' } })).ok()).toBe(true)
    await expect.poll(async () => {
      const body = await (await context.request.get('/api/expose')).json() as { status?: { state?: string; url?: string } }
      return body.status?.state === 'connected' ? body.status.url ?? '' : ''
    }, { timeout: 60_000 }).toMatch(/^http:\/\/127\.0\.0\.1:\d+/)
    const body = await (await context.request.get('/api/expose')).json() as { status: { url: string } }
    tunnelUrl = body.status.url.replace(/\/+$/, '')
    await context.close()
  })

  test.afterAll(async ({ browser }) => {
    const context = await browser.newContext({ baseURL: test.info().project.use.baseURL })
    await context.request.put('/api/expose', { data: { enabled: false } }).catch(() => {})
    await context.request.put('/api/config', { data: { expose: {} } }).catch(() => {})
    await context.close()
  })

  /** A fresh iPhone that signs in through the tunnel with a real code. */
  async function signedInPhone(browser: Browser, page: Page): Promise<{ phone: Page; context: BrowserContext; name: string }> {
    const context = await browser.newContext({ ...IPHONE })
    const phone = await context.newPage()
    await phone.goto(tunnelUrl)
    await expect(phone.getByTestId('unpaired-notice')).toBeVisible({ timeout: 60_000 })
    await phone.getByTestId('unpaired-code-input').fill((await mintCode(page)).toLowerCase())
    await phone.getByTestId('unpaired-code-submit').click()
    await expect(phone.getByTestId('unpaired-notice')).toHaveCount(0, { timeout: 60_000 })
    await settleSignedIn(phone)
    const name = await newestBrowser(page)
    await meNamesDevice(context, name)
    return { phone, context, name }
  }

  test('C39 C74: no code buttons, its own row first and marked, no Remove on the others', async ({ page, browser }) => {
    // Another browser signed in, so the list has a row that is not this phone.
    const other = await page.request.post('/api/v1/browser-pair', { data: { code: await mintCode(page) } })
    expect(other.ok()).toBe(true)
    const { phone, context, name } = await signedInPhone(browser, page)
    await openSettings(phone)
    await openPane(phone, 'settings-nav-devices', 'Phones & Cloud')
    const devices = phone.locator('#devices')
    await expect(devices.getByTestId('devices-browsers-group')).toBeVisible({ timeout: 30_000 })
    await expect(phone.getByTestId('browser-access-make-code')).toHaveCount(0)
    await expect(phone.getByTestId('browser-access-codes-elsewhere')).toHaveText('Make sign-in codes on the computer Walnut runs on.')
    await expect(devices).not.toContainText('No phones paired yet.')
    const group = devices.getByTestId('devices-browsers-group')
    await expect(group).toContainText('Signed-in browsers')
    const rows = group.locator('[data-device-name]')
    expect(await rows.count()).toBeGreaterThanOrEqual(2)
    await expect(rows.first()).toHaveAttribute('data-device-name', name)
    const tag = rows.first().getByTestId('devices-own-tag')
    await expect(tag).toHaveText('This phone')
    // N2-21: the row is named by what it is (an iPhone UA here), never by its id.
    await expect(rows.first().locator('.devices-name')).toContainText(/^iPhone Safari( \d+)?This phone$/)
    await expect(rows.first().locator('.devices-name')).not.toContainText(name)
    expect(await tag.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBe(12)
    await expect(group.getByTestId('devices-remove')).toHaveCount(0)
    await expect(devices.getByTestId('devices-show-qr')).toHaveCount(0)
    // N18: each row says when it signed in, and no tag is the same on every row.
    for (const r of await rows.all()) await expect(r.locator('.devices-meta')).toContainText(/signed in /)
    await expect(group.locator('.settings-tag, [class*="settings-tag"]').filter({ hasText: /^Local$/ })).toHaveCount(0)
    const signOut = rows.first().getByTestId('devices-sign-out')
    await expect(signOut).toHaveText('Sign out this phone')
    expect((await signOut.boundingBox())!.height).toBeGreaterThanOrEqual(44)
    await rows.first().scrollIntoViewIfNeeded()
    await shot(phone, 'phone-devices')
    await context.close()
  })

  test('C75: Sign out this phone asks first, removes only itself, and lands on Signed out', async ({ page, browser }) => {
    const { phone, context, name } = await signedInPhone(browser, page)
    const deletes: string[] = []
    phone.on('request', (req) => { if (req.method() === 'DELETE') deletes.push(new URL(req.url()).pathname) })
    await openSettings(phone)
    await openPane(phone, 'settings-nav-devices', 'Phones & Cloud')
    const own = phone.locator(`[data-device-name="${name}"]`)
    await own.getByTestId('devices-sign-out').click({ timeout: 30_000 })
    const sheet = phone.getByTestId('devices-sign-out-sheet')
    await expect(sheet.getByRole('heading')).toHaveText('Sign out this phone?')
    await expect(sheet).toContainText('You will need a new code from your computer to sign in again.')
    await shot(phone, 'sign-out-sheet')
    await sheet.getByRole('button', { name: 'Cancel', exact: true }).last().click()
    await expect(sheet).toHaveCount(0)
    expect(deletes).toEqual([])

    await own.getByTestId('devices-sign-out').click()
    await sheet.getByRole('button', { name: 'Sign out', exact: true }).click()
    await expect(phone.getByTestId('unpaired-notice').locator('h1')).toHaveText('Signed out', { timeout: 60_000 })
    expect(deletes).toEqual([`/api/devices/${encodeURIComponent(name)}`])
    await shot(phone, 'signed-out')
    const listed = await (await page.request.get('/api/devices')).json() as { devices: Array<{ name: string }> }
    expect(listed.devices.some((d) => d.name === name)).toBe(false)
    await context.close()
  })
})

test.describe('on a computer', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false })

  test('C51: no Home Screen line, and the desktop Settings layout is untouched', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('link', { name: /settings/i }).first().click()
    await page.getByTestId('settings-nav-devices').click({ timeout: 60_000 })
    await expect(page.locator('#devices')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('devices-home-screen-hint')).toHaveCount(0)
    await expect(page.locator('.settings-layout')).not.toHaveAttribute('data-phone-settings', /.+/)
    // Nav and pane side by side, as before.
    const nav = (await page.locator('.settings-nav').boundingBox())!
    const pane = (await page.locator('.settings-pane').boundingBox())!
    expect(pane.x).toBeGreaterThanOrEqual(nav.x + nav.width - 1)
    await expect(page.getByTestId('browser-access-make-code')).toBeVisible({ timeout: 30_000 })
  })
})

test.describe('a Home Screen app', () => {
  test.use({ ...IPHONE })

  test('C51: standalone shows no Home Screen line', async ({ page }) => {
    await page.addInitScript(() => {
      const real = window.matchMedia.bind(window)
      window.matchMedia = (q: string) => {
        if (!q.includes('display-mode: standalone')) return real(q)
        const noop = () => {}
        return { matches: true, media: q, onchange: null, addEventListener: noop, removeEventListener: noop, addListener: noop, removeListener: noop, dispatchEvent: () => false } as unknown as MediaQueryList
      }
    })
    await page.goto('/')
    await openSettings(page)
    await openPane(page, 'settings-nav-devices', 'Phones & Cloud')
    await expect(page.locator('#devices')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('devices-home-screen-hint')).toHaveCount(0)
  })
})
