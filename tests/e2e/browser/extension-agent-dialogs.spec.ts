/**
 * Page dialogs and leaving a page, with the real extension in Chromium (packages/browser-extension/
 * src/agent-dialog.ts, agent-dialog-act.ts, agent-leave.ts, page-unsaved.ts, tab-close.ts; server
 * routes/browser-v1.ts). 2026-11-17, the user, about an agent posting on a forum whose close hung on
 * Chrome's "Leave site?": "does it know it is in this state, can the walnut browser get out of
 * this". One test page opens, in turn, an alert, a confirm, a prompt and a "Leave site?"
 * (beforeunload): the agent gets each in the answer of the step that opened it, answers it with one
 * dialog call, and the page never stays stuck. Then the leave rules: work typed and not sent stops a
 * close (unsaved_work) until discard; a "Leave site?" on close and navigate comes back to the agent
 * at once with the tab still its own; Stay keeps the page, Leave goes.
 *
 * The agent acts through the API, as `walnut browser` and the `browser` op do. Every dialog is held
 * open for the extension's own debugger: the test's Playwright connection listens for dialogs
 * (and never answers one), so it does not dismiss them by itself. Sites are *.forum.test.
 * WALNUT_EXT_HEADED=1 runs it headed (under xvfb-run, 1920x1080) at a watchable pace, for a
 * recording: the agent window on the left, and on the right a log of each agent call and its answer.
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
holdApprovalsLock('file')

const HEADED = process.env.WALNUT_EXT_HEADED === '1'
let ctx: BrowserContext
let sw: Worker
let sites: http.Server
let port = 0
let base = ''
let device = ''
const site = (host: string, p: string) => `http://${host}:${port}${p}`
const beat = (ms = 1200) => (HEADED ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve())
/** The recording's log of the agent's calls (headed only). */
let logPage: Page | undefined
async function logLine(call: Record<string, unknown>, answer: Record<string, any>): Promise<void> {
  if (!logPage) return
  const { device: _d, ...c } = call
  const a = answer.dialog && typeof answer.dialog === 'object' ? { dialog: answer.dialog, ...(answer.closed === false ? { closed: false } : {}) }
    : answer.code ? { code: answer.code, error: String(answer.error ?? '').slice(0, 160) }
    : Object.fromEntries(Object.entries(answer).filter(([k]) => ['dialog', 'closed', 'stayed', 'left', 'url', 'text', 'answered'].includes(k)))
  await logPage.evaluate(({ c, a }) => {
    const li = document.createElement('li')
    li.innerHTML = `<b></b><pre></pre>`
    li.querySelector('b')!.textContent = `agent: ${JSON.stringify(c)}`
    li.querySelector('pre')!.textContent = `answer: ${JSON.stringify(a, null, 1)}`
    document.getElementById('log')!.append(li)
    li.scrollIntoView()
  }, { c, a }).catch(() => undefined)
}

/** One page with every kind of dialog, and a draft whose upload keeps it from being left. */
const SUBMIT = `<h1>New post</h1>
  <p><button id="alert" onclick="alert('Draft saved.'); out('alert: done')">Save draft</button>
  <button id="confirm" onclick="out('confirm: ' + confirm('Discard the old draft?'))">Discard old draft</button>
  <button id="prompt" onclick="out('prompt: ' + prompt('Title?', 'Untitled'))">Set title</button>
  <button id="upload" onclick="uploading = true; out('uploading video')">Upload video</button></p>
  <p id="out">ready</p>
  <script>
    let uploading = false
    function out(t) { document.getElementById('out').textContent = t }
    // The page asks "Leave site?" while its upload runs, as a forum's submit page does.
    addEventListener('beforeunload', (e) => { if (uploading) { e.preventDefault(); e.returnValue = '' } })
  </script>`
const DRAFT = '<h1>Reply</h1><label>Reply <textarea id="reply"></textarea></label>'
const LOG = '<style>li{margin:0 0 10px;list-style:none}b{color:#1d4ed8;font-size:14px}pre{margin:2px 0;font-size:13px;white-space:pre-wrap;color:#111}</style><h2>Agent calls (Walnut browser API)</h2><ul id="log" style="padding:0"></ul>'

function startSites(): Promise<void> {
  sites = http.createServer((req, res) => {
    const p = new URL(req.url ?? '/', 'http://x').pathname
    const body = p === '/submit' ? SUBMIT : p === '/draft' ? DRAFT : p === '/home' ? '<h1>Forum home</h1>' : p === '/log' ? LOG : ''
    res.writeHead(body ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' })
    res.end(body ? `<!doctype html><html><head><title>Forum</title></head><body style="font:18px sans-serif;margin:24px">${body}</body></html>` : 'not found')
  })
  return new Promise((resolve) => sites.listen(0, '127.0.0.1', () => { port = (sites.address() as AddressInfo).port; resolve() }))
}

async function act(page: Page, body: Record<string, unknown>): Promise<{ status: number; body: Record<string, any> }> {
  const r = await page.request.post(`${base}/api/v1/browser/act`, { data: { device, ...body }, headers: { 'x-walnut-caller-kind': 'automation' }, timeout: 80_000 })
  const out = { status: r.status(), body: await r.json() }
  if (body.action !== 'snapshot' && body.action !== 'tabs') await logLine(body, out.body)
  return out
}

/** Headed: the agent window on the left, the person's window with the log on the right. */
async function arrange(tab: number): Promise<void> {
  if (!HEADED) return
  logPage ??= await ctx.newPage()
  if (!logPage.url().endsWith('/log')) await logPage.goto(`http://127.0.0.1:${port}/log`)
  await sw.evaluate(async (id: number) => {
    const t = await chrome.tabs.get(id)
    await chrome.windows.update(t.windowId, { left: 0, top: 0, width: 1240, height: 1080 })
    for (const w of await chrome.windows.getAll()) if (w.id !== t.windowId) await chrome.windows.update(w.id!, { left: 1240, top: 0, width: 680, height: 1080 })
  }, tab)
}

async function press(page: Page, loc: Locator): Promise<void> {
  await expect(loc).toBeVisible()
  const b = (await loc.boundingBox())!
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2)
}

const refOf = (snapshot: string, re: RegExp): string => {
  const line = snapshot.split('\n').find((l) => re.test(l))
  expect(line, `no element ${re} in\n${snapshot}`).toBeTruthy()
  return /\[(e\d+)\]/.exec(line!)![1]
}
const tabAlive = (id: number) => sw.evaluate(async (t: number) => chrome.tabs.get(t).then(() => true, () => false), id)

test.beforeAll(async ({ browser }, info) => {
  test.setTimeout(360_000)
  base = String(info.project.use.baseURL ?? 'http://localhost:3457')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-ext-dialogs-'))
  execFileSync(bunRuntime(), ['scripts/build-extension.mjs', '--out', dir, '--no-zip'], { stdio: 'pipe' })
  await startSites()
  ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-ext-dialogs-profile-')), {
    channel: 'chromium',
    headless: !HEADED,
    viewport: HEADED ? { width: 1200, height: 900 } : { width: 1100, height: 760 },
    args: [`--disable-extensions-except=${path.join(dir, 'chrome')}`, `--load-extension=${path.join(dir, 'chrome')}`, '--host-resolver-rules=MAP *.forum.test 127.0.0.1',
      ...(HEADED ? ['--window-position=0,0', '--window-size=1000,900'] : [])],
  })
  // Seen, never answered: Playwright would dismiss a dialog nobody listens for.
  ctx.on('dialog', () => undefined)
  sw = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent('serviceworker')
  sw.on('console', (msg) => { if (msg.type() === 'error') console.log(`[background error] ${msg.text()}`) })
  const extId = new URL(sw.url()).host

  const api = await browser.newContext()
  const before = new Set(((await (await api.request.get(`${base}/api/v1/browser/status`)).json()).browsers as Array<{ device: string }>).map((b) => b.device))
  const p = await ctx.newPage()
  await p.goto(`chrome-extension://${extId}/popup.html`)
  await press(p, p.locator('#server'))
  await p.keyboard.press('ControlOrMeta+a')
  await p.keyboard.type(base)
  const opened = ctx.waitForEvent('page')
  await press(p, p.getByTestId('popup-connect'))
  const connect = await opened
  await connect.waitForLoadState('domcontentloaded')
  await expect(connect.getByRole('heading', { name: 'Connect this browser to Walnut?' })).toBeVisible({ timeout: 150_000 })
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
  // A page of the person's own, as in a real browser: their window stays when the agent's tabs close.
  await (ctx.pages()[0] ?? await ctx.newPage()).goto(`http://127.0.0.1:${port}/home`)
})

test.afterAll(async () => {
  await ctx?.close().catch(() => undefined)
  sites?.closeAllConnections()
  await new Promise<void>((r) => sites?.close(() => r()) ?? r())
})

test('an alert, a confirm, a prompt and a "Leave site?" each reach the agent, which answers each; the page is never stuck', async () => {
  test.setTimeout(240_000)
  const page = ctx.pages()[0]
  const o = await act(page, { action: 'open', url: site('www.forum.test', '/submit') })
  expect(o.status, JSON.stringify(o.body)).toBe(200)
  const tab = o.body.tab as number
  await arrange(tab)
  const read = async () => String((await act(page, { action: 'text', tab, selector: '#out' })).body.text ?? '')
  const click = async (re: RegExp) => {
    const s = (await act(page, { action: 'snapshot', tab })).body.snapshot as string
    const r = await act(page, { action: 'click', tab, ref: refOf(s, re) })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    return r.body
  }
  await beat()

  // An alert: the click's own answer carries it; OK answers it.
  expect(await click(/button "Save draft"/)).toMatchObject({ dialog: { type: 'alert', message: 'Draft saved.' } })
  await beat()
  // Nothing else reaches the page meanwhile, at once (no 30 s wait).
  expect((await act(page, { action: 'snapshot', tab })).body.code).toBe('dialog_open')
  expect((await act(page, { action: 'dialog', tab, read: true })).body).toMatchObject({ open: true, dialog: { type: 'alert' } })
  expect((await act(page, { action: 'dialog', tab, accept: true })).body).toMatchObject({ dialog: 'accepted' })
  await expect.poll(read).toContain('alert: done')

  // A confirm: Cancel.
  expect(await click(/button "Discard old draft"/)).toMatchObject({ dialog: { type: 'confirm', message: 'Discard the old draft?' } })
  await beat()
  expect((await act(page, { action: 'dialog', tab, accept: false })).body).toMatchObject({ dialog: 'dismissed' })
  await expect.poll(read).toContain('confirm: false')

  // A prompt: its default, then the agent's own text.
  expect(await click(/button "Set title"/)).toMatchObject({ dialog: { type: 'prompt', message: 'Title?', default_prompt: 'Untitled' } })
  await beat()
  expect((await act(page, { action: 'dialog', tab, accept: true, text: 'Launch notes' })).body).toMatchObject({ dialog: 'accepted', answered: { with: 'Launch notes' } })
  await expect.poll(read).toContain('prompt: Launch notes')

  // An upload under way: the page asks "Leave site?" on a close. The close answers at once with
  // it, the tab still the agent's (before 2026-11-17: a 504 after 30 s, and the tab read as the person's).
  await click(/button "Upload video"/)
  await expect.poll(read).toContain('uploading video')
  const t0 = Date.now()
  const shut = await act(page, { action: 'close', tab })
  expect(shut.status, JSON.stringify(shut.body)).toBe(200)
  expect(Date.now() - t0).toBeLessThan(15_000)
  expect(shut.body).toMatchObject({ closed: false, dialog: { type: 'beforeunload', message: 'Leave site? Changes you made may not be saved.' } })
  expect(String(shut.body.note)).toMatch(/dialog dismiss stays on the page/)
  await beat(2500)
  const tabs = (await act(page, { action: 'tabs' })).body.tabs as Array<{ id: number }>
  expect(tabs.map((t) => t.id)).toContain(tab)
  // Stay: the page is as it was, and answers again.
  expect((await act(page, { action: 'dialog', tab, accept: false })).body).toMatchObject({ dialog: 'dismissed', stayed: true })
  expect(await read()).toContain('uploading video')
  expect(await tabAlive(tab)).toBe(true)
  await beat()

  // A navigate meets it too; this time the agent decides to leave.
  const nav = await act(page, { action: 'navigate', tab, url: site('www.forum.test', '/home') })
  expect(nav.body).toMatchObject({ dialog: { type: 'beforeunload' } })
  await beat(2500)
  const went = await act(page, { action: 'dialog', tab, accept: true })
  expect(went.body).toMatchObject({ dialog: 'accepted', left: true })
  expect(String(went.body.url)).toContain('/home')
  expect((await act(page, { action: 'text', tab })).body.text).toContain('Forum home')
  await beat()
  expect((await act(page, { action: 'close', tab })).body).toMatchObject({ closed: true })
  expect(await tabAlive(tab)).toBe(false)
})

test('a reply typed and not sent stops a close until the agent discards it; a close with discard skips the "Leave site?"', async () => {
  test.setTimeout(180_000)
  const page = ctx.pages()[0]
  const o = await act(page, { action: 'open', url: site('www.forum.test', '/draft') })
  const tab = o.body.tab as number
  await arrange(tab)
  const s = (await act(page, { action: 'snapshot', tab })).body.snapshot as string
  expect((await act(page, { action: 'type', tab, ref: refOf(s, /textbox "Reply"/), text: 'Thanks, this fixed it for me' })).status).toBe(200)
  await beat()
  const refused = await act(page, { action: 'close', tab })
  expect(refused.body.code).toBe('unsaved_work')
  expect(String(refused.body.error ?? refused.body.message)).toMatch(/Reply \(28 characters typed\)/)
  expect(await tabAlive(tab)).toBe(true)
  await beat()
  expect((await act(page, { action: 'close', tab, discard: true })).body).toMatchObject({ closed: true })
  expect(await tabAlive(tab)).toBe(false)

  // An upload under way and discard: closed at once, its beforeunload never run.
  const two = (await act(page, { action: 'open', url: site('www.forum.test', '/submit') })).body.tab as number
  const s2 = (await act(page, { action: 'snapshot', tab: two })).body.snapshot as string
  await act(page, { action: 'click', tab: two, ref: refOf(s2, /button "Upload video"/) })
  expect((await act(page, { action: 'close', tab: two, discard: true })).body).toMatchObject({ closed: true })
  expect(await tabAlive(two)).toBe(false)
})
