/**
 * The Browser replay, end to end with the real extension in Chromium (packages/browser-extension/
 * src/agent-replay.ts; server core/browser-control/replay-store.ts and routes/browser-view-v1.ts;
 * web components/sessions/SessionBrowserReplay.tsx). 2026-11-14, the user: "can we make sure the
 * browser action screenshot or video is saved for 7 days (configurable), and can be played back".
 *
 * A real task session's agent opens the bank's sign-in page, types an email, clicks Continue and
 * goes to the statement, through the `browser` act route, as its agent would. Each step's picture
 * is taken by the extension after its answer and kept by Walnut. In the task's Browser view,
 * Replay plays the run back: one stop per step on a scrubber (arrow keys), Play / Pause, a list of
 * steps that says what each did (never the typed text), and Live goes back. After Stop the pill
 * turns into a grey Replay that opens it directly. Settings, Browser extension, sets the days kept:
 * Off deletes every recorded step. Every click and key is real input.
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

const SHOTS = path.join(process.env.WALNUT_TASK_DIR ?? os.tmpdir(), 'shots', 'browser-replay')

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
  '/signin': { title: 'Sign in to Test Bank', body: '<h1 style="background:#7a3b12;color:#fff;padding:40px">Sign in</h1><form action="/home"><label>Email <input id="e" name="email"></label> <button type="submit">Continue</button></form>' },
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
    ws.send(JSON.stringify({ type: 'req', id: 'pw-browser-replay-start', method: 'session:start', payload: { taskId: task, message, project: 'Walnut' } }))
    await new Promise<void>((resolve) => {
      ws.onmessage = (ev) => { try { const m = JSON.parse(ev.data as string); if (m.type === 'res' && m.id === 'pw-browser-replay-start') resolve() } catch { /* not ours */ } }
      setTimeout(resolve, 5000)
    })
    ws.close()
  }, { message, task })
}

// The view lives in the header pill's popover (2026-11-09, the user: "we only show as a small pill
// tehere people can click and see detail"); nothing of it is in the chat.
const chip = (page: Page) => page.locator(`.main-page-session-column .session-panel[data-session-id="${sid}"] [data-testid="session-browser-chip"]`)
const popover = (page: Page) => page.getByTestId('session-browser-popover')
const card = (page: Page) => popover(page).getByTestId('session-browser-card')
const column = (page: Page) => page.locator('.main-page-session-column').filter({ has: page.locator(`.session-panel[data-session-id="${sid}"]`) })

test.beforeAll(async ({ browser }, info) => {
  test.setTimeout(240_000)
  base = String(info.project.use.baseURL ?? 'http://localhost:3457')
  fs.mkdirSync(SHOTS, { recursive: true })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-ext-'))
  execFileSync(bunRuntime(), ['scripts/build-extension.mjs', '--out', dir, '--no-zip'], { stdio: 'pipe' })
  await startSites()
  ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-ext-replay-')), {
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
  const created = await api.request.post(`${base}/api/tasks`, { data: { title: `Check the bank statement (${info.project.name})`, source: 'local', project: 'Walnut' } })
  const body = await created.json() as { task?: { id: string }; id?: string }
  taskId = body.task?.id ?? body.id ?? ''
  expect(taskId).not.toBe('')
  await api.close()
})

test.afterAll(async () => {
  await ctx?.close()
  await new Promise<void>((r) => sites?.close(() => r()) ?? r())
})


const refOf = (snapshot: string, re: RegExp): string => {
  const line = snapshot.split('\n').find((l) => re.test(l))
  expect(line, `no element ${re} in\n${snapshot}`).toBeTruthy()
  return /\[(e\d+)\]/.exec(line!)![1]
}

const replay = (page: Page) => popover(page).getByTestId('session-browser-replay')
const rows = (page: Page) => replay(page).locator('.session-browser-replay-row')

async function steps(page: Page): Promise<Array<{ id: string; label: string; picture: boolean; action: string }>> {
  const r = await page.request.get(`${base}/api/v1/browser/view/replay?task=${taskId}`)
  expect(r.status()).toBe(200)
  return (await r.json()).steps
}

test('an agent\'s browser steps are recorded and play back in the task\'s Browser view; Off deletes them', async ({ page }) => {
  test.setTimeout(300_000)
  await page.setViewportSize({ width: 1280, height: 860 })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await startSession(page, 'hello from the browser replay spec', taskId)
  await expect.poll(async () => {
    const r = await page.request.get(`/api/sessions/task/${taskId}`)
    const s = r.ok() ? ((await r.json()) as { sessions?: Array<{ claudeSessionId: string }> }).sessions ?? [] : []
    sid = s[0]?.claudeSessionId ?? ''
    return sid
  }, { timeout: 60_000 }).not.toBe('')
  await seedColumns(page, [sid])
  await loadHome(page)
  await expect(column(page)).toBeVisible({ timeout: 30_000 })

  // The agent's run: open, type, click, go to another page.
  const opened = await act(page, { action: 'open', url: site('login.bank.test', '/signin') })
  expect(opened.status, JSON.stringify(opened.body)).toBe(200)
  agentTab = opened.body.tab
  const snap = (await act(page, { action: 'snapshot', tab: agentTab })).body.snapshot as string
  const typed = await act(page, { action: 'type', tab: agentTab, ref: refOf(snap, /textbox "Email"/), text: 'me@bank.test' })
  expect(typed.status, JSON.stringify(typed.body)).toBe(200)
  const clicked = await act(page, { action: 'click', tab: agentTab, ref: refOf(snap, /button "Continue"/) })
  expect(clicked.status, JSON.stringify(clicked.body)).toBe(200)
  expect((await act(page, { action: 'navigate', tab: agentTab, url: site('login.bank.test', '/statement') })).status).toBe(200)

  // Each acting step is recorded with its picture (the snapshot, a read, is not); what was typed is not.
  await expect.poll(async () => (await steps(page)).length, { timeout: 30_000 }).toBe(4)
  const got = await steps(page)
  expect(got.map((s) => s.action)).toEqual(['open', 'type', 'click', 'navigate'])
  expect(got.map((s) => s.label)).toEqual([
    `Open login.bank.test:${port}/signin`,
    'Type 12 characters into textbox "Email"',
    'Click button "Continue"',
    `Go to login.bank.test:${port}/statement`,
  ])
  expect(got.every((s) => s.picture)).toBe(true)
  expect(JSON.stringify(got)).not.toContain('me@bank.test')
  const first = await page.request.get(`${base}/api/v1/browser/view/replay/frame?task=${taskId}&id=${got[0].id}`)
  const img = (await first.json()).image as string
  expect(img).toMatch(/^data:image\/jpeg;base64,/)
  const bytes = Buffer.from(img.split(',')[1], 'base64').length
  console.log(`[browser replay] step picture: ${bytes} bytes`)
  // An agent is refused the pictures, as it is the live frame.
  expect((await page.request.get(`${base}/api/v1/browser/view/replay?task=${taskId}`, { headers: { 'x-walnut-caller-sid': sid } })).status()).toBe(403)

  // The Browser view: Replay beside Larger opens it at the last step, its picture shown.
  await expect(chip(page)).toBeVisible({ timeout: 20_000 })
  await press(page, chip(page))
  await expect(card(page)).toBeVisible({ timeout: 20_000 })
  // The live picture first: its arrival adds the foot line, which moves the buttons down.
  await expect(card(page).getByTestId('session-browser-foot')).toContainText('Live', { timeout: 30_000 })
  await press(page, card(page).getByTestId('session-browser-replay-open'))
  await expect(replay(page)).toBeVisible()
  const where = replay(page).getByTestId('session-browser-replay-where')
  await expect(where).toContainText('step 4 of 4')
  await expect(replay(page).getByTestId('session-browser-replay-step')).toContainText(`Go to login.bank.test:${port}/statement`)
  await expect(replay(page).getByTestId('session-browser-replay-title')).toHaveText('Statement for October')
  const pic = replay(page).getByTestId('session-browser-replay-picture')
  await expect(pic).toBeVisible({ timeout: 20_000 })
  await expect(pic).toHaveAttribute('data-step', got[3].id)
  await expect(rows(page)).toHaveCount(4)
  await page.screenshot({ path: path.join(SHOTS, 'replay-last.png') })

  // The scrubber steps back with the arrow keys: the picture and the words follow.
  const scrub = replay(page).getByTestId('session-browser-replay-scrub')
  await press(page, scrub)
  await page.keyboard.press('Home')
  await expect(where).toContainText('step 1 of 4')
  await expect(pic).toHaveAttribute('data-step', got[0].id, { timeout: 20_000 })
  await expect(replay(page).getByTestId('session-browser-replay-title')).toHaveText('Sign in to Test Bank')
  await page.keyboard.press('ArrowRight')
  await expect(where).toContainText('step 2 of 4')
  await expect(replay(page).getByTestId('session-browser-replay-step')).toContainText('Type 12 characters into textbox "Email"')
  await expect(pic).toHaveAttribute('data-step', got[1].id, { timeout: 20_000 })
  // A step in the list goes to it.
  await press(page, rows(page).nth(2))
  await expect(where).toContainText('step 3 of 4')
  await expect(rows(page).nth(2)).toHaveAttribute('aria-current', 'step')
  // Previous and next.
  await press(page, replay(page).getByTestId('session-browser-replay-prev'))
  await expect(where).toContainText('step 2 of 4')
  await press(page, replay(page).getByTestId('session-browser-replay-next'))
  await expect(where).toContainText('step 3 of 4')

  // Play from the start at 4 steps a second: it runs to the last step and stops.
  await press(page, replay(page).getByTestId('session-browser-replay-speed-4'))
  await press(page, scrub)
  await page.keyboard.press('End')
  await expect(where).toContainText('step 4 of 4')
  const play = replay(page).getByTestId('session-browser-replay-play')
  await press(page, play)
  await expect(play).toHaveText('Pause')
  await expect(where).toContainText('step 1 of 4')
  await expect(where).toContainText('step 4 of 4', { timeout: 10_000 })
  await expect(play).toHaveText('Play', { timeout: 10_000 })
  // Pause on the way at 1 step a second: it stays where it was paused.
  const stepNow = async () => Number(/step (\d+) of/.exec((await where.textContent()) ?? '')?.[1] ?? 0)
  await press(page, replay(page).getByTestId('session-browser-replay-speed-1'))
  await press(page, play)
  await expect.poll(stepNow, { intervals: [50], timeout: 5000 }).toBeGreaterThan(1)
  await press(page, play)
  await expect(play).toHaveText('Play')
  const paused = await stepNow()
  await page.waitForTimeout(1500)
  expect(await stepNow()).toBe(paused)

  // Larger, and dark.
  await press(page, replay(page).getByTestId('session-browser-replay-size'))
  await expect(replay(page)).toHaveClass(/session-browser-card--large/)
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
  await page.screenshot({ path: path.join(SHOTS, 'replay-dark-large.png') })
  // Its controls stay inside the popover (nothing scrolls out of view).
  const box = (await popover(page).boundingBox())!
  const ctl = (await play.boundingBox())!
  expect(ctl.y + ctl.height).toBeLessThanOrEqual(box.y + box.height)
  await press(page, replay(page).getByTestId('session-browser-replay-size'))
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'))
  await page.emulateMedia({ colorScheme: 'light' })

  // A new step while the replay is open at its last step: it follows.
  await press(page, scrub)
  await page.keyboard.press('End')
  expect((await act(page, { action: 'navigate', tab: agentTab, url: site('login.bank.test', '/home') })).status).toBe(200)
  await expect(rows(page)).toHaveCount(5, { timeout: 20_000 })
  await expect(where).toContainText('step 5 of 5')
  await expect(replay(page).getByTestId('session-browser-replay-title')).toHaveText('Account overview')

  // Live goes back to the live picture.
  await press(page, replay(page).getByTestId('session-browser-replay-back'))
  await expect(card(page).getByTestId('session-browser-picture')).toBeVisible({ timeout: 30_000 })

  // Stop: no tab left, the pill is a grey Replay that opens the replay directly.
  await press(page, card(page).getByTestId('session-browser-stop'))
  await expect(popover(page).getByTestId('session-browser-ended')).toBeVisible({ timeout: 20_000 })
  await expect(replay(page)).toBeVisible()
  await press(page, popover(page).getByTestId('session-browser-ended').getByRole('button', { name: 'Dismiss' }))
  await expect(replay(page)).toBeVisible()
  await press(page, replay(page).getByTestId('session-browser-replay-hide'))
  await expect(popover(page)).toHaveCount(0)
  await expect(chip(page)).toHaveText('Replay')
  await expect(chip(page)).toHaveAttribute('data-tone', 'ended')
  await page.screenshot({ path: path.join(SHOTS, 'replay-pill.png') })
  await press(page, chip(page))
  await expect(replay(page)).toBeVisible()
  await expect(replay(page).getByTestId('session-browser-replay-picture')).toBeVisible({ timeout: 20_000 })
  await expect(replay(page).getByTestId('session-browser-replay-back')).toHaveCount(0)
  await page.screenshot({ path: path.join(SHOTS, 'replay-after-stop.png') })
  await press(page, replay(page).getByTestId('session-browser-replay-hide'))

  // Settings, Browser extension: the days kept. Off deletes every recorded step; 7 again records anew.
  await page.goto('/settings#browser')
  const days = page.getByTestId('browser-replay-days')
  await expect(days).toBeVisible({ timeout: 30_000 })
  await expect(days).toHaveValue('7')
  await expect(page.getByText(/Using \d/)).toBeVisible()
  await days.selectOption('0')
  await expect(page.getByText("Off: no picture of an agent's step is kept.")).toBeVisible({ timeout: 10_000 })
  expect((await (await page.request.get(`${base}/api/v1/browser/status`)).json()).replayDays).toBe(0)
  expect(await steps(page)).toEqual([])
  expect((await (await page.request.get(`${base}/api/v1/browser/view?task=${taskId}`)).json()).replay).toBeUndefined()
  await page.screenshot({ path: path.join(SHOTS, 'settings-off.png') })
  await days.selectOption('7')
  await expect(days).toHaveValue('7')
  await expect.poll(async () => (await (await page.request.get(`${base}/api/v1/browser/status`)).json()).replayDays).toBe(7)
  // A value Settings does not offer is refused.
  expect((await page.request.put(`${base}/api/v1/browser/settings`, { data: { replayDays: 5 } })).status()).toBe(400)
})
