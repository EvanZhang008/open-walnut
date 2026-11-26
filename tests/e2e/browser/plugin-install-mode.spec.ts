import { bunRuntime } from '../../helpers/bun-runtime.js'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import { backToApps, openPluginDetail } from './apps-store-helpers'
import { startProofVideo } from './proof-video'
import { reservePort } from './fixture-port'

/**
 * Plugin Store install modes on the Apps page (manifest `install`,
 * src/core/plugins/store-install-mode.ts), end to end on its own server
 * (tests/e2e/browser/plugin-install-mode-server.ts):
 *
 *   1. A source an older Walnut installed keeps the plugin it had loaded, although its store
 *      now marks that plugin optional (`legacy-keep` is on, and config.yaml records it).
 *   2. Installing a store from a link brings in its `auto` plugin only; its `optional` plugin
 *      waits under the store's section as a card with an Install button, unloaded and with no
 *      `enabled` key in config.yaml.
 *   3. Install on that card loads it live and writes `enabled: true`; Remove on its page takes
 *      it back to waiting under its source and deletes the key. The `auto` plugin has the
 *      switch to turn it off, and no Remove of its own.
 *
 * PROOF_VIDEO_DIR=<dir> records the run as a sharp MP4 (proof-video.ts).
 */

interface Fixture { port: number; home: string; teamUrl: string; legacyUrl: string }

let child: ChildProcessWithoutNullStreams | null = null
let fixture: Fixture | null = null
let output = ''

test.setTimeout(300_000)
test.describe.configure({ mode: 'serial' })
test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 })

async function pluginConfig(): Promise<Record<string, { enabled?: boolean } | undefined>> {
  const yaml = await import('js-yaml')
  const doc = yaml.load(await fs.readFile(`${fixture!.home}/config.yaml`, 'utf-8')) as { plugins?: Record<string, { enabled?: boolean }> }
  return doc.plugins ?? {}
}

const sourceSection = (page: Page, slug: string) => page.getByTestId(`apps-source-${slug}`)

test.beforeAll(async () => {
  const port = await reservePort()
  child = spawn(bunRuntime(), ['tests/e2e/browser/plugin-install-mode-server.ts'], {
    cwd: process.cwd(), env: { ...process.env, PW_PLUGIN_STORE_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => { output += String(chunk) })
  child.stderr.on('data', (chunk) => { output += String(chunk) })
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

test('auto plugins come with their store, optional ones wait for Install, and what was installed stays', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  const video = await startProofVideo(page)
  const link = `open-walnut://install-plugin?url=${encodeURIComponent(fixture!.teamUrl)}`
  // The install link opens the Apps page on its card, the way a teammate's link does.
  await page.goto(`http://localhost:${fixture!.port}/#open-link=${encodeURIComponent(link)}`)
  await expect(page.locator('#plugin-store')).toBeVisible({ timeout: 60_000 })

  // 1. The source an older Walnut installed keeps its plugin, now marked optional by its store.
  await video.caption('A store installed before install modes: its plugin stays on')
  const legacy = sourceSection(page, 'legacy-store').getByTestId('plugin-card-legacy-keep')
  await expect(legacy).toHaveAttribute('data-plugin-status', 'active', { timeout: 60_000 })
  await legacy.evaluate((el) => el.scrollIntoView({ block: 'center' }))
  await video.hold(1500)
  expect((await pluginConfig())['legacy-keep']?.enabled).toBe(true)

  // 2. Install the team store from its link: the auto plugin comes, the optional one waits.
  await page.getByTestId('plugin-link-request').scrollIntoViewIfNeeded()
  await video.caption('Install a store from a link')
  await expect(page.getByTestId('plugin-link-install')).toBeEnabled({ timeout: 30_000 })
  await video.hold()
  await page.getByTestId('plugin-link-install').click()
  await expect(page.getByTestId('plugin-link-request')).toHaveCount(0, { timeout: 60_000 })
  const team = sourceSection(page, 'team-store')
  const auto = team.getByTestId('plugin-card-team-auto')
  const pick = team.getByTestId('plugin-card-team-pick')
  await expect(auto).toHaveAttribute('data-plugin-status', 'active', { timeout: 30_000 })
  await expect(pick).toHaveAttribute('data-plugin-status', 'available')
  await expect(pick.getByTestId('plugin-card-team-pick-status')).toHaveText('Not installed')
  // It waits under its source, not under Get more.
  await expect(page.getByTestId('plugin-store-available').getByTestId('plugin-card-team-pick')).toHaveCount(0)
  await expect(page.locator('#plugin-store')).toContainText('1 plugin came on; 1 plugin waits under the source for you to press Install.')
  // Mid-screen, so the caption at the bottom never covers the cards.
  await team.evaluate((el) => el.scrollIntoView({ block: 'center' }))
  await video.caption('Team Auto came with the store; Team Pick waits for Install')
  await video.hold(1800)
  let plugins = await pluginConfig()
  expect(plugins['team-auto']?.enabled).toBe(true)
  expect(plugins['team-pick']).toBeUndefined()

  // 3. Install the optional one from its card: it loads live.
  await video.caption('Press Install on Team Pick')
  await video.hold(800)
  await pick.getByTestId('plugin-card-install-team-pick').click()
  await expect(pick).toHaveAttribute('data-plugin-status', 'active', { timeout: 30_000 })
  await expect(page.locator('#plugin-store')).toContainText('Installed Team Pick.')
  await video.caption('Team Pick is installed and on')
  await video.hold(1500)
  expect((await pluginConfig())['team-pick']?.enabled).toBe(true)

  // The auto plugin can be switched off, and has no Remove of its own (its store has one).
  await openPluginDetail(page, 'team-auto')
  await expect(page.locator('#plugin-toggle-team-auto')).toBeVisible()
  await expect(page.getByTestId('plugin-remove-group-team-auto')).toContainText('Plugins from the same source go with it')
  await video.caption('An auto plugin has its own on/off switch')
  await video.hold(1200)
  await backToApps(page)

  // Remove the optional one: back to waiting under its source, its key gone.
  await openPluginDetail(page, 'team-pick')
  await video.caption('Remove Team Pick: it goes back to waiting under its store')
  const remove = page.getByTestId('plugin-remove-team-pick')
  await expect(page.getByTestId('plugin-remove-group-team-pick')).toContainText('Its source keeps it')
  await remove.click()
  await expect(remove).toHaveText('Confirm remove')
  await video.hold(700)
  await remove.click()
  await expect(page.getByTestId('plugin-detail')).toHaveCount(0, { timeout: 30_000 })
  const waiting = sourceSection(page, 'team-store').getByTestId('plugin-card-team-pick')
  await expect(waiting).toHaveAttribute('data-plugin-status', 'available', { timeout: 30_000 })
  await expect(waiting.getByTestId('plugin-card-install-team-pick')).toBeVisible()
  await expect(page.locator('#plugin-store')).toContainText('Removed Team Pick; it waits under its source to install again.')
  await sourceSection(page, 'team-store').evaluate((el) => el.scrollIntoView({ block: 'center' }))
  await video.caption('Team Pick waits under its store again, ready to install')
  await video.hold(1500)
  plugins = await pluginConfig()
  expect(plugins['team-pick']).toBeUndefined()
  expect(plugins['team-auto']?.enabled).toBe(true)
  expect(plugins['legacy-keep']?.enabled).toBe(true)

  await video.stop('plugin-install-mode')
  expect(errors).toEqual([])
})
