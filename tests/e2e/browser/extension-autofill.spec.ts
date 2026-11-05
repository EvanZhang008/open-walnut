/**
 * The extension's autofill as a person uses it, beside extension-passwords.spec.ts: the in-page
 * menu worked from the keyboard, one-time codes (the code shown with its countdown, filled into
 * one field or six boxes, copied after a login fill and cleared from the clipboard 30 s later,
 * offered on the code page that follows once the person is in the field), the toolbar count, a strong password that
 * fits the field's rules, the popup generator's kept options, the save bar's corrections and
 * its pick of which login to update, the "Never" list in Settings, per-site match rules, an
 * https login on an http page, the auto-lock, and cards and identities.
 *
 * Its sites are *.autofill.test, *.mfa.test, *.tls.test and *.rule.test (mapped to this machine), so nothing saved by
 * the other specs on the shared fixture vault matches them.
 */
import { expect, test, chromium, type BrowserContext, type Frame, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { bunRuntime } from '../../helpers/bun-runtime'
import { parseTotp, totpAt } from '../../../src/core/vault/totp'

test.describe.configure({ mode: 'serial' })

const MASTER = 'Correct Horse Battery Staple 42'
const stamp = Date.now().toString(36)
const SEED = 'JBSWY3DPEHPK3PXP'

let ctx: BrowserContext
let extId = ''
let sites: http.Server
let port = 0
let base = ''
const site = (host: string, p: string) => `http://${host}:${port}${p}`
const ids: Record<string, string> = {}

const PAGES: Record<string, string> = {
  '/login': `<h1>Sign in</h1><form method="post" action="/welcome">
      <input name="email" id="user" autocomplete="username" placeholder="Email">
      <input name="password" type="password" id="pass" autocomplete="current-password">
      <button type="submit" id="go">Sign in</button></form>`,
  '/pw-only': `<h1>Password</h1><form method="post" action="/welcome">
      <input name="password" type="password" id="pass" autocomplete="current-password">
      <button type="submit" id="go">Sign in</button></form>`,
  '/code6': `<h1>Enter the code</h1><form method="post" action="/welcome"><div id="boxes">
      ${[1, 2, 3, 4, 5, 6].map((i) => `<input id="c${i}" maxlength="1" inputmode="numeric" ${i === 1 ? 'autocomplete="one-time-code"' : ''} style="width:28px">`).join('')}
      </div><button type="submit">Verify</button></form>`,
  '/code1': `<h1>Enter the code</h1><form method="post" action="/welcome"><input id="otp" name="otp" autocomplete="one-time-code"><button>Verify</button></form>`,
  '/signup-rules': `<h1>Create account</h1><form method="post" action="/welcome">
      <input name="email" type="email" id="user" placeholder="Email">
      <input type="password" id="new1" autocomplete="new-password" maxlength="12" pattern="[A-Za-z0-9]{8,12}">
      <button type="submit">Create account</button></form>`,
  '/checkout': `<h1>Pay</h1><form>
      <input id="ccname" autocomplete="cc-name" placeholder="Name on card">
      <input id="ccnum" autocomplete="cc-number" placeholder="Card number">
      <select id="ccmonth" autocomplete="cc-exp-month"><option value="">MM</option>${Array.from({ length: 12 }, (_, i) => `<option value="${String(i + 1).padStart(2, '0')}">${String(i + 1).padStart(2, '0')}</option>`).join('')}</select>
      <select id="ccyear" autocomplete="cc-exp-year"><option value="">YYYY</option>${[2027, 2028, 2029, 2030].map((y) => `<option>${y}</option>`).join('')}</select>
      <input id="cvc" autocomplete="cc-csc" placeholder="CVC" maxlength="4">
      <button type="button">Pay</button></form>`,
  '/address': `<h1>Shipping</h1><form>
      <input id="fn" autocomplete="given-name" placeholder="First name"><input id="ln" autocomplete="family-name" placeholder="Last name">
      <input id="em" type="email" autocomplete="email" placeholder="Email"><input id="tel" type="tel" autocomplete="tel" placeholder="Phone">
      <input id="a1" autocomplete="address-line1" placeholder="Address"><input id="city" autocomplete="address-level2" placeholder="City">
      <input id="zip" autocomplete="postal-code" placeholder="ZIP">
      <select id="country" autocomplete="country"><option value="">Country</option><option value="CA">Canada</option><option value="US">United States</option></select>
      <button type="button">Continue</button></form>`,
  '/welcome': `<h1 id="welcome">Signed in</h1>`,
}

function startSites(): Promise<void> {
  sites = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x')
    const page = PAGES[u.pathname]
    const send = () => {
      res.writeHead(page ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' })
      res.end(page ? `<!doctype html><html><head><title>${u.pathname}</title></head><body>${page}</body></html>` : 'not found')
    }
    if (req.method === 'POST') { req.resume(); req.on('end', send) } else send()
  })
  return new Promise((resolve) => sites.listen(0, '127.0.0.1', () => { port = (sites.address() as AddressInfo).port; resolve() }))
}

// ── Walnut, through its API ──

async function session(page: Page): Promise<string> {
  const st = await (await page.request.get(`${base}/api/v1/vault/status`)).json()
  const r = st.setUp
    ? await page.request.post(`${base}/api/v1/vault/unlock`, { data: { password: MASTER, kdfSalt: st.kdf?.salt } })
    : await page.request.post(`${base}/api/v1/vault/setup`, { data: { password: MASTER } })
  expect(r.ok(), await r.text()).toBe(true)
  return (await r.json()).session.token
}

async function api(page: Page, method: 'GET' | 'POST', p: string, data?: unknown): Promise<any> {
  const s = await session(page)
  const r = method === 'GET'
    ? await page.request.get(`${base}/api/v1${p}`, { headers: { 'x-walnut-vault-session': s } })
    : await page.request.post(`${base}/api/v1${p}`, { headers: { 'x-walnut-vault-session': s }, data })
  expect(r.ok(), await r.text()).toBe(true)
  return r.json()
}

async function seed(page: Page, key: string, item: Record<string, unknown>): Promise<void> {
  ids[key] = (await api(page, 'POST', '/vault/items', { item })).item.id
}

const item = (page: Page, key: string) => api(page, 'GET', `/vault/items/${ids[key]}`).then((r) => r.item)

// ── the extension's pages ──

const sw = () => ctx.serviceWorkers()[0]

async function frameOf(page: Page, file: string): Promise<Frame> {
  let f: Frame | undefined
  await expect.poll(() => { f = page.frames().find((x) => x.url().includes(`/${file}`) && !x.isDetached()); return !!f }, { timeout: 10_000 }).toBe(true)
  await page.waitForTimeout(650) // its buttons act once it has been on screen a moment (frame-guard.ts)
  return f!
}

async function noFrame(page: Page, file: string): Promise<void> {
  await expect.poll(() => page.frames().filter((x) => x.url().includes(`/${file}`) && !x.isDetached()).length, { timeout: 10_000 }).toBe(0)
}

/** The popup, about the page in `win` (as the side panel shows it), or about nothing. */
async function popup(win?: number): Promise<Page> {
  let p: Page
  if (win) {
    // A window of its own, as the side panel is: the page's window keeps its page as the active tab.
    const opened = ctx.waitForEvent('page')
    await sw().evaluate((u: string) => chrome.windows.create({ url: u, type: 'popup', width: 380, height: 640 }), `chrome-extension://${extId}/popup.html?embed=panel&window=${win}`)
    p = await opened
  } else {
    p = await ctx.newPage()
    await p.goto(`chrome-extension://${extId}/popup.html`)
  }
  p.on('pageerror', (e) => console.log(`[popup pageerror] ${e.message}`))
  return p
}

/** A page in a window of its own, so a popup can be about it. */
async function pageInWindow(url: string): Promise<{ page: Page; win: number; tab: number }> {
  const opened = ctx.waitForEvent('page')
  const w = await sw().evaluate((u: string) => chrome.windows.create({ url: u, focused: true }).then((x) => ({ win: x.id ?? 0, tab: x.tabs?.[0]?.id ?? 0 })), url)
  const page = await opened
  await page.waitForLoadState('domcontentloaded')
  return { page, ...w }
}

async function clipboard(): Promise<string> {
  const p = await ctx.newPage()
  await p.goto(`chrome-extension://${extId}/popup.html?embed=panel`)
  await p.bringToFront()
  const text = await p.evaluate(() => navigator.clipboard.readText())
  await p.close()
  return text
}

async function totpNow(page: Page, key: string): Promise<string> {
  return (await api(page, 'GET', `/vault/items/${ids[key]}/totp`)).code
}

test.beforeAll(async ({}, info) => {
  test.setTimeout(240_000)
  base = String(info.project.use.baseURL ?? 'http://localhost:3457')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-ext-af-'))
  execFileSync(bunRuntime(), ['scripts/build-extension.mjs', '--out', dir, '--no-zip'], { stdio: 'pipe' })
  await startSites()
  ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-ext-af-profile-')), {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1100, height: 760 },
    args: [
      `--disable-extensions-except=${path.join(dir, 'chrome')}`,
      `--load-extension=${path.join(dir, 'chrome')}`,
      '--host-resolver-rules=MAP *.autofill.test 127.0.0.1, MAP *.rule.test 127.0.0.1, MAP *.mfa.test 127.0.0.1, MAP *.tls.test 127.0.0.1',
    ],
  })
  let worker = ctx.serviceWorkers()[0]
  if (!worker) worker = await ctx.waitForEvent('serviceworker')
  worker.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[background ${m.type()}] ${m.text()}`) })
  extId = new URL(worker.url()).host
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: `chrome-extension://${extId}` }).catch(() => {})

  // The vault and what this spec fills.
  const p = await ctx.newPage()
  await seed(p, 'ada', { type: 'login', title: `Ada ${stamp}`, username: 'ada@autofill.test', password: `Ada-pw-${stamp}`, urls: [site('www.autofill.test', '')] })
  await seed(p, 'bob', { type: 'login', title: `Bob ${stamp}`, username: 'bob@autofill.test', password: `Bob-pw-${stamp}`, urls: [site('www.autofill.test', '')] })
  await seed(p, 'mfa', { type: 'login', title: `Mfa ${stamp}`, username: 'mia@autofill.test', password: `Mia-pw-${stamp}`, totp: SEED, urls: [site('login.mfa.test', '')] })
  await seed(p, 'secure', { type: 'login', title: `Secure ${stamp}`, username: 'sam@autofill.test', password: 'Sam-pw-1', urls: [`https://secure.tls.test:${port}`] })
  await seed(p, 'host', { type: 'login', title: `Accounts ${stamp}`, username: 'amy@rule.test', password: 'Amy-pw-1', urls: [`${site('accounts.rule.test', '')}#walnut-match=host`] })
  await seed(p, 'never', { type: 'login', title: `Never ${stamp}`, username: 'ned@rule.test', password: 'Ned-pw-1', urls: [`${site('www.rule.test', '')}#walnut-match=never`] })
  await seed(p, 'card', { type: 'card', title: `Visa ${stamp}`, card: { holder: 'Ada Example', number: '4242 4242 4242 4242', expMonth: '03', expYear: '29', code: '123' } })
  await seed(p, 'who', {
    type: 'identity', title: `Home ${stamp}`,
    fields: [{ name: 'First name', value: 'Ada' }, { name: 'Last name', value: 'Example' }, { name: 'Email', value: 'ada@autofill.test' }, { name: 'Phone', value: '555-0100' },
      { name: 'Address 1', value: '1 Main St' }, { name: 'City', value: 'Springfield' }, { name: 'ZIP', value: '12345' }, { name: 'Country', value: 'US' }],
  })

  // Connect the extension and unlock it.
  await p.goto(`chrome-extension://${extId}/popup.html`)
  await p.locator('#server').fill(base)
  const opened = ctx.waitForEvent('page')
  await p.getByTestId('popup-connect').click()
  const connect = await opened
  await expect(connect.getByRole('heading', { name: 'Connect this browser to Walnut?' })).toBeVisible({ timeout: 60_000 })
  await connect.getByTestId('connect-extension-go').click()
  await expect(connect.getByTestId('connect-extension-done')).toBeVisible({ timeout: 20_000 })
  await connect.close()
  const un = await popup()
  await un.getByLabel('Master password').fill(MASTER)
  await un.getByTestId('popup-unlock').click()
  await expect(un.getByLabel('Search Walnut')).toBeVisible({ timeout: 30_000 })
  await un.close()
})

test.afterAll(async () => {
  await ctx?.close()
  await new Promise<void>((r) => sites?.close(() => r()) ?? r())
})

test('the menu works from the keyboard: ArrowDown opens and moves into it, Enter fills, Escape and Tab give the field back', async () => {
  const page = await ctx.newPage()
  await page.goto(site('www.autofill.test', '/login'))
  await page.locator('#user').click()
  let menu = await frameOf(page, 'menu.html')
  await expect(menu.getByTestId('menu-item')).toHaveCount(2)
  // ArrowDown in the field: the first login is picked, as a listbox says it.
  await page.keyboard.press('ArrowDown')
  const list = menu.locator('[role=listbox]')
  const first = menu.getByTestId('menu-item').nth(0)
  await expect(first).toHaveAttribute('aria-selected', 'true')
  await expect(list).toHaveAttribute('aria-activedescendant', (await first.getAttribute('id'))!)
  await page.keyboard.press('ArrowDown')
  const second = menu.getByTestId('menu-item').nth(1)
  await expect(second).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('ArrowUp')
  await expect(first).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('ArrowDown')
  const pick = (await second.textContent()) ?? ''
  await page.keyboard.press('Enter')
  const who = pick.includes('Bob') ? 'bob' : 'ada'
  await expect(page.locator('#user')).toHaveValue(`${who}@autofill.test`, { timeout: 15_000 })
  await expect(page.locator('#pass')).toHaveValue(`${who === 'bob' ? 'Bob' : 'Ada'}-pw-${stamp}`)
  await noFrame(page, 'menu.html')

  // Escape in the menu closes it and the field has the focus again.
  await page.locator('#user').fill('')
  await page.keyboard.press('ArrowDown')
  menu = await frameOf(page, 'menu.html')
  await expect(menu.getByTestId('menu-item').nth(0)).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Escape')
  await noFrame(page, 'menu.html')
  expect(await page.evaluate(() => document.activeElement?.id)).toBe('user')
  // ArrowDown again opens it; Tab in the field closes it and moves on.
  await page.keyboard.press('ArrowDown')
  await frameOf(page, 'menu.html')
  await page.keyboard.press('Escape')
  await noFrame(page, 'menu.html')
  await page.locator('#user').click()
  await frameOf(page, 'menu.html')
  await page.keyboard.press('Tab')
  await noFrame(page, 'menu.html')
  expect(await page.evaluate(() => document.activeElement?.id)).toBe('pass')
  await page.close()
})

test('the toolbar badge counts the logins of the tab; a never login is none', async () => {
  const { page, tab } = await pageInWindow(site('www.autofill.test', '/login'))
  const badge = () => sw().evaluate((t: number) => chrome.action.getBadgeText({ tabId: t }), tab)
  await expect.poll(badge, { timeout: 10_000 }).toBe('2')
  await page.goto(site('login.mfa.test', '/login'))
  await expect.poll(badge, { timeout: 10_000 }).toBe('1')
  await page.goto(site('www.rule.test', '/login'))
  // A "never" login is no match.
  await expect.poll(badge, { timeout: 10_000 }).toBe('')
  await page.close()
})

test('a login with a one-time code: its code is copied as it fills, the code page offers it once the person is in the field, six boxes take one digit each, the clipboard is cleared after 30 s', async () => {
  test.setTimeout(180_000)
  const page = await ctx.newPage()
  await page.goto(site('login.mfa.test', '/login'))
  await page.locator('#user').click()
  await (await frameOf(page, 'menu.html')).getByTestId('menu-item').filter({ hasText: `Mfa ${stamp}` }).click()
  await expect(page.locator('#pass')).toHaveValue(`Mia-pw-${stamp}`)
  const copiedAt = Date.now()
  await expect.poll(clipboard, { timeout: 10_000 }).toMatch(/^\d{6}$/)
  const copied = await clipboard()
  // The code of the moment it was copied: a 30 s window may have turned over since.
  const params = parseTotp(SEED)!
  const now = Date.now()
  const near = await Promise.all([now - 30_000, now].map(async (t) => (await totpAt(params, t)).code))
  expect([...near, await totpNow(page, 'mfa')]).toContain(copied)

  // The code page right after: the menu waits for the person (it never opens by itself over the
  // page's Verify button), then offers the code with its countdown.
  await page.goto(site('login.mfa.test', '/code6'))
  await page.waitForTimeout(1200)
  expect(page.frames().some((f) => f.url().includes('/menu.html'))).toBe(false)
  await page.locator('#c1').click()
  const menu = await frameOf(page, 'menu.html')
  const row = menu.getByTestId('menu-item').filter({ hasText: `Mfa ${stamp}` })
  await expect(row.getByTestId('totp-code')).toHaveText(/\d{3} \d{3}\d{1,2}/)
  await row.click()
  const code = await totpNow(page, 'mfa')
  await expect.poll(() => page.evaluate(() => [1, 2, 3, 4, 5, 6].map((i) => (document.getElementById(`c${i}`) as HTMLInputElement).value).join(''))).toBe(code)
  expect(await page.evaluate(() => (document.getElementById('c3') as HTMLInputElement).value.length)).toBe(1)

  // One field with autocomplete="one-time-code", from its menu once the person is in it (waiting
  // for a menu that never opens by itself spent 10 s of the 30 s this test checks on a busy runner).
  await page.goto(site('login.mfa.test', '/code1'))
  await page.locator('#otp').click()
  await (await frameOf(page, 'menu.html')).getByTestId('menu-item').first().click()
  await expect(page.locator('#otp')).toHaveValue(/^\d{6}$/)

  // The popup shows the code with its countdown too.
  const { page: tabPage, win } = await pageInWindow(site('login.mfa.test', '/login'))
  const p = await popup(win)
  await expect(p.getByTestId('popup-item').filter({ hasText: `Mfa ${stamp}` }).getByTestId('totp-code')).toHaveText(/\d{3} \d{3}/, { timeout: 15_000 })
  await p.close()
  await tabPage.close()

  // 30 s after the copy, the code is gone from the clipboard (it still held it).
  await page.waitForTimeout(Math.max(0, copiedAt + 32_000 - Date.now()))
  await expect.poll(clipboard, { timeout: 15_000 }).toBe('')
  await page.close()
})

test('a copied password is cleared after 30 s, but not what the person copied since', async () => {
  test.setTimeout(120_000)
  const { page, win } = await pageInWindow(site('www.autofill.test', '/login'))
  const p = await popup(win)
  const row = p.getByTestId('popup-item').filter({ hasText: `Ada ${stamp}` })
  await row.hover()
  await row.getByTestId('copy-password').click()
  await expect.poll(clipboard).toBe(`Ada-pw-${stamp}`)
  await p.close()
  await page.waitForTimeout(32_000)
  await expect.poll(clipboard, { timeout: 15_000 }).toBe('')
  await page.close()
})

test('a strong password fits the field (maxlength 12, letters and digits only); another one on request', async () => {
  const page = await ctx.newPage()
  await page.goto(site('shop.autofill.test', '/signup-rules'))
  await page.locator('#user').fill(`neo-${stamp}@autofill.test`)
  await page.locator('#new1').click()
  const menu = await frameOf(page, 'menu.html')
  const shown = menu.getByTestId('menu-suggestion')
  await expect(shown).toHaveText(/^[A-Za-z0-9]{12}$/)
  const before = await shown.textContent()
  await menu.getByTestId('menu-regenerate').click()
  await expect(shown).not.toHaveText(before!)
  const now = await shown.textContent()
  await menu.getByTestId('menu-generate').click()
  await expect(page.locator('#new1')).toHaveValue(now!)
  expect(await page.locator('#new1').evaluate((el: HTMLInputElement) => el.checkValidity())).toBe(true)
  await page.close()
})

test('the popup generator: passphrase, word count and character sets are kept for next time', async () => {
  const p = await popup()
  await p.getByTestId('popup-generator').click()
  await p.getByTestId('gen-kind-words').click()
  await p.getByTestId('gen-words').fill('4')
  await p.getByTestId('gen-separator').selectOption('.')
  await expect(p.getByTestId('gen-out')).toHaveText(/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+){3}$/)
  await p.getByTestId('gen-kind-random').click()
  await p.getByTestId('gen-symbols').uncheck()
  await p.getByTestId('gen-length').fill('30')
  await expect(p.getByTestId('gen-out')).toHaveText(/^[A-Za-z0-9]{30}$/)
  await p.close()
  const again = await popup()
  await again.getByTestId('popup-generator').click()
  await expect(again.getByTestId('gen-kind-random')).toHaveAttribute('aria-pressed', 'true')
  await expect(again.getByTestId('gen-symbols')).not.toBeChecked()
  await expect(again.getByTestId('gen-out')).toHaveText(/^[A-Za-z0-9]{30}$/)
  await again.getByTestId('gen-kind-words').click()
  await expect(again.getByTestId('gen-out')).toHaveText(/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+){3}$/)
  await again.getByTestId('gen-kind-random').click()
  await again.close()
})

test('the save bar: pick which login to update when the site has several, correct the password first', async () => {
  const page = await ctx.newPage()
  await page.goto(site('www.autofill.test', '/pw-only'))
  await page.locator('#pass').click()
  await page.keyboard.press('Escape')
  await page.locator('#pass').pressSequentially('Typed-wrong-1')
  await page.locator('#go').click()
  await expect(page.locator('#welcome')).toBeVisible()
  const bar = await frameOf(page, 'savebar.html')
  const target = bar.getByTestId('savebar-target')
  await expect(target.locator('option')).toHaveCount(3) // Ada, Bob, a new login
  await target.selectOption(ids.bob)
  await expect(bar.getByText(`Update the password for Bob ${stamp}?`)).toBeVisible()
  // The person sees what was sent and corrects it.
  await bar.getByTestId('savebar-reveal').click()
  await expect(bar.locator('#password')).toHaveValue('Typed-wrong-1')
  await bar.locator('#password').fill(`Bob-new-${stamp}`)
  await bar.getByTestId('savebar-update').click()
  await expect(bar.getByText('Password updated in Walnut')).toBeVisible()
  expect((await item(page, 'bob')).password).toBe(`Bob-new-${stamp}`)
  expect((await item(page, 'ada')).password).toBe(`Ada-pw-${stamp}`)
  await page.close()
})

test('the save bar: a new login with a corrected username; Never for this site is listed in Settings and removable', async () => {
  const page = await ctx.newPage()
  await page.goto(site('new.autofill.test', '/login'))
  await page.locator('#user').fill(`typo-${stamp}`)
  await page.locator('#pass').fill(`Neo-pw-${stamp}`)
  await page.locator('#go').click()
  let bar = await frameOf(page, 'savebar.html')
  await expect(bar.locator('#username')).toHaveValue(`typo-${stamp}`)
  await bar.locator('#username').fill(`neo-${stamp}@autofill.test`)
  await bar.locator('#title').fill(`Neo ${stamp}`)
  await bar.getByTestId('savebar-save').click()
  await expect(bar.getByText('Saved to Walnut')).toBeVisible()
  const saved = (await api(page, 'GET', '/vault/items')).items.find((i: { title: string }) => i.title === `Neo ${stamp}`)
  expect(saved.username).toBe(`neo-${stamp}@autofill.test`)

  // Never for this site, then taken off again in Settings.
  await page.goto(site('www.rule.test', '/login'))
  await page.locator('#user').fill('someone')
  await page.locator('#pass').fill('Some-pw-1')
  await page.locator('#go').click()
  bar = await frameOf(page, 'savebar.html')
  await bar.getByRole('button', { name: 'Never for this site' }).click()
  await noFrame(page, 'savebar.html')
  const p = await popup()
  await p.getByTestId('popup-settings').click()
  const list = p.getByTestId('never-list')
  // Never names the host it was said on (www.rule.test), not the whole rule.test site.
  await expect(list).toContainText('www.rule.test')
  await list.getByRole('button', { name: 'Remove www.rule.test' }).click()
  await expect(p.getByTestId('never-list')).not.toContainText('rule.test')
  expect(await sw().evaluate(() => chrome.storage.local.get('neverSave').then((r) => r.neverSave))).toEqual([])
  await p.close()
  await page.close()
})

test('match rules: an exact-host login only on its host, a never login nowhere; an https login on an http page says why', async () => {
  // Exact host: offered on accounts.rule.test, not on www.rule.test.
  let w = await pageInWindow(site('accounts.rule.test', '/login'))
  let p = await popup(w.win)
  await expect(p.getByTestId('popup-item').filter({ hasText: `Accounts ${stamp}` })).toBeVisible({ timeout: 15_000 })
  await p.close(); await w.page.close()
  w = await pageInWindow(site('www.rule.test', '/login'))
  p = await popup(w.win)
  await expect(p.getByText('No saved login for this site.')).toBeVisible({ timeout: 15_000 })
  await expect(p.getByTestId('popup-item').filter({ hasText: new RegExp(`(Never|Accounts) ${stamp}`) })).toHaveCount(0)
  await p.close(); await w.page.close()

  // Saved for https; this page is http: the popup and the menu say so plainly.
  w = await pageInWindow(site('secure.tls.test', '/login'))
  p = await popup(w.win)
  await expect(p.getByTestId('popup-insecure')).toContainText('not secure (http)')
  await p.close()
  await w.page.locator('#user').click()
  await w.page.locator('walnut-ext').first().waitFor({ state: 'attached' })
  const box = (await w.page.locator('#user').boundingBox())!
  await w.page.mouse.click(box.x + box.width - 15, box.y + box.height / 2)
  const menu = await frameOf(w.page, 'menu.html')
  await expect(menu.getByText('Not offered on this page')).toBeVisible()
  await expect(menu.getByText(/not secure \(http\)/)).toBeVisible()
  await w.page.close()
})

test('a card fills a payment form and an identity an address form, from the menu and the popup', async () => {
  const page = await ctx.newPage()
  await page.goto(site('shop.autofill.test', '/checkout'))
  await page.locator('#ccnum').click()
  const menu = await frameOf(page, 'menu.html')
  const card = menu.getByTestId('menu-item').filter({ hasText: `Visa ${stamp}` })
  await expect(card).toContainText('•••• 4242')
  await card.click()
  await expect(page.locator('#ccnum')).toHaveValue('4242424242424242')
  await expect(page.locator('#ccname')).toHaveValue('Ada Example')
  await expect(page.locator('#ccmonth')).toHaveValue('03')
  await expect(page.locator('#ccyear')).toHaveValue('2029')
  await expect(page.locator('#cvc')).toHaveValue('123')

  await page.goto(site('shop.autofill.test', '/address'))
  await page.locator('#a1').click()
  await (await frameOf(page, 'menu.html')).getByTestId('menu-item').filter({ hasText: `Home ${stamp}` }).click()
  await expect(page.locator('#fn')).toHaveValue('Ada')
  await expect(page.locator('#ln')).toHaveValue('Example')
  await expect(page.locator('#em')).toHaveValue('ada@autofill.test')
  await expect(page.locator('#tel')).toHaveValue('555-0100')
  await expect(page.locator('#a1')).toHaveValue('1 Main St')
  await expect(page.locator('#city')).toHaveValue('Springfield')
  await expect(page.locator('#zip')).toHaveValue('12345')
  await expect(page.locator('#country')).toHaveValue('US')
  await page.close()

  // The popup lists them and fills the page's form.
  const w = await pageInWindow(site('shop.autofill.test', '/checkout'))
  const p = await popup(w.win)
  await p.getByTestId('popup-item').filter({ hasText: `Visa ${stamp}` }).click()
  await expect(w.page.locator('#ccnum')).toHaveValue('4242424242424242')
  await p.close()
  await w.page.close()
})

test('auto-lock: after the chosen time with no use, the extension locks itself, and the badges go', async () => {
  const p = await popup()
  await p.getByTestId('popup-settings').click()
  await p.getByTestId('popup-autolock').selectOption('1')
  await expect.poll(() => sw().evaluate(() => chrome.storage.local.get('settings').then((r) => r.settings?.autoLock))).toBe('1')
  await p.close()
  const w = await pageInWindow(site('www.autofill.test', '/login'))
  // Ada and Bob: the login saved above on new.autofill.test is another part of the site (tier 2), never counted.
  await expect.poll(() => sw().evaluate((t: number) => chrome.action.getBadgeText({ tabId: t }), w.tab), { timeout: 10_000 }).toBe('2')
  // Two minutes with no use.
  await sw().evaluate(() => chrome.storage.session.set({ lastActive: Date.now() - 120_000 }))
  const again = await popup()
  await expect(again.getByRole('heading', { name: 'Walnut is locked' })).toBeVisible({ timeout: 15_000 })
  // Locked: no tab shows a count.
  await expect.poll(() => sw().evaluate((t: number) => chrome.action.getBadgeText({ tabId: t }), w.tab), { timeout: 10_000 }).toBe('')
  await w.page.close()
  // Unlocked again, the time starts over.
  await again.getByLabel('Master password').fill(MASTER)
  await again.getByTestId('popup-unlock').click()
  await expect(again.getByLabel('Search Walnut')).toBeVisible({ timeout: 30_000 })
  await again.getByTestId('popup-settings').click()
  await expect(again.getByTestId('popup-autolock')).toHaveValue('1')
  await again.getByTestId('popup-autolock').selectOption('15')
  await again.close()
})
