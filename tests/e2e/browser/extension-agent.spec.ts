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
import { holdApprovalsLock } from './approvals-lock'
import { vaultSession as openVaultSession } from './vault-session-helper'
import { holdVaultLock } from './vault-lock'

test.describe.configure({ mode: 'serial' })
// Its agent reads the shared fixture vault; the vault lock comes before the approvals lock.
holdVaultLock('shared', 'file')
// It makes and answers approvals on the shared fixture server, where another file clears them.
holdApprovalsLock('file')

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
  '/forms': () => `<h1>Forms</h1>
    <form id="f" onsubmit="return false">
      <label>Full name <input name="fullname" id="fullname"></label>
      <label>Email <input type="email" name="email" id="email"></label>
      <label>Password <input type="password" name="pw" id="pw" value="Hidden-Pass-9"></label>
      <label><input type="checkbox" name="news" id="news"> Newsletter</label>
      <label>Size <select name="size" id="size"><option value="s">Small</option><option value="l">Large</option></select></label>
      <label>Notes <textarea name="notes" id="notes"></textarea></label>
    </form>
    <div id="menu" style="display:inline-block;padding:8px" onmouseenter="document.getElementById('tip').textContent = 'Menu opened'">Hover me</div><p id="tip"></p>
    <p>Shipping is free over fifty dollars.</p><button id="checkout">Checkout now</button>
    <p id="gone">Loading results</p>
    <button id="load" onclick="setTimeout(() => { document.getElementById('gone').remove(); history.pushState({}, '', '/forms?done=1') }, 800)">Load results</button>
    <div style="width:4000px;height:3000px"></div><p>Bottom of page</p>`,
  '/framed': () => `<h1>Framed</h1>
    <iframe src="/inner-same" width="420" height="140"></iframe>
    <iframe src="${site('widget.example.test', '/inner-cross')}" width="420" height="140"></iframe>
    <iframe src="${site('ads.other.test', '/inner-other')}" width="420" height="140"></iframe>
    <script>addEventListener('load', () => { const f = document.createElement('iframe'); f.src = '/inner-late'; f.width = '420'; f.height = '80'; document.body.append(f) })</script>`,
  // A frame the page adds once it has loaded, its page slow to answer: there when the page is, not yet reachable.
  '/inner-late': () => `<button>Late button</button>`,
  '/inner-same': () => `<button onclick="document.getElementById('o').textContent = 'same clicked'">Same button</button><p id="o"></p>`,
  '/inner-cross': () => `<button onclick="document.getElementById('o').textContent = 'cross clicked: ' + document.getElementById('cf').value">Cross button</button>
    <input aria-label="Cross field" id="cf"><p id="o"></p>`,
  '/inner-other': () => `<button>Other site button</button>`,
  '/links': () => `<h1>Links</h1><a href="/order" target="_blank" id="nt">Open offers</a> <a href="/dl.txt" download="notes.txt" id="dl">Get notes</a>`,
  '/long': () => `<h1>Long</h1><div style="height:5000px;background:linear-gradient(#fff,#36c)"></div>`,
  '/huge': () => `<h1>Huge</h1><div style="height:20000px;background:linear-gradient(#fff,#c63)"></div>`,
  '/upload': () => `<h1>Upload</h1><label>Attachment <input type="file" id="up" multiple
    onchange="Promise.all([...this.files].map(async (f) => f.name + ':' + f.size + ':' + f.type + ':' + await f.text())).then((l) => document.getElementById('o').textContent = l.join(','))"></label><p id="o"></p>`,
  '/login': () => `<h1>Sign in</h1><form id="lf" onsubmit="return false"><label>Email <input id="user" name="email" type="email" autocomplete="username"></label>
    <label>Password <input id="pass" name="password" type="password" autocomplete="current-password"></label><button>Sign in</button></form>`,
  '/verify': () => `<h1>Two-step verification</h1><form id="vf" onsubmit="return false"><label>Code from your app <input id="otp" name="otp" inputmode="numeric" autocomplete="one-time-code"></label><button>Verify</button></form>`,
}
/** The fixture vault's fake master password (shared with the other extension specs). */
const MASTER = 'Correct Horse Battery Staple 42'

function startSites(): Promise<void> {
  sites = http.createServer((req, res) => {
    if (new URL(req.url ?? '/', 'http://x').pathname === '/dl.txt') {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-disposition': 'attachment; filename="notes.txt"' })
      res.end('downloaded notes\n')
      return
    }
    const path = new URL(req.url ?? '/', 'http://x').pathname
    const page = PAGES[path]
    const send = () => {
      res.writeHead(page ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' })
      res.end(page ? `<!doctype html><html><head><title>Test shop</title></head><body>${page()}</body></html>` : 'not found')
    }
    if (path === '/inner-late') setTimeout(send, 400)
    else send()
  })
  return new Promise((resolve) => sites.listen(0, '127.0.0.1', () => { port = (sites.address() as AddressInfo).port; resolve() }))
}

/** What an agent sends (the `browser` op's route). */
async function act(page: Page, body: Record<string, unknown>): Promise<{ status: number; body: Record<string, any> }> {
  const r = await page.request.post(`${base}/api/v1/browser/act`, { data: body, headers: { 'x-walnut-caller-kind': 'automation' }, timeout: 80_000 })
  return { status: r.status(), body: await r.json() }
}

async function answer(page: Page, id: string, decision: 'approve' | 'deny', proof = false): Promise<void> {
  const headers = proof ? { 'x-walnut-vault-session': await vaultSession(page) } : undefined
  const r = await page.request.post(`${base}/api/v1/approvals/${id}/answer`, { data: { decision }, ...(headers ? { headers } : {}) })
  expect(r.ok(), await r.text()).toBe(true)
}
/** The person's proof for an approval that needs one (an agent's buy, send or delete): Passwords unlocked in this window. */
async function vaultSession(page: Page): Promise<string> {
  return openVaultSession(page, base, { password: MASTER })
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

/** A JPEG's size in pixels, from its frame header. */
function jpegSize(b: Buffer): { w: number; h: number } {
  for (let i = 2; i < b.length - 9;) {
    if (b[i] !== 0xff) { i++; continue }
    const m = b[i + 1]
    if (m >= 0xc0 && m <= 0xc3) return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) }
    i += 2 + b.readUInt16BE(i + 2)
  }
  throw new Error('no JPEG frame header')
}

const imageOf = (body: Record<string, any>) => Buffer.from(String(body.image).split(',')[1], 'base64')
const frameRef = (snapshot: string, re: RegExp): string => {
  const line = snapshot.split('\n').find((l) => re.test(l))
  expect(line, `no element ${re} in\n${snapshot}`).toBeTruthy()
  return /\[(f\d+:e\d+)\]/.exec(line!)![1]
}

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
  // The connect page asks once whether agents may use this browser, on by default (R1-7); this
  // spec turns them on in the popup itself, so it says no here.
  await expect(connect.getByTestId('connect-extension-agents')).toBeChecked()
  await connect.getByTestId('connect-extension-agents').uncheck()
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

test('with Ask me first, a new site waits for the person; approved, the agent opens it in its own window', async () => {
  const mine = await ctx.newPage()
  await mine.goto(site('shop.other.test', '/mine'))
  // Any site is the default; the person may ask to approve each new one in Settings.
  expect((await (await mine.request.put(`${base}/api/v1/browser/settings`, { data: { mode: 'ask' } })).json()).mode).toBe('ask')
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
  // Placing an order waits for the person's yes (outward-asks.ts); approved with their proof, the same click goes through.
  const ask = await act(page, { action: 'click', ref: send })
  expect(ask.status, JSON.stringify(ask.body)).toBe(202)
  expect(ask.body).toMatchObject({ status: 'needs_ok', code: 'outward_needs_ok', kind: 'buy' })
  await answer(page, ask.body.request, 'approve', true)
  expect((await act(page, { action: 'click', ref: send, request: ask.body.request })).status).toBe(200)
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

test('find, form values and a whole form at once; hover; wait for text to go and for the address', async () => {
  const page = ctx.pages()[0]
  expect((await act(page, { action: 'navigate', url: site('shop.example.test', '/forms') })).status).toBe(200)
  const found = await act(page, { action: 'find', text: 'free over fifty' })
  expect(found.status, JSON.stringify(found.body)).toBe(200)
  expect(found.body.matches[0]).toMatchObject({ role: 'generic' })
  expect(found.body.matches[0].text).toContain('Shipping is free over fifty dollars.')
  const button = await act(page, { action: 'find', text: 'checkout', role: 'button' })
  expect(button.body.matches).toHaveLength(1)
  expect(button.body.matches[0]).toMatchObject({ role: 'button', name: 'Checkout now' })
  expect(button.body.matches[0].ref).toMatch(/^e\d+$/)

  const values = await act(page, { action: 'form_values' })
  const byLabel = (l: string) => (values.body.fields as Array<Record<string, any>>).find((f) => String(f.label).trim() === l)
  expect(byLabel('Full name')).toMatchObject({ name: 'fullname', type: 'text', value: '' })
  expect(byLabel('Password')).toMatchObject({ type: 'password', value: '(hidden)' })
  expect(JSON.stringify(values.body)).not.toContain('Hidden-Pass-9')
  expect(byLabel('Size')).toMatchObject({ type: 'select', value: 'Small', options: ['Small', 'Large'] })

  const filled = await act(page, { action: 'fill_form', fields: [
    { label: 'Full name', value: 'Test Person' }, { label: 'email', value: 'person@example.test' }, { label: 'Newsletter', value: true },
    { label: 'Size', value: 'Large' }, { ref: byLabel('Notes')!.ref, value: 'Leave at the door' },
  ] })
  expect(filled.status, JSON.stringify(filled.body)).toBe(200)
  expect(filled.body.filled).toHaveLength(5)
  const tab = agentPage()!
  await expect(tab.locator('#fullname')).toHaveValue('Test Person')
  await expect(tab.locator('#email')).toHaveValue('person@example.test')
  await expect(tab.locator('#news')).toBeChecked()
  await expect(tab.locator('#size')).toHaveValue('l')
  await expect(tab.locator('#notes')).toHaveValue('Leave at the door')
  // A field that is not there fills nothing.
  const none = await act(page, { action: 'fill_form', fields: [{ label: 'Full name', value: 'Other' }, { label: 'No such field', value: 'x' }] })
  expect(none.status).toBe(409)
  expect(none.body.code).toBe('no_field')
  await expect(tab.locator('#fullname')).toHaveValue('Test Person')

  const menu = (await act(page, { action: 'find', text: 'Hover me', exact: true })).body.matches[0]
  expect((await act(page, { action: 'hover', ref: menu.ref })).status).toBe(200)
  await expect(tab.locator('#tip')).toHaveText('Menu opened')

  expect((await act(page, { action: 'click', ref: (await act(page, { action: 'find', text: 'Load results', role: 'button' })).body.matches[0].ref })).status).toBe(200)
  const gone = await act(page, { action: 'wait', textGone: 'Loading results' })
  expect(gone.status, JSON.stringify(gone.body)).toBe(200)
  expect(gone.body.waited).toContain('gone')
  const at = await act(page, { action: 'wait', url: '/done=1$/' })
  expect(at.status, JSON.stringify(at.body)).toBe(200)
  expect(at.body.url).toBe(site('shop.example.test', '/forms?done=1'))
  expect((await act(page, { action: 'wait', url: 'never-there', ms: 1 })).status).toBe(409)
})

test('scroll to the bottom and top, by pixels, and sideways; each says where the page is', async () => {
  const page = ctx.pages()[0]
  const bottom = await act(page, { action: 'scroll', to: 'bottom' })
  expect(bottom.body).toMatchObject({ atBottom: true })
  expect(bottom.body.scrollTop).toBeGreaterThan(2000)
  const top = await act(page, { action: 'scroll', to: 'top' })
  expect(top.body).toMatchObject({ scrollTop: 0, atTop: true, atBottom: false })
  expect((await act(page, { action: 'scroll', by: 200 })).body.scrollTop).toBe(200)
  const right = await act(page, { action: 'scroll', direction: 'right' })
  expect(right.body.scrollLeft).toBeGreaterThan(100)
  expect((await act(page, { action: 'scroll', direction: 'left', by: 100_000 })).body.scrollLeft).toBe(0)
})

test('frames: the snapshot reads same-origin and cross-origin frames, a frame ref acts there, a frame on a site not allowed is left out', async () => {
  const page = ctx.pages()[0]
  expect((await act(page, { action: 'navigate', url: site('shop.example.test', '/framed') })).status).toBe(200)
  // Right after navigate, with no wait of its own: the snapshot waits for the frames the page
  // shows to be reachable (R1-15: it listed none until a 1.5 s wait).
  const snap = await act(page, { action: 'snapshot' })
  expect(snap.status).toBe(200)
  const s = snap.body.snapshot as string
  expect(s).toContain('h1 Framed')
  expect(s).toMatch(/button "Late button"/)
  const same = frameRef(s, /button "Same button"/)
  const cross = frameRef(s, /button "Cross button"/)
  const field = frameRef(s, /textbox "Cross field"/)
  expect(same.split(':')[0]).not.toBe(cross.split(':')[0])
  expect(s).toMatch(/other\.test is not allowed for agents/)
  expect(s).not.toContain('Other site button')

  expect((await act(page, { action: 'type', ref: field, text: 'hello frame' })).status).toBe(200)
  expect((await act(page, { action: 'click', ref: cross })).status).toBe(200)
  expect((await act(page, { action: 'click', ref: same })).status).toBe(200)
  const outs = async () => (await Promise.all(agentPage()!.frames().map((f) => f.evaluate(() => document.getElementById('o')?.textContent ?? '').catch(() => '')))).join('|')
  await expect.poll(outs).toContain('cross clicked: hello frame')
  await expect.poll(outs).toContain('same clicked')

  const text = await act(page, { action: 'text' })
  expect(text.body.text).toContain('cross clicked: hello frame')
  const found = await act(page, { action: 'find', text: 'Cross button' })
  expect(found.body.matches.map((m: { ref: string }) => m.ref)).toContain(cross)
  // A ref of a frame that is gone says so.
  const stale = await act(page, { action: 'click', ref: 'f9999:e1' })
  expect(stale.body.code).toBe('stale_ref')
})

test('a link to a new tab opens it as the agent\'s own; a download it starts is listed and waited for', async () => {
  const page = ctx.pages()[0]
  expect((await act(page, { action: 'navigate', url: site('shop.example.test', '/links') })).status).toBe(200)
  const s = (await act(page, { action: 'snapshot' })).body.snapshot as string
  const r = await act(page, { action: 'click', ref: refOf(s, /link "Open offers"/) })
  expect(r.status, JSON.stringify(r.body)).toBe(200)
  expect(r.body.opened).toMatchObject({ url: site('shop.example.test', '/order') })
  const child = r.body.opened.tab as number
  expect(child).not.toBe(agentTab)
  const tabs = await act(page, { action: 'tabs' })
  expect(tabs.body.tabs.map((t: { id: number }) => t.id).sort()).toEqual([agentTab, child].sort())
  const inChild = await act(page, { action: 'snapshot', tab: child })
  expect(inChild.status, JSON.stringify(inChild.body)).toBe(200)
  expect(inChild.body.snapshot).toContain('Order a test sandwich')
  expect((await act(page, { action: 'close', tab: child })).body).toMatchObject({ closed: true })

  expect((await act(page, { action: 'click', tab: agentTab, ref: refOf(s, /link "Get notes"/) })).status).toBe(200)
  const dl = await act(page, { action: 'downloads', wait: true, ms: 20_000 })
  expect(dl.status, JSON.stringify(dl.body)).toBe(200)
  expect(dl.body.finished).toMatchObject({ state: 'complete', url: site('shop.example.test', '/dl.txt') })
  expect(dl.body.finished.bytes).toBeGreaterThan(0)
  expect((await act(page, { action: 'downloads' })).body.downloads).toHaveLength(1)
  // Nothing new finishes: the wait says so.
  expect((await act(page, { action: 'downloads', wait: true, ms: 500 })).body.code).toBe('wait_timeout')
})

test('a full-page screenshot is the whole page in one image, cut at 12000 px; the scroll is put back', async () => {
  test.setTimeout(120_000)
  const page = ctx.pages()[0]
  expect((await act(page, { action: 'navigate', url: site('shop.example.test', '/long') })).status).toBe(200)
  await act(page, { action: 'scroll', by: 300 })
  const shot = await act(page, { action: 'screenshot', full: true, inline: true })
  expect(shot.status, JSON.stringify({ ...shot.body, image: undefined })).toBe(200)
  expect(shot.body).toMatchObject({ full: true })
  expect(shot.body.cut).toBeUndefined()
  fs.mkdirSync(test.info().outputDir, { recursive: true })
  fs.writeFileSync(path.join(test.info().outputDir, 'full-page.jpg'), imageOf(shot.body))
  const size = jpegSize(imageOf(shot.body))
  expect(size.h).toBe(shot.body.height)
  expect(size.h).toBeGreaterThan(5000)
  expect(await agentPage()!.evaluate(() => scrollY)).toBe(300)

  expect((await act(page, { action: 'navigate', url: site('shop.example.test', '/huge') })).status).toBe(200)
  const huge = await act(page, { action: 'screenshot', full: true, inline: true })
  expect(huge.status).toBe(200)
  expect(huge.body).toMatchObject({ cut: true, height: 12_000 })
  expect(huge.body.pageHeight).toBeGreaterThan(20_000)
  expect(jpegSize(imageOf(huge.body)).h).toBe(12_000)
})

test('upload puts files into a file field as a person\'s pick would; too much is refused', async () => {
  const page = ctx.pages()[0]
  expect((await act(page, { action: 'navigate', url: site('shop.example.test', '/upload') })).status).toBe(200)
  const s = (await act(page, { action: 'snapshot' })).body.snapshot as string
  const ref = refOf(s, /textbox "Attachment"|"Attachment"/)
  const up = await act(page, { action: 'upload', ref, files: [
    { name: 'a.txt', type: 'text/plain', base64: Buffer.from('hello').toString('base64') },
    { name: 'b.csv', type: 'text/csv', base64: Buffer.from('x,y;1,2').toString('base64') },
  ] })
  expect(up.status, JSON.stringify(up.body)).toBe(200)
  expect(up.body.uploaded).toEqual(['a.txt (5 bytes)', 'b.csv (7 bytes)'])
  await expect(agentPage()!.locator('#o')).toHaveText('a.txt:5:text/plain:hello,b.csv:7:text/csv:x,y;1,2')
  const big = await act(page, { action: 'upload', ref, files: [{ name: 'big.bin', base64: Buffer.alloc(10.5 * 1024 * 1024).toString('base64') }] })
  expect(big.status).toBe(413)
  expect(big.body.code).toBe('too_big')
  // Not a file field.
  const heading = (await act(page, { action: 'find', text: 'Upload', exact: true })).body.matches[0].ref
  const not = await act(page, { action: 'upload', ref: heading, files: [{ name: 'a', base64: 'YQ==' }] })
  expect(not.body.code).toBe('not_a_file_field')
})

test('the person\'s tabs: listed by title and address; one they are not on can be taken, with the frame; close gives it back', async () => {
  const page = ctx.pages()[0]
  const sw = ctx.serviceWorkers()[0]
  // The person's own window, with two tabs; they are on the second one.
  const ids = await sw.evaluate(async (urls: string[]) => {
    const w = await chrome.windows.create({ url: urls, focused: true, type: 'normal' })
    const [a, b] = w.tabs!
    await chrome.tabs.update(b.id!, { active: true })
    await chrome.windows.update(w.id!, { focused: true })
    return { a: a.id!, b: b.id! }
  }, [site('home.example.test', '/order'), site('home.example.test', '/elsewhere')])
  await expect.poll(() => ctx.pages().filter((x) => x.url().startsWith(site('home.example.test', ''))).length).toBe(2)
  const p1 = ctx.pages().find((x) => x.url() === site('home.example.test', '/order'))!
  const p2 = ctx.pages().find((x) => x.url() === site('home.example.test', '/elsewhere'))!
  await p1.waitForLoadState()
  const all = await act(page, { action: 'tabs', all: true })
  expect(all.status).toBe(200)
  const row = (id: number) => (all.body.tabs as Array<Record<string, any>>).find((t) => t.id === id)
  expect(row(ids.a)).toMatchObject({ owner: 'person', url: site('home.example.test', '/order') })
  expect(row(agentTab)).toMatchObject({ owner: 'mine' })
  expect(JSON.stringify(all.body)).not.toContain('Order a test sandwich</h1>')

  const here = await act(page, { action: 'take', tab: ids.b })
  expect(here.status).toBe(409)
  expect(here.body.code).toBe('person_is_here')
  const took = await act(page, { action: 'take', tab: ids.a })
  expect(took.status, JSON.stringify(took.body)).toBe(200)
  expect(took.body).toMatchObject({ tab: ids.a, taken: true })
  await expect.poll(() => p1.locator('walnut-ext').count(), { timeout: 10_000 }).toBeGreaterThan(0)
  const snap = await act(page, { action: 'snapshot', tab: ids.a })
  expect(snap.status).toBe(200)
  expect(snap.body.snapshot).toContain('Order a test sandwich')
  expect((await act(page, { action: 'tabs' })).body.tabs.map((t: { id: number }) => t.id)).toContain(ids.a)
  // A tab the taken one opens stays behind the person's tab: it is not brought forward for a screenshot.
  expect((await act(page, { action: 'navigate', tab: ids.a, url: site('home.example.test', '/links') })).status).toBe(200)
  const links = (await act(page, { action: 'snapshot', tab: ids.a })).body.snapshot as string
  const opened = await act(page, { action: 'click', tab: ids.a, ref: refOf(links, /link "Open offers"/) })
  expect(opened.status, JSON.stringify(opened.body)).toBe(200)
  const child = opened.body.opened.tab as number
  const hidden = await act(page, { action: 'screenshot', tab: child })
  expect(hidden.body.code).toBe('tab_hidden')
  expect(await sw.evaluate(async (id: number) => (await chrome.tabs.get(id)).active, child)).toBe(false)
  expect((await act(page, { action: 'close', tab: child })).body).toMatchObject({ closed: true })
  const back = await act(page, { action: 'close', tab: ids.a })
  expect(back.body).toMatchObject({ closed: false, released: true })
  await expect.poll(() => p1.locator('walnut-ext').count(), { timeout: 10_000 }).toBe(0)
  expect(p1.isClosed()).toBe(false)
  expect((await act(page, { action: 'snapshot', tab: ids.a })).body.code).toBe('not_your_tab')
  // A browser page is never taken.
  const blank = await ctx.newPage()
  const blankId = await sw.evaluate(async () => (await chrome.tabs.query({})).find((t) => t.url === 'about:blank')?.id ?? -1)
  if (blankId >= 0) expect((await act(page, { action: 'take', tab: blankId })).body.code).toBe('not_a_web_page')
  await Promise.all([p1.close(), p2.close(), blank.close()])
})

test('real input is off until the person turns it on: trusted, dialog and evaluate say where', async () => {
  const page = ctx.pages()[0]
  const nav = await act(page, { action: 'navigate', url: site('shop.example.test', '/order') })
  expect(nav.status, JSON.stringify(nav.body)).toBe(200)
  const s = (await act(page, { action: 'snapshot' })).body.snapshot as string
  for (const body of [
    { action: 'click', ref: refOf(s, /button "Place order"/), trusted: true },
    { action: 'type', ref: refOf(s, /textbox "Your name"/), text: 'x', trusted: true },
    { action: 'evaluate', expression: 'document.title' },
    { action: 'dialog', accept: true },
    { action: 'network' },
    { action: 'console' },
  ]) {
    const r = await act(page, body)
    expect(r.status, JSON.stringify(r.body)).toBe(409)
    expect(r.body.code).toBe('trusted_off')
    // Exactly which switch the person turns on, and where.
    expect(r.body.error).toContain('click the gear (Settings) at the top of the popup, and turn on "Let agents use real mouse and keys"')
  }
  await expect(agentPage()!.locator('#who')).toHaveValue('')
})

test('fill_login signs in with the saved login for the page; the agent never sees the password', async () => {
  const page = ctx.pages()[0]
  const session = await vaultSession(page)
  const secretPw = `Agent-Fill-${Date.now().toString(36)}`
  const made = await page.request.post(`${base}/api/v1/vault/items`, {
    headers: { 'x-walnut-vault-session': session },
    data: { item: { type: 'login', title: 'Test shop login', username: 'agent@example.test', password: secretPw, urls: [site('shop.example.test', '')], agentAccess: 'allow' } },
  })
  expect(made.ok(), await made.text()).toBe(true)
  expect((await act(page, { action: 'navigate', url: site('shop.example.test', '/login') })).status).toBe(200)
  const itemId = String((await made.json()).item?.id ?? '')
  const fill = (body: Record<string, unknown>) => page.request.post(`${base}/api/v1/browser/act`, { data: { action: 'fill_login', ...body }, headers: { 'x-walnut-caller-kind': 'automation' }, timeout: 80_000 })
  let r = await fill({})
  // Another spec's login for this site may share the fixture vault: then it asks which, and the id names ours.
  if (r.status() === 409 && (await r.json()).code === 'which_login') {
    expect(JSON.stringify((await r.json()).logins)).toContain(itemId)
    r = await fill({ item: itemId })
  }
  const raw = await r.text()
  expect(r.status(), raw).toBe(200)
  expect(raw).not.toContain(secretPw)
  expect(JSON.parse(raw)).toMatchObject({ filled: true, fields: ['username', 'password'], item: { title: 'Test shop login' } })
  const tab = agentPage()!
  await expect(tab.locator('#user')).toHaveValue('agent@example.test')
  await expect(tab.locator('#pass')).toHaveValue(secretPw)
  // What the agent reads of the page afterwards keeps it hidden too.
  expect(JSON.stringify((await act(page, { action: 'form_values' })).body)).not.toContain(secretPw)
  const logged = await (await page.request.get(`${base}/api/v1/vault/agent/log`, { headers: { 'x-walnut-vault-session': session } })).json()
  expect(logged.entries[0]).toMatchObject({ kind: 'fill', itemTitle: 'Test shop login', fields: ['username', 'password'] })
  // No login saved for a page: said so, nothing filled.
  expect((await act(page, { action: 'navigate', url: site('shop.example.test', '/order') })).status).toBe(200)
  expect((await act(page, { action: 'fill_login', item: 'No such login' })).body.code).toMatch(/no_login|other_site/)
})

test('fill_login refuses a page an agent\'s script or real input touched since it loaded; a reload clears it', async () => {
  const page = ctx.pages()[0]
  expect((await act(page, { action: 'navigate', url: site('shop.example.test', '/login') })).status).toBe(200)
  const sw = ctx.serviceWorkers()[0]
  // What the debugger's run marks (agent-trusted.ts noteTampered): this document's id. Real input
  // is off in this browser, so the mark is set the way that run sets it.
  await sw.evaluate(async (tab: number) => {
    const r = await chrome.tabs.sendMessage(tab, { type: 'agent-check' }, { frameId: 0 }) as { doc?: string }
    if (!r?.doc) throw new Error('the page gave no document id')
    const cur = (await chrome.storage.session.get('agentTampered')).agentTampered ?? {}
    await chrome.storage.session.set({ agentTampered: { ...cur, [String(tab)]: { owner: 'test', doc: r.doc, at: Date.now() } } })
  }, agentTab)
  const fill = async () => {
    let r = await act(page, { action: 'fill_login' })
    if (r.status === 409 && r.body.code === 'which_login') r = await act(page, { action: 'fill_login', item: 'Test shop login' })
    return r
  }
  const refused = await fill()
  expect(refused.status, JSON.stringify(refused.body)).toBe(409)
  expect(refused.body.code).toBe('page_tampered')
  expect(refused.body.error).toMatch(/Reload the page first/)
  await expect(agentPage()!.locator('#pass')).toHaveValue('')
  // A navigation to the same address is a new document: the fill goes through.
  expect((await act(page, { action: 'navigate', url: site('shop.example.test', '/login') })).status).toBe(200)
  const ok = await fill()
  expect(ok.status, JSON.stringify(ok.body)).toBe(200)
  expect(ok.body).toMatchObject({ filled: true })  // The next test reads the order page in this tab.
  expect((await act(page, { action: 'navigate', url: site('shop.example.test', '/order') })).status).toBe(200)
})

test('fill_code types the saved login\'s one-time code into the page; the agent never sees the code', async () => {
  const page = ctx.pages()[0]
  const session = await vaultSession(page)
  // A made-up base32 seed, the one the other vault tests use.
  const seed = 'JBSWY3DPEHPK3PXP'
  const made = await page.request.post(`${base}/api/v1/vault/items`, {
    headers: { 'x-walnut-vault-session': session },
    data: { item: { type: 'login', title: 'Test shop code', username: 'code@example.test', password: `Code-Fill-${Date.now().toString(36)}`, totp: seed, urls: [site('shop.example.test', '')], agentAccess: 'allow' } },
  })
  expect(made.ok(), await made.text()).toBe(true)
  const itemId = String((await made.json()).item?.id ?? '')
  expect((await act(page, { action: 'navigate', url: site('shop.example.test', '/verify') })).status).toBe(200)
  let r = await act(page, { action: 'fill_code' })
  if (r.status === 409 && r.body.code === 'which_login') r = await act(page, { action: 'fill_code', item: itemId })
  expect(r.status, JSON.stringify(r.body)).toBe(200)
  expect(r.body).toMatchObject({ filled: true, fields: ['code'], item: { title: 'Test shop code' } })
  const { parseTotp, totpAt } = await import('../../../src/core/vault/totp')
  const tab = agentPage()!
  const typed = await tab.locator('#otp').inputValue()
  expect(typed).toMatch(/^\d{6}$/)
  // The code of the moment it was filled (one period either side of now, for a slow runner).
  const p = parseTotp(seed)!
  const near = await Promise.all([-30_000, 0, 30_000].map(async (d) => (await totpAt(p, Date.now() + d)).code))
  expect(near).toContain(typed)
  expect(JSON.stringify(r.body)).not.toContain(typed)
  const logged = await (await page.request.get(`${base}/api/v1/vault/agent/log`, { headers: { 'x-walnut-vault-session': session } })).json()
  expect(logged.entries[0]).toMatchObject({ kind: 'fill', itemTitle: 'Test shop code', fields: ['totp'] })
  // The next test reads the order page in this tab.
  expect((await act(page, { action: 'navigate', url: site('shop.example.test', '/order') })).status).toBe(200)
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
  // The person turned it off a moment ago: the command says so (hub.ts lastGone), at once.
  const r = await act(p, { action: 'tabs' })
  expect(r.body.code).toBe('browser_off')
  expect(r.body.error).toContain('turned agents off')
})
