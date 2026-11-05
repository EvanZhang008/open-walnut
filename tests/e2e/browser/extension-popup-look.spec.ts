/**
 * The extension's popup as a person sees it, beside extension-passwords.spec.ts: it finds Walnut
 * by itself before asking for an address, a login opens its detail view (each field copied,
 * the password shown whole), icon buttons carry their names, one type scale, a real Back
 * button, the one-time code ring fits its digits, the side panel's Passwords tab fills the
 * panel, Settings says plainly what agents may do, and the connect page wears the extension's
 * colour and key. Each view is saved as a screenshot (LOOK_SHOTS, else the task's review dir).
 *
 * Its sites are *.look.test (mapped to this machine), so nothing the other specs save matches.
 */
import { expect, test, chromium, type BrowserContext, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { bunRuntime } from '../../helpers/bun-runtime'
import { vaultSession } from './vault-session-helper'

test.describe.configure({ mode: 'serial' })

const MASTER = 'Correct Horse Battery Staple 42'
const stamp = Date.now().toString(36)
const SEED = 'JBSWY3DPEHPK3PXP'
/** A long password with an underscore, to see it shown whole. */
// A made-up test value: long, with underscores, so a revealed password must wrap, never be cut.
const LONG_PW = `fake_test_value_not_a_password-${stamp}-wraps_whole_never_cut`
const SHOTS = process.env.LOOK_SHOTS
  || (process.env.WALNUT_TASK_DIR ? path.join(process.env.WALNUT_TASK_DIR, 'review/fix-shots/E', process.env.LOOK_PHASE || 'after') : '')

let ctx: BrowserContext
let extId = ''
let sites: http.Server
let port = 0
let base = ''
const site = (host: string, p: string) => `http://${host}:${port}${p}`
const ids: Record<string, string> = {}

function startSites(): Promise<void> {
  sites = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(`<!doctype html><html><head><title>Sign in to Look Shop</title></head><body><h1>Sign in</h1>
      <form method="post" action="/"><input name="email" id="user" autocomplete="username"><input name="password" type="password" id="pass" autocomplete="current-password"><button>Sign in</button></form></body></html>`)
  })
  return new Promise((resolve) => sites.listen(0, '127.0.0.1', () => { port = (sites.address() as AddressInfo).port; resolve() }))
}

async function session(page: Page): Promise<string> {
  return vaultSession(page, base, { password: MASTER })
}

async function seed(page: Page, key: string, item: Record<string, unknown>): Promise<void> {
  const s = await session(page)
  const r = await page.request.post(`${base}/api/v1/vault/items`, { headers: { 'x-walnut-vault-session': s }, data: { item } })
  expect(r.ok(), await r.text()).toBe(true)
  ids[key] = (await r.json()).item.id
}

const sw = () => ctx.serviceWorkers()[0]

async function shot(p: Page, name: string): Promise<void> {
  if (!SHOTS) return
  fs.mkdirSync(SHOTS, { recursive: true })
  await p.waitForTimeout(250)
  await p.screenshot({ path: path.join(SHOTS, `${name}.png`) })
}

/** The toolbar popup, the size Chrome gives it. */
async function popup(height = 600): Promise<Page> {
  const p = await ctx.newPage()
  await p.setViewportSize({ width: 360, height })
  p.on('pageerror', (e) => console.log(`[popup pageerror] ${e.message}`))
  await p.goto(`chrome-extension://${extId}/popup.html`)
  return p
}

/** The popup as the side panel's Passwords tab shows it, about the page in `win`, `width` wide. */
async function panelView(win: number, width = 400): Promise<Page> {
  const opened = ctx.waitForEvent('page')
  await sw().evaluate((u: string) => chrome.windows.create({ url: u, type: 'popup', width: 420, height: 700 }), `chrome-extension://${extId}/popup.html?embed=panel&window=${win}`)
  const p = await opened
  await p.setViewportSize({ width, height: 640 })
  p.on('pageerror', (e) => console.log(`[panel pageerror] ${e.message}`))
  return p
}

async function pageInWindow(url: string): Promise<{ page: Page; win: number }> {
  const opened = ctx.waitForEvent('page')
  const w = await sw().evaluate((u: string) => chrome.windows.create({ url: u, focused: true }).then((x) => x.id ?? 0), url)
  const page = await opened
  await page.waitForLoadState('domcontentloaded')
  return { page, win: w }
}

test.beforeAll(async ({}, info) => {
  test.setTimeout(240_000)
  base = String(info.project.use.baseURL ?? 'http://localhost:3457')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-ext-look-'))
  execFileSync(bunRuntime(), ['scripts/build-extension.mjs', '--out', dir, '--no-zip'], { stdio: 'pipe' })
  await startSites()
  ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-ext-look-profile-')), {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1100, height: 760 },
    args: [
      `--disable-extensions-except=${path.join(dir, 'chrome')}`,
      `--load-extension=${path.join(dir, 'chrome')}`,
      '--host-resolver-rules=MAP *.look.test 127.0.0.1',
    ],
  })
  let worker = ctx.serviceWorkers()[0]
  if (!worker) worker = await ctx.waitForEvent('serviceworker')
  worker.on('console', (m) => { if (m.type() === 'error') console.log(`[background error] ${m.text()}`) })
  extId = new URL(worker.url()).host
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: `chrome-extension://${extId}` }).catch(() => {})
  const p = await ctx.newPage()
  await seed(p, 'shop', { type: 'login', title: `Look Shop ${stamp}`, username: 'lena@look.test', password: LONG_PW, totp: SEED, urls: [site('shop.look.test', '')], notes: 'Support PIN is in the drawer.' })
  await seed(p, 'work', { type: 'login', title: `Look Work ${stamp}`, username: 'lena.work@look.test', password: `Work-pw-${stamp}`, urls: [site('shop.look.test', '')] })
  await seed(p, 'card', { type: 'card', title: `Look Visa ${stamp}`, card: { holder: 'Lena Look', number: '4111 1111 1111 1111', expMonth: '07', expYear: '30', code: '321' } })
  await seed(p, 'who', { type: 'identity', title: `Lena at home ${stamp}`, fields: [{ name: 'First name', value: 'Lena' }, { name: 'Last name', value: 'Look' }, { name: 'Email', value: 'lena@look.test' }, { name: 'City', value: 'Springfield' }] })
  await p.close()
})

test.afterAll(async () => {
  await ctx?.close()
  await new Promise<void>((r) => sites?.close(() => r()) ?? r())
})

test('every view, connected and unlocked, as screenshots', async () => {
  test.setTimeout(240_000)
  // Not connected yet.
  const fresh = await popup()
  await expect(fresh.getByRole('heading', { name: 'Connect to Walnut' })).toBeVisible()
  await shot(fresh, '01-connect')
  await fresh.locator('#server').fill(base)
  const opened = ctx.waitForEvent('page')
  await fresh.getByTestId('popup-connect').click()
  const connect = await opened
  await connect.setViewportSize({ width: 1100, height: 700 })
  await expect(connect.getByRole('heading', { name: 'Connect this browser to Walnut?' })).toBeVisible({ timeout: 60_000 })
  await shot(connect, '02-connect-page')
  await connect.getByTestId('connect-extension-go').click()
  await expect(connect.getByTestId('connect-extension-done')).toBeVisible({ timeout: 20_000 })
  await shot(connect, '03-connect-page-done')
  await connect.close()

  const locked = await popup()
  await expect(locked.getByRole('heading', { name: 'Walnut is locked' })).toBeVisible({ timeout: 20_000 })
  await shot(locked, '04-locked')
  await locked.getByLabel('Master password').fill(MASTER)
  await locked.getByTestId('popup-unlock').click()
  await expect(locked.getByLabel('Search Walnut')).toBeVisible({ timeout: 30_000 })
  await shot(locked, '05-unlocked-no-site')
  await locked.getByLabel('Search Walnut').fill('look')
  await expect(locked.getByTestId('popup-item').first()).toBeVisible()
  await locked.getByTestId('popup-item').first().hover()
  await shot(locked, '06-search-hover')

  await locked.getByTestId('popup-generator').click()
  await expect(locked.getByTestId('gen-out')).not.toBeEmpty()
  await shot(locked, '07-generator')
  await locked.getByRole('button', { name: 'Back' }).click()
  await locked.getByTestId('popup-settings').click()
  await expect(locked.getByTestId('popup-autolock')).toBeVisible()
  await locked.setViewportSize({ width: 360, height: 900 })
  await shot(locked, '08-settings')
  await locked.close()

  const w = await pageInWindow(site('shop.look.test', '/login'))
  const panel = await panelView(w.win)
  await expect(panel.getByTestId('popup-item').filter({ hasText: `Look Shop ${stamp}` })).toBeVisible({ timeout: 20_000 })
  await panel.getByTestId('popup-item').filter({ hasText: `Look Shop ${stamp}` }).hover()
  await shot(panel, '09-panel-site-list')
  await panel.close()
  await w.page.close()
})

/** Every visible piece of text in the page: its computed size, and the element. */
async function textSizes(p: Page): Promise<Array<{ px: number; text: string; cls: string }>> {
  return p.evaluate(() => {
    const out: Array<{ px: number; text: string; cls: string }> = []
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const el = n.parentElement
      if (!el || !n.textContent?.trim()) continue
      const r = el.getBoundingClientRect()
      const cs = getComputedStyle(el)
      if (!r.width || !r.height || cs.visibility === 'hidden' || cs.opacity === '0') continue
      out.push({ px: parseFloat(cs.fontSize), text: n.textContent.trim().slice(0, 40), cls: el.className })
    }
    return out
  })
}

test('one type scale: 13 px text, never under 12 px, in every view (Chrome\'s 75% default for extension pages is undone)', async () => {
  const p = await popup()
  await expect(p.getByLabel('Search Walnut')).toBeVisible({ timeout: 20_000 })
  expect(await p.evaluate(() => getComputedStyle(document.body).fontSize)).toBe('13px')
  const views: Array<[string, () => Promise<void>]> = [
    ['list', async () => { await p.getByLabel('Search Walnut').fill('look'); await expect(p.getByTestId('popup-item').first()).toBeVisible() }],
    ['generator', async () => { await p.getByTestId('popup-generator').click(); await expect(p.getByTestId('gen-out')).not.toBeEmpty() }],
    ['settings', async () => { await p.getByTestId('popup-back').click(); await p.getByTestId('popup-settings').click(); await expect(p.getByTestId('popup-autolock')).toBeVisible() }],
  ]
  for (const [name, open] of views) {
    await open()
    const sizes = await textSizes(p)
    expect(sizes.length, name).toBeGreaterThan(3)
    // (The countdown inside a one-time code's ring is part of the ring, sized to fit it.)
    expect(sizes.filter((s) => s.px < 12 && !s.cls.includes('totp-secs')), name).toEqual([])
    // A row's name is the body size; its second line is the secondary size.
    for (const s of sizes.filter((x) => x.cls.includes('row-title'))) expect(s.px, `${name}: ${s.text}`).toBe(13)
  }
  await p.close()
})

test('a copy says when it is cleared, and is cleared 30 s after the latest copy, not an earlier one', async () => {
  const p = await ctx.newPage()
  await p.setViewportSize({ width: 360, height: 600 })
  await p.clock.install()
  await p.goto(`chrome-extension://${extId}/popup.html`)
  await expect(p.getByLabel('Search Walnut')).toBeVisible({ timeout: 20_000 })
  await p.getByLabel('Search Walnut').fill(`Look Work ${stamp}`)
  const row = p.getByTestId('popup-item').filter({ hasText: `Look Work ${stamp}` })
  const clip = () => p.evaluate(() => navigator.clipboard.readText())
  // When the page told the background of its latest copy (it resets its own timer in the same step).
  const copiedAt = () => sw().evaluate(() => chrome.storage.session.get('clipboardCopied').then((r) => (r.clipboardCopied as { at?: number } | undefined)?.at ?? 0))
  await row.hover()
  await row.getByTestId('copy-password').click()
  await expect(p.locator('.toast')).toHaveText('Password copied, cleared in 30 s')
  await shot(p, '21-copied-toast')
  await expect.poll(clip).toBe(`Work-pw-${stamp}`)
  await expect.poll(copiedAt).toBeGreaterThan(0)
  const first = await copiedAt()
  // The same password again 20 s later: the first copy's 30 s must not clear it at 30 s.
  await p.clock.fastForward(20_000)
  await row.hover()
  await row.getByTestId('copy-password').click()
  // The clipboard already holds it, so wait for this copy itself (it asks the background first).
  await expect.poll(copiedAt, { timeout: 15_000 }).toBeGreaterThan(first)
  await expect.poll(clip).toBe(`Work-pw-${stamp}`)
  await p.clock.fastForward(11_000)
  await p.waitForTimeout(300)
  expect(await clip()).toBe(`Work-pw-${stamp}`)
  await p.clock.fastForward(20_000)
  await expect.poll(clip).toBe('')
  await p.close()
})

test('the generator says what happens on a sign-up page: a strong password suggested, the save asked', async () => {
  const p = await popup()
  await expect(p.getByLabel('Search Walnut')).toBeVisible({ timeout: 20_000 })
  await p.getByTestId('popup-generator').click()
  await expect(p.getByText('When you send the form, it asks whether to save the login.', { exact: false })).toBeVisible()
  await expect(p.getByText(/saves it when you send/)).toHaveCount(0)
  await p.close()
})

test('a real Back button: its icon and the word, and every icon-only button is named and shows its name on hover', async () => {
  const p = await popup()
  await expect(p.getByLabel('Search Walnut')).toBeVisible({ timeout: 20_000 })
  // The list's head and rows: no button without a visible word lacks a name and a tooltip.
  await p.getByLabel('Search Walnut').fill('look')
  await expect(p.getByTestId('popup-item').first()).toBeVisible()
  const unnamed = await p.evaluate(() => [...document.querySelectorAll('button')]
    .filter((b) => !b.textContent?.trim() && (!b.getAttribute('aria-label') || !b.dataset.tip)).map((b) => b.outerHTML.slice(0, 80)))
  expect(unnamed).toEqual([])
  const settings = p.getByTestId('popup-settings')
  await settings.hover()
  await expect.poll(() => settings.evaluate((b) => { const a = getComputedStyle(b, '::after'); return `${a.content} ${a.opacity}` })).toBe('"Settings" 1')
  await settings.click()
  const back = p.getByTestId('popup-back')
  await expect(back).toHaveText('Back')
  await expect(back.locator('svg')).toHaveCount(1)
  expect((await back.boundingBox())!.width).toBeGreaterThan(50)
  await back.click()
  await expect(p.getByLabel('Search Walnut')).toBeVisible()
  await p.close()
})

test('a login opens its detail view: each field copied in one click, the password shown whole, Fill and Edit in Walnut', async () => {
  test.setTimeout(120_000)
  const w = await pageInWindow(site('shop.look.test', '/login'))
  const panel = await panelView(w.win)
  const row = panel.getByTestId('popup-item').filter({ hasText: `Look Shop ${stamp}` })
  await expect(row).toBeVisible({ timeout: 20_000 })
  await row.getByTestId('popup-open-item').click()
  const detail = panel.getByTestId('popup-detail')
  await expect(detail).toBeVisible()
  await expect(detail.getByTestId('detail-title')).toHaveText(`Look Shop ${stamp}`)
  const field = (label: string) => detail.locator(`[data-testid=detail-field][data-label="${label}"]`)
  await expect(field('Username').getByTestId('detail-value')).toHaveText('lena@look.test')
  await expect(field('Password').getByTestId('detail-value')).toHaveText('••••••••')
  await expect(field('One-time code').getByTestId('totp-code')).toHaveText(/\d{3} \d{3}/, { timeout: 10_000 })
  await expect(field('Website').getByTestId('detail-value')).toHaveText("shop.look.test")
  await expect(field('Notes').getByTestId('detail-value')).toHaveText('Support PIN is in the drawer.')
  await shot(panel, '10-detail')

  // Shown whole: wrapped, never cut with an ellipsis, and its underscores drawn.
  await field('Password').getByTestId('detail-reveal').click()
  const value = field('Password').getByTestId('detail-value')
  await expect(value).toHaveText(LONG_PW)
  expect(await value.evaluate((el) => el.scrollWidth <= el.clientWidth + 1 && getComputedStyle(el).textOverflow !== 'ellipsis')).toBe(true)
  expect((await value.boundingBox())!.height).toBeGreaterThan(30)
  await shot(panel, '11-detail-shown')
  await field('Password').getByTestId('detail-reveal').click()
  await expect(value).toHaveText('••••••••')

  // One click copies a field.
  await field('Username').getByTestId('detail-copy').click()
  await expect.poll(() => panel.evaluate(() => navigator.clipboard.readText())).toBe('lena@look.test')
  await field('Password').click()
  await expect.poll(() => panel.evaluate(() => navigator.clipboard.readText())).toBe(LONG_PW)

  // Fill from the detail view fills the page in the panel's window.
  await detail.getByTestId('detail-fill').click()
  await expect.poll(() => w.page.locator('#pass').inputValue(), { timeout: 15_000 }).toBe(LONG_PW)
  // Edit in Walnut opens that item in Walnut's Passwords.
  const opened = ctx.waitForEvent('page')
  await detail.getByTestId('detail-edit').click()
  const walnut = await opened
  // Walnut's Passwords opens it: still named in the address while Walnut is locked, or opened.
  await expect.poll(async () => walnut.url().includes(`/passwords?item=${ids.shop}`)
    || await walnut.getByText(`Look Shop ${stamp}`).count() > 0, { timeout: 30_000 }).toBe(true)
  await shot(walnut, '19-edit-in-walnut')
  await walnut.close()
  // The panel follows its window's page (Walnut's tab, then the site's again), else Back.
  await panel.waitForTimeout(1000)
  if (await detail.isVisible()) await panel.getByTestId('popup-back').click()
  await expect(row).toBeVisible({ timeout: 20_000 })

  // In the side panel the list shows a password whole too, on a line of its own: the row's
  // first line, its buttons and Fill, stay exactly where they were.
  await row.hover()
  const eye = row.getByTestId('reveal-password')
  const place = async () => Promise.all([eye, row.getByTestId('popup-fill'), row.locator('.row-title')].map(async (l) => {
    const b = (await l.boundingBox())!
    return [Math.round(b.x), Math.round(b.y)]
  }))
  const before = await place()
  await eye.click()
  const sub = row.locator('.row-sub')
  await expect(sub).toHaveText(LONG_PW)
  await panel.waitForTimeout(300)
  expect(await place()).toEqual(before)
  expect(await sub.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
  await shot(panel, '12-panel-list-shown')
  await eye.click()
  await expect(sub).toHaveText('lena@look.test')
  expect(await place()).toEqual(before)
  await panel.close()
  await w.page.close()
})

test('a row that does not fill here opens its item; a card shows its last four and expiry', async () => {
  const p = await popup()
  await expect(p.getByLabel('Search Walnut')).toBeVisible({ timeout: 20_000 })
  await p.getByLabel('Search Walnut').fill(`Look Work ${stamp}`)
  await p.getByTestId('popup-item').filter({ hasText: `Look Work ${stamp}` }).click()
  await expect(p.getByTestId('popup-detail')).toBeVisible()
  await expect(p.getByTestId('detail-title')).toHaveText(`Look Work ${stamp}`)
  // Not this page's login: no Fill.
  await expect(p.getByTestId('detail-fill')).toHaveCount(0)
  await p.getByTestId('popup-back').click()
  await p.getByLabel('Search Walnut').fill(`Look Visa ${stamp}`)
  await p.getByTestId('popup-item').filter({ hasText: `Look Visa ${stamp}` }).getByTestId('popup-open-item').click()
  const field = (label: string) => p.locator(`[data-testid=detail-field][data-label="${label}"] [data-testid=detail-value]`)
  await expect(field('Number')).toHaveText('•••• 1111')
  await expect(field('Expires')).toHaveText('07/30')
  await expect(field('Cardholder')).toHaveText('Lena Look')
  await p.locator('[data-testid=detail-field][data-label="Number"]').getByTestId('detail-reveal').click()
  await expect(field('Number')).toHaveText('4111 1111 1111 1111')
  await shot(p, '13-card-detail')
  await p.close()
})

test('the one-time code ring fits its two digits', async () => {
  const w = await pageInWindow(site('shop.look.test', '/login'))
  const panel = await panelView(w.win)
  const ring = panel.getByTestId('popup-item').filter({ hasText: `Look Shop ${stamp}` }).locator('.totp-ring')
  await expect(ring).toBeVisible({ timeout: 20_000 })
  const fit = await ring.evaluate((el) => {
    const r = el.getBoundingClientRect()
    const secs = el.querySelector('.totp-secs')!
    const range = document.createRange(); range.selectNodeContents(secs)
    const t = range.getBoundingClientRect()
    // The ring's stroke is 2.2 of 18 units: the digits fit inside its inner circle.
    const inner = r.width * (1 - (2 * 2.2) / 18)
    return { ring: r.width, digits: Math.max(t.width, t.height), inner }
  })
  expect(fit.ring).toBeGreaterThanOrEqual(22)
  expect(fit.digits).toBeLessThan(fit.inner * 0.8)
  await panel.close()
  await w.page.close()
})

test("the side panel's Passwords tab fills the panel's width", async () => {
  const w = await pageInWindow(site('shop.look.test', '/login'))
  for (const width of [400, 520]) {
    const panel = await panelView(w.win, width)
    await expect(panel.getByTestId('popup-item').first()).toBeVisible({ timeout: 20_000 })
    expect(await panel.evaluate(() => Math.round(document.body.getBoundingClientRect().width))).toBe(width)
    expect(await panel.evaluate(() => Math.round(document.querySelector('.foot')!.getBoundingClientRect().width))).toBe(width)
    await panel.close()
  }
  await w.page.close()
})

test('Settings says plainly what agents may do and where their sites are chosen', async () => {
  const p = await popup(900)
  await expect(p.getByLabel('Search Walnut')).toBeVisible({ timeout: 20_000 })
  await p.getByTestId('popup-settings').click()
  const note = p.getByTestId('popup-agents-note')
  await expect(note).toContainText('When this is on, your Walnut agents can open pages in this browser')
  await expect(p.getByText(/Which sites they may use/)).toHaveCount(0)
  await shot(p, '14-settings')
  await p.close()
})

test('dark: the list and an item read clearly (dark text on the light brown buttons)', async () => {
  const w = await pageInWindow(site('shop.look.test', '/login'))
  const panel = await panelView(w.win)
  await panel.emulateMedia({ colorScheme: 'dark' })
  const row = panel.getByTestId('popup-item').filter({ hasText: `Look Shop ${stamp}` })
  await expect(row).toBeVisible({ timeout: 20_000 })
  await row.hover()
  expect(await row.getByTestId('popup-fill').evaluate((b) => getComputedStyle(b).color)).toBe('rgb(31, 29, 27)')
  await shot(panel, '17-dark-list')
  await row.getByTestId('popup-open-item').click()
  await expect(panel.getByTestId('popup-detail')).toBeVisible()
  await shot(panel, '18-dark-detail')
  await panel.close()
  await w.page.close()
})

test('the connect page wears the extension\'s colour and key; disconnected, the popup finds Walnut by itself', async () => {
  test.setTimeout(120_000)
  const p = await popup()
  await expect(p.getByLabel('Search Walnut')).toBeVisible({ timeout: 20_000 })
  await p.getByTestId('popup-settings').click()
  // Asked once more, saying what stops; Cancel keeps it connected.
  await p.getByTestId('popup-disconnect').click()
  const confirm = p.getByRole('alertdialog', { name: 'Disconnect this browser?' })
  await expect(confirm).toContainText('stops filling and saving passwords here, and your Walnut agents can no longer use this browser')
  await shot(p, '20-disconnect-confirm')
  await p.getByTestId('popup-disconnect-cancel').click()
  await expect(confirm).toHaveCount(0)
  // Still connected: the list is still there behind Back.
  await p.getByTestId('popup-back').click()
  await expect(p.getByLabel('Search Walnut')).toBeVisible()
  await p.getByTestId('popup-settings').click()
  await p.getByTestId('popup-disconnect').click()
  await p.getByTestId('popup-disconnect-confirm').click()
  await expect(p.getByRole('heading', { name: 'Connect to Walnut' })).toBeVisible({ timeout: 20_000 })
  // The same key tile as the connect page, not a plug.
  await expect(p.locator('.big-icon svg path[d="M10.85 12.15 19 4"]')).toHaveCount(1)
  const found = p.getByTestId('popup-found')
  await expect(found).toHaveText(`Found Walnut at ${new URL(base).host}`, { timeout: 10_000 })
  await expect(p.locator('#server')).toHaveValue(base)
  await shot(p, '15-connect-found')

  // Nothing remembered and nothing on this computer's default port: it asks for the address.
  await sw().evaluate(() => chrome.storage.local.set({ lastServer: 'http://localhost:9' }))
  const defaultUp = await p.request.get('http://localhost:3456/api/v1/instance', { timeout: 2000 }).then((r) => r.ok(), () => false)
  if (!defaultUp) {
    await p.reload()
    await expect(p.getByTestId('popup-found')).toContainText('No Walnut answered on this computer', { timeout: 10_000 })
    await expect(p.locator('#server')).toBeFocused()
    await shot(p, '16-connect-not-found')
  }
  await sw().evaluate((b: string) => chrome.storage.local.set({ lastServer: b }), base)

  // Connected again from the address it found: the connect page's button is the extension's brown.
  await p.reload()
  await expect(p.getByTestId('popup-found')).toHaveText(`Found Walnut at ${new URL(base).host}`, { timeout: 10_000 })
  const opened = ctx.waitForEvent('page')
  await p.getByTestId('popup-connect').click()
  const connect = await opened
  const go = connect.getByTestId('connect-extension-go')
  await expect(go).toBeVisible({ timeout: 60_000 })
  expect(await go.evaluate((b) => getComputedStyle(b).backgroundColor)).toBe('rgb(138, 90, 43)')
  await go.click()
  await expect(connect.getByTestId('connect-extension-done')).toBeVisible({ timeout: 20_000 })
  await connect.close()
  await p.close()
})
