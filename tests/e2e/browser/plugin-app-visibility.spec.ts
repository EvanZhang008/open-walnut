/**
 * Every plugin App keeps a way to be seen, through a deploy and through any choice the user made.
 *
 * 2026-10-01: after a deploy the Slack App was gone from an open window, from the Sidebar AND from
 * Settings, and its plugin row in Settings → Plugins had no App row to bring it back from (the
 * App now has a tile on the Apps page, /apps, with a Sidebar / Settings / Hidden choice). Cause:
 * the server answers `/api/plugin-runtime` while it is still walking its plugins at boot; the
 * window read that partial list right after reconnecting, unloaded every plugin not reached yet,
 * and nothing told it to read again. Separately, an App unpinned from the Sidebar's menu read
 * "In sidebar" on its plugin row with no way back.
 *
 * Its own servers (plugin-restart-server.ts), because the race needs an api process that is
 * restarted under an open page while the page's origin (Vite) stays up.
 */
import { bunRuntime } from '../../helpers/bun-runtime.js'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from './shortcut-test-fixture'
import type { Page } from '@playwright/test'
import { expandSidebar, openPlugins } from './plugin-update-fixture'

const SCREENSHOT_DIR = '/tmp/plugin-app-visibility'
const APP_KEY = 'restart-demo:main'
const SIDEBAR_ROW = `sidebar-app-${APP_KEY}`

let home = ''
let apiPort = 0
let vitePort = 0
let api: ChildProcessWithoutNullStreams | null = null
let vite: ChildProcessWithoutNullStreams | null = null
let output = ''

async function reservePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Could not reserve a port')
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return address.port
}

function spawnRole(role: 'api' | 'vite'): ChildProcessWithoutNullStreams {
  const child = spawn(bunRuntime(), ['tests/e2e/browser/plugin-restart-server.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PW_RESTART_ROLE: role,
      PW_RESTART_HOME: home,
      PW_RESTART_API_PORT: String(apiPort),
      PW_RESTART_VITE_PORT: String(vitePort),
      // Three of these in a row (45 s) outlast the page's 30 s reconnect backoff cap, so a
      // reconnect always lands mid-walk; one alone stays under the 20 s activation limit.
      PW_SLOW_BOOT_MS: '15000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => { output = `${output}${String(chunk)}`.slice(-40_000) })
  child.stderr.on('data', (chunk) => { output = `${output}${String(chunk)}`.slice(-40_000) })
  return child
}

/** Resolves once `marker` appears in output written AFTER `from`. */
function waitFor(marker: string, from: number, child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`${marker} never came\n${output.slice(-8000)}`)), 180_000)
    const timer = setInterval(() => {
      if (output.slice(from).includes(marker)) {
        clearInterval(timer)
        clearTimeout(deadline)
        resolve()
      } else if (child.exitCode !== null) {
        clearInterval(timer)
        clearTimeout(deadline)
        reject(new Error(`${marker}: fixture exited (${child.exitCode})\n${output.slice(-8000)}`))
      }
    }, 200)
  })
}

async function stop(child: ChildProcessWithoutNullStreams | null): Promise<void> {
  if (!child || child.exitCode !== null) return
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  child.kill('SIGTERM')
  const graceful = await Promise.race([exited.then(() => true), new Promise<false>((r) => setTimeout(() => r(false), 20_000))])
  if (!graceful) { child.kill('SIGKILL'); await exited }
}

async function startApi(): Promise<void> {
  const from = output.length
  api = spawnRole('api')
  await waitFor('RESTART_API_READY', from, api)
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(420_000)
  await fs.mkdir(SCREENSHOT_DIR, { recursive: true })
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-plugin-restart-'))
  apiPort = await reservePort()
  vitePort = await reservePort()
  await startApi()
  const from = output.length
  vite = spawnRole('vite')
  await waitFor('RESTART_VITE_READY', from, vite)
  // A cold Vite compiles the whole SPA on the first visit, which under machine load outlasts any
  // per-test budget. Pay it once here, so each test times only what it tests.
  const warm = await browser.newPage()
  await warm.goto(`http://127.0.0.1:${vitePort}/`)
  await expect(warm.getByTestId('sidebar-core-app-home')).toBeVisible({ timeout: 240_000 })
  await warm.close()
})

test.afterAll(async () => {
  await stop(vite)
  await stop(api)
  if (home) await fs.rm(home, { recursive: true, force: true }).catch(() => {})
})

async function openHome(page: Page): Promise<void> {
  const pluginLogs: string[] = []
  page.on('console', (message) => {
    if (/\[plugins\]|plugin-runtime/.test(message.text())) pluginLogs.push(message.text().slice(0, 300))
  })
  await page.goto(`http://127.0.0.1:${vitePort}/`)
  await page.waitForLoadState('domcontentloaded')
  await expandSidebar(page)
  try {
    await expect(page.getByTestId(SIDEBAR_ROW)).toBeVisible({ timeout: 60_000 })
  } catch (error) {
    // Say what the server and the window thought, so a miss here is diagnosable from the report.
    const runtime = await (await page.request.get(`http://127.0.0.1:${apiPort}/api/plugin-runtime`)).text()
    throw new Error(`${String(error)}\nserver runtime: ${runtime.slice(0, 1500)}\nwindow: ${pluginLogs.join('\n')}`)
  }
}

/** The App's tile on the Apps page, reached from the sidebar. */
async function appTileOnApps(page: Page) {
  await openPlugins(page)
  const tile = page.getByTestId(`apps-app-${APP_KEY}`)
  await tile.scrollIntoViewIfNeeded()
  await expect(tile).toBeVisible({ timeout: 30_000 })
  return tile
}

const TOGGLE = `apps-app-toggle-${APP_KEY}`

/**
 * App choices reach the server 800 ms after the click (ui-prefs-sync). A test ends only once they
 * have, so the next test, in a fresh browser, starts from the state this one left.
 */
async function expectAppShownInSidebarOnServer(page: Page): Promise<void> {
  await expect.poll(async () => {
    const body = await (await page.request.get(`http://127.0.0.1:${apiPort}/api/ui-prefs`)).json() as {
      prefs?: Record<string, { v?: unknown }>
    }
    const raw = body.prefs?.['open-walnut-app-preferences-v1']?.v
    const prefs = (typeof raw === 'string' ? JSON.parse(raw) : raw ?? {}) as {
      hidden?: string[]; unpinned?: string[]; placement?: Record<string, string>
    }
    return !(prefs.hidden ?? []).includes(APP_KEY)
      && !(prefs.unpinned ?? []).includes(APP_KEY)
      && (prefs.placement?.[APP_KEY] ?? 'sidebar') === 'sidebar'
  }, { timeout: 15_000 }).toBe(true)
}

test.describe.configure({ mode: 'serial' })

test('an open window keeps its plugin Apps through a server restart', async ({ page }) => {
  test.setTimeout(240_000)
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  const partialAnswers: number[] = []
  page.on('response', async (response) => {
    if (!response.url().endsWith('/api/plugin-runtime') || response.request().method() !== 'GET') return
    try {
      const body = await response.json() as { loading?: boolean }
      if (body.loading) partialAnswers.push(Date.now())
    } catch { /* a body that is gone is not the one this counts */ }
  })

  const navigations: string[] = []
  page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) navigations.push(frame.url()) })
  await openHome(page)
  const navigationsBefore = navigations.length
  // Count every moment the row is missing, from now on: the bug was a row that went away and
  // stayed away, and "visible at the end" alone would pass a row that blinked.
  await page.evaluate((testId) => {
    const w = window as unknown as { __rowMissing: number }
    w.__rowMissing = 0
    new MutationObserver(() => {
      if (!document.querySelector(`[data-testid="${testId}"]`)) w.__rowMissing += 1
    }).observe(document.body, { childList: true, subtree: true })
  }, SIDEBAR_ROW)

  // The deploy: the api process dies and a new one boots over the same data.
  await stop(api)
  await startApi()
  // Past the end of the walk plus the window's own re-read.
  await page.waitForTimeout(4_000)

  await expect(page.getByTestId(SIDEBAR_ROW)).toBeVisible()
  // The same page lived through the restart (a reload would hide a blink, and reset the counter).
  expect(navigations.slice(navigationsBefore)).toEqual([])
  expect(await page.evaluate(() => (window as unknown as { __rowMissing: number }).__rowMissing)).toBe(0)
  // The race was really exercised: the window read at least one list the server marked partial.
  expect(partialAnswers.length).toBeGreaterThan(0)
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'after-restart.png'), clip: { x: 0, y: 0, width: 320, height: 720 } })

  // And the App's tile on the Apps page is there too.
  const tile = await appTileOnApps(page)
  await expect(tile).toHaveAttribute('data-shown', 'true')
  expect(pageErrors).toEqual([])
})

test('an App unpinned from the Sidebar can be pinned back from its Apps page tile', async ({ page }) => {
  test.setTimeout(180_000)
  await openHome(page)

  await page.getByTestId(SIDEBAR_ROW).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Unpin from sidebar' }).click()
  await expect(page.getByTestId(SIDEBAR_ROW)).toHaveCount(0)

  // Off the Sidebar, the App lives only on the Apps page: its switch reads off.
  const tile = await appTileOnApps(page)
  await expect(tile).toHaveAttribute('data-shown', 'false')
  await expect(page.getByTestId(TOGGLE)).toHaveAttribute('aria-checked', 'false')
  await expect(tile).toContainText('Only in Apps')
  await tile.screenshot({ path: path.join(SCREENSHOT_DIR, 'unpinned-tile.png') })

  await page.getByTestId(TOGGLE).click()
  await expect(tile).toHaveAttribute('data-shown', 'true')
  await expect(page.getByTestId(TOGGLE)).toHaveAttribute('aria-checked', 'true')
  await expect(tile).toContainText('On the sidebar')
  await expect(page.getByTestId(SIDEBAR_ROW)).toBeVisible({ timeout: 15_000 })
  await expectAppShownInSidebarOnServer(page)
})

test('an App an older build filed in Settings opens from Apps only, and Settings lists no Apps', async ({ page }) => {
  test.setTimeout(180_000)
  await openHome(page)
  // What an older build stored for "Move to settings": it reads as off the Sidebar now,
  // and nothing errors.
  const stored = { version: 2, order: [], unpinned: [], hidden: [], placement: { [APP_KEY]: 'settings' } }
  const put = await page.request.put(`http://127.0.0.1:${apiPort}/api/ui-prefs`, {
    data: { prefs: { 'open-walnut-app-preferences-v1': { v: JSON.stringify(stored), ts: Date.now() + 1_000 } } },
  })
  expect(put.ok()).toBe(true)
  await page.reload()
  await expect(page.getByTestId('sidebar-core-app-apps')).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId(SIDEBAR_ROW)).toHaveCount(0, { timeout: 15_000 })

  // Settings has no App rows any more: only the way to the Apps page.
  await page.getByTestId('sidebar-core-app-settings').click()
  await expect(page.getByTestId('settings-nav-plugin-store')).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('.settings-nav a[href^="/apps/"]')).toHaveCount(0)

  const tile = await appTileOnApps(page)
  await expect(tile).toHaveAttribute('data-shown', 'false')

  // On: on the Sidebar. Off: back to Apps only.
  await page.getByTestId(TOGGLE).click()
  await expect(page.getByTestId(SIDEBAR_ROW)).toBeVisible({ timeout: 15_000 })
  await page.getByTestId(TOGGLE).click()
  await expect(tile).toHaveAttribute('data-shown', 'false')
  await expect(page.getByTestId(SIDEBAR_ROW)).toHaveCount(0)

  // The choice survives a reload; on again restores the row.
  await page.reload()
  await expect(page.getByTestId(`apps-app-${APP_KEY}`)).toHaveAttribute('data-shown', 'false', { timeout: 60_000 })
  await page.getByTestId(TOGGLE).click()
  await expect(page.getByTestId(`apps-app-${APP_KEY}`)).toHaveAttribute('data-shown', 'true')
  await expect(page.getByTestId(SIDEBAR_ROW)).toBeVisible({ timeout: 15_000 })
  await expectAppShownInSidebarOnServer(page)
})

test('an App hidden from the Sidebar menu reads off on its tile, and its switch brings it back', async ({ page }) => {
  test.setTimeout(180_000)
  await openHome(page)
  await expect(page.getByTestId(SIDEBAR_ROW)).toBeVisible({ timeout: 30_000 })
  await page.getByTestId(SIDEBAR_ROW).click({ button: 'right' })
  // The Sidebar's menu no longer offers a way into Settings.
  await expect(page.getByRole('menuitem', { name: 'Hide app' })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: /Move to Settings/i })).toHaveCount(0)
  await page.getByRole('menuitem', { name: 'Hide app' }).click()
  await expect(page.getByTestId(SIDEBAR_ROW)).toHaveCount(0)

  const tile = await appTileOnApps(page)
  await expect(tile).toHaveAttribute('data-shown', 'false')
  await page.getByTestId(TOGGLE).click()
  await expect(tile).toHaveAttribute('data-shown', 'true')
  await expect(page.getByTestId(SIDEBAR_ROW)).toBeVisible({ timeout: 15_000 })
  await expectAppShownInSidebarOnServer(page)
})

test('a plugin whose App failed to load says so on its row, with the cause', async ({ page }) => {
  test.setTimeout(180_000)
  await openHome(page)
  await openPlugins(page)
  const failed = page.getByTestId('plugin-app-failed-broken-demo')
  await failed.scrollIntoViewIfNeeded()
  await expect(failed).toContainText("App didn't load")
  // The cause survives the refreshes after it: a later one only repeats "skipped", and used to
  // drop why. It leads, whole: behind the loader's build hash it was ellipsized out of sight.
  const reason = failed.locator('.settings-row-help')
  await expect(reason).toContainText('Broken demo fixture: activation refused')
  await expect(reason).not.toContainText(' build ')
  expect(await reason.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
  await failed.screenshot({ path: path.join(SCREENSHOT_DIR, 'failed-row.png') })
  // A plugin that loaded has its App tile and no failure row.
  await expect(page.getByTestId(`apps-app-${APP_KEY}`)).toBeVisible()
  await expect(page.getByTestId('plugin-app-failed-restart-demo')).toHaveCount(0)
})
