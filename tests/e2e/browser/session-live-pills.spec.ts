/**
 * What a session holds live shows only as small pills in its header, never as a card in its chat
 * (2026-11-09, the user, of a "Server this turn started" card above the composer: "not show
 * bottom,only show the top one there", then "same for brwoser, we only show as a small pill tehere
 * people can click and see detail"). Code half: tests/web/live-resources-header-only-guard.test.ts.
 *
 * The servers are real processes naming the fixture session (as session-servers.spec.ts starts
 * them). The browser's tabs come from the person's browser extension, which only Chromium can load
 * (extension-browser-view.spec.ts drives it for real), so here the two Browser view routes answer
 * from the page and every engine, WebKit (the Mac app's) included, shows the pill and its popover.
 * Every click is real mouse input.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import { test, expect, type Locator, type Page, type Route } from '@playwright/test'

const SESSION_ID = 'pw-servers-session'
const TASK_ID = 'pw-task-servers'
const SHOTS = process.env.PW_EVIDENCE_DIR ?? '/tmp/walnut-live-pills'

test.setTimeout(180_000)
test.beforeAll(() => fs.mkdirSync(SHOTS, { recursive: true }))

const started: Array<{ pgid: number }> = []
test.afterEach(() => {
  // Only the groups this spec started.
  for (const s of started.splice(0)) {
    try { if (s.pgid > 1) process.kill(-s.pgid, 'SIGKILL') } catch { /* gone */ }
  }
})

async function freePort(): Promise<number> {
  for (;;) {
    const port = 20_000 + Math.floor(Math.random() * 10_000)
    const ok = await new Promise<boolean>((resolve) => {
      const srv = net.createServer()
      srv.once('error', () => resolve(false))
      srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)))
    })
    if (ok) return port
  }
}

const WEB = [
  'import http.server, sys',
  'class H(http.server.BaseHTTPRequestHandler):',
  '    def do_GET(self):',
  '        body = b"<!doctype html><title>Fixture dev page</title><h1>DEV</h1>"',
  '        self.send_response(200); self.send_header("content-type", "text/html"); self.end_headers(); self.wfile.write(body)',
  '    def log_message(self, *a): pass',
  'http.server.HTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()',
].join('\n')

/** A real server left in the background by a shell job, naming the fixture session. */
async function startServer(port: number): Promise<void> {
  const sh = spawn('sh', ['-c', 'python3 -c "$0" "$1" >/dev/null 2>&1 & echo $!', WEB, String(port)], {
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp', WALNUT_SESSION_ID: SESSION_ID },
  })
  await new Promise((r) => sh.once('exit', r))
  started.push({ pgid: sh.pid! })
  for (let i = 0; i < 100; i++) {
    const up = await new Promise<boolean>((resolve) => {
      const s = net.connect({ host: '127.0.0.1', port }, () => { s.destroy(); resolve(true) })
      s.once('error', () => resolve(false))
    })
    if (up) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`server on ${port} did not start`)
}

async function press(page: Page, loc: Locator): Promise<void> {
  await expect(loc).toBeVisible()
  const b = (await loc.boundingBox())!
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 8 })
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2)
}

/** The Browser view's two routes, answered from here: one tab of the task, and its picture. */
function fakeBrowser(page: Page, picture: string) {
  const state = { signIn: false, gone: false }
  const tab = () => ({
    device: 'pw-device', browser: 'Chrome', tab: 41, url: 'https://login.bank.test/signin', title: 'Sign in to Test Bank',
    window: 'agent', windowState: 'normal', connected: true, pictures: true,
    ...(state.signIn ? { signIn: { id: 'si-1', at: new Date().toISOString(), site: 'bank.test' } } : {}),
  })
  void page.route('**/api/v1/browser/view?*', (route: Route) => route.fulfill({
    json: state.gone ? { tabs: [], ended: { at: new Date().toISOString(), why: 'stopped' } } : { tabs: [tab()] },
  }))
  void page.route('**/api/v1/browser/view/frame?*', (route: Route) => route.fulfill({
    json: { tab: 41, device: 'pw-device', shown: true, image: picture, at: new Date().toISOString(), title: 'Sign in to Test Bank', url: 'https://login.bank.test/signin', window: 'agent', windowState: 'normal' },
  }))
  void page.route('**/api/v1/browser/view/stop', (route: Route) => { state.gone = true; return route.fulfill({ json: { ok: true } }) })
  return state
}

test('servers and the browser show only as header pills, their details in popovers', async ({ browser }, testInfo) => {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 820 },
    recordVideo: { dir: SHOTS, size: { width: 1280, height: 820 } },
    baseURL: String(testInfo.project.use.baseURL ?? 'http://localhost:3457'),
  })
  const page = await ctx.newPage()
  // The picture the browser "takes": a rendered page, as the extension would capture.
  const art = await ctx.newPage()
  await art.setContent('<body style="margin:0;font:16px -apple-system,sans-serif;background:#f4f6fb"><div style="padding:28px"><h2 style="margin:0 0 12px">Test Bank</h2><p>Sign in to your account</p><div style="border:1px solid #ccd;border-radius:6px;padding:10px;width:260px;background:#fff">user@example.com</div><div style="margin-top:10px;border:1px solid #ccd;border-radius:6px;padding:10px;width:260px;background:#fff">••••••••</div></div></body>')
  await art.setViewportSize({ width: 640, height: 400 })
  const picture = `data:image/jpeg;base64,${(await art.screenshot({ type: 'jpeg', quality: 80 })).toString('base64')}`
  await art.close()
  const browserState = fakeBrowser(page, picture)

  const port = await freePort()
  await startServer(port)

  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.locator('.todo-search-input').fill(SESSION_ID)
  const task = page.locator(`.todo-panel-item[data-task-id="${TASK_ID}"]`)
  await expect(task).toBeVisible({ timeout: 20_000 })
  await press(page, task.locator('.todo-item-title'))
  const panel = page.locator(`.session-panel[data-session-id="${SESSION_ID}"]`)
  await expect(panel).toBeVisible({ timeout: 20_000 })
  const body = panel.locator('.session-panel-body')

  // ── Servers: one pill in the header, nothing in the chat ──
  const webChip = panel.getByTestId('session-web-chip')
  await expect(webChip).toHaveText(`:${port}`, { timeout: 60_000 })
  await expect(body.getByTestId('session-server-row')).toHaveCount(0)
  await expect(page.getByTestId('session-servers-turn-card')).toHaveCount(0)
  await page.screenshot({ path: `${SHOTS}/${testInfo.project.name}-1-pills.png`, scale: 'css' })
  await press(page, webChip)
  const webCard = page.getByTestId('session-web-card')
  await expect(webCard.locator(`[data-port="${port}"]`)).toBeVisible()
  await expect(webCard.locator(`[data-port="${port}"] [data-testid="session-server-open"]`)).toBeVisible()
  await page.screenshot({ path: `${SHOTS}/${testInfo.project.name}-2-servers-popover.png`, scale: 'css' })
  await page.keyboard.press('Escape')
  await expect(webCard).toHaveCount(0)

  // ── Browser: one pill in the header, nothing in the chat; a click opens the view ──
  const chip = panel.getByTestId('session-browser-chip')
  await expect(chip).toHaveText('Browser', { timeout: 30_000 })
  await expect(body.locator('[data-testid^="session-browser-"]')).toHaveCount(0)
  await press(page, chip)
  const pop = page.getByTestId('session-browser-popover')
  const card = pop.getByTestId('session-browser-card')
  await expect(card.getByTestId('session-browser-title')).toHaveText('Sign in to Test Bank')
  await expect(card.getByTestId('session-browser-picture')).toBeVisible({ timeout: 20_000 })
  await expect(card.getByTestId('session-browser-foot')).toContainText('Live')
  // An overlay: it never pushes the chat.
  const popBox = (await pop.boundingBox())!
  const chipBox = (await chip.boundingBox())!
  expect(popBox.y).toBeGreaterThanOrEqual(chipBox.y + chipBox.height - 1)
  expect(popBox.x + popBox.width).toBeLessThanOrEqual(1280)
  await page.screenshot({ path: `${SHOTS}/${testInfo.project.name}-3-browser-popover.png`, scale: 'css' })
  // × closes it, the pill stays; an outside click closes it too.
  await press(page, card.getByTestId('session-browser-hide'))
  await expect(pop).toHaveCount(0)
  await expect(chip).toBeVisible()
  await press(page, chip)
  await expect(card).toBeVisible()
  await page.mouse.click(640, 700)
  await expect(pop).toHaveCount(0)

  // ── The agent asks the person to sign in: the pill says so in the attention colour ──
  browserState.signIn = true
  await expect(chip).toHaveText('Sign in', { timeout: 30_000 })
  await expect(chip).toHaveAttribute('data-tone', 'ask')
  await page.screenshot({ path: `${SHOTS}/${testInfo.project.name}-4-sign-in-pill.png`, scale: 'css' })
  await press(page, chip)
  await expect(card.getByTestId('session-browser-hand')).toContainText('sign in')
  browserState.signIn = false

  // ── Stop: the view says why in the open popover; dismissed, the pill is gone ──
  await press(page, card.getByTestId('session-browser-stop'))
  const ended = pop.getByTestId('session-browser-ended')
  await expect(ended).toBeVisible({ timeout: 20_000 })
  await expect(chip).toHaveAttribute('data-tone', 'ended')
  await page.screenshot({ path: `${SHOTS}/${testInfo.project.name}-5-stopped.png`, scale: 'css' })
  await press(page, ended.getByRole('button', { name: 'Dismiss' }))
  await expect(pop).toHaveCount(0)
  await expect(chip).toHaveCount(0)
  await expect(body.locator('[data-testid^="session-browser-"]')).toHaveCount(0)
  await page.waitForTimeout(800)
  await ctx.close()
})
