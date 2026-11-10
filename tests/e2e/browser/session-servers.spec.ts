/**
 * The servers a session started show up in its Web view, open there in one click,
 * and stop in two clicks, without touching anything else.
 *
 * Nothing is faked below the browser: the spec starts REAL processes whose
 * environment names the fixture session (WALNUT_SESSION_ID, as every process an
 * agent spawns carries; WALNUT_TERMINAL_SESSION_ID, as a job in its terminal does), the
 * fixture daemon runs the real host scan (port-scan-core.ts) over this machine's
 * listening sockets, and Stop really signals the server's process group. A process
 * naming another session must never appear, and must survive every Stop.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import { test, expect, type Locator, type Page } from '@playwright/test'
import { openKebabGroup } from './kebab-group-helpers'
import { specLock } from './spec-lock'

const SESSION_ID = 'pw-servers-session'
const TASK_ID = 'pw-task-servers'
const SHOTS = process.env.PW_EVIDENCE_DIR ?? '/tmp/walnut-session-servers'

test.setTimeout(150_000)
test.beforeAll(() => fs.mkdirSync(SHOTS, { recursive: true }))

const started: Array<{ pid: number; pgid: number }> = []
test.afterEach(() => {
  // Only the groups this spec started.
  for (const s of started.splice(0)) {
    try { if (s.pgid > 1) process.kill(-s.pgid, 'SIGKILL') } catch { /* gone */ }
  }
})

// Both session-servers.spec.ts and session-live-pills.spec.ts start real servers for the one
// fixture session, and each counts that session's servers: one test of either at a time.
// Declared after the kill above, so a test's servers are gone before the next one starts.
specLock('servers-session').hold('test')

/**
 * A free port below the OS-assigned range, the way a dev server picks one: a young
 * listener on an OS-assigned port is not probed (it may serve a single login callback).
 */
const handedOut = new Set<number>()
async function freePort(): Promise<number> {
  for (;;) {
    const port = 20_000 + Math.floor(Math.random() * 10_000)
    if (handedOut.has(port)) continue
    handedOut.add(port)
    const ok = await new Promise<boolean>((resolve) => {
      const srv = net.createServer()
      srv.once('error', () => resolve(false))
      srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)))
    })
    if (ok) return port
  }
}

/**
 * A real server as an agent's Bash tool leaves one: started in the background of a shell
 * job (its own process group) whose shell then exits, so init adopts it. Its environment
 * names `env`. Returns its pid and group.
 */
async function startServer(script: string, port: number, env: Record<string, string>): Promise<{ pid: number; pgid: number }> {
  const sh = spawn('sh', ['-c', 'python3 -c "$0" "$1" >/dev/null 2>&1 & echo $!', script, String(port)], {
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp', ...env },
  })
  let out = ''
  sh.stdout!.on('data', (b: Buffer) => { out += b.toString() })
  await new Promise((r) => sh.once('exit', r))
  const server = { pid: Number(out.trim()), pgid: sh.pid! }
  started.push(server)
  // Listening before the page asks.
  for (let i = 0; i < 100; i++) {
    const up = await new Promise<boolean>((resolve) => {
      const s = net.connect({ host: '127.0.0.1', port }, () => { s.destroy(); resolve(true) })
      s.once('error', () => resolve(false))
    })
    if (up) return server
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`server on ${port} did not start`)
}

const WEB = [
  'import http.server, sys',
  'class H(http.server.BaseHTTPRequestHandler):',
  '    def do_GET(self):',
  '        body = b"<!doctype html><title>Fixture dev page</title><h1>DEV_SERVER_MARKER</h1>"',
  '        self.send_response(200); self.send_header("content-type", "text/html"); self.end_headers(); self.wfile.write(body)',
  '    def log_message(self, *a): pass',
  'http.server.HTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()',
].join('\n')
const RAW = [
  'import socket, sys',
  's = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)',
  's.bind(("127.0.0.1", int(sys.argv[1]))); s.listen(8)',
  'while True:',
  '    c, _ = s.accept(); c.sendall(b"220 not http\\r\\n"); c.close()',
].join('\n')

/** Running (a zombie init has not reaped yet has exited). */
function alive(pid: number | undefined): boolean {
  if (!pid) return false
  try { process.kill(pid, 0) } catch { return false }
  try { return !/^\d+ \(.*\) Z/.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8')) } catch { return true }
}

async function openSessionPanel(page: Page): Promise<Locator> {
  await page.locator('.todo-search-input').fill(SESSION_ID)
  const task = page.locator(`.todo-panel-item[data-task-id="${TASK_ID}"]`)
  await expect(task).toBeVisible({ timeout: 20_000 })
  await task.locator('.todo-item-title').click()
  const panel = page.locator(`.session-panel[data-session-id="${SESSION_ID}"]`)
  await expect(panel).toBeVisible({ timeout: 20_000 })
  await expect(panel.locator('.session-panel-chat-col').getByText('dev servers are starting')).toBeVisible({ timeout: 20_000 })
  return panel
}

async function webPreviewRow(page: Page, panel: Locator): Promise<Locator> {
  await panel.getByRole('button', { name: 'More actions' }).click()
  const menu = page.locator('.task-kebab-menu:visible')
  await expect(menu).toBeVisible({ timeout: 15_000 })
  const views = await openKebabGroup(menu, 'session-kebab-open')
  return views.locator('.task-kebab-item').filter({ hasText: 'Web preview' })
}

/** The stop confirm (a popover under the button), placed and holding the keyboard on Cancel. */
async function stopPopover(page: Page): Promise<Locator> {
  const pop = page.getByTestId('session-server-stop-popover')
  await expect(pop).toBeVisible()
  await expect(pop.getByRole('button', { name: 'Cancel' })).toBeFocused()
  return pop
}

async function confirmStop(page: Page, item: Locator): Promise<void> {
  await item.getByTestId('session-server-stop').click()
  await (await stopPopover(page)).getByTestId('session-server-stop-confirm').click()
}

async function shot(page: Page, name: string, testInfo: { project: { name: string } }): Promise<void> {
  await page.screenshot({ path: `${SHOTS}/${testInfo.project.name}-${name}.png`, scale: 'css' })
}

test('a session\'s servers are listed, open in the Web view, and stop without touching anything else', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  const [webPort, rawPort, termPort, otherPort] = await Promise.all([freePort(), freePort(), freePort(), freePort()])
  const web = await startServer(WEB, webPort, { WALNUT_SESSION_ID: SESSION_ID })
  const raw = await startServer(RAW, rawPort, { WALNUT_SESSION_ID: SESSION_ID })
  const term = await startServer(WEB, termPort, { WALNUT_TERMINAL_SESSION_ID: SESSION_ID })
  const other = await startServer(WEB, otherPort, { WALNUT_SESSION_ID: 'pw-some-other-session' })

  await page.goto('/')
  await page.waitForLoadState('networkidle')
  const panel = await openSessionPanel(page)

  // ── The title row has a "Web 2" chip (the web pages); its card lists every server of this
  //    session (not the other session's), one line each, and Escape closes it ──
  const webChip0 = panel.getByTestId('session-web-chip')
  // A probe that times out on a loaded host reads `unknown`, which counts as a page until its
  // retry (15 s on the host) and the panel's next slow poll (20 s): allow both.
  await expect(webChip0).toHaveText(/Web 2/, { timeout: 60_000 })
  await webChip0.click()
  const chipCard = page.getByTestId('session-web-card')
  await expect(chipCard.getByTestId('session-server-row')).toHaveCount(3)
  await expect(chipCard.locator(`[data-port="${otherPort}"]`)).toHaveCount(0)
  await expect(chipCard.locator(`[data-port="${rawPort}"] [data-testid="session-server-open"]`)).toHaveCount(0)
  await shot(page, '00a-title-chip-card', testInfo)
  await page.keyboard.press('Escape')
  await expect(chipCard).toHaveCount(0)
  await expect(panel).toBeVisible()

  // ── The servers are the header pill's alone: no card in the chat (2026-11-09, the user:
  //    "not show bottom,only show the top one there") ──
  await expect(panel.locator('.session-panel-body').getByTestId('session-server-row')).toHaveCount(0)

  // ── The menu's Web preview row counts the web pages it can open (two; the raw service is not one) ──
  const row = await webPreviewRow(page, panel)
  await expect(row.getByTestId('session-menu-servers-count')).toHaveText(' · 2 web servers', { timeout: 20_000 })
  await row.click()

  // ── Nothing open yet: the Web view lists them, each with what it is ──
  const view = panel.locator('.session-web-panel')
  const list = view.getByTestId('session-servers-list')
  await expect(list).toBeVisible({ timeout: 20_000 })
  const rows = list.getByTestId('session-server-row')
  await expect(rows).toHaveCount(3)
  // Web pages first by port, then what is not a web page.
  await expect(rows.nth(0)).toHaveAttribute('data-port', String(Math.min(webPort, termPort)))
  await expect(rows.nth(2)).toHaveAttribute('data-port', String(rawPort))
  const webRow = list.locator(`[data-testid="session-server-row"][data-port="${webPort}"]`)
  const rawRow = list.locator(`[data-testid="session-server-row"][data-port="${rawPort}"]`)
  const termRow = list.locator(`[data-testid="session-server-row"][data-port="${termPort}"]`)
  await expect(webRow).toContainText(`:${webPort}`)
  await expect(webRow).toContainText('python3')
  await expect(webRow).toContainText(`pid ${web.pid}`)
  await expect(webRow).toContainText('this host only')
  // The page's own title tells two servers of one program apart.
  await expect(webRow.locator('.session-server-title')).toHaveText('Fixture dev page')
  await expect(webRow.getByTestId('session-server-open')).toBeVisible()
  // Not a web page: listed and stoppable, but no Open.
  await expect(rawRow).toContainText('not a web page')
  await expect(rawRow.getByTestId('session-server-open')).toHaveCount(0)
  await expect(termRow).toContainText('Terminal')
  // Another session's server is not this one's.
  await expect(list.locator(`[data-port="${otherPort}"]`)).toHaveCount(0)
  await shot(page, '01-servers-list', testInfo)

  // ── Open: the page loads in the Web view, and the strip marks it ──
  await webRow.getByTestId('session-server-open').click()
  await expect(view.locator('.session-web-address')).toHaveValue(`http://localhost:${webPort}/`)
  await expect(panel.frameLocator('.session-web-iframe').getByText('DEV_SERVER_MARKER')).toBeVisible({ timeout: 20_000 })
  // The chat beside the Web view is narrow: the turn card's rows still show every Open and Stop
  // clear of the name and its tags (a tag that ran under the buttons hid "Open").
  await expect(turnCard).toBeVisible()
  const overlaps = await turnCard.getByTestId('session-server-row').evaluateAll((rows) => rows.flatMap((row) => {
    const main = row.querySelector('.session-server-row-main') as HTMLElement
    const actions = row.querySelector('.session-server-row-actions') as HTMLElement
    const clip = getComputedStyle(main).overflow === 'hidden' ? main.getBoundingClientRect().right : Infinity
    const left = actions.getBoundingClientRect().left
    return [...main.children].filter((c) => Math.min(c.getBoundingClientRect().right, clip) > left + 0.5)
      .map((c) => `${row.getAttribute('data-port')}: ${c.textContent}`)
  }))
  expect(overlaps, 'nothing in a row runs under its buttons').toEqual([])
  // One chip per web page (as many as the menu counts); the raw service is counted on "Servers"
  // that opens the list. Only the page shown carries a Stop.
  const strip = view.getByTestId('session-servers-strip')
  await expect(strip.getByTestId('session-server-chip')).toHaveCount(2)
  await expect(strip.locator(`[data-testid="session-server-chip"][data-port="${rawPort}"]`)).toHaveCount(0)
  await expect(strip.getByTestId('session-servers-count')).toHaveText('3')
  await expect(strip.getByTestId('session-servers-others')).toHaveCount(0)
  const webChip = strip.locator(`[data-testid="session-server-chip"][data-port="${webPort}"]`)
  const termChip = strip.locator(`[data-testid="session-server-chip"][data-port="${termPort}"]`)
  await expect(webChip).toHaveClass(/session-server-chip-active/)
  // The page shown has one Stop, at the row's end (not in a chip, which would move under a click).
  await expect(strip.getByTestId('session-server-stop')).toHaveCount(1)
  await expect(strip.getByTestId('session-server-stop')).toHaveAttribute('aria-label', `Stop the server on port ${webPort}`)
  await expect(strip.getByTestId('session-server-stop')).toContainText(`Stop :${webPort}`)
  await expect(webChip.getByTestId('session-server-stop')).toHaveCount(0)
  // A double click on another chip opens it and nothing else: no Stop confirm appears.
  const webBox = await webChip.boundingBox()
  await termChip.locator('.session-server-chip-open').dblclick()
  await expect(view.locator('.session-web-address')).toHaveValue(`http://localhost:${termPort}/`)
  await expect(page.getByTestId('session-server-stop-popover')).toHaveCount(0)
  expect(await webChip.boundingBox(), 'switching moves no chip').toEqual(webBox)
  await webChip.locator('.session-server-chip-open').click()
  await expect(view.locator('.session-web-address')).toHaveValue(`http://localhost:${webPort}/`)
  await expect(panel.frameLocator('.session-web-iframe').getByText('DEV_SERVER_MARKER')).toBeVisible({ timeout: 20_000 })
  await shot(page, '02-open-in-web-view', testInfo)

  // ── Escape closes the menu over the page, not the page (one Escape, one layer) ──
  await panel.getByRole('button', { name: 'More actions' }).click()
  await expect(page.locator('.task-kebab-menu:visible')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('.task-kebab-menu:visible')).toHaveCount(0)
  await expect(view.locator('.session-web-address')).toHaveValue(`http://localhost:${webPort}/`)
  // Escape in the address bar gives the shown address back, and the page stays.
  await view.locator('.session-web-address').fill('localhost:1')
  await view.locator('.session-web-address').press('Escape')
  await expect(view.locator('.session-web-address')).toHaveValue(`http://localhost:${webPort}/`)
  await expect(panel.frameLocator('.session-web-iframe').getByText('DEV_SERVER_MARKER')).toBeVisible()

  // ── "Web servers" in the menu's Session info can be pinned to the header: a "Web" chip
  //    with the count, opening the Web view (off by default; unpinned again after) ──
  await expect(panel.getByTestId('session-web-servers-chip')).toHaveCount(0)
  await panel.getByRole('button', { name: 'More actions' }).click()
  const info = await openKebabGroup(page.locator('.task-kebab-menu:visible'), 'session-kebab-details')
  const fact = info.getByTestId('session-fact-web-servers')
  await expect(fact).toContainText('2 running')
  await fact.getByTestId('session-fact-pin').click()
  await page.keyboard.press('Escape')
  const webChip2 = panel.getByTestId('session-web-servers-chip')
  await expect(webChip2).toHaveText(/Web\s*2/)
  await expect(webChip2).toHaveClass(/session-action-chip-active/)
  await panel.getByRole('button', { name: 'More actions' }).click()
  await (await openKebabGroup(page.locator('.task-kebab-menu:visible'), 'session-kebab-details')).getByTestId('session-fact-web-servers').getByTestId('session-fact-pin').click()
  await page.keyboard.press('Escape')
  await expect(webChip2).toHaveCount(0)
  await expect(view.locator('.session-web-address')).toHaveValue(`http://localhost:${webPort}/`)

  // ── A window narrowed to the phone layout and widened again keeps the page open ──
  await page.setViewportSize({ width: 760, height: 680 })
  await expect(view.locator('.session-web-address')).toHaveValue(`http://localhost:${webPort}/`)
  await page.setViewportSize({ width: 1280, height: 800 })
  // The full-screen entry animation briefly shows the panel twice: wait for one.
  await expect(view.locator('.session-web-address')).toHaveCount(1, { timeout: 10_000 })
  await expect(view.locator('.session-web-address')).toHaveValue(`http://localhost:${webPort}/`, { timeout: 10_000 })
  // Full screen comes back with its entry animation: one panel, one page, on screen.
  const settled = await expect.poll(() => page.evaluate(() => {
    const frames = [...document.querySelectorAll<HTMLElement>('.session-web-iframe')]
    return frames.map((f) => { const r = f.getBoundingClientRect(); return `${Math.round(r.width)}x${Math.round(r.height)}:${getComputedStyle(f.closest('.session-panel')!).opacity}` }).join(',')
  }), { timeout: 20_000 }).toMatch(/^[1-9]\d*x[1-9]\d*:1$/).then(() => true, async (err) => {
    await shot(page, '02c-after-phone-round-trip-FAILED', testInfo)
    throw err
  })
  expect(settled).toBe(true)
  await expect(panel.frameLocator('.session-web-iframe').getByText('DEV_SERVER_MARKER')).toBeVisible({ timeout: 20_000 })

  // ── Every server's details stay one click away over the open page ("Servers 3") ──
  await strip.getByTestId('session-servers-show-all').click()
  const overlay = view.getByTestId('session-servers-overlay')
  await expect(overlay.getByTestId('session-server-row')).toHaveCount(3)
  await expect(overlay.locator(`[data-port="${webPort}"]`)).toContainText('Showing')
  await expect(overlay.locator(`[data-port="${webPort}"] [data-testid="session-server-open"]`)).toHaveCount(0)
  // A Stop popover opened from the list is the top layer: one Escape closes it alone.
  await overlay.locator(`[data-port="${rawPort}"] [data-testid="session-server-stop"]`).click()
  await stopPopover(page)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('session-server-stop-popover')).toHaveCount(0)
  await expect(overlay).toBeVisible()
  await shot(page, '02b-all-servers', testInfo)
  await page.keyboard.press('Escape')
  await expect(overlay).toHaveCount(0)
  await expect(panel).toBeVisible()

  // ── A typed port held by this session's non-web service says what it is, and where to stop it ──
  await view.locator('.session-web-address').fill(`localhost:${rawPort}`)
  await view.locator('.session-web-address').press('Enter')
  const notWeb = view.getByTestId('session-web-not-web')
  await expect(notWeb).toContainText(`:${rawPort}`, { timeout: 20_000 })
  await expect(notWeb).toContainText('is running, but it does not serve a web page')
  await view.getByRole('button', { name: 'Show in Servers' }).click()
  await expect(overlay.locator(`[data-port="${rawPort}"]`)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(overlay).toHaveCount(0)
  await strip.locator(`[data-testid="session-server-chip"][data-port="${webPort}"] .session-server-chip-open`).click()
  await expect(panel.frameLocator('.session-web-iframe').getByText('DEV_SERVER_MARKER')).toBeVisible({ timeout: 20_000 })

  // ── Stop asks first, in a popover that never sits under the button: a double click
  //    does not stop, Escape and Cancel keep it running and the panel open ──
  const popover = page.getByTestId('session-server-stop-popover')
  await strip.getByTestId('session-server-stop').dblclick()
  await expect(popover).toBeVisible()
  await shot(page, '03-stop-confirm', testInfo)
  await page.keyboard.press('Escape')
  await expect(popover).toHaveCount(0)
  await expect(panel).toBeVisible()
  await strip.getByTestId('session-server-stop').click()
  await (await stopPopover(page)).getByRole('button', { name: 'Cancel' }).click()
  await expect(popover).toHaveCount(0)
  expect(alive(web.pid)).toBe(true)

  // ── Stop the page shown: the process really exits, the others stay, and the view goes
  //    back to the list with a word (the person did it; it is not a failure screen) ──
  await confirmStop(page, strip)
  await expect.poll(() => alive(web.pid), { timeout: 10_000 }).toBe(false)
  await expect(view.getByTestId('session-servers-notice')).toContainText(`Stopped :${webPort}`, { timeout: 15_000 })
  await expect(list.locator(`[data-port="${webPort}"]`)).toHaveCount(0)
  await expect(list.getByTestId('session-server-row')).toHaveCount(2)
  await expect(view.locator('.session-code-error-card')).toHaveCount(0)
  expect(alive(raw.pid), 'another server of the session').toBe(true)
  expect(alive(term.pid), 'the terminal job').toBe(true)
  expect(alive(other.pid), 'another session\'s server').toBe(true)
  await shot(page, '04-after-stop', testInfo)

  // ── A second round: open the terminal job and stop it from its chip ──
  await termRow.getByTestId('session-server-open').click()
  await expect(view.locator('.session-web-address')).toHaveValue(`http://localhost:${termPort}/`)
  await expect(termChip).toHaveClass(/session-server-chip-active/)
  await confirmStop(page, strip)
  await expect.poll(() => alive(term.pid), { timeout: 10_000 }).toBe(false)
  await expect(view.getByTestId('session-servers-notice')).toContainText(`Stopped :${termPort}`, { timeout: 15_000 })
  expect(alive(raw.pid)).toBe(true)
  expect(alive(other.pid)).toBe(true)

  // ── A server that starts later appears on its own (the view polls while open) ──
  const latePort = await freePort()
  const late = await startServer(WEB, latePort, { WALNUT_SESSION_ID: SESSION_ID })
  const lateRow = list.locator(`[data-testid="session-server-row"][data-port="${latePort}"]`)
  await expect(lateRow).toBeVisible({ timeout: 20_000 })

  // ── A server that ends on its own while shown: the page says so, and when one listens
  //    on that port again the page reloads by itself ──
  await lateRow.getByTestId('session-server-open').click()
  await expect(panel.frameLocator('.session-web-iframe').getByText('DEV_SERVER_MARKER')).toBeVisible({ timeout: 20_000 })
  process.kill(-late.pgid, 'SIGKILL')
  await expect(view.locator('.session-code-error-body')).toHaveText(`The server on :${latePort} stopped.`, { timeout: 20_000 })
  await expect(view.locator('.session-web-iframe')).toHaveCount(0)
  // Reload asks again: the stopped server does not come back as a cached page, and the
  // page still says why (with its host), not a generic failure.
  await view.getByRole('button', { name: 'Reload' }).click()
  await expect(view.getByTestId('session-web-error-title')).toContainText(`localhost:${latePort}`, { timeout: 20_000 })
  await expect(view.locator('.session-code-error-body')).toHaveText(`The server on :${latePort} stopped.`)
  await expect(view.locator('.session-code-host')).toHaveText('Local')
  await expect(view.locator('.session-web-iframe')).toHaveCount(0)
  await startServer(WEB, latePort, { WALNUT_SESSION_ID: SESSION_ID })
  await expect(panel.frameLocator('.session-web-iframe').getByText('DEV_SERVER_MARKER')).toBeVisible({ timeout: 30_000 })
  await expect(view.locator('.session-code-error-card')).toHaveCount(0)
  await expect(strip.locator(`[data-testid="session-server-chip"][data-port="${latePort}"]`)).toBeVisible({ timeout: 10_000 })

  // ── Stopping a server that is not shown (from the list over the page) says so too, and the
  //    page stays ──
  await view.getByTestId('session-servers-show-all').click()
  await confirmStop(page, view.getByTestId('session-servers-overlay').locator(`[data-port="${rawPort}"]`))
  await expect.poll(() => alive(raw.pid), { timeout: 10_000 }).toBe(false)
  await expect(view.getByTestId('session-servers-notice')).toContainText(`Stopped :${rawPort}`, { timeout: 15_000 })
  // The word and the list agree at once: the row is gone the moment "Stopped" shows (read
  // once, no waiting), and no later scan brings it back.
  const overlayRows = view.getByTestId('session-servers-overlay').locator('[data-testid="session-server-row"]')
  expect(await overlayRows.evaluateAll((els, port) => els.filter((e) => e.getAttribute('data-port') === port).length, String(rawPort))).toBe(0)
  await page.waitForTimeout(3_000)
  await expect(overlayRows.and(page.locator(`[data-port="${rawPort}"]`))).toHaveCount(0)
  await expect(panel.frameLocator('.session-web-iframe').getByText('DEV_SERVER_MARKER')).toBeVisible()
  expect(alive(other.pid)).toBe(true)
})

test('a server that exits on its own leaves the list, and a Stop of one already gone is not an error', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  const port = await freePort()
  const server = await startServer(WEB, port, { WALNUT_SESSION_ID: SESSION_ID })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  const panel = await openSessionPanel(page)
  await (await webPreviewRow(page, panel)).click()
  const view = panel.locator('.session-web-panel')
  const item = view.locator(`[data-port="${port}"]`).first()
  await expect(item).toBeVisible({ timeout: 20_000 })
  // Arm Stop, then the server dies before the confirm.
  await item.getByTestId('session-server-stop').click()
  await stopPopover(page)
  process.kill(-server.pgid, 'SIGKILL')
  await expect.poll(() => alive(server.pid), { timeout: 5_000 }).toBe(false)
  const confirm = page.getByTestId('session-server-stop-confirm')
  if (await confirm.count()) await confirm.click({ timeout: 2_000 }).catch(() => { /* the row already left */ })
  await expect(view.locator(`[data-port="${port}"]`)).toHaveCount(0, { timeout: 20_000 })
  await expect(view.locator('.session-server-error')).toHaveCount(0)
})

test('on a phone the shown page keeps its whole port in the strip, beside All servers and Stop', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const port = await freePort()
  await startServer(WEB, port, { WALNUT_SESSION_ID: SESSION_ID })
  // The fixture's session runs on this machine; a remote host's name is the widest the strip's
  // All button gets (2026-11-09: "All servers on <host>" and Stop left the shown chip a sliver).
  await page.route(/\/api\/sessions\/pw-servers-session\/servers(\?|$)/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    const res = await route.fetch()
    await route.fulfill({ response: res, json: { ...(await res.json()), host: 'a-remote-build-host' } })
  })
  await page.goto('/')
  await page.locator('.todo-search-input').click()
  await page.locator('.phone-search-input').fill('Session servers fixture')
  await page.locator('.phone-search-row', { hasText: 'Session servers fixture task' }).first().click()
  const panel = page.locator('.main-page-session-column.is-mobile-active .session-panel')
  await expect(panel).toBeVisible({ timeout: 20_000 })

  // The compact chip by the kebab opens the card; Open shows the page.
  const chip = page.locator('[data-testid="session-web-chip"].is-compact')
  await expect(chip).toBeVisible({ timeout: 60_000 })
  await chip.click()
  const card = page.getByTestId('session-web-card')
  await card.locator(`[data-port="${port}"] [data-testid="session-server-open"]`).click()
  await expect(panel.frameLocator('.session-web-iframe').getByText('DEV_SERVER_MARKER')).toBeVisible({ timeout: 20_000 })

  const strip = panel.getByTestId('session-servers-strip')
  const shown = strip.locator(`[data-testid="session-server-chip"][data-port="${port}"]`)
  await expect(shown).toBeVisible()
  await expect(strip.getByTestId('session-server-stop')).toBeVisible()
  await shot(page, '20-phone-strip', testInfo)
  // The port is drawn whole inside its chip, and the chip inside the strip's chip row.
  const fit = await shown.evaluate((el) => {
    const r = el.getBoundingClientRect()
    const p = el.querySelector('.session-server-port')!.getBoundingClientRect()
    const row = el.closest('.session-servers-strip-chips')!.getBoundingClientRect()
    return { chip: Math.round(r.width), port: Math.round(p.width), inChip: p.left >= r.left - 0.5 && p.right <= r.right + 0.5, inRow: r.left >= row.left - 0.5 && r.right <= row.right + 0.5 }
  })
  expect(fit, JSON.stringify(fit)).toMatchObject({ inChip: true, inRow: true })
  await expect(strip.getByTestId('session-servers-show-all')).toHaveAttribute('title', /servers? this session started on a-remote-build-host/)
})
