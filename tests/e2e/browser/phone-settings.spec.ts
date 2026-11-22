/**
 * Settings on a phone (spec 4.7 Settings; checklist C18, C19, C23, C28, C38,
 * C39, C51, C74, C75) on an iPhone 15.
 *
 *   the computer's own browser (the fixture trusts it): list, pane, back,
 *     rows stacked, the Sign in a browser row still offered
 *   a phone through a tunnel (the fake tunnel of sign-in-state.ts, a loopback
 *     proxy Walnut does not trust): no code buttons, its own row marked, no
 *     Remove on other rows, Sign out this phone. The server has one tunnel, so
 *     this spec runs one at a time with the others that drive it
 *     (one-at-a-time-specs.ts).
 *
 * Config writes are real, on the fixture server only. Navigation is by taps;
 * page.goto only for the first load. Screenshots: /tmp/mobile-web/settings-*.png.
 */
import { devices, expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { backToDevices, openWay } from './devices-ways-helpers'
import { findSmallTargets, findSmallText, pastRightEdge } from './phone-helpers'
import { isolateUiPrefsContext } from './status-section-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'
import { endServerTunnel, mintBrowserCode, settleSignedIn, signInWithCode, startServerTunnel } from './sign-in-state'
import { clearBesideMic } from './search-mic-layout-helpers'

test.setTimeout(240_000)

const SHOTS = '/tmp/mobile-web'
const PHONE = devices['iPhone 15']
const { defaultBrowserType: _engine, ...IPHONE } = PHONE

async function shot(page: Page, name: string) {
  const engine = page.context().browser()?.browserType().name() ?? 'browser'
  await page.screenshot({ path: `${SHOTS}/settings-${engine}-${name}.png` })
}

const topbar = (page: Page) => page.locator('.phone-topbar')

// Every phone here starts from Home's drawer (Menu). The shared fixture's ui-prefs hold what
// other specs left: an open chat spot puts a layer over Home on a phone, with Back where
// Menu was. Each page boots on the fixture's own prefs and keeps its writes to itself.
test.beforeEach(async ({ page }) => { await isolateUiPrefs(page) })

/** Home > Menu > Settings, by taps. */
async function openSettings(page: Page) {
  await page.getByRole('button', { name: 'Menu', exact: true }).click({ timeout: 60_000 })
  await page.locator('#primary-sidebar').getByRole('link', { name: /settings/i }).first().click()
  await expect(page.locator('.settings-layout[data-phone-settings="list"]')).toBeVisible({ timeout: 60_000 })
}

/** Tap one Settings row; its pane opens as a layer with Back and its name. */
/** Phones & Cloud opens the tab in use (it replaces its own address): wait until a tab is open. */
async function landedTab(page: Page) {
  await expect(page.getByTestId('pc-tabs').locator('.pc-tab[aria-current="page"]')).toHaveCount(1, { timeout: 30_000 })
}

async function openPane(page: Page, testId: string, name: string) {
  await page.getByTestId(testId).click()
  await expect(page.locator('.settings-layout[data-phone-settings="pane"]')).toBeVisible({ timeout: 30_000 })
  await expect(topbar(page)).toContainText(name)
  await expect(topbar(page).getByRole('button', { name: 'Back' })).toBeVisible()
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
    await landedTab(page)
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
      // Phones & Cloud: measure its Same Wi-Fi tab (the pairing, the browser sign-in code and the phone list).
      if (testId === 'settings-nav-devices') { await landedTab(page); await openWay(page, 'wifi') }
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
      expect(overflow, `${name} scrolls sideways: ${overflow > 0 ? (await pastRightEdge(page, '.settings-pane')).join('; ') : ''}`).toBeLessThanOrEqual(0)
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
      await clearBesideMic(page.getByTestId('settings-filter'), page.locator('.settings-filter-clear'),
        'voice', `${test.info().project.name}-settings-${size.width}`)
      await openPane(page, 'settings-nav-devices', 'Phones & Cloud')
      await landedTab(page)
      // The tab bar scrolls sideways on its own; the All devices tab holds the most rows.
      await backToDevices(page)
      await page.waitForTimeout(1_500)
      // Walk the pane a screen at a time: only what is on screen can be measured.
      const pane = page.locator('.settings-pane')
      const height = await pane.evaluate((el) => el.scrollHeight)
      for (let top = 0; top < height; top += size.height - 120) {
        await pane.evaluate((el, y) => { el.scrollTop = y }, top)
        await page.waitForTimeout(150)
        const sideways = await pane.evaluate((el) => el.scrollWidth - el.clientWidth)
        expect(sideways, `sideways at ${top}: ${sideways > 0 ? (await pastRightEdge(page, '.settings-pane')).join('; ') : ''}`).toBeLessThanOrEqual(0)
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
    await openWay(page, 'browser')
    await expect(page.getByTestId('browser-access-code')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('browser-access-codes-elsewhere')).toHaveCount(0)
    // N2-36: this tab is on the computer's own address and holds no device token,
    // so nothing can sign it out after a week: no Home Screen tip here.
    await expect(page.getByTestId('devices-pane-loaded').or(page.getByTestId('browser-access-code')).first()).toBeVisible()
    await backToDevices(page)
    await expect(page.getByTestId('devices-home-screen-hint')).toHaveCount(0)
    await expect(page.getByText('Add Walnut to your Home Screen', { exact: false })).toHaveCount(0)
  })
})

test.describe('a phone signed in through a tunnel', () => {
  test.describe.configure({ mode: 'serial' })
  let tunnelUrl = ''

  test.beforeAll(async ({ browser }) => {
    const baseURL = test.info().project.use.baseURL
    const context = await browser.newContext({ baseURL })
    tunnelUrl = await startServerTunnel(context.request, baseURL)
    await context.close()
  })

  test.afterAll(async ({ browser }) => {
    const context = await browser.newContext({ baseURL: test.info().project.use.baseURL })
    await endServerTunnel(context.request)
    await context.close()
  })

  /** A fresh iPhone that signs in through the tunnel with a real code. */
  async function signedInPhone(browser: Browser, page: Page): Promise<{ phone: Page; context: BrowserContext; name: string }> {
    const context = await browser.newContext({ ...IPHONE })
    await isolateUiPrefsContext(context)
    const phone = await context.newPage()
    await phone.goto(tunnelUrl)
    await expect(phone.getByTestId('unpaired-notice')).toBeVisible({ timeout: 60_000 })
    // Its own sign-in names it: another browser may have signed in since.
    const name = await signInWithCode(phone, (await mintBrowserCode(page.request)).code.toLowerCase(), 60_000)
    await settleSignedIn(phone)
    await meNamesDevice(context, name)
    return { phone, context, name }
  }

  test('C39 C74: no code buttons, its own row first and marked, no Remove on the others', async ({ page, browser }) => {
    // Another browser signed in, so the list has a row that is not this phone.
    const other = await page.request.post('/api/v1/browser-pair', { data: { code: (await mintBrowserCode(page.request)).code } })
    expect(other.ok()).toBe(true)
    const { phone, context, name } = await signedInPhone(browser, page)
    await openSettings(phone)
    await openPane(phone, 'settings-nav-devices', 'Phones & Cloud')
    const devices = await backToDevices(phone)
    await expect(devices.getByTestId('devices-browsers-group')).toBeVisible({ timeout: 30_000 })
    await openWay(phone, 'browser')
    await expect(phone.getByTestId('browser-access-code')).toHaveCount(0)
    await expect(phone.getByTestId('browser-access-link')).toHaveCount(0)
    await expect(phone.getByTestId('browser-access-codes-elsewhere')).toHaveText('The sign-in link shows on the computer Walnut runs on.')
    // The All devices tab holds the list of devices.
    await backToDevices(phone)
    await expect(devices).not.toContainText('No phone has the Walnut app signed in yet')
    const group = devices.getByTestId('devices-browsers-group')
    await expect(group).toContainText('Browsers signed in to this Walnut')
    const rows = group.locator('[data-device-name]')
    expect(await rows.count()).toBeGreaterThanOrEqual(2)
    await expect(rows.first()).toHaveAttribute('data-device-name', name)
    const tag = rows.first().getByTestId('devices-own-tag')
    await expect(tag).toHaveText('This phone')
    // N2-21: the row is named by what it is (an iPhone UA here), never by its id.
    await expect(rows.first().locator('.devices-name')).toContainText(/^iPhone Safari( \d+)?This phoneAll addresses$/)
    await expect(rows.first().locator('.settings-tag')).toHaveText('All addresses')
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
    await backToDevices(phone)
    const own = phone.locator(`[data-device-name="${name}"]`)
    await own.getByTestId('devices-sign-out').click({ timeout: 30_000 })
    const sheet = phone.getByTestId('devices-sign-out-sheet')
    await expect(sheet.getByRole('heading')).toHaveText('Sign out this phone?')
    await expect(sheet).toContainText('You will need a new link from your computer to sign in again.')
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
    await landedTab(page)
    await expect(page.getByTestId('devices-home-screen-hint')).toHaveCount(0)
    await expect(page.locator('.settings-layout')).not.toHaveAttribute('data-phone-settings', /.+/)
    // Nav and pane side by side, as before.
    const nav = (await page.locator('.settings-nav').boundingBox())!
    const pane = (await page.locator('.settings-pane').boundingBox())!
    expect(pane.x).toBeGreaterThanOrEqual(nav.x + nav.width - 1)
    await openWay(page, 'browser')
    await expect(page.getByTestId('browser-access-code')).toBeVisible({ timeout: 30_000 })
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
    await landedTab(page)
    await expect(page.getByTestId('devices-home-screen-hint')).toHaveCount(0)
  })
})
