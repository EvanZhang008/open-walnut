/**
 * Full screen is ONE state of the tab, plugin pages included (2026-11-02, the user,
 * on a practice plugin's session panel still full page: "why this still full page
 * in plugin, isn't this global setting?"; web/src/hooks/fullscreen-owner.ts).
 *
 * The fixture (plugin-mic-server.ts with PW_PLUGIN_FIXTURE=session) links a plugin
 * whose App has two pages with one session in walnut.ui.views.SessionView beside
 * them, and a second session the home page opens in a column.
 *   - The plugin's panel opens in its normal place, and a move to the plugin's
 *     other page (the App stays mounted) leaves full screen there; a trip away and
 *     back to the page it was full screen on finds it full screen until it is left.
 *   - Leaving full screen on the plugin page leaves the home column's too; a home
 *     column's full screen still waits for the way back while nobody left it.
 * Run both engines: PW_WEBKIT=1 ... for the Mac app.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs/promises'
import net from 'node:net'
import { devices, expect, test, type Locator, type Page } from '@playwright/test'
import { bunRuntime } from '../../helpers/bun-runtime.js'

if (process.env.PW_WEBKIT) test.use({ browserName: 'webkit', userAgent: devices['Desktop Safari'].userAgent })

const APP_PATH = '/apps/plugin-session-fixture~main'
const SHOTS = process.env.PLUGIN_SESSION_SHOTS ?? '/tmp/plugin-session-fullscreen'
const FS = /open-walnut-fullscreen/
let port = 0
let child: ChildProcessWithoutNullStreams | null = null

test.setTimeout(240_000)
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

async function openHome(page: Page): Promise<string[]> {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.addInitScript(() => {
    try {
      localStorage.setItem('open-walnut-home-chat-visible', '0')
      sessionStorage.removeItem('open-walnut-home-session-columns')
      localStorage.removeItem('open-walnut-layout:home-columns')
    } catch { /* storage off */ }
  })
  await page.goto(`http://127.0.0.1:${port}/`)
  await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 60_000 })
  return errors
}

/** The plugin's page, by its sidebar entry (the sidebar stays usable in full screen). */
async function openApp(page: Page): Promise<Locator> {
  const entry = page.locator(`a[href="${APP_PATH}"]`).first()
  await expect(entry).toBeAttached({ timeout: 60_000 })
  await entry.click()
  await expect(page.getByTestId('session-fixture-app')).toBeVisible({ timeout: 30_000 })
  const panel = page.locator('.plugin-session-view .session-panel[data-session-id="pw-plugin-session"]')
  await expect(panel).toBeVisible({ timeout: 30_000 })
  return panel
}

async function goHome(page: Page): Promise<void> {
  await page.getByTestId('sidebar-core-app-home').click()
  await expect.poll(() => new URL(page.url()).pathname).toBe('/')
}

async function expand(panel: Locator): Promise<void> {
  await panel.getByRole('button', { name: 'Expand session to full screen' }).click()
  await expect(panel).toHaveClass(FS)
}

async function shot(page: Page, name: string): Promise<void> {
  const engine = page.context().browser()?.browserType().name() ?? 'browser'
  await page.screenshot({ path: `${SHOTS}/${engine}-${name}.png` })
}

test("a plugin's session panel opens in its normal place, and its other page leaves full screen", async ({ page }) => {
  const errors = await openHome(page)
  let panel = await openApp(page)
  await expect(panel).not.toHaveClass(FS)

  // Page two, full screen there, then back to page one: the App (and the panel) stay mounted.
  await page.getByTestId('session-fixture-next').click()
  await expect(page.getByTestId('session-fixture-page')).toHaveText('Problem two')
  await expand(panel)
  // Full screen fills the plugin's box edge to edge: no margin, no rounded sheet.
  await expect.poll(() => panel.evaluate((el) => {
    const box = el.closest('.plugin-bounds')!.getBoundingClientRect()
    const r = el.getBoundingClientRect()
    const gaps = [r.left - box.left, box.right - r.right, r.top - box.top, box.bottom - r.bottom].map((g) => Math.round(g))
    return `${gaps.join(',')} ${getComputedStyle(el).borderTopLeftRadius}`
  })).toBe('0,0,0,0 0px')
  await shot(page, '1-plugin-fullscreen')
  await page.goBack()
  await expect(page.getByTestId('session-fixture-page')).toHaveText('Problem one')
  await expect(panel).not.toHaveClass(FS)
  await expect(page.locator('.open-walnut-fullscreen')).toHaveCount(0)
  await shot(page, '2-plugin-other-page-normal')

  // Full screen, away to Home and back: nobody left it, so the page opens with the panel full
  // screen again (2026-11-02, the user: "it keep lost my state like ... full screen"; the place
  // is kept, hooks/fullscreen-owner.ts). Home's columns are in their place meanwhile.
  await expand(panel)
  await goHome(page)
  await expect(page.locator('.open-walnut-fullscreen:not(.open-walnut-fullscreen-away)')).toHaveCount(0)
  panel = await openApp(page)
  await expect(panel).toHaveClass(FS)
  // Left with Esc, it stays left after another trip.
  await page.keyboard.press('Escape')
  await expect(panel).not.toHaveClass(FS)
  await goHome(page)
  panel = await openApp(page)
  await expect(panel).not.toHaveClass(FS)
  expect(errors).toEqual([])
})

test('leaving full screen on the plugin page leaves it everywhere; a home column keeps it only while nobody left it', async ({ page }) => {
  const errors = await openHome(page)
  await page.locator('.todo-search-input').fill('Home column round')
  await page.locator('.todo-panel-item[data-task-id="pw-task-home-session"] .todo-item-title').click()
  const home = page.locator('.main-page-session-column .session-panel[data-session-id="pw-home-session"]')
  await expect(home).toBeVisible({ timeout: 30_000 })

  // The home column full screen, the plugin page: there its panel is in its place.
  await expand(home)
  let panel = await openApp(page)
  await expect(panel).not.toHaveClass(FS)
  await expect(home).toHaveClass(/open-walnut-fullscreen-away/)

  // Full screen on the plugin's panel, then left with Esc: no sheet anywhere is full screen.
  await expand(panel)
  await expect(home).not.toHaveClass(FS)
  await page.keyboard.press('Escape')
  await expect(panel).not.toHaveClass(FS)
  await goHome(page)
  await expect(home).toBeVisible()
  await expect(home).not.toHaveClass(FS)
  await expect(page.locator('.open-walnut-fullscreen-backdrop')).toHaveCount(0)
  await shot(page, '3-home-normal-after-leaving-on-plugin')

  // A home column's full screen nobody left is still there on the way back (the tab's full screen).
  await expand(home)
  panel = await openApp(page)
  await expect(panel).not.toHaveClass(FS)
  await goHome(page)
  await expect(home).toHaveClass(FS)
  await expect(home).not.toHaveClass(/open-walnut-fullscreen-away/)
  expect(errors).toEqual([])
})
