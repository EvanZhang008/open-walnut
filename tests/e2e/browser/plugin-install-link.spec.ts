import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs/promises'
import net from 'node:net'
import { expect, test, type Page } from '@playwright/test'

/**
 * A plugin install link (`open-walnut://install-plugin?…`) reaching the console,
 * by each way it arrives (web/src/utils/open-link.ts), and installing for real:
 *
 *   1. Opened as an address (`/#open-link=<link>`, what the Mac app loads for a
 *      link when no page is open): the Plugin Store opens on an "Install from a
 *      link" card, in view without scrolling, trust off, Install disabled, and the
 *      fragment is gone from the address bar. Cancel installs nothing.
 *   2. Handed to a page that is already open, the way the Mac app does
 *      (`window.__walnutDesktop.openLink`, desktop/AppLink.swift): no reload. Trust
 *      on, Install: the team pack (a real git repo, two plugins) is cloned and both
 *      plugins are on, and config.yaml has the source.
 *   3. A link to a repo that cannot be read: the error stays on the card, with
 *      Cancel; nothing is added.
 *   4. A hash change (an old app path) and a link this build does not understand.
 *
 * Opened as localhost: an install is a write, and the server refuses a write whose
 * Origin is not its own name (127.0.0.1 through the fixture's proxy is another site).
 * Its own server (tests/e2e/browser/plugin-store-server.ts): an install changes the
 * plugin list, which the shared :3457 fixture keeps empty on purpose.
 * WebKit too (PW_WEBKIT=1 --project webkit): the Mac app is a WKWebView.
 */

interface Fixture { port: number; home: string; packUrl: string }

let child: ChildProcessWithoutNullStreams | null = null
let fixture: Fixture | null = null
let output = ''

test.setTimeout(240_000)
test.describe.configure({ mode: 'serial' })
test.use({
  viewport: { width: 1280, height: 800 },
  ...(process.env.PW_VIDEO ? { video: { mode: 'on', size: { width: 1280, height: 800 } } } : {}),
})

const pause = (page: Page, ms = 1200) => (process.env.PW_VIDEO ? page.waitForTimeout(ms) : Promise.resolve())
const fragment = (link: string) => `#open-link=${encodeURIComponent(link)}`
const linkTo = (url: string, ref?: string) => `open-walnut://install-plugin?url=${encodeURIComponent(url)}${ref ? `&ref=${ref}` : ''}`

async function reservePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return address.port
}

async function configSources(): Promise<string[]> {
  const yaml = await import('js-yaml')
  const doc = yaml.load(await fs.readFile(`${fixture!.home}/config.yaml`, 'utf-8')) as { plugin_sources?: Array<{ url?: string }> }
  return (doc.plugin_sources ?? []).map((s) => s.url ?? '')
}

async function home(page: Page): Promise<void> {
  await page.goto(`http://localhost:${fixture!.port}/`)
  await expect(page.locator('.sidebar')).toBeVisible({ timeout: 60_000 })
}

/** To Routines and back to the store through the rail: the store mounts again. */
async function awayAndBack(page: Page): Promise<void> {
  if (await page.locator('.sidebar.collapsed').count()) await page.locator('.sidebar-collapse-btn').click()
  await page.getByTestId('sidebar-core-app-routines').click()
  await expect(page.locator('#plugin-store')).toHaveCount(0)
  await page.getByTestId('sidebar-core-app-apps').click()
  await expect(page.locator('#plugin-store')).toBeVisible({ timeout: 30_000 })
}

async function expectCard(page: Page, source: string): Promise<void> {
  const card = page.getByTestId('plugin-link-request')
  await expect(card).toBeVisible({ timeout: 60_000 })
  await expect(card).toBeInViewport()
  await expect(page.getByTestId('plugin-link-source')).toHaveText(source)
  await expect(page.getByTestId('plugin-link-trust')).toHaveAttribute('aria-checked', 'false')
  await expect(page.getByTestId('plugin-link-install')).toBeDisabled()
  expect(page.url()).not.toContain('open-link')
}

test.beforeAll(async () => {
  test.setTimeout(240_000)
  await fs.mkdir('/tmp/plugin-install-link', { recursive: true })
  const port = await reservePort()
  child = spawn('./node_modules/.bin/tsx', ['tests/e2e/browser/plugin-store-server.ts'], {
    cwd: process.cwd(), env: { ...process.env, PW_PLUGIN_STORE_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (c) => { output = `${output}${String(c)}`.slice(-20_000) })
  child.stderr.on('data', (c) => { output = `${output}${String(c)}`.slice(-20_000) })
  fixture = await new Promise<Fixture>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`fixture did not start\n${output.slice(-6000)}`)), 180_000)
    const timer = setInterval(() => {
      const match = /PLUGIN_STORE_READY (\{.*\})/.exec(output)
      if (match) { clearInterval(timer); clearTimeout(deadline); resolve(JSON.parse(match[1]!) as Fixture) }
      else if (child?.exitCode !== null && child?.exitCode !== undefined) { clearInterval(timer); clearTimeout(deadline); reject(new Error(`fixture exited\n${output.slice(-6000)}`)) }
    }, 250)
  })
})

test.afterAll(async () => {
  if (!child) return
  child.kill('SIGTERM')
  await new Promise((r) => setTimeout(r, 2000))
  if (child.exitCode === null) child.kill('SIGKILL')
})

test('1. a link opened as an address shows its card, trust off; Cancel installs nothing', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  const before = await configSources()
  await page.goto(`http://localhost:${fixture!.port}/${fragment(linkTo(fixture!.packUrl))}`)
  await expectCard(page, fixture!.packUrl)
  expect(new URL(page.url()).pathname).toBe('/apps')
  await pause(page, 2000)
  await page.screenshot({ path: `/tmp/plugin-install-link/${test.info().project.name}-1-card.png` })
  // The store mounted again (another page and back) still shows the link: it waits
  // until it is answered. It once vanished when Settings failed a load ("Load failed",
  // WebKit, right after a pack install) and mounted the store a second time.
  await awayAndBack(page)
  await expectCard(page, fixture!.packUrl)
  await page.getByTestId('plugin-link-cancel').click()
  await expect(page.getByTestId('plugin-link-request')).toHaveCount(0)
  await awayAndBack(page)
  await expect(page.getByTestId('plugin-link-request')).toHaveCount(0)
  await pause(page)
  expect(await configSources()).toEqual(before)
  // Checked before the reload: WebKit reports each request the reload cuts off as
  // "Fetch API cannot load … due to access control checks", even a caught one.
  expect(errors).toEqual([])
  // A reload never asks again.
  await page.reload()
  await expect(page.locator('#plugin-store')).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId('plugin-link-request')).toHaveCount(0)
})

test('2. the app hands a link to an open page in place; Install brings in the whole pack', async ({ page }) => {
  await home(page)
  await pause(page)
  await page.evaluate(() => { (window as unknown as { __noReload: boolean }).__noReload = true })
  expect(await page.evaluate((link) => window.__walnutDesktop?.openLink(link), linkTo(fixture!.packUrl, 'main'))).toBe(true)
  await expectCard(page, `${fixture!.packUrl} (branch main)`)
  expect(await page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload)).toBe(true)
  await pause(page, 1500)

  await page.getByTestId('plugin-link-trust').click()
  await expect(page.getByTestId('plugin-link-install')).toBeEnabled()
  await pause(page)
  await page.getByTestId('plugin-link-install').click()
  await expect(page.getByTestId('plugin-link-request')).toHaveCount(0, { timeout: 60_000 })
  await expect(page.locator('#plugin-store')).toContainText('found 2 plugins')
  for (const id of ['pack-notes', 'pack-board']) {
    await expect(page.getByTestId(`plugin-row-${id}`)).toHaveAttribute('data-plugin-status', 'active', { timeout: 30_000 })
  }
  expect(await configSources()).toContain(fixture!.packUrl)
  await page.getByTestId('plugin-row-pack-notes').scrollIntoViewIfNeeded()
  await pause(page, 2000)
  await page.screenshot({ path: `/tmp/plugin-install-link/${test.info().project.name}-2-installed.png` })
})

test('3. a repo that cannot be read: the error stays on the card, and nothing is added', async ({ page }) => {
  await home(page)
  const before = await configSources()
  const missing = 'file:///nonexistent/team-pack.git'
  await page.evaluate((link) => window.__walnutDesktop?.openLink(link), linkTo(missing))
  await expectCard(page, missing)
  await page.getByTestId('plugin-link-trust').click()
  await page.getByTestId('plugin-link-install').click()
  const card = page.getByTestId('plugin-link-request')
  await expect(card).toContainText(/git clone failed/i, { timeout: 30_000 })
  await expect(card).toBeVisible()
  await pause(page, 2000)
  await page.screenshot({ path: `/tmp/plugin-install-link/${test.info().project.name}-3-error.png` })
  expect(await configSources()).toEqual(before)
  await page.getByTestId('plugin-link-cancel').click()
  await expect(card).toHaveCount(0)
})

test('4. a hash change carries a link the same way; a link this build does not know changes nothing', async ({ page }) => {
  await home(page)
  expect(await page.evaluate(() => window.__walnutDesktop?.openLink('open-walnut://something-else?x=1'))).toBe(false)
  await expect(page.getByTestId('plugin-link-request')).toHaveCount(0)
  await page.evaluate((hash) => { window.location.hash = hash }, fragment(linkTo(fixture!.packUrl)))
  await expectCard(page, fixture!.packUrl)
  await pause(page)
})
