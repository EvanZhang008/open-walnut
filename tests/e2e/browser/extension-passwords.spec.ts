/**
 * The Walnut browser extension (packages/browser-extension) loaded into a real Chromium, used
 * as a person would on test sites: connect it to the fixture Walnut from its popup and the
 * /connect-extension page, unlock it, fill a login from the in-page menu, update a changed
 * password from the save bar, make and save a strong password on a sign-up page, carry the
 * username of a two-step sign in, fill inside a same-origin frame and never inside another
 * site's frame, "Never for this site", lock, and Remove in Settings ending its token.
 *
 * The sites are served here on *.example.test / *.other.test, mapped to this machine by
 * Chromium's host resolver, so the site matching is the real one (registrable domains).
 * The fixture vault is shared with passwords.spec.ts: it is set up when it is not, with the
 * same fake master password. Chromium only: Firefox needs its own driver (see the docs).
 */
import { expect, test, chromium, type BrowserContext, type Frame, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { bunRuntime } from '../../helpers/bun-runtime'

test.describe.configure({ mode: 'serial' })

const MASTER = 'Correct Horse Battery Staple 42'
const stamp = Date.now().toString(36)
const USER = `alice-${stamp}@example.test`
const OLD_PW = `Old-Password-${stamp}!`

let ctx: BrowserContext
let extId = ''
let sites: http.Server
let port = 0
let base = ''
let profile = ''
/** The device this browser's extension was paired as (the shared fixture may hold other extensions). */
let ownDevice = ''
const site = (host: string, p: string) => `http://${host}:${port}${p}`

// ── the test sites ──

const PAGES: Record<string, (q: URLSearchParams) => string> = {
  '/login': () => `<h1>Sign in</h1>
    <form id="f" method="post" action="/welcome">
      <label>Email <input name="email" type="email" autocomplete="username" id="user"></label>
      <label>Password <input name="password" type="password" autocomplete="current-password" id="pass"></label>
      <button type="submit" id="go">Sign in</button>
    </form>`,
  '/signup': () => `<h1>Create account</h1>
    <form method="post" action="/welcome">
      <input name="email" type="email" id="user" placeholder="Email">
      <input name="new" type="password" autocomplete="new-password" id="new1" placeholder="Password">
      <input name="confirm" type="password" autocomplete="new-password" id="new2" placeholder="Confirm password">
      <button type="submit" id="go">Create account</button>
    </form>`,
  '/two-step': () => `<h1>Sign in</h1>
    <form method="get" action="/two-step/password">
      <input name="username" id="user" autocomplete="username" placeholder="Username">
      <button type="submit" id="next">Next</button>
    </form>`,
  '/two-step/password': () => `<h1>Enter your password</h1>
    <form method="post" action="/welcome">
      <input name="password" type="password" id="pass" autocomplete="current-password">
      <button type="submit" id="go">Sign in</button>
    </form>`,
  '/spa': () => `<h1>App</h1>
    <div id="box"><input id="user" autocomplete="username"><input id="pass" type="password"><button id="go" type="button">Log in</button></div>
    <p id="done" hidden>Welcome back</p>
    <script>document.getElementById('go').onclick = () => { document.getElementById('box').remove(); document.getElementById('done').hidden = false }</script>`,
  '/frame-same': () => `<h1>Embedded</h1><iframe id="fr" src="/login" style="width:600px;height:300px"></iframe>`,
  '/frame-cross': () => `<h1>Another site</h1><iframe id="fr" src="${site('login.other.test', '/login')}" style="width:600px;height:300px"></iframe>`,
  '/welcome': () => `<h1 id="welcome">Signed in</h1>`,
  '/login-show': () => `<h1>Sign in</h1>
    <form method="post" action="/welcome">
      <input name="email" id="user" autocomplete="username">
      <input name="password" type="password" id="pass" autocomplete="current-password">
      <button type="button" id="show" onclick="const p = document.getElementById('pass'); p.type = p.type === 'password' ? 'text' : 'password'">Show</button>
      <button type="submit" id="go">Sign in</button>
    </form>`,
}

function startSites(): Promise<void> {
  sites = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x')
    const page = PAGES[u.pathname]
    const send = () => {
      res.writeHead(page ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' })
      res.end(page ? `<!doctype html><html><head><title>${u.pathname}</title></head><body>${page(u.searchParams)}</body></html>` : 'not found')
    }
    if (req.method === 'POST') { req.resume(); req.on('end', send) } else send()
  })
  return new Promise((resolve) => sites.listen(0, '127.0.0.1', () => { port = (sites.address() as AddressInfo).port; resolve() }))
}

// ── Walnut, through its API (the fixture is this machine's own) ──

async function vaultSession(page: Page): Promise<string> {
  const st = await (await page.request.get(`${base}/api/v1/vault/status`)).json()
  if (!st.setUp) {
    const r = await page.request.post(`${base}/api/v1/vault/setup`, { data: { password: MASTER } })
    expect(r.ok(), await r.text()).toBe(true)
    return (await r.json()).session.token
  }
  const r = await page.request.post(`${base}/api/v1/vault/unlock`, { data: { password: MASTER, kdfSalt: st.kdf?.salt } })
  expect(r.ok(), await r.text()).toBe(true)
  return (await r.json()).session.token
}

async function vaultItems(page: Page): Promise<Array<{ id: string; title: string; username?: string; urls?: string[] }>> {
  const s = await vaultSession(page)
  return (await (await page.request.get(`${base}/api/v1/vault/items`, { headers: { 'x-walnut-vault-session': s } })).json()).items
}

async function vaultItem(page: Page, id: string): Promise<{ password?: string; username?: string }> {
  const s = await vaultSession(page)
  return (await (await page.request.get(`${base}/api/v1/vault/items/${id}`, { headers: { 'x-walnut-vault-session': s } })).json()).item
}

// ── the extension's pages ──

async function frameOf(page: Page, file: string): Promise<Frame> {
  let f: Frame | undefined
  await expect.poll(() => { f = page.frames().find((x) => x.url().includes(`/${file}`)); return !!f }, { timeout: 10_000 }).toBe(true)
  // Its buttons act only once it has been on screen for a moment (frame-guard.ts).
  await page.waitForTimeout(650)
  return f!
}

async function noFrame(page: Page, file: string): Promise<void> {
  await expect.poll(() => page.frames().filter((x) => x.url().includes(`/${file}`) && !x.isDetached()).length, { timeout: 10_000 }).toBe(0)
}

async function popup(): Promise<Page> {
  const p = await ctx.newPage()
  p.on('pageerror', (e) => console.log(`[popup pageerror] ${e.message}`))
  p.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[popup ${m.type()}] ${m.text()}`) })
  await p.goto(`chrome-extension://${extId}/popup.html`)
  return p
}

/** The icon sits in a closed shadow root, so it is clicked where it is drawn: the field's right edge. */
async function clickIcon(page: Page, selector: string, frame?: Frame): Promise<void> {
  const field = (frame ?? page.mainFrame()).locator(selector)
  await field.focus()
  const box = (await field.boundingBox())!
  await page.mouse.click(box.x + box.width - 15, box.y + box.height / 2)
}

test.beforeAll(async ({}, info) => {
  base = String(info.project.use.baseURL ?? 'http://localhost:3457')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-ext-'))
  execFileSync(bunRuntime(), ['scripts/build-extension.mjs', '--out', dir, '--no-zip'], { stdio: 'pipe' })
  await startSites()
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-ext-profile-'))
  ctx = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1100, height: 760 },
    args: [
      `--disable-extensions-except=${path.join(dir, 'chrome')}`,
      `--load-extension=${path.join(dir, 'chrome')}`,
      '--host-resolver-rules=MAP *.example.test 127.0.0.1, MAP *.other.test 127.0.0.1',
    ],
  })
  let sw = ctx.serviceWorkers()[0]
  if (!sw) sw = await ctx.waitForEvent('serviceworker')
  sw.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[background ${m.type()}] ${m.text()}`) })
  extId = new URL(sw.url()).host
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: `chrome-extension://${extId}` }).catch(() => {})
  // The vault exists before the extension meets it (the shared fixture may be fresh).
  const seed = await ctx.newPage()
  await vaultSession(seed)
  await seed.close()
})

test.afterAll(async () => {
  await ctx?.close()
  await new Promise<void>((r) => sites?.close(() => r()) ?? r())
})

test('connect the extension from its popup and the connect page', async () => {
  const p = await popup()
  await expect(p.getByRole('heading', { name: 'Connect to Walnut' })).toBeVisible()
  await p.locator('#server').fill(base)
  const opened = ctx.waitForEvent('page')
  await p.getByTestId('popup-connect').click()
  const connect = await opened
  await connect.waitForLoadState('domcontentloaded')
  expect(connect.url()).toBe(`${base}/connect-extension`)
  await expect(connect.getByRole('heading', { name: 'Connect this browser to Walnut?' })).toBeVisible({ timeout: 20_000 })
  const extensionDevices = async () => ((await (await connect.request.get(`${base}/api/devices`)).json()).devices as Array<{ name: string }>).map((d) => d.name).filter((n) => n.startsWith('extension-'))
  const earlier = new Set(await extensionDevices())
  await connect.getByTestId('connect-extension-go').click()
  await expect(connect.getByTestId('connect-extension-done')).toBeVisible({ timeout: 20_000 })
  ownDevice = (await extensionDevices()).find((n) => !earlier.has(n)) ?? ''
  expect(ownDevice).not.toBe('')
  await expect(connect.locator('.pw-ext-card p').first()).toHaveText(/^Walnut extension \(Chrome on (Linux|Mac|Windows)\) is connected\./)
  // Its device: an extension, named for what it is.
  const devices = (await (await connect.request.get(`${base}/api/devices`)).json()).devices as Array<{ name: string; info?: { deviceName?: string } }>
  expect(devices.some((d) => d.name.startsWith('extension-') && /^Walnut extension \(Chrome on /.test(d.info?.deviceName ?? ''))).toBe(true)
  await connect.close()
  // The popup closed itself when it opened the connect tab; opened again, it asks for the master password.
  expect(p.isClosed()).toBe(true)
  const again = await popup()
  await expect(again.getByRole('heading', { name: 'Walnut is locked' })).toBeVisible()
  await again.close()
})

test('a page of another site cannot connect it: the extension answers only its own connect tab', async () => {
  const page = await ctx.newPage()
  await page.goto(site('login.example.test', '/welcome'))
  const answered = await page.evaluate(() => new Promise<boolean>((resolve) => {
    addEventListener('message', (e) => { if ((e.data as { source?: string })?.source === 'walnut-extension') resolve(true) })
    postMessage({ source: 'walnut-connect-page', type: 'hello' }, location.origin)
    postMessage({ source: 'walnut-connect-page', type: 'code', code: 'ABCD-EFGH' }, location.origin)
    setTimeout(() => resolve(false), 1500)
  }))
  // Neither a hello nor a code from a page it did not open gets any answer, so a site cannot
  // even tell the extension is installed, and nothing is paired.
  expect(answered).toBe(false)
  await page.close()
})

test('unlock in the popup; a wrong password says so', async () => {
  const seed = await ctx.newPage()
  const s = await vaultSession(seed)
  const r = await seed.request.post(`${base}/api/v1/vault/items`, {
    headers: { 'x-walnut-vault-session': s },
    data: { item: { type: 'login', title: `Example ${stamp}`, username: USER, password: OLD_PW, urls: [site('login.example.test', '')] } },
  })
  expect(r.ok(), await r.text()).toBe(true)
  await seed.request.post(`${base}/api/v1/vault/items`, {
    headers: { 'x-walnut-vault-session': s },
    data: { item: { type: 'login', title: `Other ${stamp}`, username: 'mallory@other.test', password: 'Other-Site-Password-1', urls: [site('login.other.test', '')] } },
  })
  await seed.close()

  const p = await popup()
  await p.getByLabel('Master password').fill('not the password')
  await p.getByTestId('popup-unlock').click()
  await expect(p.getByRole('alert')).toHaveText(/wrong|incorrect/i)
  await p.getByLabel('Master password').fill(MASTER)
  await p.getByTestId('popup-unlock').click()
  await expect(p.getByLabel('Search Walnut')).toBeVisible({ timeout: 30_000 })
  await p.getByLabel('Search Walnut').fill(stamp)
  await expect(p.getByTestId('popup-item')).toHaveCount(2)
  await p.close()
})

test('the in-page menu fills the saved login, and a changed password is offered as an update', async () => {
  const page = await ctx.newPage()
  await page.goto(site('login.example.test', '/login'))
  await page.locator('#user').click()
  const menu = await frameOf(page, 'menu.html')
  await expect(menu.getByTestId('menu-item').filter({ hasText: `Example ${stamp}` })).toBeVisible()
  await menu.getByTestId('menu-item').filter({ hasText: `Example ${stamp}` }).click()
  await expect(page.locator('#user')).toHaveValue(USER)
  await expect(page.locator('#pass')).toHaveValue(OLD_PW)
  await noFrame(page, 'menu.html')

  // The person changed it on the site: Walnut offers to update the saved one. Clearing the field
  // opens the menu again; typing their own closes it, so it never covers the form.
  const NEW_PW = `New-Password-${stamp}!`
  await page.locator('#pass').fill('')
  await page.locator('#user').click()
  await page.locator('#pass').click()
  await frameOf(page, 'menu.html')
  await page.locator('#pass').pressSequentially(NEW_PW)
  await noFrame(page, 'menu.html')
  await page.locator('#go').click()
  await expect(page.locator('#welcome')).toBeVisible()
  const bar = await frameOf(page, 'savebar.html')
  await expect(bar.getByText(`Update the password for Example ${stamp}?`)).toBeVisible()
  await bar.getByTestId('savebar-update').click()
  await expect(bar.getByText('Password updated in Walnut')).toBeVisible()
  await noFrame(page, 'savebar.html')
  const item = (await vaultItems(page)).find((i) => i.title === `Example ${stamp}`)!
  expect((await vaultItem(page, item.id)).password).toBe(NEW_PW)

  // Signing in again with the saved password offers nothing.
  await page.goto(site('login.example.test', '/login'))
  await page.locator('#user').click()
  await (await frameOf(page, 'menu.html')).getByTestId('menu-item').filter({ hasText: `Example ${stamp}` }).click()
  await page.locator('#go').click()
  await expect(page.locator('#welcome')).toBeVisible()
  await page.waitForTimeout(1500)
  expect(page.frames().some((f) => f.url().includes('/savebar.html'))).toBe(false)
  await page.close()
})

test('a sign-up page gets a strong password, and the new login is saved', async () => {
  const page = await ctx.newPage()
  await page.goto(site('shop.example.test', '/signup'))
  await page.locator('#user').fill(`bob-${stamp}@example.test`)
  await page.locator('#new1').click()
  const menu = await frameOf(page, 'menu.html')
  await menu.getByTestId('menu-generate').click()
  await expect(page.locator('#new1')).toHaveValue(/^.{20,}$/)
  const made = await page.locator('#new1').inputValue()
  await expect(page.locator('#new2')).toHaveValue(made)
  // The fill moved the focus to the confirmation: that never opens the menu again over the form.
  await noFrame(page, 'menu.html')
  await page.waitForTimeout(800)
  expect(page.frames().some((f) => f.url().includes('/menu.html'))).toBe(false)
  await page.locator('#go').click()
  await expect(page.locator('#welcome')).toBeVisible()
  const bar = await frameOf(page, 'savebar.html')
  await expect(bar.getByText('Save this login to Walnut?')).toBeVisible()
  await bar.locator('#title').fill(`Shop ${stamp}`)
  await bar.getByTestId('savebar-save').click()
  await expect(bar.getByText('Saved to Walnut')).toBeVisible()
  const saved = (await vaultItems(page)).find((i) => i.title === `Shop ${stamp}`)!
  expect(saved.username).toBe(`bob-${stamp}@example.test`)
  expect(saved.urls?.[0]).toBe(site('shop.example.test', ''))
  expect((await vaultItem(page, saved.id)).password).toBe(made)
  await page.close()
})

test('a two-step sign in keeps the username of its first page', async () => {
  const page = await ctx.newPage()
  await page.goto(site('id.example.test', '/two-step'))
  await page.locator('#user').fill(`carol-${stamp}`)
  await page.locator('#next').click()
  await page.locator('#pass').fill(`Carol-${stamp}-pw`)
  await page.locator('#go').click()
  const bar = await frameOf(page, 'savebar.html')
  await expect(bar.getByText(`carol-${stamp} · id.example.test`)).toBeVisible()
  await bar.getByRole('button', { name: 'Not now' }).click()
  await noFrame(page, 'savebar.html')
  await page.close()
})

test('a single-page app that sends without leaving gets the save bar; Never for this site sticks', async () => {
  const page = await ctx.newPage()
  await page.goto(site('app.example.test', '/spa'))
  await page.locator('#user').fill(`dave-${stamp}`)
  await page.locator('#pass').fill('Dave-pw-1234')
  await page.locator('#go').click()
  await expect(page.locator('#done')).toBeVisible()
  const bar = await frameOf(page, 'savebar.html')
  await bar.getByRole('button', { name: 'Never for this site' }).click()
  await noFrame(page, 'savebar.html')
  // The same host: no more offers there.
  await page.goto(site('app.example.test', '/spa'))
  await page.locator('#user').fill(`dave-${stamp}`)
  await page.locator('#pass').fill('Dave-pw-5678')
  await page.locator('#go').click()
  await page.waitForTimeout(1500)
  expect(page.frames().some((f) => f.url().includes('/savebar.html'))).toBe(false)
  // Undo it, so the later tests on example.test still get offers.
  const sw = ctx.serviceWorkers()[0]
  await sw.evaluate(() => (globalThis as unknown as { chrome: { storage: { local: { remove(k: string): Promise<void> } } } }).chrome.storage.local.remove('neverSave'))
  await page.close()
})

test('a same-origin frame fills; another site\'s frame gets no icon and no fill', async () => {
  const page = await ctx.newPage()
  await page.goto(site('login.example.test', '/frame-same'))
  const inner = page.frameLocator('#fr')
  await inner.locator('#user').click()
  const menu = await frameOf(page, 'menu.html')
  await menu.getByTestId('menu-item').filter({ hasText: `Example ${stamp}` }).click()
  await expect(inner.locator('#user')).toHaveValue(USER)

  await page.goto(site('login.example.test', '/frame-cross'))
  const cross = page.frameLocator('#fr')
  await cross.locator('#user').click()
  await page.waitForTimeout(1200)
  await expect(cross.locator('walnut-ext')).toHaveCount(0)
  expect(page.frames().some((f) => f.url().includes('/menu.html'))).toBe(false)
  await expect(cross.locator('#user')).toHaveValue('')
  await page.close()
})

test('a page cannot open the menu itself, restyle it unseen, use menu.html, or have a login it typed offered', async () => {
  test.setTimeout(120_000) // many steps, each waiting on the menu frame: a busy runner needs more than the default
  const page = await ctx.newPage()
  await page.goto(site('login.example.test', '/login'))
  await page.waitForTimeout(400)
  // Focus from script: the icon may show, the menu does not open.
  await page.evaluate(() => (document.getElementById('user') as HTMLInputElement).focus())
  await page.waitForTimeout(1200)
  expect(page.frames().some((f) => f.url().includes('/menu.html'))).toBe(false)

  // A stylesheet cannot hide the menu's host: its own !important styles win.
  await page.addStyleTag({ content: 'walnut-ext { opacity: 0 !important; visibility: hidden !important; }' })
  await page.locator('#pass').click()
  await frameOf(page, 'menu.html')
  expect(await page.evaluate(() => { const h = document.querySelector('walnut-ext[data-walnut-menu]')!; const cs = getComputedStyle(h); return `${cs.opacity} ${cs.visibility}` })).toBe('1 visible')
  // A script that restyles it closes it.
  await page.evaluate(() => { (document.querySelector('walnut-ext[data-walnut-menu]') as HTMLElement).style.opacity = '0' })
  await noFrame(page, 'menu.html')

  // menu.html framed by the page itself has no nonce (a guessed one does not do): it shows nothing and fills nothing.
  await page.evaluate((src) => {
    const f = document.createElement('iframe'); f.id = 'evil'; f.src = src
    f.onload = () => f.contentWindow!.postMessage({ walnutNonce: 'guessed' }, '*')
    document.body.append(f)
  }, `chrome-extension://${extId}/menu.html`)
  await page.waitForTimeout(1500)
  const evil = page.frames().find((f) => f.url().includes('/menu.html') && f.parentFrame() === page.mainFrame() && f.name() !== '')
    ?? page.frames().find((f) => f.url().includes('/menu.html'))
  if (evil) expect(await evil.locator('[data-testid=menu-item]').count()).toBe(0)
  await expect(page.locator('#user')).toHaveValue('')
  await page.evaluate(() => document.getElementById('evil')?.remove())

  // The menu's nonce is in no URL the page can read.
  await page.locator('#user').click()
  await page.locator('#pass').click()
  await frameOf(page, 'menu.html')
  expect(page.frames().filter((f) => f.url().includes('/menu.html')).every((f) => !f.url().includes('#'))).toBe(true)
  // A page rule cannot draw over it from the host's own ::after.
  await page.addStyleTag({ content: 'walnut-ext::after { content: "x"; position: absolute; inset: 0; background: #fff; }' })
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('walnut-ext[data-walnut-menu]')!, '::after').content)).toBe('none')
  // Faded: a pick fills nothing (in Chrome the frame itself sees it is faded and ignores the
  // click; where it cannot, the page check before the fill refuses and closes the menu).
  await page.evaluate(() => { document.documentElement.style.opacity = '0.3' })
  const faded = await frameOf(page, 'menu.html')
  await faded.getByTestId('menu-item').first().click()
  await page.waitForTimeout(800)
  await expect(page.locator('#user')).toHaveValue('')
  await page.keyboard.press('Escape')
  await noFrame(page, 'menu.html')
  await page.evaluate(() => { document.documentElement.style.opacity = '' })
  // Something put after it (it would paint on top): the menu closes.
  await page.locator('#user').click()
  await page.locator('#pass').click()
  await frameOf(page, 'menu.html')
  await page.evaluate(() => { const d = document.createElement('div'); d.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none'; document.documentElement.append(d) })
  await noFrame(page, 'menu.html')

  // A page that fills the fields itself and sends the form gets no save offer.
  await page.evaluate(() => {
    ;(document.getElementById('user') as HTMLInputElement).value = `forged-${Date.now()}@example.test`
    ;(document.getElementById('pass') as HTMLInputElement).value = 'Forged-Password-1'
    ;(document.getElementById('f') as HTMLFormElement).requestSubmit()
  })
  await expect(page.locator('#welcome')).toBeVisible()
  await page.waitForTimeout(1500)
  expect(page.frames().some((f) => f.url().includes('/savebar.html'))).toBe(false)
  await page.close()
})

test("Walnut's own pages get no icon, no menu and no save offer (its master password is never offered)", async () => {
  // Under the address it is connected to, and under another one (it marks its own pages).
  for (const at of [base, base.replace('localhost', '127.0.0.1')]) {
    const page = await ctx.newPage()
    await page.goto(`${at}/passwords`)
    const pw = page.locator('input[type=password]').first()
    await expect(pw).toBeVisible({ timeout: 30_000 })
    await pw.click()
    await pw.pressSequentially('typed on the Walnut page')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(1500)
    await expect(page.locator('walnut-ext')).toHaveCount(0)
    expect(page.frames().some((f) => /\/(menu|savebar)\.html/.test(f.url()))).toBe(false)
    await page.close()
  }
})

test('a password typed while shown as text is still offered', async () => {
  const page = await ctx.newPage()
  await page.goto(site('show.example.test', '/login-show'))
  await page.locator('#user').fill(`erin-${stamp}`)
  await page.locator('#show').click()
  await page.locator('#pass').click()
  await page.locator('#pass').pressSequentially('Erin-pw-4321')
  await page.locator('#show').click()
  await page.locator('#go').click()
  await expect(page.locator('#welcome')).toBeVisible()
  const bar = await frameOf(page, 'savebar.html')
  await expect(bar.getByText('Save this login to Walnut?')).toBeVisible()
  await bar.getByRole('button', { name: 'Not now' }).click()
  await noFrame(page, 'savebar.html')
  await page.close()
})

test('locked: the menu says so and opens the unlock; Remove in Settings disconnects it', async () => {
  const p = await popup()
  await p.getByTestId('popup-lock').click()
  await expect(p.getByRole('heading', { name: 'Walnut is locked' })).toBeVisible()
  await p.close()

  const page = await ctx.newPage()
  await page.goto(site('login.example.test', '/login'))
  await page.waitForTimeout(300)
  await clickIcon(page, '#user')
  const menu = await frameOf(page, 'menu.html')
  await expect(menu.getByText('Walnut is locked')).toBeVisible()

  // A login sent while locked: the bar asks to unlock, and once unlocked offers to save it.
  await page.locator('#user').fill(`frank-${stamp}@example.test`)
  await page.locator('#pass').click()
  await page.locator('#pass').pressSequentially('Frank-pw-2468')
  await page.locator('#go').click()
  await expect(page.locator('#welcome')).toBeVisible()
  const bar = await frameOf(page, 'savebar.html')
  await expect(bar.getByRole('button', { name: 'Unlock' })).toBeVisible()
  await expect(bar.getByTestId('savebar-save')).toHaveCount(0)
  const un = await popup()
  await un.getByLabel('Master password').fill(MASTER)
  await un.getByTestId('popup-unlock').click()
  await expect(un.getByLabel('Search Walnut')).toBeVisible({ timeout: 30_000 })
  await un.close()
  await page.bringToFront()
  await expect(bar.getByTestId('savebar-save')).toBeVisible({ timeout: 10_000 })
  await page.waitForTimeout(650) // the tab came back to the front: the bar waits before it acts (frame-guard.ts)
  await bar.getByRole('button', { name: 'Not now' }).click()
  await noFrame(page, 'savebar.html')
  await page.close()

  // Settings → Passwords lists it; Remove ends its token, and the popup asks to connect again.
  const settings = await ctx.newPage()
  await settings.goto(`${base}/settings#browser`)
  // Other extensions paired on this Walnut (earlier specs on the shared fixture) carry the same
  // name: the row is this browser's own device.
  const row = settings.locator(`.settings-row[data-device="${ownDevice}"]`)
  await expect(row).toBeVisible({ timeout: 20_000 })
  await expect(row).toContainText(/Walnut extension \(Chrome on /)
  await row.getByRole('button', { name: 'Remove' }).click()
  await expect.poll(async () => ((await (await settings.request.get(`${base}/api/devices`)).json()).devices as Array<{ name: string }>).some((d) => d.name === ownDevice)).toBe(false)
  await settings.close()

  // Its first call is refused: it forgets the connection and asks to connect again.
  const again = await popup()
  await expect(again.getByRole('heading', { name: 'Connect to Walnut' })).toBeVisible({ timeout: 20_000 })
  await again.close()
})
