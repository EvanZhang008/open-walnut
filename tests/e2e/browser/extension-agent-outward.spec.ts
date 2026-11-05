/**
 * Agents in the person's browser, through the real extension in Chromium:
 *  - a tab the person hands over from the side panel lets agents act there only: the browser-wide
 *    switch stays off, an agent cannot open or take another tab, and giving the tab back ends it;
 *  - a click, Enter or other key that places an order, sends a message or presses Enter in a chat
 *    box waits for the person's yes through Walnut's approvals (also with "Allow any site"), and
 *    runs only once they approved with a proof (a plain Approve from this machine is refused, and
 *    the step still waits); a no stops it; Add to cart, search and sign in never ask;
 *  - keys are judged where the focus is: Enter or Space on a focused "Place order" button,
 *    Control+Enter in a message box, Enter in a chat box with no form, typing into a button with
 *    submit; real input's own check (locate) holds Meta+Enter and typed text with a newline;
 *  - a window a page opens from an agent tab (window.open) is the agent's tab, named in the click's answer;
 *  - a screenshot can be a PNG.
 * Sites are *.example.test, mapped to this machine by Chromium's host resolver.
 */
import { expect, test, chromium, type BrowserContext, type Page, type Worker } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { bunRuntime } from '../../helpers/bun-runtime'
import { holdApprovalsLock } from './approvals-lock'

test.describe.configure({ mode: 'serial' })
// It makes and answers approvals on the shared fixture server, where another file clears them.
holdApprovalsLock('file')

let ctx: BrowserContext
let extId = ''
let sites: http.Server
let port = 0
let base = ''
let tab = 0
const site = (host: string, p: string) => `http://${host}:${port}${p}`
const shots = process.env.WALNUT_TASK_DIR ? path.join(process.env.WALNUT_TASK_DIR, 'review', 'fix-shots', 'c') : fs.mkdtempSync(path.join(os.tmpdir(), 'agent-outward-'))

const PAGES: Record<string, () => string> = {
  '/mine': () => `<h1>The person's own page</h1>`,
  '/checkout': () => `<h1>Checkout</h1>
    <button type="button" id="add" onclick="document.getElementById('cart').textContent = 'In cart: 1'">Add to cart</button><p id="cart"></p>
    <form id="s" role="search" onsubmit="event.preventDefault(); document.getElementById('found').textContent = 'Results for ' + this.q.value"><input name="q" aria-label="Search"><button>Search</button></form><p id="found"></p>
    <form id="f" onsubmit="event.preventDefault(); document.getElementById('out').textContent = 'Order placed for ' + this.name.value">
      <label>Full name <input name="name" autocomplete="name"></label>
      <label>Card number <input name="cardnumber" autocomplete="cc-number"></label>
      <label>Security code <input name="cvc" autocomplete="cc-csc"></label>
      <button>Place order</button>
    </form><p>Order total: $42.10</p><p id="out"></p>`,
  '/feedback': () => `<h1>News</h1>
    <form onsubmit="event.preventDefault(); document.getElementById('sent').textContent = 'Thanks: ' + this.fb.value"><label>Your feedback <textarea name="fb"></textarea></label><button>Send feedback</button></form><p id="sent"></p>
    <label>Chat <textarea id="chat" onkeydown="if (event.key === 'Enter') { event.preventDefault(); document.getElementById('said').textContent = 'Said: ' + this.value }"></textarea></label><p id="said"></p>`,
  '/popup': () => `<h1>Help</h1><button id="help" onclick="window.open('/help-window', 'help', 'width=480,height=400')">Open the help window</button>`,
  '/help-window': () => `<h1>Help window</h1><p>Orders ship in 2 days.</p>`,
  '/frame': () => `<h1>Account</h1><iframe src="/frame-inner" title="Sign in" width="420" height="160"></iframe>`,
  '/frame-inner': () => `<button id="in" onclick="setTimeout(() => { document.getElementById('st').textContent = 'You are signed in.' }, 600)">Sign in here</button><p id="st"></p>`,
  '/keys': () => `<h1>Keys</h1>
    <button type="button" id="place" onkeydown="if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); document.getElementById('out').textContent = 'Order placed by key' }">Place order</button>
    <button type="button" id="add" onkeydown="if (event.key === ' ') document.getElementById('cart').textContent = 'In cart: 1'">Add to cart</button>
    <p id="out"></p><p id="cart"></p>
    <label>Message <input id="msg" type="text" onkeydown="if (event.key === 'Enter') { event.preventDefault(); document.getElementById('said').textContent = 'Said: ' + this.value }"></label><p id="said"></p>
    <label>Notes <textarea id="notes" onkeydown="if (event.key.endsWith('Enter') && event.key !== 'Enter') document.getElementById('noted').textContent = 'Sent: ' + this.value"></textarea></label><p id="noted"></p>
    <label>Find <input id="find" type="text" aria-label="Search the shop" onkeydown="if (event.key === 'Enter') document.getElementById('found').textContent = 'Results for ' + this.value"></label><p id="found"></p>`,
}

function startSites(): Promise<void> {
  sites = http.createServer((req, res) => {
    const page = PAGES[new URL(req.url ?? '/', 'http://x').pathname]
    res.writeHead(page ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' })
    res.end(page ? `<!doctype html><html><head><title>Test shop</title></head><body>${page()}</body></html>` : 'not found')
  })
  return new Promise((resolve) => sites.listen(0, '127.0.0.1', () => { port = (sites.address() as AddressInfo).port; resolve() }))
}

async function act(page: Page, body: Record<string, unknown>): Promise<{ status: number; body: Record<string, any> }> {
  const r = await page.request.post(`${base}/api/v1/browser/act`, { data: body, headers: { 'x-walnut-caller-kind': 'automation' }, timeout: 80_000 })
  return { status: r.status(), body: await r.json() }
}
const MASTER = 'Correct Horse Battery Staple 42'
/** The person's proof in this window: Passwords unlocked (set up first on a fresh server). */
async function vaultSession(page: Page): Promise<string> {
  const st = await (await page.request.get(`${base}/api/v1/vault/status`)).json()
  const r = st.setUp
    ? await page.request.post(`${base}/api/v1/vault/unlock`, { data: { password: MASTER, kdfSalt: st.kdf?.salt } })
    : await page.request.post(`${base}/api/v1/vault/setup`, { data: { password: MASTER } })
  expect(r.ok(), await r.text()).toBe(true)
  return (await r.json()).session.token
}
/** The person answers: an Approve carries their proof (an unlocked Passwords session); a no needs none. */
async function answer(page: Page, id: string, decision: 'approve' | 'deny'): Promise<void> {
  const headers = decision === 'approve' ? { 'x-walnut-vault-session': await vaultSession(page) } : undefined
  const r = await page.request.post(`${base}/api/v1/approvals/${id}/answer`, { data: { decision }, ...(headers ? { headers } : {}) })
  expect(r.ok(), await r.text()).toBe(true)
}
const refOf = (snapshot: string, re: RegExp): string => {
  const line = snapshot.split('\n').find((l) => re.test(l))
  expect(line, `no element ${re} in\n${snapshot}`).toBeTruthy()
  return /\[((?:f\d+:)?e\d+)\]/.exec(line!)![1]
}
const sw = (): Worker => ctx.serviceWorkers()[0]
const pageAt = (p: string) => ctx.pages().find((x) => x.url().startsWith(site('shop.example.test', p)))
const status = async (page: Page) => (await (await page.request.get(`${base}/api/v1/browser/status`)).json()) as { browsers: Array<{ caps: string[] }> }

test.beforeAll(async ({}, info) => {
  base = String(info.project.use.baseURL ?? 'http://localhost:3457')
  fs.mkdirSync(shots, { recursive: true })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-ext-c-'))
  execFileSync(bunRuntime(), ['scripts/build-extension.mjs', '--out', dir, '--no-zip'], { stdio: 'pipe' })
  await startSites()
  ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-ext-c-profile-')), {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1100, height: 760 },
    args: [`--disable-extensions-except=${path.join(dir, 'chrome')}`, `--load-extension=${path.join(dir, 'chrome')}`, '--host-resolver-rules=MAP *.example.test 127.0.0.1'],
  })
  let w = ctx.serviceWorkers()[0]
  if (!w) w = await ctx.waitForEvent('serviceworker')
  extId = new URL(w.url()).host
})

test.afterAll(async () => {
  // Give back what this spec's agent opened, so the next spec on this server starts with no tab of its.
  // and turn agents off here, so Walnut stops counting this browser (the next spec's browser takes the commands).
  const page = ctx?.pages()[0]
  if (page) {
    const mine = ((await act(page, { action: 'tabs' }).catch(() => ({ body: {} as Record<string, any> }))).body.tabs ?? []) as Array<{ id: number }>
    for (const t of mine) await act(page, { action: 'close', tab: t.id }).catch(() => undefined)
    const p = await ctx.newPage()
    await p.goto(`chrome-extension://${extId}/popup.html`).catch(() => undefined)
    await p.getByRole('button', { name: 'Settings' }).click().catch(() => undefined)
    if (await p.getByTestId('popup-agents').isChecked().catch(() => false)) await p.getByText('Let Walnut agents use this browser').click().catch(() => undefined)
    await expect.poll(async () => (await status(page)).browsers.length, { timeout: 10_000 }).toBe(0).catch(() => undefined)
  }
  await ctx?.close()
  await new Promise<void>((r) => sites?.close(() => r()) ?? r())
})

test('connect the extension (agents stay off)', async () => {
  test.setTimeout(120_000)
  const p = await ctx.newPage()
  await p.goto(`chrome-extension://${extId}/popup.html`)
  await p.locator('#server').fill(base)
  const opened = ctx.waitForEvent('page')
  await p.getByTestId('popup-connect').click()
  const connect = await opened
  await expect(connect.getByRole('heading', { name: 'Connect this browser to Walnut?' })).toBeVisible({ timeout: 60_000 })
  await connect.getByTestId('connect-extension-go').click()
  await expect(connect.getByTestId('connect-extension-done')).toBeVisible({ timeout: 20_000 })
  await connect.close()
  await p.close()
  expect((await status(ctx.pages()[0])).browsers).toHaveLength(0)
  // "Allow any site" (the default; another spec on this server may have picked "Ask me first"):
  // the steps below wait for the person all the same.
  expect((await (await ctx.pages()[0].request.put(`${base}/api/v1/browser/settings`, { data: { mode: 'any' } })).json()).mode).toBe('any')
})

test('a tab handed over from the side panel lets agents in that tab only; the browser-wide switch stays off', async () => {
  test.setTimeout(90_000)
  const mine = ctx.pages()[0]
  await mine.goto(site('shop.example.test', '/mine'))
  const made = await mine.request.post(`${base}/api/v1/tasks`, { data: { title: 'Ask about the shop page' } })
  expect(made.ok(), await made.text()).toBe(true)
  const taskId = ((await made.json()) as { task: { id: string } }).task.id
  const mineTab = await sw().evaluate(async () => (await chrome.tabs.query({ url: 'http://shop.example.test/*' }))[0]?.id ?? 0)
  // The side panel's own page sends the hand-over, as its "Let Walnut act in this tab" does.
  const panel = await ctx.newPage()
  await panel.goto(`chrome-extension://${extId}/sidepanel.html`)
  const adopted = await panel.evaluate(({ t, task }) => chrome.runtime.sendMessage({ type: 'panel-adopt', tabId: t, task }), { t: mineTab, task: taskId })
  expect(adopted).toMatchObject({ ok: true })
  expect((await sw().evaluate(() => chrome.storage.local.get('agentControl'))).agentControl).not.toBe(true)
  await expect.poll(async () => (await status(mine)).browsers.map((b) => b.caps), { timeout: 20_000 }).toEqual([expect.arrayContaining(['handed-tabs-only'])])
  // No new tab and no other tab of the person's.
  const open = await act(mine, { action: 'open', url: site('shop.example.test', '/checkout') })
  expect(open.status, JSON.stringify(open.body)).toBe(409)
  expect(open.body.code).toBe('agents_tab_only')
  const all = await act(mine, { action: 'tabs', all: true })
  expect(all.body.code).toBe('agents_tab_only')
  // Giving the tab back ends it: Walnut hears the browser is out.
  await panel.evaluate((t) => chrome.runtime.sendMessage({ type: 'panel-release', tabId: t }), mineTab)
  await expect.poll(async () => (await status(mine)).browsers.length, { timeout: 15_000 }).toBe(0)
  expect((await sw().evaluate(() => chrome.storage.local.get('agentControl'))).agentControl).not.toBe(true)
  await panel.close()
})

test('turn agents on in the popup', async () => {
  const p = await ctx.newPage()
  await p.goto(`chrome-extension://${extId}/popup.html`)
  await p.getByRole('button', { name: 'Settings' }).click()
  await p.getByText('Let Walnut agents use this browser').click()
  await expect(p.getByTestId('popup-agents')).toBeChecked()
  await expect.poll(async () => (await status(p)).browsers.length, { timeout: 15_000 }).toBe(1)
  await p.close()
  const page = ctx.pages()[0]
  const r = await act(page, { action: 'open', url: site('shop.example.test', '/checkout') })
  expect(r.status, JSON.stringify(r.body)).toBe(200)
  tab = r.body.tab
})

test('Add to cart and search never ask', async () => {
  const page = ctx.pages()[0]
  const s = (await act(page, { action: 'snapshot', tab })).body.snapshot as string
  expect((await act(page, { action: 'click', tab, ref: refOf(s, /button "Add to cart"/) })).status).toBe(200)
  await expect(pageAt('/checkout')!.locator('#cart')).toHaveText('In cart: 1')
  const typed = await act(page, { action: 'type', tab, ref: refOf(s, /textbox "Search"/), text: 'rye', submit: true })
  expect(typed.status, JSON.stringify(typed.body)).toBe(200)
  await expect(pageAt('/checkout')!.locator('#found')).toHaveText('Results for rye')
})

test('Place order waits for the person, and runs only after they approve', async () => {
  test.setTimeout(90_000)
  const page = ctx.pages()[0]
  const s = (await act(page, { action: 'snapshot', tab })).body.snapshot as string
  const filled = await act(page, { action: 'fill_form', tab, fields: [{ label: 'Full name', value: 'Test Person' }, { label: 'Card number', value: '4111111111111111' }, { label: 'Security code', value: '123' }] })
  expect(filled.status, JSON.stringify(filled.body)).toBe(200)
  const place = refOf(s, /button "Place order"/)
  const ask = await act(page, { action: 'click', tab, ref: place })
  expect(ask.status, JSON.stringify(ask.body)).toBe(202)
  expect(ask.body).toMatchObject({ status: 'needs_ok', code: 'outward_needs_ok', kind: 'buy', what: 'click button "Place order"', waitsMinutes: 10 })
  expect(ask.body.error).toContain('Waiting for the person to approve: click button "Place order" on shop.example.test')
  expect(ask.body.error).toContain('10 minutes')
  const shop = pageAt('/checkout')!
  // Nothing was sent: the form waits.
  await expect(shop.locator('#out')).toHaveText('')
  // The approval is Walnut's own, for the person to answer, and says exactly what in plain words:
  // who asks (no task here: "a Walnut agent"), the button, the site, the total the page shows.
  const apr = (await (await page.request.get(`${base}/api/v1/approvals/${ask.body.request}`)).json()).approval ?? {}
  expect(apr.what).toBe(`Let a Walnut agent click button "Place order" on shop.example.test:${port} ($42.10)?`)
  expect(apr.detail).toContain('Order total on the page: $42.10')
  expect(apr.requester).toMatchObject({ local: true })
  // Asked again before the answer: the same ask, still waiting, still nothing sent.
  const again = await act(page, { action: 'click', tab, ref: place, request: ask.body.request })
  expect(again.status).toBe(202)
  expect(again.body.request).toBe(ask.body.request)
  await expect(shop.locator('#out')).toHaveText('')
  // The ask names this step only: another step with it is refused.
  const other = await act(page, { action: 'click', tab, ref: refOf(s, /button "Add to cart"/), request: ask.body.request })
  expect(other.body.code).toBe('no_such_request')
  // A plain Approve from this machine, with no signature and no Passwords session, is what any
  // local process (the asking agent too) could send: refused, and the step still waits.
  const forged = await page.request.post(`${base}/api/v1/approvals/${ask.body.request}/answer`, { data: { decision: 'approve' } })
  expect(forged.status(), await forged.text()).toBe(403)
  expect((await forged.json()).code).toBe('proof_needed')
  const still = await act(page, { action: 'click', tab, ref: place, request: ask.body.request })
  expect(still.status, JSON.stringify(still.body)).toBe(202)
  await expect(shop.locator('#out')).toHaveText('')
  // The person approves on Walnut's card. Passwords is locked in that window, so the card offers
  // "Unlock to approve" in place: the master password, then Approve.
  // Passwords set up (a fresh fixture server has none); that window holds no unlock of its own.
  await vaultSession(page)
  const con = await ctx.newPage()
  await con.goto(`${base}/`)
  const card = con.locator(`[data-testid="approval-card"][data-approval-id="${ask.body.request}"]`)
  await expect(card).toBeVisible({ timeout: 30_000 })
  await expect(card.locator('.approval-who')).toContainText('on this computer')
  await expect(card.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0)
  await card.getByTestId('approval-unlock-to-approve').click()
  await card.getByLabel('Master password').fill(MASTER)
  await card.getByRole('button', { name: 'Unlock', exact: true }).click()
  await expect.poll(async () => (await card.getByRole('button', { name: 'Approve', exact: true }).count()) || await card.innerText(), { timeout: 20_000 }).toBe(1)
  await card.screenshot({ path: path.join(shots, 'card-unlocked-approve.png') })
  await card.getByRole('button', { name: 'Approve', exact: true }).click()
  await expect.poll(async () => ((await (await page.request.get(`${base}/api/v1/approvals/${ask.body.request}`)).json()).approval ?? {}).status, { timeout: 15_000 }).toBe('approved')
  await con.close()
  const done = await act(page, { action: 'click', tab, ref: place, request: ask.body.request, wait_ms: 5000 })
  expect(done.status, JSON.stringify(done.body)).toBe(200)
  await expect(shop.locator('#out')).toHaveText('Order placed for Test Person')
  await shop.screenshot({ path: path.join(shots, 'place-order-after-approval.png') })
  // One use: the approval is spent.
  expect((await act(page, { action: 'click', tab, ref: place, request: ask.body.request })).body.code).toBe('no_such_request')
})

test('sending feedback waits too; a no stops it; Enter in a chat box with a message asks', async () => {
  const page = ctx.pages()[0]
  expect((await act(page, { action: 'navigate', tab, url: site('shop.example.test', '/feedback') })).status).toBe(200)
  const s = (await act(page, { action: 'snapshot', tab })).body.snapshot as string
  // type --submit into the message box: held before a single key, so the box stays empty.
  const sub = await act(page, { action: 'type', tab, ref: refOf(s, /textbox "Your feedback"/), text: 'Great update', submit: true })
  expect(sub.status, JSON.stringify(sub.body)).toBe(202)
  expect(sub.body.kind).toBe('send')
  // The card shows the message it would send.
  const subApr = (await (await page.request.get(`${base}/api/v1/approvals/${sub.body.request}`)).json()).approval ?? {}
  expect(subApr.what).toContain(': "Great update"?')
  expect(subApr.detail).toContain('Message it sends: Great update')
  const news = pageAt('/feedback')!
  await expect(news.locator('textarea[name=fb]')).toHaveValue('')
  expect((await act(page, { action: 'type', tab, ref: refOf(s, /textbox "Your feedback"/), text: 'Great update' })).status).toBe(200)
  const ask = await act(page, { action: 'click', tab, ref: refOf(s, /button "Send feedback"/) })
  expect(ask.status).toBe(202)
  await answer(page, ask.body.request, 'deny')
  const no = await act(page, { action: 'click', tab, ref: refOf(s, /button "Send feedback"/), request: ask.body.request })
  expect(no.status).toBe(403)
  expect(no.body.code).toBe('denied')
  await expect(news.locator('#sent')).toHaveText('')
  expect((await act(page, { action: 'type', tab, ref: refOf(s, /textbox "Chat"/), text: 'hello there' })).status).toBe(200)
  const enter = await act(page, { action: 'press', tab, key: 'Enter' })
  expect(enter.status, JSON.stringify(enter.body)).toBe(202)
  expect(enter.body.what).toContain('press Enter in textbox "Chat"')
  await expect(news.locator('#said')).toHaveText('')
})

test('keys are judged where the focus is: Enter or Space on a focused Place order, Control+Enter, a chat box with no form', async () => {
  const page = ctx.pages()[0]
  expect((await act(page, { action: 'navigate', tab, url: site('shop.example.test', '/keys') })).status).toBe(200)
  const s = (await act(page, { action: 'snapshot', tab })).body.snapshot as string
  const keys = pageAt('/keys')!
  // Enter, then Space, on the focused button: each works it as a click would.
  await keys.locator('#place').focus()
  for (const key of ['Enter', ' ']) {
    const r = await act(page, { action: 'press', tab, key })
    expect(r.status, `${JSON.stringify(key)}: ${JSON.stringify(r.body)}`).toBe(202)
    expect(r.body).toMatchObject({ kind: 'buy' })
    expect(r.body.what).toContain('"Place order"')
  }
  // Typing into the button with submit is Enter on it.
  const typed = await act(page, { action: 'type', tab, ref: refOf(s, /button "Place order"/), text: '', submit: true })
  expect(typed.status, JSON.stringify(typed.body)).toBe(202)
  await expect(keys.locator('#out')).toHaveText('')
  // Space on Add to cart and Tab never ask.
  await keys.locator('#add').focus()
  expect((await act(page, { action: 'press', tab, key: ' ' })).status).toBe(200)
  await expect(keys.locator('#cart')).toHaveText('In cart: 1')
  expect((await act(page, { action: 'press', tab, key: 'Tab' })).status).toBe(200)
  // A chat box with no form: Enter with a message asks.
  expect((await act(page, { action: 'type', tab, ref: refOf(s, /textbox "Message"/), text: 'hello there' })).status).toBe(200)
  const chat = await act(page, { action: 'press', tab, key: 'Enter' })
  expect(chat.status, JSON.stringify(chat.body)).toBe(202)
  expect(chat.body.kind).toBe('send')
  await expect(keys.locator('#said')).toHaveText('')
  // Control+Enter in a message box asks too.
  expect((await act(page, { action: 'type', tab, ref: refOf(s, /textbox "Notes"/), text: 'see you' })).status).toBe(200)
  const ctrl = await act(page, { action: 'press', tab, key: 'Control+Enter' })
  expect(ctrl.status, JSON.stringify(ctrl.body)).toBe(202)
  expect(ctrl.body.what).toContain('press Control+Enter in textbox "Notes"')
  await expect(keys.locator('#noted')).toHaveText('')
  // A search box with no form is no chat box: Enter there never asks.
  expect((await act(page, { action: 'type', tab, ref: refOf(s, /textbox "Search the shop"/), text: 'rye' })).status).toBe(200)
  expect((await act(page, { action: 'press', tab, key: 'Enter' })).status).toBe(200)
  await expect(keys.locator('#found')).toHaveText('Results for rye')
  await keys.screenshot({ path: path.join(shots, 'keys-held.png') })
})

test('real input asks the page the same before it acts: Meta+Enter, and typed text with a newline', async () => {
  const page = ctx.pages()[0]
  const s = (await act(page, { action: 'snapshot', tab })).body.snapshot as string
  const keys = pageAt('/keys')!
  const allow = { any: true, sites: [] as string[] }
  // The background's own check before the debugger acts (agent-trusted.ts locate): the page answers hold.
  const locate = (args: Record<string, unknown>) => sw().evaluate(({ t, args, allow }) =>
    chrome.tabs.sendMessage(t, { type: 'agent', op: 'locate', args, allow }, { frameId: 0 }), { t: tab, args, allow }) as Promise<{ ok: boolean; result?: Record<string, any> }>
  await keys.locator('#notes').focus()
  const meta = await locate({ active: true, outward: 'key', key: 'Meta+Enter' })
  expect(meta.result?.hold, JSON.stringify(meta)).toMatchObject({ kind: 'send' })
  await keys.locator('#place').focus()
  expect((await locate({ active: true, outward: 'key', key: ' ' })).result?.hold).toMatchObject({ kind: 'buy' })
  // Text with a newline into the empty chat box (real typing presses Enter for it): held before the focus moves.
  await keys.locator('#msg').fill('')
  await keys.locator('#find').focus()
  const nl = await locate({ ref: refOf(s, /textbox "Message"/), focus: true, outward: 'enter', typing: 'hi\nthere' })
  expect(nl.result?.hold, JSON.stringify(nl)).toMatchObject({ kind: 'send' })
  expect(await keys.evaluate(() => document.activeElement?.id)).toBe('find')
  // The same text with no newline is only typing: the point comes back.
  const plain = await locate({ ref: refOf(s, /textbox "Message"/), focus: true })
  expect(plain.result, JSON.stringify(plain)).toMatchObject({ x: expect.any(Number), y: expect.any(Number) })
})

test('refs are the page\'s own: form_values, snapshot and fill_form name a field the same way, also after a reload', async () => {
  const page = ctx.pages()[0]
  expect((await act(page, { action: 'navigate', tab, url: site('shop.example.test', '/checkout') })).status).toBe(200)
  // form_values first on a fresh page, then the snapshot: one ref for Full name.
  const fields = (await act(page, { action: 'form_values', tab })).body.fields as Array<{ ref: string; label: string }>
  const nameRef = fields.find((f) => /Full name/.test(f.label))!.ref
  const s1 = (await act(page, { action: 'snapshot', tab })).body.snapshot as string
  expect(refOf(s1, /textbox "Full name"/)).toBe(nameRef)
  // fill_form, then a ref from the snapshot before it still works.
  const filled = await act(page, { action: 'fill_form', tab, fields: [{ ref: nameRef, value: 'Ref Person' }] })
  expect(filled.status, JSON.stringify(filled.body)).toBe(200)
  const add = await act(page, { action: 'click', tab, ref: refOf(s1, /button "Add to cart"/) })
  expect(add.status, JSON.stringify(add.body)).toBe(200)
  // The same page loaded again: the same refs, whichever action reads it first.
  expect((await act(page, { action: 'navigate', tab, url: site('shop.example.test', '/checkout') })).status).toBe(200)
  const s2 = (await act(page, { action: 'snapshot', tab })).body.snapshot as string
  expect(refOf(s2, /textbox "Full name"/)).toBe(nameRef)
  expect(refOf(s2, /button "Add to cart"/)).toBe(refOf(s1, /button "Add to cart"/))
})

test('wait for text looks inside the page\'s frames too', async () => {
  test.setTimeout(90_000)
  const page = ctx.pages()[0]
  expect((await act(page, { action: 'navigate', tab, url: site('shop.example.test', '/frame') })).status).toBe(200)
  const s = (await act(page, { action: 'snapshot', tab })).body.snapshot as string
  const button = refOf(s, /button "Sign in here"/)
  expect(button).toMatch(/^f\d+:e\d+$/)
  expect((await act(page, { action: 'click', tab, ref: button })).status).toBe(200)
  const waited = await act(page, { action: 'wait', tab, text: 'You are signed in' })
  expect(waited.status, JSON.stringify(waited.body)).toBe(200)
  expect(waited.body.waited).toMatch(/in frame f\d+/)
})

test('a window the page opens from the agent tab is the agent\'s, named in the click\'s answer', async () => {
  const page = ctx.pages()[0]
  expect((await act(page, { action: 'navigate', tab, url: site('shop.example.test', '/popup') })).status).toBe(200)
  const s = (await act(page, { action: 'snapshot', tab })).body.snapshot as string
  const r = await act(page, { action: 'click', tab, ref: refOf(s, /button "Open the help window"/) })
  expect(r.status, JSON.stringify(r.body)).toBe(200)
  expect(r.body.opened).toMatchObject({ url: site('shop.example.test', '/help-window') })
  const child = r.body.opened.tab as number
  const mine = (await act(page, { action: 'tabs' })).body.tabs.map((t: { id: number }) => t.id)
  expect(mine).toContain(child)
  const inChild = await act(page, { action: 'snapshot', tab: child })
  expect(inChild.status, JSON.stringify(inChild.body)).toBe(200)
  expect(inChild.body.snapshot).toContain('Orders ship in 2 days.')
  const all = (await act(page, { action: 'tabs', all: true })).body.tabs as Array<{ id: number; owner: string }>
  expect(all.find((t) => t.id === child)?.owner).toBe('mine')
  expect((await act(page, { action: 'close', tab: child })).body).toMatchObject({ closed: true })
})

test('a screenshot can be a PNG', async () => {
  const page = ctx.pages()[0]
  const png = await act(page, { action: 'screenshot', tab, inline: true, format: 'png' })
  expect(png.status, JSON.stringify(png.body).slice(0, 300)).toBe(200)
  expect(String(png.body.image)).toMatch(/^data:image\/png;base64,/)
  expect([...Buffer.from(String(png.body.image).split(',')[1], 'base64').subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47])
  const jpeg = await act(page, { action: 'screenshot', tab, inline: true })
  expect(String(jpeg.body.image)).toMatch(/^data:image\/jpeg;base64,/)
})
