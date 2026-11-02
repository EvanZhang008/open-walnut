/**
 * Walnut keeps what a view shows, by itself, plugin pages included (2026-11-02, the user, on a
 * practice plugin's page: "it keep lost my state like the open state of the session, like full
 * screen, file, can we make it default feature in walnut no matter where include plugin,
 * remember the state, like full store, file tab, tab location", then "a generic walnut thing not
 * only to this plugin").
 *
 * The fixture (plugin-mic-server.ts with PW_PLUGIN_FIXTURE=session) links a plugin whose App
 * shows one session in walnut.ui.views.SessionView, beside a button that hides it (kept with
 * walnut.ui.useView), and a second session the home page opens in a column. The session panel
 * keeps its split view and file per place (components/sessions/panel-view.ts), full screen is
 * the tab's one state kept as that place (hooks/fullscreen-owner.ts), and the explorer keeps the
 * file it shows (utils/file-view-state.ts). Each comes back after:
 *   - the plugin reloads (POST /api/plugin-runtime/<id>/reload remounts its App),
 *   - the page reloads,
 *   - a visit to another page and back,
 *   - an app restart (a new tab of the same profile: sessionStorage gone, localStorage kept),
 *   - for the plugin's own choice, cleared browser data (the server's ui-prefs bring it back;
 *     the panel's view and full screen are this window's own and stay on this device).
 * Leaving full screen ends it for good. Run both engines: PW_WEBKIT=1 ... for the Mac app.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs/promises'
import net from 'node:net'
import { devices, expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test'
import { bunRuntime } from '../../helpers/bun-runtime.js'

if (process.env.PW_WEBKIT) test.use({ browserName: 'webkit', userAgent: devices['Desktop Safari'].userAgent })

const PLUGIN_ID = 'plugin-session-fixture'
const APP_PATH = `/apps/${PLUGIN_ID}~main`
const SHOTS = process.env.VIEW_STATE_SHOTS ?? '/tmp/view-state-kept'
const FS = /open-walnut-fullscreen/
const FILE = 'package.json'
let port = 0
let child: ChildProcessWithoutNullStreams | null = null

test.setTimeout(300_000)
test.describe.configure({ mode: 'serial' })
test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })

async function reservePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Could not reserve a fixture port')
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return address.port
}

test.beforeAll(async () => {
  test.setTimeout(240_000)
  await fs.mkdir(SHOTS, { recursive: true })
  port = await reservePort()
  let output = ''
  child = spawn(bunRuntime(), ['tests/e2e/browser/plugin-mic-server.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, PW_PLUGIN_MIC_PORT: String(port), PW_PLUGIN_FIXTURE: 'session' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => { output = `${output}${String(chunk)}`.slice(-20_000) })
  child.stderr.on('data', (chunk) => { output = `${output}${String(chunk)}`.slice(-20_000) })
  await new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`Plugin session fixture did not start\n${output.slice(-8000)}`)), 180_000)
    const timer = setInterval(() => {
      if (/PLUGIN_MIC_READY /.test(output)) { clearInterval(timer); clearTimeout(deadline); resolve() }
      else if (child?.exitCode !== null) { clearInterval(timer); clearTimeout(deadline); reject(new Error(`Fixture exited\n${output.slice(-8000)}`)) }
    }, 200)
  })
})

test.afterAll(async () => {
  if (!child || child.exitCode !== null) return
  const exited = new Promise<void>((resolve) => child!.once('exit', () => resolve()))
  child.kill('SIGTERM')
  const graceful = await Promise.race([exited.then(() => true), new Promise<false>((r) => setTimeout(() => r(false), 20_000))])
  if (!graceful) child.kill('SIGKILL')
})

const base = () => `http://127.0.0.1:${port}`

/** Every test starts from no kept view: the server's copy of the view keys goes before the first load. */
async function forgetViews(page: Page): Promise<void> {
  const res = await page.request.get(`${base()}/api/ui-prefs`)
  const { prefs } = await res.json() as { prefs: Record<string, unknown> }
  const gone = Object.fromEntries(Object.keys(prefs).filter((k) => k.startsWith('open-walnut-view:') || k.startsWith('open-walnut-file-explorer'))
    .map((k) => [k, { v: null, ts: Date.now() }]))
  if (Object.keys(gone).length) await page.request.put(`${base()}/api/ui-prefs`, { data: { prefs: gone } })
}

const prepared = new WeakSet<Page>()
async function boot(page: Page, path = '/'): Promise<string[]> {
  const errors: string[] = []
  // WebKit reports a fetch a reload cut off as "... due to access control checks": the reload's, not the page's.
  page.on('pageerror', (error) => { if (!/due to access control checks/.test(error.message)) errors.push(error.message) })
  if (!prepared.has(page)) {
    prepared.add(page)
    // The Ask slot off, as plugin-session-fullscreen.spec.ts: the home column has the room.
    await page.addInitScript(() => { try { localStorage.setItem('open-walnut-home-chat-visible', '0') } catch { /* storage off */ } })
  }
  await page.goto(`${base()}${path}`)
  await expect(page.locator('.app-shell, .todo-panel').first()).toBeVisible({ timeout: 60_000 })
  return errors
}

async function openApp(page: Page): Promise<void> {
  const entry = page.locator(`a[href="${APP_PATH}"]`).first()
  await expect(entry).toBeAttached({ timeout: 60_000 })
  await entry.click()
  await expect(page.getByTestId('session-fixture-app')).toBeVisible({ timeout: 30_000 })
}

function pluginPanel(page: Page): Locator {
  return page.locator('.plugin-session-view .session-panel[data-session-id="pw-plugin-session"]')
}

async function goHome(page: Page): Promise<void> {
  await page.getByTestId('sidebar-core-app-home').click()
  await expect.poll(() => new URL(page.url()).pathname).toBe('/')
}

async function openFile(panel: Locator): Promise<void> {
  await panel.locator('.session-action-chip', { hasText: /^Files$/ }).click()
  const explorer = panel.locator('.session-file-explorer')
  await expect(explorer).toBeVisible({ timeout: 20_000 })
  await explorer.locator('.session-file-explorer-node .sfe-name', { hasText: new RegExp(`^${FILE.replace('.', '\\.')}$`) }).first().click()
  await expect(explorer.locator('.session-file-explorer-node.selected .sfe-name')).toHaveText(FILE, { timeout: 20_000 })
}

/** The panel as it was left: full screen, Files beside the chat, the file open. */
async function expectKept(panel: Locator): Promise<void> {
  await expect(panel).toBeVisible({ timeout: 30_000 })
  await expect(panel).toHaveClass(FS, { timeout: 20_000 })
  await expect(panel.locator('.session-action-chip.session-action-chip-active')).toHaveText('Files')
  const explorer = panel.locator('.session-file-explorer')
  await expect(explorer).toBeVisible({ timeout: 20_000 })
  await expect(explorer.locator('.session-file-explorer-node.selected .sfe-name')).toHaveText(FILE, { timeout: 20_000 })
}

async function shot(page: Page, name: string): Promise<void> {
  const engine = page.context().browser()?.browserType().name() ?? 'browser'
  await page.screenshot({ path: `${SHOTS}/${engine}-${name}.png` })
}

/** A new tab of the same profile, as the Mac app's window after a restart: its sessionStorage is new. */
async function restart(context: BrowserContext, page: Page): Promise<Page> {
  await page.close()
  const next = await context.newPage()
  return next
}

test("a plugin page's session panel comes back as it was left: plugin reload, page reload, another page, restart", async ({ page, context }) => {
  await forgetViews(page)
  let errors = await boot(page, APP_PATH)
  await expect(page.getByTestId('session-fixture-app')).toBeVisible({ timeout: 30_000 })
  let panel = pluginPanel(page)
  await expect(panel).toBeVisible({ timeout: 30_000 })
  await expect(panel).not.toHaveClass(FS)
  await openFile(panel)
  await shot(page, '1-left-full-screen-with-a-file')

  // The plugin reloads: its App mounts again.
  const reload = await page.request.post(`${base()}/api/plugin-runtime/${PLUGIN_ID}/reload`)
  expect(reload.ok()).toBe(true)
  await expectKept(pluginPanel(page))
  await shot(page, '2-after-plugin-reload')

  // The page reloads.
  await page.reload()
  await expect(page.getByTestId('session-fixture-app')).toBeVisible({ timeout: 60_000 })
  await expectKept(pluginPanel(page))

  // Home and back: nothing is full screen on Home meanwhile.
  await goHome(page)
  await expect(page.locator('.open-walnut-fullscreen:not(.open-walnut-fullscreen-away)')).toHaveCount(0)
  await openApp(page)
  await expectKept(pluginPanel(page))
  expect(errors).toEqual([])

  // The app restarts: a new tab, the same profile.
  page = await restart(context, page)
  errors = await boot(page, APP_PATH)
  await expect(page.getByTestId('session-fixture-app')).toBeVisible({ timeout: 60_000 })
  await expectKept(pluginPanel(page))
  await shot(page, '3-after-restart')

  // Left with Esc: gone for good, after a reload and a plugin reload too.
  panel = pluginPanel(page)
  await page.keyboard.press('Escape')
  await expect(panel).not.toHaveClass(FS)
  await expect(panel.locator('.session-file-explorer')).toHaveCount(0)
  await page.reload()
  await expect(page.getByTestId('session-fixture-app')).toBeVisible({ timeout: 60_000 })
  await expect(pluginPanel(page)).toBeVisible({ timeout: 30_000 })
  await expect(pluginPanel(page)).not.toHaveClass(FS)
  await expect(pluginPanel(page).locator('.session-file-explorer')).toHaveCount(0)
  await shot(page, '4-left-stays-left')
  expect(errors).toEqual([])
})

test("the plugin's own pane toggle comes back too (walnut.ui.useView)", async ({ page }) => {
  await forgetViews(page)
  const errors = await boot(page, APP_PATH)
  await expect(pluginPanel(page)).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('session-fixture-partner').click()
  await expect(pluginPanel(page)).toHaveCount(0)
  // A plugin reload, then a page reload: still hidden.
  expect((await page.request.post(`${base()}/api/plugin-runtime/${PLUGIN_ID}/reload`)).ok()).toBe(true)
  await expect(page.getByTestId('session-fixture-partner')).toHaveText('Show partner', { timeout: 30_000 })
  await expect(pluginPanel(page)).toHaveCount(0)
  await page.reload()
  await expect(page.getByTestId('session-fixture-partner')).toHaveText('Show partner', { timeout: 60_000 })
  await expect(pluginPanel(page)).toHaveCount(0)
  // Cleared browser data: the server's copy brings it back at the next boot (a plugin's view
  // choice follows the user; a session panel's view and full screen stay this window's own).
  await page.waitForTimeout(1500) // the mirror's 800 ms debounce
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear() })
  await page.reload()
  await expect(page.getByTestId('session-fixture-partner')).toHaveText('Show partner', { timeout: 60_000 })
  await expect(pluginPanel(page)).toHaveCount(0)
  // Shown again, and kept so.
  await page.getByTestId('session-fixture-partner').click()
  await expect(pluginPanel(page)).toBeVisible({ timeout: 30_000 })
  await goHome(page)
  await openApp(page)
  await expect(pluginPanel(page)).toBeVisible({ timeout: 30_000 })
  expect(errors).toEqual([])
})

test('a home column comes back as it was left after a reload; one place per host and session; the plugin page is its own', async ({ page }) => {
  await forgetViews(page)
  const errors = await boot(page)
  await page.locator('.todo-search-input').fill('Home column round')
  await page.locator('.todo-panel-item[data-task-id="pw-task-home-session"] .todo-item-title').click()
  const home = page.locator('.main-page-session-column .session-panel[data-session-id="pw-home-session"]')
  await expect(home).toBeVisible({ timeout: 30_000 })
  await openFile(home)
  await page.reload()
  await expectKept(page.locator('.main-page-session-column .session-panel[data-session-id="pw-home-session"]'))
  await shot(page, '5-home-column-after-reload')

  // The plugin page shows its own session in its normal place: the home column holds full screen.
  await openApp(page)
  await expect(pluginPanel(page)).toBeVisible({ timeout: 30_000 })
  await expect(pluginPanel(page)).not.toHaveClass(FS)
  await expect(pluginPanel(page).locator('.session-file-explorer')).toHaveCount(0)
  // Full screen there moves it: back home, the column is in its place, its Files closed.
  await pluginPanel(page).getByRole('button', { name: 'Expand session to full screen' }).click()
  await expect(pluginPanel(page)).toHaveClass(FS)
  await goHome(page)
  const column = page.locator('.main-page-session-column .session-panel[data-session-id="pw-home-session"]')
  await expect(column).toBeVisible()
  await expect(column).not.toHaveClass(FS)
  await expect(column.locator('.session-file-explorer')).toHaveCount(0)
  // And a reload keeps it so: the plugin page's panel is the one full screen.
  await page.reload()
  await expect(page.locator('.main-page-session-column .session-panel[data-session-id="pw-home-session"]')).not.toHaveClass(FS, { timeout: 30_000 })
  await openApp(page)
  await expect(pluginPanel(page)).toHaveClass(FS, { timeout: 20_000 })
  await page.keyboard.press('Escape')
  await expect(pluginPanel(page)).not.toHaveClass(FS)
  expect(errors).toEqual([])
})
