/**
 * What lets the old private relay retire (2026-11-07, the user: "we actually now fully migrate
 * to this new extension"), with the real extension in Chromium: an agent records its own tab's
 * requests and console (packages/browser-extension/src/agent-net.ts) and reads a response's and a
 * request's body, which a script reading a site's own data needs; uploads into a file field the
 * page hides (upload {selector}); sizes Walnut's agent window (resize), which stays unfocused and
 * never minimized; and its tabs are muted at birth, their media kept from playing by itself
 * while the agent's own click on Play still plays it (agent-media.ts).
 *
 * Recording uses the browser's debugger, which the person allows with "Let agents use real mouse
 * and keys" (an optional permission Chrome asks about in a prompt no test can answer): this spec
 * builds the extension with that permission granted, the state the person's Allow leaves.
 * The person's steps (connecting the browser in the popup) are real mouse and keys; agents act
 * through the API, as `walnut browser` and the `browser` op do. Sites are *.portal.test.
 */
import { expect, test, chromium, type BrowserContext, type Locator, type Page, type Worker } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { bunRuntime } from '../../helpers/bun-runtime'
import { holdApprovalsLock } from './approvals-lock'

test.describe.configure({ mode: 'serial' })
// Allow any site is the whole fixture server's setting: the approvals lock keeps the agent specs apart.
holdApprovalsLock('file')

let ctx: BrowserContext
let sw: Worker
let extId = ''
let sites: http.Server
let port = 0
let base = ''
let device = ''
const site = (host: string, p: string) => `http://${host}:${port}${p}`
const notes: string[] = []

/** A second of silence as a WAV file: something to play. */
function silence(): Buffer {
  const rate = 8000
  const data = Buffer.alloc(rate)
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12)
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate, 28)
  h.writeUInt16LE(1, 32); h.writeUInt16LE(8, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40)
  return Buffer.concat([h, data.fill(128)])
}

const PAGES: Record<string, string> = {
  '/orders': `<h1>Your orders</h1><p id="n">loading</p>
    <button id="send" onclick="fetch('/api/note', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ note: 'gift wrap please' }) }).then((r) => r.json()).then((j) => { document.getElementById('sent').textContent = j.ok ? 'sent' : 'no' })">Save note</button><p id="sent"></p>
    <script>
      console.log('orders page ready', 3)
      console.error('demo error 42')
      fetch('/api/orders').then((r) => r.json()).then((d) => { document.getElementById('n').textContent = d.items.length + ' orders' })
    </script>`,
  '/hidden-upload': `<h1>New post</h1><button id="pick" type="button">Add image</button>
    <input type="file" id="image-upload-field" style="display:none" onchange="this.files[0].text().then((t) => document.getElementById('o').textContent = this.files[0].name + ':' + t)">
    <p id="o"></p>`,
  '/media': `<h1>Video</h1><audio id="a" src="/tone.wav" autoplay loop muted></audio>
    <button id="play" onclick="document.getElementById('a').play()">Play</button>
    <script>setTimeout(() => document.getElementById('a').play().catch(() => {}), 2500)</script>`,
}

function startSites(): Promise<void> {
  sites = http.createServer((req, res) => {
    const p = new URL(req.url ?? '/', 'http://x').pathname
    if (p === '/api/orders') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ items: [{ id: 1, name: 'Blue mug' }, { id: 2, name: 'Green lamp' }] })); return }
    if (p === '/api/note') {
      let b = ''
      req.on('data', (c) => { b += c })
      req.on('end', () => { notes.push(b); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}') })
      return
    }
    if (p === '/tone.wav') { res.writeHead(200, { 'content-type': 'audio/wav' }); res.end(silence()); return }
    const page = PAGES[p]
    res.writeHead(page ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' })
    res.end(page ? `<!doctype html><html><head><title>Portal</title></head><body>${page}</body></html>` : 'not found')
  })
  return new Promise((resolve) => sites.listen(0, '127.0.0.1', () => { port = (sites.address() as AddressInfo).port; resolve() }))
}

async function act(page: Page, body: Record<string, unknown>): Promise<{ status: number; body: Record<string, any> }> {
  const r = await page.request.post(`${base}/api/v1/browser/act`, { data: { device, ...body }, headers: { 'x-walnut-caller-kind': 'automation' }, timeout: 80_000 })
  return { status: r.status(), body: await r.json() }
}

async function press(page: Page, loc: Locator): Promise<void> {
  await expect(loc).toBeVisible()
  const b = (await loc.boundingBox())!
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2)
}

const pageAt = (p: string) => ctx.pages().find((x) => new URL(x.url(), 'http://x').pathname === p)
const refOf = (snapshot: string, re: RegExp): string => {
  const line = snapshot.split('\n').find((l) => re.test(l))
  expect(line, `no element ${re} in\n${snapshot}`).toBeTruthy()
  return /\[(e\d+)\]/.exec(line!)![1]
}

test.beforeAll(async ({ browser }, info) => {
  test.setTimeout(360_000)
  base = String(info.project.use.baseURL ?? 'http://localhost:3457')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-ext-net-'))
  execFileSync(bunRuntime(), ['scripts/build-extension.mjs', '--out', dir, '--no-zip'], { stdio: 'pipe' })
  // The person's Allow on "Let agents use real mouse and keys": the debugger permission, granted.
  const mf = path.join(dir, 'chrome', 'manifest.json')
  const m = JSON.parse(fs.readFileSync(mf, 'utf8')) as { permissions: string[]; optional_permissions?: string[] }
  m.permissions.push('debugger')
  m.optional_permissions = (m.optional_permissions ?? []).filter((x) => x !== 'debugger')
  fs.writeFileSync(mf, JSON.stringify(m))
  await startSites()
  ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-ext-net-profile-')), {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1100, height: 760 },
    args: [`--disable-extensions-except=${path.join(dir, 'chrome')}`, `--load-extension=${path.join(dir, 'chrome')}`, '--host-resolver-rules=MAP *.portal.test 127.0.0.1'],
  })
  sw = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent('serviceworker')
  sw.on('console', (msg) => { if (msg.type() === 'error') console.log(`[background error] ${msg.text()}`) })
  extId = new URL(sw.url()).host

  const api = await browser.newContext()
  const before = new Set(((await (await api.request.get(`${base}/api/v1/browser/status`)).json()).browsers as Array<{ device: string }>).map((b) => b.device))
  const p = await ctx.newPage()
  await p.goto(`chrome-extension://${extId}/popup.html`)
  await press(p, p.locator('#server'))
  await p.keyboard.press('Control+a')
  await p.keyboard.type(base)
  const opened = ctx.waitForEvent('page')
  await press(p, p.getByTestId('popup-connect'))
  const connect = await opened
  await connect.waitForLoadState('domcontentloaded')
  await expect(connect.getByRole('heading', { name: 'Connect this browser to Walnut?' })).toBeVisible({ timeout: 150_000 })
  await expect(connect.getByTestId('connect-extension-agents')).toBeChecked()
  await press(connect, connect.getByTestId('connect-extension-go'))
  await expect(connect.getByTestId('connect-extension-done')).toBeVisible({ timeout: 20_000 })
  await connect.close()
  await p.close()
  await expect.poll(async () => {
    const list = ((await (await api.request.get(`${base}/api/v1/browser/status`)).json()).browsers as Array<{ device: string; caps?: string[] }>).filter((b) => !before.has(b.device))
    device = list[0]?.caps?.includes('trusted-input') ? list[0].device : ''
    return device
  }, { timeout: 30_000 }).not.toBe('')
  expect((await api.request.put(`${base}/api/v1/browser/settings`, { data: { mode: 'any' } })).ok()).toBe(true)
  await api.close()
})

test.afterAll(async () => {
  await ctx?.close()
  await new Promise<void>((r) => sites?.close(() => r()) ?? r())
})

test('open with record: the page\'s requests and console from its load; a response\'s and a request\'s body; stop lets the debugger go', async () => {
  test.setTimeout(180_000)
  const page = ctx.pages()[0]
  const o = await act(page, { action: 'open', url: site('www.portal.test', '/orders'), record: true })
  expect(o.status, JSON.stringify(o.body)).toBe(200)
  expect(o.body.recording).toBe(true)
  const tab = o.body.tab as number
  await expect(pageAt('/orders')!.locator('#n')).toHaveText('2 orders')

  const net = await act(page, { action: 'network', tab })
  expect(net.status, JSON.stringify(net.body)).toBe(200)
  const urls = (net.body.requests as Array<{ url: string }>).map((r) => new URL(r.url).pathname)
  expect(urls).toEqual(expect.arrayContaining(['/orders', '/api/orders']))
  expect(net.body.started_now).toBeUndefined()
  const api = await act(page, { action: 'network', tab, url: '/api/orders', type: 'Fetch' })
  const rec = (api.body.requests as Array<{ id: string; status: number; method: string; ms?: number }>)[0]
  expect(rec).toMatchObject({ status: 200, method: 'GET' })
  const body = await act(page, { action: 'network_body', tab, request_id: rec.id })
  expect(body.status, JSON.stringify(body.body)).toBe(200)
  expect(JSON.parse(body.body.body as string).items[1].name).toBe('Green lamp')

  // A request the page sends after an agent's click: what it sent reads back.
  const s = (await act(page, { action: 'snapshot', tab })).body.snapshot as string
  expect((await act(page, { action: 'click', tab, ref: refOf(s, /button "Save note"/) })).status).toBe(200)
  await expect(pageAt('/orders')!.locator('#sent')).toHaveText('sent')
  const posts = await act(page, { action: 'network', tab, method: 'POST' })
  const post = (posts.body.requests as Array<{ id: string; hasBody?: boolean }>)[0]
  expect(post.hasBody).toBe(true)
  const sent = await act(page, { action: 'network_request_body', tab, request_id: post.id })
  expect(JSON.parse(sent.body.body as string)).toEqual({ note: 'gift wrap please' })
  expect(notes).toContain(JSON.stringify({ note: 'gift wrap please' }))
  expect((await act(page, { action: 'network_body', tab, request_id: 'no-such-id' })).body.code).toBe('no_such_request')

  const con = await act(page, { action: 'console', tab })
  const texts = (con.body.messages as Array<{ level: string; text: string }>).map((x) => `${x.level}: ${x.text}`)
  expect(texts).toEqual(expect.arrayContaining(['log: orders page ready 3', 'error: demo error 42']))
  const errs = await act(page, { action: 'console', tab, level: 'error' })
  expect((errs.body.messages as Array<{ level: string }>).every((x) => x.level === 'error')).toBe(true)

  // Real input in a recording tab goes through the same debugger session.
  const s2 = (await act(page, { action: 'snapshot', tab })).body.snapshot as string
  expect((await act(page, { action: 'hover', tab, ref: refOf(s2, /button "Save note"/), trusted: true })).status).toBe(200)

  // Whether the extension's own debugger session is on the tab (getTargets counts Playwright's too).
  const attached = () => sw.evaluate(async (id: number) => chrome.debugger.sendCommand({ tabId: id }, 'Page.getFrameTree').then(() => true, () => false), tab)
  expect(await attached()).toBe(true)
  expect((await act(page, { action: 'network', tab, stop: true })).body).toMatchObject({ recording: false, stopped: true })
  await expect.poll(attached).toBe(false)
  // A new recording starts afresh.
  expect((await act(page, { action: 'network', tab })).body.started_now).toBe(true)
  await act(page, { action: 'close', tab })
})

test('the first network in a tab starts recording and says what it missed', async () => {
  const page = ctx.pages()[0]
  const o = await act(page, { action: 'open', url: site('www.portal.test', '/orders') })
  expect(o.body.recording).toBeUndefined()
  const first = await act(page, { action: 'network', tab: o.body.tab })
  expect(first.body).toMatchObject({ recording: true, started_now: true })
  expect(first.body.note).toMatch(/Navigate to the page again/)
  expect((await act(page, { action: 'navigate', tab: o.body.tab, url: site('www.portal.test', '/orders') })).status).toBe(200)
  await expect.poll(async () => ((await act(page, { action: 'network', tab: o.body.tab, url: '/api/orders' })).body.requests as unknown[]).length).toBeGreaterThan(0)
  await act(page, { action: 'close', tab: o.body.tab })
})

test('upload by selector reaches a file field the page hides', async () => {
  const page = ctx.pages()[0]
  const o = await act(page, { action: 'open', url: site('www.portal.test', '/hidden-upload') })
  const tab = o.body.tab as number
  // snapshot does not list a hidden field: the selector is the way in.
  expect((await act(page, { action: 'snapshot', tab })).body.snapshot).not.toMatch(/image-upload-field/)
  const up = await act(page, { action: 'upload', tab, selector: '#image-upload-field', files: [{ name: 'cover.txt', type: 'text/plain', base64: Buffer.from('cover image').toString('base64') }] })
  expect(up.status, JSON.stringify(up.body)).toBe(200)
  expect(up.body.uploaded).toEqual(['cover.txt (11 bytes)'])
  await expect(pageAt('/hidden-upload')!.locator('#o')).toHaveText('cover.txt:cover image')
  expect((await act(page, { action: 'upload', tab, selector: '#nothing-here', files: [{ name: 'a', base64: 'YQ==' }] })).body.code).toBe('no_match')
  expect((await act(page, { action: 'upload', tab, selector: '#pick', files: [{ name: 'a', base64: 'YQ==' }] })).body.code).toBe('not_a_file_field')
  expect((await act(page, { action: 'upload', tab, selector: '[[bad', files: [{ name: 'a', base64: 'YQ==' }] })).body.code).toBe('bad_selector')
  await act(page, { action: 'close', tab })
})

test('resize sizes the agent window, which stays unfocused and never minimized', async () => {
  const page = ctx.pages()[0]
  const o = await act(page, { action: 'open', url: site('www.portal.test', '/hidden-upload') })
  const tab = o.body.tab as number
  // The tab opened blank (to be muted first) has no blank page to go back to.
  expect((await act(page, { action: 'back', tab })).body.code).toBe('no_history')
  const r = await act(page, { action: 'resize', tab, width: 1000, height: 700 })
  expect(r.status, JSON.stringify(r.body)).toBe(200)
  expect(r.body).toMatchObject({ width: 1000, height: 700, window: 'agent' })
  const win = () => sw.evaluate(async (id: number) => { const t = await chrome.tabs.get(id); const w = await chrome.windows.get(t.windowId); return { state: w.state, focused: w.focused, width: w.width, tabW: t.width, tabH: t.height } }, tab)
  expect(await win()).toMatchObject({ state: 'normal', focused: false, width: 1000 })
  const v = await act(page, { action: 'resize', tab, width: 900, height: 600, viewport: true })
  expect(v.body.viewport).toEqual({ width: 900, height: 600 })
  expect(await win()).toMatchObject({ state: 'normal', focused: false, tabW: 900, tabH: 600 })
  // A second tab in the agent window comes to its front, and the window stays unfocused
  // (2026-11-09: tabs.create with active: true focused it).
  const two = (await act(page, { action: 'open', url: site('www.portal.test', '/hidden-upload') })).body.tab as number
  expect(await sw.evaluate(async (id: number) => { const t = await chrome.tabs.get(id); const w = await chrome.windows.get(t.windowId); return { active: t.active, focused: w.focused } }, two)).toEqual({ active: true, focused: false })
  await act(page, { action: 'close', tab: two })
  await act(page, { action: 'close', tab })
})

test('an agent tab is muted at birth; its media does not play by itself, the agent\'s own click on Play plays it', async () => {
  const page = ctx.pages()[0]
  const o = await act(page, { action: 'open', url: site('www.portal.test', '/media') })
  const tab = o.body.tab as number
  expect(await sw.evaluate(async (id: number) => (await chrome.tabs.get(id)).mutedInfo?.muted, tab)).toBe(true)
  const media = pageAt('/media')!
  const paused = () => media.evaluate(() => (document.getElementById('a') as HTMLAudioElement).paused)
  // Its autoplay, and the page's own play() a moment later, are both held.
  await media.waitForTimeout(3500)
  expect(await paused()).toBe(true)
  const s = (await act(page, { action: 'snapshot', tab })).body.snapshot as string
  expect((await act(page, { action: 'click', tab, ref: refOf(s, /button "Play"/) })).status).toBe(200)
  await expect.poll(paused).toBe(false)
  await act(page, { action: 'close', tab })
})
