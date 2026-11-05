/**
 * Which saved logins the extension offers and what it saves, with the real built extension:
 * logins match in tiers (this host and its parent or child hosts are offered and counted;
 * another part of the same site is only listed apart, with its saved host; another registrable
 * domain gets nothing), "Never for this site" covers that host alone, a changed password updates
 * the login just used there, step two of a two-step sign in offers the account of step one
 * alone, and a new login is named after the site.
 *
 * Its sites are *.a1.test and a1-other.test (mapped to this machine), so nothing the other specs
 * save on the shared fixture vault matches them.
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
const SHOTS = process.env.WALNUT_TASK_DIR ? path.join(process.env.WALNUT_TASK_DIR, 'review/fix-shots/a1') : ''

let ctx: BrowserContext
let extId = ''
let sites: http.Server
let port = 0
let base = ''
const site = (host: string, p: string) => `http://${host}:${port}${p}`
const ids: Record<string, string> = {}

const PAGES: Record<string, { title: string; body: string }> = {
  '/login': { title: 'Sign in to A1 Shop', body: `<form method="post" action="/welcome">
      <input name="email" id="user" autocomplete="username" placeholder="Email">
      <input name="password" type="password" id="pass" autocomplete="current-password">
      <button type="submit" id="go">Sign in</button></form>` },
  '/signup': { title: 'Create your A1 Shop account', body: `<form method="post" action="/welcome">
      <input name="email" id="user" autocomplete="username" placeholder="Email">
      <input name="password" type="password" id="new1" autocomplete="new-password">
      <button type="submit" id="go">Create account</button></form>` },
  '/change': { title: 'Change your password', body: `<form method="post" action="/welcome">
      <input type="hidden" name="email" autocomplete="username" value="alex.work@a1.test">
      <input name="current" type="password" id="cur" autocomplete="current-password">
      <input name="new" type="password" id="new1" autocomplete="new-password">
      <input name="new2" type="password" id="new2" autocomplete="new-password">
      <button type="submit" id="go">Change password</button></form>` },
  '/email': { title: 'Sign in: step 1 of 2', body: `<form method="get" action="/password"><input name="identifier" id="user" type="email" autocomplete="username"><button id="next">Next</button></form>` },
  '/password': { title: 'Sign in: step 2 of 2', body: `<form method="post" action="/welcome"><input name="password" id="pass" type="password" autocomplete="current-password"><button id="go">Sign in</button></form>` },
  '/welcome': { title: 'Welcome', body: '<h1 id="welcome">Signed in</h1>' },
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
  const st = await (await page.request.get(`${base}/api/v1/vault/status`)).json()
  const r0 = st.setUp
    ? await page.request.post(`${base}/api/v1/vault/unlock`, { data: { password: MASTER, kdfSalt: st.kdf?.salt } })
    : await page.request.post(`${base}/api/v1/vault/setup`, { data: { password: MASTER } })
  const s = (await r0.json()).session.token
  const r = method === 'GET'
    ? await page.request.get(`${base}/api/v1${p}`, { headers: { 'x-walnut-vault-session': s } })
    : await page.request.post(`${base}/api/v1${p}`, { headers: { 'x-walnut-vault-session': s }, data })
  expect(r.ok(), await r.text()).toBe(true)
  return r.json()
}

const sw = () => ctx.serviceWorkers()[0]

async function frameOf(page: Page, file: string): Promise<Frame> {
  let f: Frame | undefined
  await expect.poll(() => { f = page.frames().find((x) => x.url().includes(`/${file}`) && !x.isDetached()); return !!f }, { timeout: 10_000 }).toBe(true)
  await page.waitForTimeout(650) // its buttons act once it has been on screen a moment (frame-guard.ts)
  return f!
}

async function pageInWindow(url: string): Promise<{ page: Page; tab: number }> {
  const opened = ctx.waitForEvent('page')
  const tab = await sw().evaluate((u: string) => chrome.windows.create({ url: u, focused: true }).then((x) => x.tabs?.[0]?.id ?? 0), url)
  const page = await opened
  await page.waitForLoadState('domcontentloaded')
  return { page, tab }
}

const badge = (tab: number) => sw().evaluate((t: number) => chrome.action.getBadgeText({ tabId: t }), tab)

/** Open the menu on the page's login (as the keyboard shortcut does) and ask the background what it lists, as the menu does. */
async function menuData(page: Page, tab: number): Promise<{ menu: Frame; data: any }> {
  const open = () => page.frames().find((x) => x.url().includes('/menu.html') && !x.isDetached())
  await expect.poll(async () => {
    if (!open()) await sw().evaluate((t: number) => chrome.tabs.sendMessage(t, { type: 'open-menu-here' }, { frameId: 0 }).catch(() => undefined), tab)
    return !!open()
  }, { timeout: 15_000, intervals: [500, 1000] }).toBe(true)
  const menu = await frameOf(page, 'menu.html')
  const nonce = await sw().evaluate((t: number) => chrome.storage.session.get('menus').then((r) => r.menus?.[String(t)]?.nonce as string), tab)
  const data = await menu.evaluate((n: string) => chrome.runtime.sendMessage({ type: 'menu-data', nonce: n }), nonce)
  return { menu, data: { ...data, nonce } }
}

test.beforeAll(async ({}, info) => {
  test.setTimeout(240_000)
  base = String(info.project.use.baseURL ?? 'http://localhost:3457')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-ext-a1-'))
  execFileSync(bunRuntime(), ['scripts/build-extension.mjs', '--out', dir, '--no-zip'], { stdio: 'pipe' })
  await startSites()
  ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-ext-a1-profile-')), {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1100, height: 760 },
    args: [
      `--disable-extensions-except=${path.join(dir, 'chrome')}`,
      `--load-extension=${path.join(dir, 'chrome')}`,
      '--host-resolver-rules=MAP *.a1.test 127.0.0.1, MAP a1-other.test 127.0.0.1',
    ],
  })
  let worker = ctx.serviceWorkers()[0]
  if (!worker) worker = await ctx.waitForEvent('serviceworker')
  extId = new URL(worker.url()).host

  const p = await ctx.newPage()
  const seed = async (key: string, item: Record<string, unknown>) => { ids[key] = (await api(p, 'POST', '/vault/items', { item })).item.id }
  await seed('shop', { type: 'login', title: `Shop ${stamp}`, username: 'alex@a1.test', password: `Shop-pw-${stamp}`, urls: [site('shop.a1.test', '')] })
  await seed('work', { type: 'login', title: `Work ${stamp}`, username: 'alex.work@a1.test', password: `Work-pw-${stamp}`, urls: [site('shop.a1.test', '')] })
  await seed('sam', { type: 'login', title: `Sam ${stamp}`, username: 'sam@a1.test', password: `Sam-pw-${stamp}`, urls: [site('accounts.a1.test', '')] })
  await seed('sue', { type: 'login', title: `Sue ${stamp}`, username: 'sue@a1.test', password: `Sue-pw-${stamp}`, urls: [site('accounts.a1.test', '')] })

  await p.goto(`chrome-extension://${extId}/popup.html`)
  await p.locator('#server').fill(base)
  const opened = ctx.waitForEvent('page')
  await p.getByTestId('popup-connect').click()
  const connect = await opened
  await expect(connect.getByRole('heading', { name: 'Connect this browser to Walnut?' })).toBeVisible({ timeout: 60_000 })
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

test('tiers: the shop offers and counts its own logins; a sibling subdomain lists them apart with their host; another domain gets nothing', async () => {
  const shop = await pageInWindow(site('shop.a1.test', '/login'))
  await expect.poll(() => badge(shop.tab), { timeout: 10_000 }).toBe('2')
  let { data } = await menuData(shop.page, shop.tab)
  expect(data.items.map((i: { id: string }) => i.id).sort()).toEqual([ids.shop, ids.work].sort())
  expect(data.items.every((i: { tier: number }) => i.tier === 1)).toBe(true)
  expect(data.others.map((i: { id: string; site: string; tier: number }) => [i.id, i.site, i.tier]).sort()).toEqual([[ids.sam, 'accounts.a1.test', 2], [ids.sue, 'accounts.a1.test', 2]].sort())
  expect(data.othersDomain).toBe('a1.test')
  await shop.page.close()

  // The lookalike on the same registrable domain: no badge, nothing offered, the shop's logins only apart.
  const evil = await pageInWindow(site('evil.a1.test', '/login'))
  await evil.page.waitForTimeout(1500)
  expect(await badge(evil.tab)).toBe('')
  const r = await menuData(evil.page, evil.tab)
  expect(r.data.items).toEqual([])
  expect(r.data.others.find((i: { id: string }) => i.id === ids.shop)).toMatchObject({ tier: 2, site: 'shop.a1.test', exact: false })
  expect(r.data.others).toHaveLength(4)
  if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await evil.page.screenshot({ path: path.join(SHOTS, 'evil-sibling-menu.png') }) }
  // The person picks one from that list on purpose: it fills (it is never filled by itself).
  // (The menu closes once it filled, so its frame may go before the answer comes back.)
  await r.menu.evaluate(({ n, id }) => chrome.runtime.sendMessage({ type: 'menu-fill', nonce: n, id }), { n: r.data.nonce, id: ids.shop }).catch(() => undefined)
  await expect(evil.page.locator('#user')).toHaveValue('alex@a1.test')
  await evil.page.close()

  const other = await pageInWindow(site('a1-other.test', '/login'))
  await other.page.waitForTimeout(1500)
  expect(await badge(other.tab)).toBe('')
  ;({ data } = await menuData(other.page, other.tab))
  expect(data.items).toEqual([])
  expect(data.others).toBeUndefined()
  // A forged fill of the shop's login on another domain is refused.
  const forged = await (await frameOf(other.page, 'menu.html')).evaluate(({ n, id }) => chrome.runtime.sendMessage({ type: 'menu-fill', nonce: n, id }), { n: data.nonce, id: ids.shop })
  expect(forged).toMatchObject({ ok: false })
  await expect(other.page.locator('#user')).toHaveValue('')
  await other.page.close()
})

test('Never for this site covers the host it was said on, not its sibling', async () => {
  const page = await ctx.newPage()
  await page.goto(site('evil.a1.test', '/login'))
  await page.locator('#user').fill(`eve-${stamp}`)
  await page.locator('#pass').fill('Eve-pw-1')
  await page.locator('#go').click()
  const bar = await frameOf(page, 'savebar.html')
  await bar.getByRole('button', { name: 'Never for this site' }).click()
  // The bar answers with a note (and Undo) once the background stored it.
  await expect(bar.getByTestId('savebar-undo')).toBeVisible()
  await expect.poll(() => sw().evaluate(() => chrome.storage.local.get('neverSave').then((r) => r.neverSave))).toEqual(['evil.a1.test'])
  // Still never there.
  await page.goto(site('evil.a1.test', '/login'))
  await page.locator('#user').fill(`eve-${stamp}`)
  await page.locator('#pass').fill('Eve-pw-2')
  await page.locator('#go').click()
  await page.waitForTimeout(1500)
  expect(page.frames().some((f) => f.url().includes('/savebar.html'))).toBe(false)
  // The shop next door still gets its offer.
  await page.goto(site('shop.a1.test', '/login'))
  await page.locator('#user').fill(`neo-${stamp}@a1.test`)
  await page.locator('#pass').fill('Neo-pw-1')
  await page.locator('#go').click()
  const shopBar = await frameOf(page, 'savebar.html')
  await expect(shopBar.getByText('Save this login to Walnut?')).toBeVisible()
  // A new login is named after the site ("Sign in to A1 Shop"), not its host.
  await expect(shopBar.locator('#title')).toHaveValue('A1 Shop')
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'save-named-after-site.png') })
  await shopBar.getByRole('button', { name: 'Not now' }).click()
  await sw().evaluate(() => chrome.storage.local.remove('neverSave'))
  await page.close()
})

test('a changed password updates the login filled into Current, never another host\'s', async () => {
  const page = await ctx.newPage()
  await page.goto(site('shop.a1.test', '/change'))
  await page.locator('#cur').click()
  const menu = await frameOf(page, 'menu.html')
  await menu.getByTestId('menu-item').filter({ hasText: `Work ${stamp}` }).click()
  await expect(page.locator('#cur')).toHaveValue(`Work-pw-${stamp}`)
  await page.keyboard.press('Escape')
  await page.locator('#new1').click()
  await page.keyboard.press('Escape')
  await page.locator('#new1').pressSequentially(`Work-new-${stamp}`)
  await page.locator('#new2').pressSequentially(`Work-new-${stamp}`)
  await page.locator('#go').click()
  await expect(page.locator('#welcome')).toBeVisible()
  const bar = await frameOf(page, 'savebar.html')
  const target = bar.getByTestId('savebar-target')
  await expect(target).toHaveValue(ids.work)
  await expect(bar.getByText(`Update the password for Work ${stamp}?`)).toBeVisible()
  // Only the shop's own logins (and a new one): the accounts site's logins are not offered.
  await expect(target.locator('option')).toHaveCount(3)
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'update-picks-filled-login.png') })
  await bar.getByRole('button', { name: 'Not now' }).click()
  await page.close()
})

test('step two of a two-step sign in offers the account of step one alone, the rest as Other logins', async () => {
  const w = await pageInWindow(site('accounts.a1.test', '/email'))
  await w.page.locator('#user').click()
  await w.page.keyboard.press('Escape')
  await w.page.locator('#user').pressSequentially('sue@a1.test')
  await w.page.locator('#next').click()
  await w.page.waitForURL(/\/password/)
  const { data } = await menuData(w.page, w.tab)
  expect(data.items.map((i: { id: string }) => i.id)).toEqual([ids.sue])
  expect(data.more.map((i: { id: string }) => i.id)).toEqual([ids.sam])
  await w.page.close()
})
