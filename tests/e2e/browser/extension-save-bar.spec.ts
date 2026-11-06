/**
 * A save bar on screen keeps working for as long as it may stay, with the real built extension:
 * past the 3 minutes a sent login is offered for, after the background was stopped (Chrome stops
 * an idle service worker after about 30 s), and when the page sends the same login twice. A bar
 * whose login is gone says so in place and never closes silently.
 *
 * Its sites are *.sb.test (mapped to this machine), so nothing the other specs save on the
 * shared fixture vault matches them.
 */
import { expect, test, chromium, type BrowserContext, type Frame, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { bunRuntime } from '../../helpers/bun-runtime'
import { vaultSession } from './vault-session-helper'
import { holdVaultLock } from './vault-lock'

test.describe.configure({ mode: 'serial' })
// It needs its unlocks to hold on the shared fixture vault, where another file may end every unlock.
holdVaultLock('shared', 'file')

const MASTER = 'Correct Horse Battery Staple 42'
const stamp = Date.now().toString(36)
const SHOTS = process.env.WALNUT_TASK_DIR ? path.join(process.env.WALNUT_TASK_DIR, 'review/fix-shots/a1') : ''

let ctx: BrowserContext
let extId = ''
let sites: http.Server
let port = 0
let base = ''
const site = (host: string, p: string) => `http://${host}:${port}${p}`

const PAGES: Record<string, { title: string; body: string }> = {
  '/login': { title: 'Sign in to SB Shop', body: `<form method="post" action="/welcome">
      <input name="email" id="user" autocomplete="username" placeholder="Email">
      <input name="password" type="password" id="pass" autocomplete="current-password">
      <button type="submit" id="go">Sign in</button></form>` },
  // Sends without leaving the page, as a single-page app does.
  '/spa': { title: 'Sign in to SB App', body: `<form id="f">
      <input name="email" id="user" autocomplete="username" placeholder="Email">
      <input name="password" type="password" id="pass" autocomplete="current-password">
      <button type="submit" id="go">Sign in</button></form><p id="done" hidden>Signed in</p>
      <script>document.getElementById('f').addEventListener('submit', (e) => { e.preventDefault(); document.getElementById('done').hidden = false })</script>` },
  // The lab's sign-up: a name, an email and one new password.
  '/signup': { title: 'Create your SB Shop account', body: `<form method="post" action="/welcome">
      <label>Name <input name="name" autocomplete="name"></label>
      <label>Email <input name="email" type="email" id="user" autocomplete="email"></label>
      <label>Password <input name="password" type="password" id="new1" autocomplete="new-password"></label>
      <button type="submit" id="go">Create account</button></form>` },
  '/welcome': { title: 'Welcome back', body: '<h1 id="welcome">Signed in</h1>' },
  // A site whose account box is type=email but takes a plain account name, and signs in by script
  // on Enter in the password (no native submit): the browser's checks never run, the login goes.
  '/script-enter': { title: 'Sign in to SB Script', body: `<form id="f">
      <input name="login" type="email" id="user" autocomplete="username">
      <input name="password" type="password" id="pass" autocomplete="current-password">
      <button type="button" id="go">Sign in</button></form><p id="done" hidden>Signed in</p>
      <script>
        const send = () => fetch('/api/sign-in', { method: 'POST', body: 'x' }).then(() => { document.getElementById('done').hidden = false })
        document.getElementById('pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); send() } })
        document.getElementById('go').addEventListener('click', send)
      </script>` },
  // The same box left to the browser, but the page also sends the login itself on Enter: the
  // browser stops its own submit, the page's request went anyway.
  '/held-but-sent': { title: 'Sign in to SB Both', body: `<form method="post" action="/welcome">
      <input name="login" type="email" id="user" autocomplete="username">
      <input name="password" type="password" id="pass" autocomplete="current-password">
      <button type="submit" id="go">Sign in</button></form><p id="done" hidden>Signed in</p>
      <script>
        document.getElementById('pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') fetch('/api/sign-in', { method: 'POST', body: 'x' }).then(() => { document.getElementById('done').hidden = false }) })
      </script>` },
  // novalidate: the browser checks nothing and the form goes.
  '/novalidate': { title: 'Sign in to SB Loose', body: `<form method="post" action="/welcome" novalidate>
      <input name="login" type="email" id="user" autocomplete="username">
      <input name="password" type="password" id="pass" autocomplete="current-password">
      <button type="submit" id="go">Sign in</button></form>` },
  '/api/sign-in': { title: 'ok', body: 'ok' },
}

function startSites(): Promise<void> {
  sites = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x')
    const page = PAGES[u.pathname]
    const send = () => {
      res.writeHead(page ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' })
      res.end(page ? `<!doctype html><html><head><title>${page.title}</title></head><body>${page.body}</body></html>` : 'not found')
    }
    if (req.method === 'POST') { req.resume(); req.on('end', send) } else send()
  })
  return new Promise((resolve) => sites.listen(0, '127.0.0.1', () => { port = (sites.address() as AddressInfo).port; resolve() }))
}

async function api(page: Page, method: 'GET' | 'POST', p: string, data?: unknown): Promise<any> {
  const s = await vaultSession(page, base, { password: MASTER })
  const r = method === 'GET'
    ? await page.request.get(`${base}/api/v1${p}`, { headers: { 'x-walnut-vault-session': s } })
    : await page.request.post(`${base}/api/v1${p}`, { headers: { 'x-walnut-vault-session': s }, data })
  expect(r.ok(), await r.text()).toBe(true)
  return r.json()
}

const saved = async (page: Page, title: string) => (await api(page, 'GET', '/vault/items')).items.find((i: { title: string }) => i.title === title)

/** The background, started again if Chrome stopped it. */
async function sw() {
  const w = ctx.serviceWorkers().find((x) => x.url().startsWith(`chrome-extension://${extId}/`))
  return w ?? ctx.waitForEvent('serviceworker')
}

async function frameOf(page: Page, file: string): Promise<Frame> {
  let f: Frame | undefined
  await expect.poll(() => { f = page.frames().find((x) => x.url().includes(`/${file}`) && !x.isDetached()); return !!f }, { timeout: 10_000 }).toBe(true)
  await page.waitForTimeout(650) // its buttons act once it has been on screen a moment (frame-guard.ts)
  return f!
}

async function pageInWindow(url: string): Promise<{ page: Page; tab: number }> {
  const opened = ctx.waitForEvent('page')
  const tab = await (await sw()).evaluate((u: string) => chrome.windows.create({ url: u, focused: true }).then((x) => x.tabs?.[0]?.id ?? 0), url)
  const page = await opened
  await page.waitForLoadState('domcontentloaded')
  return { page, tab }
}

/** The login waiting on a tab, as the background keeps it. */
const pending = async (tab: number) => (await sw()).evaluate((t: number) => chrome.storage.session.get('pendingSave').then((r) => r.pendingSave?.[String(t)]), tab)

/** Move the tab's waiting login `ms` into the past, as a clock running on would. */
async function age(tab: number, ms: number): Promise<void> {
  await (await sw()).evaluate(async ({ t, ms }) => {
    const all = (await chrome.storage.session.get('pendingSave')).pendingSave
    const p = all[String(t)]
    p.at -= ms
    if (p.shownAt) p.shownAt -= ms
    await chrome.storage.session.set({ pendingSave: all })
  }, { t: tab, ms })
}

async function sendLogin(page: Page, user: string, pass: string): Promise<void> {
  await page.locator('#user').fill(user)
  await page.locator('#pass').fill(pass)
  await page.locator('#go').click()
}

test.beforeAll(async ({}, info) => {
  test.setTimeout(240_000)
  base = String(info.project.use.baseURL ?? 'http://localhost:3457')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-ext-sb-'))
  execFileSync(bunRuntime(), ['scripts/build-extension.mjs', '--out', dir, '--no-zip'], { stdio: 'pipe' })
  await startSites()
  ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-ext-sb-profile-')), {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1100, height: 760 },
    args: [
      `--disable-extensions-except=${path.join(dir, 'chrome')}`,
      `--load-extension=${path.join(dir, 'chrome')}`,
      '--host-resolver-rules=MAP *.sb.test 127.0.0.1',
    ],
  })
  let worker = ctx.serviceWorkers()[0]
  if (!worker) worker = await ctx.waitForEvent('serviceworker')
  extId = new URL(worker.url()).host

  const p = await ctx.newPage()
  // Sets the fixture's vault up when no spec did yet.
  await api(p, 'GET', '/vault/items')
  await p.goto(`chrome-extension://${extId}/popup.html`)
  await p.locator('#server').fill(base)
  const opened = ctx.waitForEvent('page')
  await p.getByTestId('popup-connect').click()
  const connect = await opened
  await expect(connect.getByRole('heading', { name: 'Connect this browser to Walnut?' })).toBeVisible({ timeout: 60_000 })
  // Agents in this browser stay off here, as the person may choose on this page (on by default):
  // a browser of this spec must not join the fixture Walnut's agents beside the agent specs' own.
  await connect.getByTestId('connect-extension-agents').uncheck()
  await connect.getByTestId('connect-extension-go').click()
  await expect(connect.getByTestId('connect-extension-done')).toBeVisible({ timeout: 20_000 })
  await connect.close()
  const un = await ctx.newPage()
  await un.goto(`chrome-extension://${extId}/popup.html`)
  await un.getByLabel('Master password').fill(MASTER)
  await un.getByTestId('popup-unlock').click()
  await expect(un.getByLabel('Search Walnut')).toBeVisible({ timeout: 30_000 })
  await un.close()
})

test.afterAll(async () => {
  await ctx?.close()
  await new Promise<void>((r) => sites?.close(() => r()) ?? r())
})

test('a bar still on screen 4 minutes after the send still saves its login', async () => {
  const { page, tab } = await pageInWindow(site('shop.sb.test', '/login'))
  await sendLogin(page, `late-${stamp}@sb.test`, 'Late-pw-1')
  await expect(page.locator('#welcome')).toBeVisible()
  const bar = await frameOf(page, 'savebar.html')
  await expect(bar.getByText('Save this login to Walnut?')).toBeVisible()
  // Past the 3 minutes a sent login is offered for: the bar on screen still acts on it.
  await age(tab, 4 * 60_000)
  await bar.locator('#title').fill(`Late ${stamp}`)
  await bar.getByTestId('savebar-save').click()
  await expect(bar.getByText(/Saved to Walnut/)).toBeVisible()
  expect((await saved(page, `Late ${stamp}`))?.username).toBe(`late-${stamp}@sb.test`)
  await page.close()
})

test('a bar whose login is gone says so in place and stays; nothing is saved', async () => {
  const { page, tab } = await pageInWindow(site('shop.sb.test', '/login'))
  await sendLogin(page, `gone-${stamp}@sb.test`, 'Gone-pw-1')
  await expect(page.locator('#welcome')).toBeVisible()
  const bar = await frameOf(page, 'savebar.html')
  await expect(bar.getByText('Save this login to Walnut?')).toBeVisible()
  // Longer than any bar waits.
  await age(tab, 31 * 60_000)
  await bar.locator('#title').fill(`Gone ${stamp}`)
  await bar.getByTestId('savebar-save').click()
  await expect(bar.getByText('This login is no longer waiting. Save it from the Walnut popup.')).toBeVisible()
  await page.waitForTimeout(1000)
  expect(page.frames().some((f) => f.url().includes('/savebar.html') && !f.isDetached())).toBe(true)
  // The frame grew to show the message whole: its bottom is inside the frame.
    await expect.poll(async () => { const m = await bar.getByText('This login is no longer waiting.', { exact: false }).boundingBox(); const f = await (await bar.frameElement()).boundingBox(); return !!m && !!f && m.y + m.height + 8 <= f.y + f.height }).toBe(true)
  if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, 'savebar-login-gone.png') }) }
  // Never says the same, rather than closing.
  await bar.getByRole('button', { name: 'Never for this site' }).click()
  await expect(bar.getByText('This login is no longer waiting. Save it from the Walnut popup.')).toBeVisible()
  expect(await saved(page, `Gone ${stamp}`)).toBeUndefined()
  await page.close()
})

test('the same login sent twice keeps its bar; a different one sent next is the one the bar saves', async () => {
  const { page, tab } = await pageInWindow(site('app.sb.test', '/spa'))
  await sendLogin(page, `twice-${stamp}@sb.test`, 'Twice-pw-1')
  await expect(page.locator('#done')).toBeVisible()
  await frameOf(page, 'savebar.html')
  const first = (await pending(tab)).nonce
  // The page sends the same login again (past the page script's own 1.5 s repeat guard).
  await page.waitForTimeout(1700)
  await page.locator('#go').click()
  await page.waitForTimeout(1200)
  expect((await pending(tab)).nonce).toBe(first)
  let bar = await frameOf(page, 'savebar.html')
  await expect(bar.getByText('Save this login to Walnut?')).toBeVisible()
  // A different password sent next: the bar now offers that one, and saves it.
  await page.waitForTimeout(1700)
  await page.locator('#pass').fill('Twice-pw-2')
  await page.locator('#go').click()
  await expect.poll(async () => (await pending(tab)).nonce, { timeout: 10_000 }).not.toBe(first)
  await page.waitForTimeout(1000)
  bar = await frameOf(page, 'savebar.html')
  await bar.locator('#title').fill(`Twice ${stamp}`)
  await bar.getByTestId('savebar-save').click()
  await expect(bar.getByText(/Saved to Walnut/)).toBeVisible()
  const item = await saved(page, `Twice ${stamp}`)
  expect((await api(page, 'GET', `/vault/items/${item.id}`)).item.password).toBe('Twice-pw-2')
  await page.close()
})

test('a send the browser blocked (its own check of the email failed) offers no save; the send that goes does', async () => {
  test.setTimeout(90_000)
  const { page, tab } = await pageInWindow(site('shop.sb.test', '/signup'))
  await page.locator('#user').fill('not-an-email')
  await page.locator('#new1').fill(`Blocked-pw-${stamp}`)
  // The browser's validation stops the send (R1-14): no login went, so nothing is offered.
  await page.locator('#go').click()
  await page.waitForTimeout(1500)
  expect(await page.locator('#user').evaluate((e) => (e as HTMLInputElement).validity.valid)).toBe(false)
  expect(await pending(tab)).toBeUndefined()
  expect(page.frames().some((f) => f.url().includes('/savebar.html') && !f.isDetached())).toBe(false)
  // Enter in the field is the same send, stopped the same way.
  await page.locator('#new1').press('Enter')
  await page.waitForTimeout(1500)
  expect(await pending(tab)).toBeUndefined()
  // Fixed, it goes, and the bar offers it.
  await page.locator('#user').fill(`valid-${stamp}@sb.test`)
  await page.locator('#go').click()
  await expect(page.locator('#welcome')).toBeVisible()
  const bar = await frameOf(page, 'savebar.html')
  await expect(bar.getByText('Save this login to Walnut?')).toBeVisible()
  await page.close()
})

test('a login the page sends by script on Enter is offered, even with an account box the browser would refuse (R1-14)', async () => {
  test.setTimeout(90_000)
  // Enter: the page's handler stops the native submit and signs in by fetch.
  let { page } = await pageInWindow(site('script.sb.test', '/script-enter'))
  await page.locator('#user').fill(`plainname${stamp}`)
  await page.locator('#pass').fill(`Script-pw-${stamp}`)
  expect(await page.locator('#user').evaluate((e) => (e as HTMLInputElement).validity.valid)).toBe(false)
  await page.locator('#pass').press('Enter')
  await expect(page.locator('#done')).toBeVisible()
  let bar = await frameOf(page, 'savebar.html')
  await expect(bar.getByText('Save this login to Walnut?')).toBeVisible()
  await expect(bar.locator('#username')).toHaveValue(`plainname${stamp}`)
  await page.close()

  // The same page by its button (type=button, a script send).
  ;({ page } = await pageInWindow(site('script2.sb.test', '/script-enter')))
  await page.locator('#user').fill(`other${stamp}`)
  await page.locator('#pass').fill(`Script-pw2-${stamp}`)
  await page.locator('#go').click()
  await expect(page.locator('#done')).toBeVisible()
  bar = await frameOf(page, 'savebar.html')
  await expect(bar.getByText('Save this login to Walnut?')).toBeVisible()
  await page.close()

  // The browser stops its own submit, but the page sent the login itself: offered.
  ;({ page } = await pageInWindow(site('both.sb.test', '/held-but-sent')))
  await page.locator('#user').fill(`both${stamp}`)
  await page.locator('#pass').fill(`Both-pw-${stamp}`)
  await page.locator('#pass').press('Enter')
  await expect(page.locator('#done')).toBeVisible()
  bar = await frameOf(page, 'savebar.html')
  await expect(bar.getByText('Save this login to Walnut?')).toBeVisible()
  await page.close()

  // novalidate: nothing is checked and the form goes; offered on the next page.
  ;({ page } = await pageInWindow(site('loose.sb.test', '/novalidate')))
  await page.locator('#user').fill(`loose${stamp}`)
  await page.locator('#pass').fill(`Loose-pw-${stamp}`)
  await page.locator('#pass').press('Enter')
  await expect(page.locator('#welcome')).toBeVisible()
  bar = await frameOf(page, 'savebar.html')
  await expect(bar.getByText('Save this login to Walnut?')).toBeVisible()
  await page.close()
})

test('a sign-up with the suggested password saves after the background was stopped, 30 s on', async () => {
  test.setTimeout(120_000)
  const { page } = await pageInWindow(site('shop.sb.test', '/signup'))
  await page.locator('#user').click()
  await page.keyboard.type(`signup-${stamp}@sb.test`)
  await page.locator('#new1').click()
  await page.waitForTimeout(300)
  await page.keyboard.press('ArrowDown')
  await page.waitForTimeout(150)
  await page.keyboard.press('Enter')
  await expect(page.locator('#new1')).toHaveValue(/^.{16,}$/)
  const made = await page.locator('#new1').inputValue()
  await page.locator('#go').click()
  await expect(page.locator('#welcome')).toBeVisible()
  const bar = await frameOf(page, 'savebar.html')
  await expect(bar.getByText('Save this login to Walnut?')).toBeVisible()
  await expect(bar.locator('#title')).toHaveValue('SB Shop')
  // Chrome stops an idle background; the bar's click starts it again.
  const cdp = await ctx.newCDPSession(page)
  await cdp.send('ServiceWorker.enable').catch(() => undefined)
  await cdp.send('ServiceWorker.stopAllWorkers').catch(() => undefined)
  await page.waitForTimeout(30_000)
  await bar.locator('#title').fill(`Signup ${stamp}`)
  await bar.getByTestId('savebar-save').click()
  await expect(bar.getByText(/Saved to Walnut/)).toBeVisible({ timeout: 15_000 })
  const item = await saved(page, `Signup ${stamp}`)
  expect(item?.username).toBe(`signup-${stamp}@sb.test`)
  expect((await api(page, 'GET', `/vault/items/${item.id}`)).item.password).toBe(made)
  await page.close()
})
