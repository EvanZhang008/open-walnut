/**
 * A task's Browser view, with the real extension in Chromium (packages/browser-extension/src/
 * agent-view.ts, agent-window.ts; server routes/browser-view-v1.ts; web
 * components/sessions/SessionBrowserCard.tsx). 2026-11-07, the user: a session drove his browser
 * in a window he never saw and signed in to his bank again; "if this task is using browser ... we
 * also show a browser screen in the task, it can be a bit slow it is fine, but at least we know".
 *
 * A real task session (the mock CLI) opens a page in the person's browser through the `browser`
 * act route, as its agent would. Its session panel on Home then shows the Browser view by itself:
 * the tab's title, address and window (Walnut's agent window, not minimized), and a live picture
 * that follows the page. Hide folds it to one line and no picture is asked for meanwhile; Stop
 * ends the agent's use (the tab stays open) and the view says so. The open names the window and
 * tab, and lists the person's own tab on the same site. Every click is real mouse input.
 *
 * Sites are *.bank.test, mapped to this machine by Chromium's host resolver.
 */
import { expect, test, chromium, type BrowserContext, type Locator, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { bunRuntime } from '../../helpers/bun-runtime'
import { holdApprovalsLock } from './approvals-lock'
import { loadHome, seedColumns } from './draft-helpers'

test.describe.configure({ mode: 'serial' })
// The site setting (Allow any site) is the whole fixture server's: the approvals lock keeps the
// other agent specs, which switch it to Ask me first, apart from this file.
holdApprovalsLock('file')

const SHOTS = path.join(process.env.WALNUT_TASK_DIR ?? os.tmpdir(), 'shots', 'browser-view')

let ctx: BrowserContext
let extId = ''
let sites: http.Server
let port = 0
let base = ''
let device = ''
let taskId = ''
let sid = ''
let agentTab = 0
const site = (host: string, p: string) => `http://${host}:${port}${p}`

const PAGES: Record<string, { title: string; body: string }> = {
  '/home': { title: 'Account overview', body: '<h1 style="background:#1d6b4f;color:#fff;padding:40px">Account overview</h1><p>Checking 1,204.18</p>' },
  '/signin': { title: 'Sign in to Test Bank', body: '<h1 style="background:#7a3b12;color:#fff;padding:40px">Sign in</h1><label>Email <input id="e"></label>' },
  '/statement': { title: 'Statement for October', body: '<h1 style="background:#23408e;color:#fff;padding:60px">Statement for October</h1><table><tr><td>Rent</td><td>1,800.00</td></tr></table>' },
}

function startSites(): Promise<void> {
  sites = http.createServer((req, res) => {
    const page = PAGES[new URL(req.url ?? '/', 'http://x').pathname]
    res.writeHead(page ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' })
    res.end(page ? `<!doctype html><html><head><title>${page.title}</title></head><body style="margin:0;font:16px sans-serif">${page.body}</body></html>` : 'not found')
  })
  return new Promise((resolve) => sites.listen(0, '127.0.0.1', () => { port = (sites.address() as AddressInfo).port; resolve() }))
}

/** What the task's agent sends (the `browser` op's route), as its session. */
async function act(page: Page, body: Record<string, unknown>): Promise<{ status: number; body: Record<string, any> }> {
  const r = await page.request.post(`${base}/api/v1/browser/act`, { data: { device, ...body }, headers: { 'x-walnut-caller-sid': sid }, timeout: 80_000 })
  return { status: r.status(), body: await r.json() }
}

/** A real mouse click in the middle of the element. */
async function press(page: Page, loc: Locator): Promise<void> {
  await expect(loc).toBeVisible()
  const b = (await loc.boundingBox())!
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2)
}

async function startSession(page: Page, message: string, task: string): Promise<void> {
  await page.evaluate(async ({ message, task }) => {
    const ws = new WebSocket(`${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws`)
    await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error('ws failed')) })
    ws.send(JSON.stringify({ type: 'req', id: 'pw-browser-view-start', method: 'session:start', payload: { taskId: task, message, project: 'Walnut' } }))
    await new Promise<void>((resolve) => {
      ws.onmessage = (ev) => { try { const m = JSON.parse(ev.data as string); if (m.type === 'res' && m.id === 'pw-browser-view-start') resolve() } catch { /* not ours */ } }
      setTimeout(resolve, 5000)
    })
    ws.close()
  }, { message, task })
}

const card = (page: Page) => page.locator(`.main-page-session-column .session-panel[data-session-id="${sid}"] [data-testid="session-browser-card"]`)
const column = (page: Page) => page.locator('.main-page-session-column').filter({ has: page.locator(`.session-panel[data-session-id="${sid}"]`) })

test.beforeAll(async ({ browser }, info) => {
  test.setTimeout(240_000)
  base = String(info.project.use.baseURL ?? 'http://localhost:3457')
  fs.mkdirSync(SHOTS, { recursive: true })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-ext-'))
  execFileSync(bunRuntime(), ['scripts/build-extension.mjs', '--out', dir, '--no-zip'], { stdio: 'pipe' })
  await startSites()
  ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-ext-view-')), {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1100, height: 760 },
    args: [`--disable-extensions-except=${path.join(dir, 'chrome')}`, `--load-extension=${path.join(dir, 'chrome')}`, '--host-resolver-rules=MAP *.bank.test 127.0.0.1'],
  })
  let sw = ctx.serviceWorkers()[0]
  if (!sw) sw = await ctx.waitForEvent('serviceworker')
  sw.on('console', (m) => { if (m.type() === 'error') console.log(`[background error] ${m.text()}`) })
  extId = new URL(sw.url()).host

  // Connect this browser to Walnut and turn agents on, in the popup (as the person does).
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
  await expect(connect.getByRole('heading', { name: 'Connect this browser to Walnut?' })).toBeVisible({ timeout: 60_000 })
  await expect(connect.getByTestId('connect-extension-agents')).toBeChecked()
  await press(connect, connect.getByTestId('connect-extension-go'))
  await expect(connect.getByTestId('connect-extension-done')).toBeVisible({ timeout: 20_000 })
  await connect.close()
  await p.close()
  await expect.poll(async () => {
    const list = ((await (await api.request.get(`${base}/api/v1/browser/status`)).json()).browsers as Array<{ device: string }>).filter((b) => !before.has(b.device))
    device = list[0]?.device ?? ''
    return device
  }, { timeout: 20_000 }).not.toBe('')
  // Any site, as by default (another agent spec may have left Ask me first).
  expect((await api.request.put(`${base}/api/v1/browser/settings`, { data: { mode: 'any' } })).ok()).toBe(true)
  const created = await api.request.post(`${base}/api/tasks`, { data: { title: `Pay the electricity bill (${info.project.name})`, source: 'local', project: 'Walnut' } })
  const body = await created.json() as { task?: { id: string }; id?: string }
  taskId = body.task?.id ?? body.id ?? ''
  expect(taskId).not.toBe('')
  await api.close()
})

test.afterAll(async () => {
  await ctx?.close()
  await new Promise<void>((r) => sites?.close(() => r()) ?? r())
})

test('the Browser view shows itself when the task\'s session opens a page, follows it live, folds, and Stop ends the agent\'s use', async ({ page }) => {
  test.setTimeout(300_000)
  await page.setViewportSize({ width: 1280, height: 860 })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await startSession(page, 'hello from the browser view spec', taskId)
  await expect.poll(async () => {
    const r = await page.request.get(`/api/sessions/task/${taskId}`)
    const s = r.ok() ? ((await r.json()) as { sessions?: Array<{ claudeSessionId: string }> }).sessions ?? [] : []
    sid = s[0]?.claudeSessionId ?? ''
    return sid
  }, { timeout: 60_000 }).not.toBe('')
  const frames: string[] = []
  const t0 = Date.now()
  const answers: string[] = []
  page.on('request', (r) => { if (r.url().includes('/api/v1/browser/view/frame')) frames.push(r.url()) })
  page.on('response', (r) => {
    if (!r.url().includes('/api/v1/browser/view/frame')) return
    void r.json().then((b: { shown?: boolean; why?: string }) => answers.push(`${Date.now() - t0}ms ${r.status()} ${b.shown ? 'shown' : `none:${b.why ?? '?'}`}`)).catch(() => answers.push(`${Date.now() - t0}ms ${r.status()}`))
  })
  await seedColumns(page, [sid])
  await loadHome(page)
  await expect(column(page)).toBeVisible({ timeout: 30_000 })
  // No browser use yet: no view.
  await expect(card(page)).toHaveCount(0)

  // The person is signed in to the bank in a tab of their own.
  const mine = await ctx.newPage()
  await mine.goto(site('www.bank.test', '/home'))
  // The agent opens the bank's sign-in page: the answer names the window and tab, and the person's tab.
  const opened = await act(page, { action: 'open', url: site('login.bank.test', '/signin') })
  expect(opened.status, JSON.stringify(opened.body)).toBe(200)
  agentTab = opened.body.tab
  expect(opened.body.window).toBe('agent')
  expect(opened.body.where).toMatch(new RegExp(`^In Walnut's agent window \\(behind theirs, not minimized\\), tab ${agentTab} "Sign in to Test Bank"`))
  expect(opened.body.person_tabs).toEqual([expect.objectContaining({ title: 'Account overview' })])
  expect(opened.body.person_tabs_note).toMatch(/They already have bank\.test open in tab \d+ \("Account overview"/)
  // Walnut's agent window: a window of its own, not minimized.
  const sw = ctx.serviceWorkers()[0]
  const win = await sw.evaluate(async (tab: number) => {
    const t = await chrome.tabs.get(tab)
    const w = await chrome.windows.get(t.windowId)
    const { agentWindow } = await chrome.storage.session.get('agentWindow')
    return { state: w.state, agent: agentWindow === t.windowId }
  }, agentTab)
  expect(win.agent).toBe(true)
  expect(win.state).not.toBe('minimized')

  // The view shows itself: title, address, window, and a live picture.
  await expect(card(page)).toBeVisible({ timeout: 20_000 })
  await expect(card(page).getByTestId('session-browser-title')).toHaveText('Sign in to Test Bank')
  await expect(card(page).getByTestId('session-browser-url')).toHaveText(site('login.bank.test', '/signin'))
  await expect(card(page).getByTestId('session-browser-where')).toContainText("Walnut's agent window, behind yours (not minimized)")
  await expect(card(page).getByTestId('session-browser-where')).toContainText(`tab ${agentTab}`)
  const picture = card(page).getByTestId('session-browser-picture')
  await expect(picture).toBeVisible({ timeout: 30_000 })
  await expect(card(page).getByTestId('session-browser-foot')).toContainText('Live')
  const first = await picture.getAttribute('src')
  expect(first).toMatch(/^data:image\/jpeg;base64,/)
  await column(page).screenshot({ path: path.join(SHOTS, 'light.png') })

  // The agent moves on: the view follows (title and a new picture).
  expect((await act(page, { action: 'navigate', tab: agentTab, url: site('login.bank.test', '/statement') })).status).toBe(200)
  await expect(card(page).getByTestId('session-browser-title')).toHaveText('Statement for October', { timeout: 20_000 })
  await expect.poll(async () => (await picture.getAttribute('src')) !== first, { timeout: 20_000 }).toBe(true)

  // Larger draws the picture large; dark looks right too.
  await press(page, card(page).getByTestId('session-browser-size'))
  await expect(card(page)).toHaveClass(/session-browser-card--large/)
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
  await expect(card(page).getByTestId('session-browser-foot')).toContainText('Live', { timeout: 20_000 })
  await column(page).screenshot({ path: path.join(SHOTS, 'dark-large.png') })
  await press(page, card(page).getByTestId('session-browser-size'))
  await column(page).screenshot({ path: path.join(SHOTS, 'dark.png') })
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'))
  await page.emulateMedia({ colorScheme: 'light' })

  // Hide folds it to one line that still says the browser is in use; no picture is asked for meanwhile.
  await press(page, card(page).getByTestId('session-browser-hide'))
  const folded = column(page).getByTestId('session-browser-folded')
  await expect(folded).toContainText('Browser in use: Statement for October')
  await page.waitForTimeout(1500)
  const asked = frames.length
  await page.waitForTimeout(4000)
  expect(frames.length).toBe(asked)
  await column(page).screenshot({ path: path.join(SHOTS, 'folded.png') })
  // Show brings it back, live again.
  await press(page, folded.getByTestId('session-browser-show'))
  await expect(card(page).getByTestId('session-browser-foot')).toContainText('Live', { timeout: 20_000 })
  await expect.poll(() => frames.length, { timeout: 20_000, message: `frame answers: ${answers.join(', ')}` }).toBeGreaterThan(asked)

  // The stream (2026-11-08, the user: "very laggy like it doesn't show in real time"): pictures keep
  // coming while the view is on screen, each at the screen's own pixels, never on a 1.2 s timer.
  const shown0 = answers.filter((a) => a.includes('shown')).length
  await page.waitForTimeout(4000)
  const perSecond = (answers.filter((a) => a.includes('shown')).length - shown0) / 4
  console.log(`[browser view] pictures per second while watched: ${perSecond}; answers: ${answers.slice(-12).join(', ')}`)
  const size = await picture.evaluate((img: HTMLImageElement) => ({ w: img.naturalWidth, shown: img.getBoundingClientRect().width }))
  expect(size.w).toBeGreaterThanOrEqual(size.shown)

  // The task's tabs sit in one Chrome tab group named walnut-<task name>.
  const group = await sw.evaluate(async (tab: number) => {
    const t = await chrome.tabs.get(tab)
    return t.groupId !== undefined && t.groupId >= 0 ? (await chrome.tabGroups.get(t.groupId)).title : null
  }, agentTab)
  expect(group).toBe('walnut-pay-the-electricity-bill')

  // Take over: the tab is the person's, the agent waits; Hand back gives it to the agent again.
  await press(page, card(page).getByTestId('session-browser-takeover'))
  await expect(card(page).getByTestId('session-browser-hand')).toContainText('You have this tab in your browser', { timeout: 20_000 })
  expect((await act(page, { action: 'snapshot', tab: agentTab })).body.code).toBe('person_driving')
  await column(page).screenshot({ path: path.join(SHOTS, 'taken-over.png') })
  await press(page, card(page).getByTestId('session-browser-handback'))
  await expect(card(page).getByTestId('session-browser-hand')).toHaveCount(0, { timeout: 20_000 })
  expect((await act(page, { action: 'snapshot', tab: agentTab })).status).toBe(200)

  // The agent asks the person to sign in themselves: the view asks, Take over, Done, and the agent goes on.
  const ask = await act(page, { action: 'request_sign_in', tab: agentTab, text: 'the bank sends a code to your phone' })
  expect(ask.status, JSON.stringify(ask.body)).toBe(202)
  const hand = card(page).getByTestId('session-browser-hand')
  await expect(hand).toContainText('The agent asks you to sign in to bank.test yourself', { timeout: 20_000 })
  await column(page).screenshot({ path: path.join(SHOTS, 'sign-in-ask.png') })
  await press(page, hand.getByRole('button', { name: 'Take over to sign in' }))
  await expect(hand).toContainText('Sign in to bank.test there, then press Done', { timeout: 20_000 })
  const waiting = act(page, { action: 'request_sign_in', tab: agentTab, request: ask.body.request, wait_ms: 20_000 })
  await press(page, hand.getByRole('button', { name: 'Done' }))
  expect((await waiting).body).toMatchObject({ done: true, signIn: 'done' })
  await expect(hand).toHaveCount(0, { timeout: 20_000 })

  // Stop: the agent's use ends, the tab stays open, the view says so, the agent's next command is refused.
  await press(page, card(page).getByTestId('session-browser-stop'))
  const ended = column(page).getByTestId('session-browser-ended')
  await expect(ended).toContainText("You stopped the agent's use of the tab. It stays open.", { timeout: 20_000 })
  await column(page).screenshot({ path: path.join(SHOTS, 'stopped.png') })
  expect(await sw.evaluate(async (tab: number) => !!(await chrome.tabs.get(tab).catch(() => null)), agentTab)).toBe(true)
  expect((await act(page, { action: 'snapshot', tab: agentTab })).body.code).toBe('not_your_tab')
  // Dismissed, it is gone.
  await press(page, ended.getByRole('button', { name: 'Dismiss' }))
  await expect(ended).toHaveCount(0)
  await mine.close()
})
