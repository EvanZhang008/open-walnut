/**
 * Walnut agents in the person's own browser, through the real extension in Chromium
 * (packages/browser-extension/src/agent.ts, page-agent.ts; server routes/browser-v1.ts): the
 * person turns it on in the popup; an agent opens a page (a new site waits for the person's
 * approval), reads it as a snapshot with element refs, types, picks, clicks, takes a
 * screenshot; a covered button is refused rather than clicked through; a link to another site
 * asks again and a denial holds; the agent's tab sits in its own window with a frame and a
 * Stop button, and Stop gives the tab back; the person's own tabs are never listed or touched;
 * Settings, Browser extension shows the browser and the allowed site, and Remove takes it off.
 *
 * Agents act through the API here (`walnut browser` and the `browser` op call the same route).
 * Sites are *.example.test / *.other.test, mapped to this machine by Chromium's host resolver.
 */
import { expect, test, chromium, type BrowserContext, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { bunRuntime } from '../../helpers/bun-runtime'

test.describe.configure({ mode: 'serial' })

let ctx: BrowserContext
let extId = ''
let sites: http.Server
let port = 0
let base = ''
let agentTab = 0
const site = (host: string, p: string) => `http://${host}:${port}${p}`

const PAGES: Record<string, () => string> = {
  '/order': () => `<h1>Order a test sandwich</h1>
    <form id="f" onsubmit="event.preventDefault(); document.getElementById('out').textContent = 'Ordered for ' + this.who.value + ': ' + this.bread.value">
      <label>Your name <input name="who" id="who"></label>
      <label>Bread <select name="bread" id="bread"><option value="white">White</option><option value="rye">Rye</option></select></label>
      <button type="submit" id="send">Place order</button>
    </form>
    <p id="out"></p>
    <a href="${site('www.other.test', '/elsewhere')}" id="away">Partner offers</a>`,
  '/covered': () => `<h1>Covered</h1><button id="under" onclick="document.title='clicked'">Buy</button>
    <div style="position:fixed;inset:0;background:rgba(0,0,0,.4)"><button>Accept cookies</button></div>`,
  '/mine': () => `<h1 id="mine">The person's own page</h1>`,
  '/reveal': () => `<h1>Sign in</h1>
    <label>Password <input id="pw" type="password" autocomplete="current-password" value="Shown-Secret-123"></label>
    <script>window.__types = []; new MutationObserver(() => window.__types.push(document.getElementById('pw').type)).observe(document.getElementById('pw'), { attributes: true, attributeFilter: ['type'] })</script>
    <button id="show" type="button" onclick="const p = document.getElementById('pw'); p.type = p.type === 'password' ? 'text' : 'password'">Show</button>`,
  '/elsewhere': () => `<h1>Elsewhere</h1>`,
  // Walnut's page as any address serves it (a tunnel, another machine): it carries Walnut's mark.
  '/walnut-app': () => `<meta name="walnut-app" content="1"><h1>Walnut</h1>`,
}

function startSites(): Promise<void> {
  sites = http.createServer((req, res) => {
    const page = PAGES[new URL(req.url ?? '/', 'http://x').pathname]
    res.writeHead(page ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' })
    res.end(page ? `<!doctype html><html><head><title>Test shop</title></head><body>${page()}</body></html>` : 'not found')
  })
  return new Promise((resolve) => sites.listen(0, '127.0.0.1', () => { port = (sites.address() as AddressInfo).port; resolve() }))
}

/** What an agent sends (the `browser` op's route). */
async function act(page: Page, body: Record<string, unknown>): Promise<{ status: number; body: Record<string, any> }> {
  const r = await page.request.post(`${base}/api/v1/browser/act`, { data: body, headers: { 'x-walnut-caller-kind': 'automation' }, timeout: 80_000 })
  return { status: r.status(), body: await r.json() }
}

async function answer(page: Page, id: string, decision: 'approve' | 'deny'): Promise<void> {
  const r = await page.request.post(`${base}/api/v1/approvals/${id}/answer`, { data: { decision } })
  expect(r.ok(), await r.text()).toBe(true)
}

async function popup(): Promise<Page> {
  const p = await ctx.newPage()
  await p.goto(`chrome-extension://${extId}/popup.html`)
  return p
}

const refOf = (snapshot: string, re: RegExp): string => {
  const line = snapshot.split('\n').find((l) => re.test(l))
  expect(line, `no element ${re} in\n${snapshot}`).toBeTruthy()
  return /\[(e\d+)\]/.exec(line!)![1]
}

const agentPage = () => ctx.pages().find((p) => p.url().startsWith(site('shop.example.test', '')))

test.beforeAll(async ({}, info) => {
  base = String(info.project.use.baseURL ?? 'http://localhost:3457')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-ext-'))
  execFileSync(bunRuntime(), ['scripts/build-extension.mjs', '--out', dir, '--no-zip'], { stdio: 'pipe' })
  await startSites()
  ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-ext-agent-')), {
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
  sw.on('console', (m) => { if (m.type() === 'error') console.log(`[background error] ${m.text()}`) })
  extId = new URL(sw.url()).host
})

test.afterAll(async () => {
  await ctx?.close()
  await new Promise<void>((r) => sites?.close(() => r()) ?? r())
})

test('connect, and turn agents on in the popup', async () => {
  test.setTimeout(120_000)
  const p = await popup()
  await p.locator('#server').fill(base)
  const opened = ctx.waitForEvent('page')
  await p.getByTestId('popup-connect').click()
  const connect = await opened
  await connect.waitForLoadState('domcontentloaded')
  // The fixture serves the app through Vite: a cold first load can take a while on a busy machine.
  await expect(connect.getByRole('heading', { name: 'Connect this browser to Walnut?' })).toBeVisible({ timeout: 60_000 })
  await connect.getByTestId('connect-extension-go').click()
  await expect(connect.getByTestId('connect-extension-done')).toBeVisible({ timeout: 20_000 })
  await connect.close()

  const again = await popup()
  // Locked or not set up, the Settings button is there: agents need no unlock.
  await again.getByRole('button', { name: 'Settings' }).click()
  const sw = again.getByTestId('popup-agents')
  await expect(sw).not.toBeChecked()
  await again.getByText('Let Walnut agents use this browser').click()
  await expect(again.getByTestId('popup-agents')).toBeChecked()
  await expect(again.getByText(/On\. Agents open their own tabs/)).toBeVisible()
  await expect.poll(async () => (await (await again.request.get(`${base}/api/v1/browser/status`)).json()).browsers.length, { timeout: 15_000 }).toBe(1)
  await again.close()
})

test('a new site waits for the person; approved, the agent opens it in its own window', async () => {
  const mine = await ctx.newPage()
  await mine.goto(site('shop.other.test', '/mine'))
  const first = await act(mine, { action: 'open', url: site('shop.example.test', '/order') })
  expect(first.status).toBe(202)
  expect(first.body).toMatchObject({ status: 'needs_ok', site: 'example.test' })
  expect(agentPage()).toBeUndefined()
  await answer(mine, first.body.approvalId, 'approve')
  const opened = await act(mine, { action: 'open', url: site('shop.example.test', '/order') })
  expect(opened.status, JSON.stringify(opened.body)).toBe(200)
  expect(opened.body).toMatchObject({ url: site('shop.example.test', '/order'), title: 'Test shop' })
  agentTab = opened.body.tab
  // Its own window, not the person's.
  const sw = ctx.serviceWorkers()[0]
  const windows = await sw.evaluate(async (tab: number) => {
    const t = await chrome.tabs.get(tab)
    const all = await chrome.tabs.query({})
    return { agentWindow: t.windowId, personWindows: all.filter((x) => x.url?.includes('/mine')).map((x) => x.windowId) }
  }, agentTab)
  expect(windows.personWindows).toHaveLength(1)
  expect(windows.personWindows[0]).not.toBe(windows.agentWindow)
  // The person's own tab is no agent's.
  const tabs = await act(mine, { action: 'tabs' })
  expect(tabs.body.tabs.map((t: { id: number }) => t.id)).toEqual([agentTab])
  await expect(mine.locator('#mine')).toBeVisible()
})

test('read, type, pick and click like a person; a screenshot of the tab', async () => {
  const page = ctx.pages()[0]
  const snap = await act(page, { action: 'snapshot' })
  expect(snap.status).toBe(200)
  const s = snap.body.snapshot as string
  expect(s).toContain('h1 Order a test sandwich')
  const who = refOf(s, /textbox "Your name"/)
  const bread = refOf(s, /combobox "Bread"/)
  const send = refOf(s, /button "Place order"/)
  expect((await act(page, { action: 'type', ref: who, text: 'Test Person' })).status).toBe(200)
  expect((await act(page, { action: 'select', ref: bread, value: 'Rye' })).body.selected).toBe('Rye')
  expect((await act(page, { action: 'click', ref: send })).status).toBe(200)
  const text = await act(page, { action: 'text' })
  expect(text.body.text).toContain('Ordered for Test Person: rye')
  // What the agent typed is in the page's own field, as the page's framework would see it.
  await expect(agentPage()!.locator('#who')).toHaveValue('Test Person')
  const shot = await act(page, { action: 'screenshot', inline: true })
  expect(shot.status).toBe(200)
  expect(shot.body.image).toMatch(/^data:image\/jpeg;base64,/)
  expect(Buffer.from((shot.body.image as string).split(',')[1], 'base64').length).toBeGreaterThan(2000)
})

test('a covered button is refused, not clicked through', async () => {
  const page = ctx.pages()[0]
  expect((await act(page, { action: 'navigate', url: site('shop.example.test', '/covered') })).status).toBe(200)
  const s = (await act(page, { action: 'snapshot' })).body.snapshot as string
  const buy = refOf(s, /button "Buy"/)
  const r = await act(page, { action: 'click', ref: buy })
  expect(r.status).toBe(409)
  expect(r.body.code).toBe('covered')
  expect(r.body.error).toContain('Accept cookies')
  expect(await agentPage()!.title()).toBe('Test shop')
  expect((await act(page, { action: 'back' })).body.url).toBe(site('shop.example.test', '/order'))
})

test('a password the page shows as text stays hidden from the agent', async () => {
  const page = ctx.pages()[0]
  expect((await act(page, { action: 'navigate', url: site('shop.example.test', '/reveal') })).status).toBe(200)
  const s = (await act(page, { action: 'snapshot' })).body.snapshot as string
  expect((await act(page, { action: 'click', ref: refOf(s, /button "Show"/) })).status).toBe(200)
  await expect(agentPage()!.locator('#pw')).toHaveAttribute('type', 'text')
  const after = (await act(page, { action: 'snapshot' })).body.snapshot as string
  expect(after).toContain('value=(hidden)')
  expect(after).not.toContain('Shown-Secret-123')
  // A screenshot draws it as dots while it is taken, then the page has it back as it was.
  expect((await act(page, { action: 'screenshot', inline: true })).status).toBe(200)
  expect(await agentPage()!.evaluate(() => (window as unknown as { __types: string[] }).__types)).toEqual(['text', 'password', 'text'])
  expect((await act(page, { action: 'back' })).body.url).toBe(site('shop.example.test', '/order'))
})

test('Walnut itself under another address is never an agent\'s page', async () => {
  const page = ctx.pages()[0]
  // An approved site that serves Walnut (as a tunnel or another machine would): the page says it is Walnut.
  const r = await act(page, { action: 'open', url: site('walnut.example.test', '/walnut-app') })
  expect(r.status, JSON.stringify(r.body)).toBe(409)
  expect(r.body.code).toBe('walnut_page')
  await expect.poll(() => ctx.pages().some((p) => p.url().startsWith('http://walnut.example.test'))).toBe(false)
  expect((await act(page, { action: 'tabs' })).body.tabs.map((t: { id: number }) => t.id)).toEqual([agentTab])
})

test('a link to another site asks again; a denial holds', async () => {
  const page = ctx.pages()[0]
  const s = (await act(page, { action: 'snapshot' })).body.snapshot as string
  const away = refOf(s, /link "Partner offers"/)
  const r = await act(page, { action: 'click', ref: away })
  // The click went (it is the page's own link); what the agent finds there is not its yet.
  expect(r.status).toBe(200)
  const next = await act(page, { action: 'snapshot' })
  expect(next.status).toBe(202)
  expect(next.body.site).toBe('other.test')
  await answer(page, next.body.approvalId, 'deny')
  const no = await act(page, { action: 'snapshot' })
  expect(no.status).toBe(403)
  expect(no.body.code).toBe('site_denied')
  const back = await act(page, { action: 'back' })
  expect(back.status, JSON.stringify(back.body)).toBe(200)
})

test('the agent tab wears a frame; Stop gives it back to the person', async () => {
  const tab = agentPage()!
  await tab.bringToFront()
  const vw = await tab.evaluate(() => ({ w: innerWidth, h: innerHeight }))
  await tab.screenshot({ path: path.join(test.info().outputDir, 'agent-tab.png') })
  // The Stop button is the right end of the pill in the bottom right corner (a closed shadow root).
  await tab.mouse.click(vw.w - 14 - 8 - 20, vw.h - 14 - 7 - 11)
  await expect.poll(async () => (await act(tab, { action: 'snapshot', tab: agentTab })).body.code, { timeout: 10_000 }).toBe('not_your_tab')
  expect((await act(tab, { action: 'tabs' })).body.tabs).toEqual([])
  // The page stays, now the person's.
  await expect(tab.locator('#who')).toBeVisible()
})

test('Settings, Browser extension shows the browser and the allowed site; Remove takes it off', async () => {
  const page = await ctx.newPage()
  await page.goto(`${base}/settings#browser`)
  const now = page.locator('.settings-row', { hasText: 'Browsers that let agents in now' })
  await expect(now).toContainText(/Walnut extension \(Chrome on/, { timeout: 20_000 })
  const row = page.locator('.settings-row', { hasText: 'example.test' })
  await expect(row).toBeVisible()
  await row.getByRole('button', { name: 'Remove' }).click()
  await expect(row).toHaveCount(0)
  await expect(page.locator('.settings-row', { hasText: 'Allowed sites' })).toContainText('None yet')
  const st = await (await page.request.get(`${base}/api/v1/browser/status`)).json()
  expect(st.sites).toEqual([])
})

test('turning agents off in the popup disconnects the browser', async () => {
  const p = await popup()
  await p.getByRole('button', { name: 'Settings' }).click()
  await p.getByText('Let Walnut agents use this browser').click()
  await expect(p.getByTestId('popup-agents')).not.toBeChecked()
  await expect.poll(async () => (await (await p.request.get(`${base}/api/v1/browser/status`)).json()).browsers.length, { timeout: 10_000 }).toBe(0)
  const r = await act(p, { action: 'tabs' })
  expect(r.body.code).toBe('browser_not_connected')
})
