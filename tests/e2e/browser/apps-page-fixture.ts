/**
 * The Apps page specs' own server: the plugin store fixture (tests/e2e/browser/plugin-store-server.ts),
 * which has installed plugins in more than one category and a plugin App (walnut-time), which the
 * shared :3457 fixture keeps out on purpose. Its data is a throwaway copy, so a switch changed in one
 * spec file never reaches another. `useAppsFixture()` boots it for the calling file (serial, one
 * server per file) and hands back its port.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { expect, test, type Page } from '@playwright/test'
import { bunRuntime } from '../../helpers/bun-runtime.js'
import { reservePort } from './fixture-port'

interface Fixture { port: number; home: string; [key: string]: unknown }

/** Another fixture server for the Apps page (its script, the line it prints when ready, its port variable). */
export interface AppsFixtureServer { script: string; readyMark: string; portEnv: string }

const PLUGIN_STORE: AppsFixtureServer = { script: 'tests/e2e/browser/plugin-store-server.ts', readyMark: 'PLUGIN_STORE_READY', portEnv: 'PW_PLUGIN_STORE_PORT' }

/**
 * Registers this file's beforeAll/afterAll; `port` (and the server's own `info`) read once
 * beforeAll has run. `server` picks a fixture other than the plugin store's.
 */
export function useAppsFixture(server: AppsFixtureServer = PLUGIN_STORE): { readonly port: number; readonly info: Fixture } {
  let child: ChildProcessWithoutNullStreams | null = null
  let fixture: Fixture | null = null
  let output = ''
  test.beforeAll(async ({ browser }) => {
    // A hook does not inherit the file's timeout, and a server plus Vite boots slowly on a busy machine.
    test.setTimeout(420_000)
    const port = await reservePort()
    child = spawn(bunRuntime(), [server.script], {
      cwd: process.cwd(),
      env: { ...process.env, [server.portEnv]: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', (chunk) => { output = `${output}${String(chunk)}`.slice(-20_000) })
    child.stderr.on('data', (chunk) => { output = `${output}${String(chunk)}`.slice(-20_000) })
    fixture = await new Promise<Fixture>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error(`fixture did not start\n${output.slice(-8000)}`)), 180_000)
      const timer = setInterval(() => {
        const match = new RegExp(`${server.readyMark} (\\{.*\\})`).exec(output)
        if (match) {
          clearInterval(timer)
          clearTimeout(deadline)
          resolve(JSON.parse(match[1]!) as Fixture)
        } else if (child?.exitCode !== null && child?.exitCode !== undefined) {
          clearInterval(timer)
          clearTimeout(deadline)
          reject(new Error(`fixture exited early (${child.exitCode})\n${output.slice(-8000)}`))
        }
      }, 250)
    })
    // A cold Vite compiles the whole SPA on the first visit, which on a busy machine outlasts a
    // per-test budget. Pay it once here, so each test times only what it tests.
    const warm = await browser.newPage()
    await warm.goto(`http://127.0.0.1:${fixture.port}/`)
    await expect(warm.getByTestId('sidebar-core-app-home')).toBeVisible({ timeout: 180_000 })
    await warm.close()
  })
  test.afterAll(async () => {
    if (!child) return
    child.kill('SIGTERM')
    await new Promise((resolve) => setTimeout(resolve, 2000))
    if (child.exitCode === null) child.kill('SIGKILL')
  })
  const started = (): Fixture => { if (!fixture) throw new Error('the Apps fixture has not started'); return fixture }
  return { get port() { return started().port }, get info() { return started() } }
}

/** Home, with the sidebar expanded. */
export async function appsHome(page: Page, port: number): Promise<void> {
  await page.goto(`http://127.0.0.1:${port}/`)
  await page.waitForLoadState('domcontentloaded')
  await expect(page.locator('.sidebar')).toBeVisible({ timeout: 60_000 })
  if (await page.locator('.sidebar.collapsed').count()) {
    await page.locator('.sidebar-collapse-btn').click()
    await expect(page.locator('.sidebar.collapsed')).toHaveCount(0)
  }
}

/**
 * Waits until the fixture server holds the page's own Apps preferences. The page mirrors them
 * to ui-prefs after an 800 ms debounce (ui-prefs-sync.ts), and a test that ends on a switch
 * click closes its page before that write leaves: the next test's page then boots from the
 * older value (here, Tasks still off the sidebar). A test that ends on a preference change
 * calls this last.
 */
export async function serverHoldsAppPreferences(page: Page, port: number): Promise<void> {
  const key = 'open-walnut-app-preferences-v1'
  await expect.poll(async () => {
    const local = await page.evaluate((k) => localStorage.getItem(k), key)
    const res = await page.request.get(`http://127.0.0.1:${port}/api/ui-prefs`)
    const body = await res.json() as { prefs?: Record<string, { v?: string | null }> }
    return body.prefs?.[key]?.v === local
  }, { timeout: 15_000 }).toBe(true)
}

/** The Apps page, the way a user opens it: the sidebar's Apps entry. */
export async function openAppsPage(page: Page): Promise<void> {
  await page.getByTestId('sidebar-core-app-apps').click()
  await expect(page).toHaveURL(/\/apps$/)
  await expect(page.getByTestId('apps-page')).toBeVisible({ timeout: 60_000 })
  // The plugin list has answered (its chips and counts come from the registry).
  await expect(page.locator('[data-testid^="plugin-card-"]').first()).toBeVisible({ timeout: 60_000 })
}
