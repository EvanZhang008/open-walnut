/**
 * Settings, "Fill and save on web pages", for a person who keeps another password manager in
 * the same browser: off, Walnut draws nothing in pages (no field icon, no menu opening in a
 * field, no save bar after a sign-in) and open tabs follow at once; the popup says so in one
 * quiet line and still fills on a click. On again, the icon, the menu and the save bar are back.
 */
import { test, expect, chromium, type BrowserContext, type Frame, type Page } from '@playwright/test'
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

let ctx: BrowserContext
let extId = ''
let sites: http.Server
let port = 0
let base = ''
const site = (host: string, p: string) => `http://${host}:${port}${p}`

const PAGES: Record<string, string> = {
  '/login': `<h1>Sign in</h1><form method="post" action="/welcome">
      <input name="email" id="user" autocomplete="username" placeholder="Email">
      <input name="password" type="password" id="pass" autocomplete="current-password">
      <button type="submit" id="go">Sign in</button></form>`,
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

async function session(page: Page): Promise<string> {
  return vaultSession(page, base, { password: MASTER })
}

async function seed(page: Page, item: Record<string, unknown>): Promise<void> {
  const s = await session(page)
  const r = await page.request.post(`${base}/api/v1/vault/items`, { headers: { 'x-walnut-vault-session': s }, data: { item } })
  expect(r.ok(), await r.text()).toBe(true)
}

const sw = () => ctx.serviceWorkers()[0]

/** Screenshots to look at (LOOK_SHOTS, else the task's review dir); none in CI. */
const SHOTS = process.env.LOOK_SHOTS
  || (process.env.WALNUT_TASK_DIR ? path.join(process.env.WALNUT_TASK_DIR, 'review/fix-shots/E/after') : '')
async function shot(p: Page, name: string): Promise<void> {
  if (!SHOTS) return
  fs.mkdirSync(SHOTS, { recursive: true })
  await p.waitForTimeout(250)
  await p.screenshot({ path: path.join(SHOTS, `${name}.png`) })
}

async function popup(win?: number): Promise<Page> {
  if (win) {
    const opened = ctx.waitForEvent('page')
    await sw().evaluate((u: string) => chrome.windows.create({ url: u, type: 'popup', width: 380, height: 640 }), `chrome-extension://${extId}/popup.html?embed=panel&window=${win}`)
    return opened
  }
  const p = await ctx.newPage()
  await p.goto(`chrome-extension://${extId}/popup.html`)
  return p
}

async function pageInWindow(url: string): Promise<{ page: Page; win: number }> {
  const opened = ctx.waitForEvent('page')
  const w = await sw().evaluate((u: string) => chrome.windows.create({ url: u, focused: true }).then((x) => ({ win: x.id ?? 0 })), url)
  const page = await opened
  await page.waitForLoadState('domcontentloaded')
  return { page, ...w }
}

async function frameOf(page: Page, file: string): Promise<Frame> {
  let f: Frame | undefined
  await expect.poll(() => { f = page.frames().find((x) => x.url().includes(`/${file}`) && !x.isDetached()); return !!f }, { timeout: 10_000 }).toBe(true)
  await page.waitForTimeout(650) // its buttons act once it has been on screen a moment (frame-guard.ts)
  return f!
}

const frames = (page: Page, file: string) => page.frames().filter((x) => x.url().includes(`/${file}`) && !x.isDetached()).length
/** Whatever Walnut drew in the page: the field icon, the menu and the save bar each live in a host of their own. */
const drawn = (page: Page) => page.evaluate(() => document.querySelectorAll('walnut-ext').length)

async function setPageFill(on: boolean): Promise<void> {
  const p = await popup()
  await expect(p.getByLabel('Search Walnut')).toBeVisible({ timeout: 20_000 })
  await expect(p.getByTestId('popup-pagefill-off')).toHaveCount(on ? 1 : 0)
  await p.getByTestId('popup-settings').click()
  const box = p.getByTestId('popup-pagefill')
  await expect(p.getByText('Turn off while another password manager fills this browser; the popup still fills on a click.')).toBeVisible()
  await expect(box).toBeChecked({ checked: !on })
  // The person clicks the row's words, as on the switch.
  await p.getByText('Fill and save on web pages', { exact: true }).click()
  await expect(box).toBeChecked({ checked: on })
  await shot(p, `30-settings-pagefill-${on ? 'on' : 'off'}`)
  await expect.poll(() => sw().evaluate(() => chrome.storage.local.get('settings').then((r) => r.settings?.pageFill))).toBe(on)
  await p.close()
}

/** A sign-in the person types and sends; the save bar shows on the page it leads to, or does not. */
async function signIn(page: Page, host: string, user: string): Promise<void> {
  await page.goto(site(host, '/login'))
  await page.locator('#user').fill(user)
  await page.locator('#pass').fill(`New-pw-${stamp}`)
  await page.locator('#go').click()
  await expect(page.locator('#welcome')).toBeVisible()
}

test.beforeAll(async ({}, info) => {
  test.setTimeout(240_000)
  base = String(info.project.use.baseURL ?? 'http://localhost:3457')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-ext-pf-'))
  execFileSync(bunRuntime(), ['scripts/build-extension.mjs', '--out', dir, '--no-zip'], { stdio: 'pipe' })
  await startSites()
  ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-ext-pf-profile-')), {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1100, height: 760 },
    args: [
      `--disable-extensions-except=${path.join(dir, 'chrome')}`,
      `--load-extension=${path.join(dir, 'chrome')}`,
      '--host-resolver-rules=MAP *.pagefill.test 127.0.0.1',
    ],
  })
  let worker = ctx.serviceWorkers()[0]
  if (!worker) worker = await ctx.waitForEvent('serviceworker')
  extId = new URL(worker.url()).host

  const p = await ctx.newPage()
  await seed(p, { type: 'login', title: `Pia ${stamp}`, username: 'pia@pagefill.test', password: `Pia-pw-${stamp}`, urls: [site('www.pagefill.test', '')] })

  // Connect the extension and unlock it.
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
  const un = await popup()
  await un.getByLabel('Master password').fill(MASTER)
  await un.getByTestId('popup-unlock').click()
  await expect(un.getByLabel('Search Walnut')).toBeVisible({ timeout: 30_000 })
  await un.close()
  await p.close()
})

test.afterAll(async () => {
  await ctx?.close()
  await new Promise<void>((r) => sites?.close(() => r()) ?? r())
})

test('off: no icon, no menu and no save bar in pages, open tabs follow at once, and the popup still fills on a click; on again, all of it is back', async () => {
  test.setTimeout(180_000)
  // On by default: the field shows the icon and its menu.
  const page = await ctx.newPage()
  await page.goto(site('www.pagefill.test', '/login'))
  await page.locator('#user').click()
  const menu = await frameOf(page, 'menu.html')
  await expect(menu.getByTestId('menu-item')).toHaveCount(1)
  expect(await drawn(page)).toBeGreaterThan(0)

  // Off, from the popup's Settings: the open tab drops its icon and menu without a reload.
  await setPageFill(false)
  await expect.poll(() => frames(page, 'menu.html')).toBe(0)
  await expect.poll(() => drawn(page)).toBe(0)

  // A click into the field, the arrow key, a new page: nothing of Walnut's opens.
  await page.reload()
  await page.locator('#user').click()
  await page.keyboard.press('ArrowDown')
  await page.locator('#pass').click()
  await page.waitForTimeout(1500)
  expect(frames(page, 'menu.html')).toBe(0)
  expect(await drawn(page)).toBe(0)

  // A typed sign-in: no save bar, now or on the page it led to.
  await signIn(page, 'off.pagefill.test', `off-${stamp}`)
  await page.waitForTimeout(2500)
  expect(frames(page, 'savebar.html')).toBe(0)
  expect(await drawn(page)).toBe(0)

  // The popup says filling on pages is off, and its Fill still fills the page.
  const { page: tab, win } = await pageInWindow(site('www.pagefill.test', '/login'))
  const p = await popup(win)
  await expect(p.getByTestId('popup-pagefill-off')).toHaveText('Filling on pages is off. Turn on in Settings.', { timeout: 20_000 })
  await shot(p, '31-list-pagefill-off')
  const row = p.getByTestId('popup-item').filter({ hasText: `Pia ${stamp}` })
  await row.hover()
  await row.getByTestId('popup-fill').click()
  await expect(tab.locator('#user')).toHaveValue('pia@pagefill.test', { timeout: 15_000 })
  await expect(tab.locator('#pass')).toHaveValue(`Pia-pw-${stamp}`)
  expect(frames(tab, 'menu.html')).toBe(0)
  await p.close()
  await tab.close()

  // On again: the open tab shows the icon and menu on the next click, and a sign-in gets its bar.
  await setPageFill(true)
  await page.goto(site('www.pagefill.test', '/login'))
  await page.locator('#user').click()
  await expect((await frameOf(page, 'menu.html')).getByTestId('menu-item')).toHaveCount(1)
  expect(await drawn(page)).toBeGreaterThan(0)
  await page.keyboard.press('Escape')
  await signIn(page, 'on.pagefill.test', `on-${stamp}`)
  const bar = await frameOf(page, 'savebar.html')
  await expect(bar.locator('#username')).toHaveValue(`on-${stamp}`)
  await page.close()
})
