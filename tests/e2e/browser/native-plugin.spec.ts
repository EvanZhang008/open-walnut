import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, test, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'

const SCREENSHOT_DIR = '/tmp/walnut-plugin-demo'
let child: ChildProcessWithoutNullStreams | null = null
let fixturePort = 0
let fixtureHome = ''
let output = ''

test.setTimeout(240_000)
test.describe.configure({ mode: 'serial' })

async function reservePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Could not reserve a Plugin fixture port')
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return address.port
}

async function waitForServer(port: number): Promise<void> {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    if (child?.exitCode !== null) {
      throw new Error(`Plugin App fixture exited early (${child?.exitCode})\n${output.slice(-12_000)}`)
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/dashboard`)
      if (response.ok) return
    } catch {
      // Startup is still in progress.
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`Timed out waiting for Plugin App fixture\n${output.slice(-12_000)}`)
}

async function stopChild(): Promise<void> {
  if (!child || child.exitCode !== null) return
  const stopped = new Promise<void>((resolve) => child?.once('exit', () => resolve()))
  child.kill('SIGTERM')
  let timer: ReturnType<typeof setTimeout> | undefined
  const graceful = await Promise.race([
    stopped.then(() => true),
    new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), 20_000) }),
  ])
  if (timer) clearTimeout(timer)
  if (graceful) return
  child.kill('SIGKILL')
  await Promise.race([
    stopped,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Plugin App fixture did not stop')), 5_000)),
  ])
}

async function expandSidebar(page: Page): Promise<void> {
  await expect(page.locator('.sidebar')).toBeVisible({ timeout: 30_000 })
  if (await page.locator('.sidebar.collapsed').count()) {
    await page.locator('.sidebar-collapse-btn').click()
    await expect(page.locator('.sidebar.collapsed')).toHaveCount(0)
  }
}

async function openSettings(page: Page): Promise<void> {
  await expandSidebar(page)
  await page.getByTestId('sidebar-core-app-settings').click()
  await expect(page).toHaveURL(/\/settings$/)
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible({ timeout: 30_000 })
}

async function openDemo(page: Page): Promise<void> {
  await expandSidebar(page)
  await page.getByTestId('sidebar-app-walnut-demo:main').click()
  await expect(page).toHaveURL(/\/apps\/walnut-demo~main$/)
  await expect(page.getByTestId('plugin-demo-app')).toBeVisible({ timeout: 30_000 })
}

test.beforeAll(async () => {
  await fs.mkdir(SCREENSHOT_DIR, { recursive: true })
  fixturePort = await reservePort()
  child = spawn('./node_modules/.bin/tsx', ['tests/e2e/browser/test-server.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PW_TEST_PORT: String(fixturePort),
      PW_NATIVE_PLUGIN_FIXTURE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => { output = `${output}${String(chunk)}`.slice(-20_000) })
  child.stderr.on('data', (chunk) => { output = `${output}${String(chunk)}`.slice(-20_000) })
  await waitForServer(fixturePort)
  ;({ walnutHome: fixtureHome } = await discoverBrowserFixture(fixturePort))
})

test.afterAll(async () => {
  await stopChild()
})

test('installs a first-class Plugin App and exercises its real capabilities', async ({ page, context }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  await page.goto(`http://127.0.0.1:${fixturePort}/`)
  await openSettings(page)
  await page.getByTestId('settings-nav-plugin-store').click()
  const pluginStore = page.locator('#plugin-store')
  await pluginStore.locator('#plugin-source-url').fill(
    pathToFileURL(path.join(fixtureHome, 'native-plugin-repo')).href,
  )
  const addButton = pluginStore.getByRole('button', { name: 'Add', exact: true })
  await expect(addButton).toBeDisabled()
  await pluginStore.getByTestId('plugin-trust-confirm').check()
  await addButton.click()
  await expect(page.getByText(/Added.*found 1 plugin/)).toBeVisible({ timeout: 30_000 })
  await expect(pluginStore.getByTestId('plugin-trust-confirm')).not.toBeChecked()
  const sourceCard = page.locator('.settings-collapsible').filter({ hasText: 'native-plugin-repo' })
  await expect(sourceCard.getByText('Walnut Plugin Demo')).toBeVisible()
  await expect(sourceCard.getByText('active', { exact: true })).toBeVisible()
  const skillsResponse = await page.request.get(`http://127.0.0.1:${fixturePort}/api/skills`)
  if (!skillsResponse.ok()) throw new Error(`Skills catalogue failed: ${await skillsResponse.text()}`)
  const skills = await skillsResponse.json() as { skills: Array<{ dirName: string }> }
  expect(skills.skills.some((skill) => skill.dirName === 'walnut-demo')).toBe(true)

  await expandSidebar(page)
  await page.getByTestId('sidebar-core-app-home').click()
  const composer = page.locator('.main-page-chat .chat-input-textarea')
  await composer.fill('/app:walnut-demo')
  const appCommand = page.locator('.command-palette-item', { hasText: 'app:walnut-demo:main' })
  await expect(appCommand.locator('.command-palette-source-app')).toHaveText('App')
  await appCommand.click()
  await expect(page).toHaveURL(/\/apps\/walnut-demo~main$/)
  await expect(page.getByTestId('plugin-demo-app')).toBeVisible({ timeout: 30_000 })

  const app = page.getByTestId('plugin-demo-app')
  await expect(page.getByTestId('app-host-native')).toBeVisible()
  await expect(page.locator('iframe')).toHaveCount(0)
  await expect(page.locator('[data-testid="plugin-dashboard"]')).toHaveCount(0)

  await app.getByTestId('plugin-demo-action-react-count').click()
  await app.getByTestId('plugin-demo-action-react-count').click()
  await expect(app.getByTestId('plugin-demo-action-react-count')).toContainText('2')

  const demoNav = page.getByTestId('sidebar-app-walnut-demo:main')
  await app.getByTestId('plugin-demo-action-badge-count').click()
  const countBadge = demoNav.locator('.notification-badge-count')
  await expect(countBadge).toHaveText('3')
  const [navBounds, badgeBounds] = await Promise.all([demoNav.boundingBox(), countBadge.boundingBox()])
  expect(navBounds).not.toBeNull()
  expect(badgeBounds).not.toBeNull()
  expect(badgeBounds!.x).toBeGreaterThanOrEqual(navBounds!.x)
  expect(badgeBounds!.y).toBeGreaterThanOrEqual(navBounds!.y)
  expect(badgeBounds!.x + badgeBounds!.width).toBeLessThanOrEqual(navBounds!.x + navBounds!.width)
  expect(badgeBounds!.y + badgeBounds!.height).toBeLessThanOrEqual(navBounds!.y + navBounds!.height)
  await app.getByTestId('plugin-demo-action-badge-dot').click()
  await expect(demoNav.locator('.notification-badge-dot')).toBeVisible()
  await app.getByTestId('plugin-demo-action-badge-clear').click()
  await expect(demoNav.locator('.notification-badge-count, .notification-badge-dot')).toHaveCount(0)

  await app.getByTestId('plugin-demo-open-auxiliary-page').click()
  await expect(page).toHaveURL(/\/plugin-demo-about$/)
  await expect(page.getByTestId('plugin-demo-auxiliary-page')).toBeVisible()
  await expect(page.getByTestId('sidebar-app-walnut-demo:main')).toHaveCount(1)
  await openDemo(page)

  await app.getByTestId('plugin-demo-tab-web').click()
  for (const action of ['refresh-status', 'event-echo', 'web-event-emit', 'web-ops-call']) {
    await app.getByTestId(`plugin-demo-action-${action}`).click()
    await expect(app.getByTestId(`plugin-demo-receipt-${action}`)).toHaveAttribute('data-ok', 'true', {
      timeout: 30_000,
    })
  }

  await app.getByTestId('plugin-demo-tab-server').click()
  for (const action of [
    'task-create',
    'task-get',
    'task-list',
    'task-query',
    'task-children',
    'task-update',
    'task-note',
    'task-log',
    'task-complete',
    'config-read',
    'config-patch',
    'storage-roundtrip',
    'sqlite-roundtrip',
    'storage-list',
    'storage-delete',
    'secret-roundtrip',
    'timer-timeout',
    'timer-interval-start',
    'timer-interval-stop',
    'notify',
    'notify-error',
    'notify-recover',
    'ops-catalogue',
    'ops-selftest',
    'unsafe-inspect',
  ]) {
    await app.getByTestId(`plugin-demo-action-${action}`).click()
    await expect(app.getByTestId(`plugin-demo-receipt-${action}`)).toHaveAttribute('data-ok', 'true', {
      timeout: 30_000,
    })
  }
  await expect(app.getByTestId('plugin-demo-receipt-task-list')).not.toContainText('Playwright test task')
  await expect(app.getByTestId('plugin-demo-receipt-task-query')).not.toContainText('pw-task-001')
  await expect(app.getByTestId('plugin-demo-receipt-secret-roundtrip')).not.toContainText('demo-value')
  await expect(app.getByTestId('plugin-demo-receipt-ops-selftest')).toContainText('"valuesReported": false')
  await app.getByTestId('plugin-demo-probe-url').fill('http://127.0.0.1/private')
  await app.getByTestId('plugin-demo-action-http-probe').click()
  await expect(app.getByTestId('plugin-demo-receipt-http-probe')).toContainText('only fetches the fixed URL')
  await app.getByTestId('plugin-demo-action-secret-delete').click()
  await app.getByTestId('plugin-demo-action-task-cleanup').click()
  await expect(app.getByTestId('plugin-demo-receipt-task-cleanup')).toHaveAttribute('data-ok', 'true', {
    timeout: 30_000,
  })

  await app.getByTestId('plugin-demo-tab-registry').click()
  for (const action of ['tool-handler-probe', 'cron-handler-probe', 'provider-adapter-probe', 'sync-adapter-probe', 'registry-list']) {
    await app.getByTestId(`plugin-demo-action-${action}`).click()
    await expect(app.getByTestId(`plugin-demo-receipt-${action}`)).toHaveAttribute('data-ok', 'true', {
      timeout: 30_000,
    })
  }

  await app.getByTestId('plugin-demo-tab-views').click()
  await app.getByTestId('plugin-demo-view-task').click()
  await expect(app.getByTestId('plugin-demo-active-view').getByTestId('plugin-task-view')).toBeVisible({ timeout: 30_000 })
  await app.getByTestId('plugin-demo-view-calendar').click()
  await expect(app.getByTestId('plugin-demo-active-view')).toBeVisible()

  const deepLinkPage = await context.newPage()
  await deepLinkPage.goto(`http://127.0.0.1:${fixturePort}/apps/walnut-demo~main/views`)
  await expect(deepLinkPage.getByTestId('plugin-demo-app')).toBeVisible({ timeout: 30_000 })
  await expect(deepLinkPage.getByTestId('plugin-demo-section-views')).toBeVisible()
  await deepLinkPage.close()

  await app.getByTestId('plugin-demo-tab-platform').click()
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'desktop.png'), fullPage: true })
  await app.getByTestId('plugin-demo-tab-server').click()
  await app.getByTestId('plugin-demo-section-server').scrollIntoViewIfNeeded()
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'capabilities.png'), fullPage: true })

  await openSettings(page)
  await page.getByTestId('settings-nav-apps').click()
  const appRow = page.getByTestId('app-manager-row-walnut-demo:main')
  await expect(appRow).toBeVisible()
  await appRow.getByRole('button', { name: 'Move Plugin Demo up' }).click()
  const sidebarOrder = await page.locator('.sidebar-nav a[data-testid]').evaluateAll((nodes) => (
    nodes.map((node) => node.getAttribute('data-testid'))
  ))
  expect(sidebarOrder.indexOf('sidebar-app-walnut-demo:main')).toBeLessThan(
    sidebarOrder.indexOf('sidebar-core-app-routines'),
  )
  await appRow.getByRole('button', { name: 'Unpin Plugin Demo' }).click()
  await expect(demoNav).toHaveCount(0)
  await appRow.getByRole('button', { name: 'Pin Plugin Demo' }).click()
  await expect(demoNav).toBeVisible()
  await appRow.getByRole('button', { name: 'Hide Plugin Demo' }).click()
  await expect(demoNav).toHaveCount(0)
  await appRow.getByRole('button', { name: 'Open', exact: true }).click()
  await expect(page).toHaveURL(/\/apps\/walnut-demo~main$/)
  await expect(page.getByTestId('plugin-demo-app')).toBeVisible()
  await expect(demoNav).toHaveCount(0)
  await page.getByTestId('sidebar-core-app-home').click()
  const hiddenComposer = page.locator('.main-page-chat .chat-input-textarea')
  await hiddenComposer.click()
  // Typed, not filled: the palette opens off the CARET, and it renders nothing at
  // all when no command matches — so "the hidden App has no entry" only means
  // something once the palette is demonstrably open and listing other Apps.
  await hiddenComposer.pressSequentially('/app:', { delay: 15 })
  await expect(page.locator('.command-palette-item', { hasText: 'app:core:tasks' }))
    .toBeVisible({ timeout: 15_000 })
  await expect(page.locator('.command-palette-item', { hasText: 'app:walnut-demo:main' })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await hiddenComposer.fill('')
  await openSettings(page)
  await page.getByTestId('settings-nav-apps').click()
  await appRow.getByRole('button', { name: 'Show Plugin Demo' }).click()
  await appRow.getByRole('button', { name: 'Pin Plugin Demo' }).click()
  await expect(demoNav).toBeVisible()

  await page.reload()
  await expect(page.getByTestId('app-manager-row-walnut-demo:main')).toBeVisible({ timeout: 30_000 })
  await expect(demoNav).toBeVisible()
  const persistedSidebarOrder = await page.locator('.sidebar-nav a[data-testid]').evaluateAll((nodes) => (
    nodes.map((node) => node.getAttribute('data-testid'))
  ))
  expect(persistedSidebarOrder.indexOf('sidebar-app-walnut-demo:main')).toBeLessThan(
    persistedSidebarOrder.indexOf('sidebar-core-app-routines'),
  )
  expect(pageErrors).toEqual([])
})

test('reloads, isolates a render crash, restores, adapts to mobile, and disables cleanly', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.goto(`http://127.0.0.1:${fixturePort}/`)
  await openDemo(page)

  const installedBundle = path.join(
    fixtureHome,
    'plugin-stores',
    'native-plugin-repo',
    'dist',
    'web.mjs',
  )
  const originalBundle = await fs.readFile(installedBundle, 'utf8')
  expect(originalBundle).toContain('Native plugin app')
  await fs.writeFile(installedBundle, originalBundle.replace('Native plugin app', 'Native plugin app reloaded'))
  const reload = await page.request.post(`http://127.0.0.1:${fixturePort}/api/plugin-runtime/walnut-demo/reload`)
  expect(reload.ok(), await reload.text()).toBe(true)
  await openDemo(page)
  await expect(page.getByText('Native plugin app reloaded', { exact: true })).toBeVisible({ timeout: 30_000 })

  const crashBundle = `
export async function activate(walnut) {
  function CrashApp() { throw new Error('Plugin App fixture crash'); }
  walnut.ui.app({ id: 'main', title: 'Plugin Demo', component: CrashApp });
}
`
  await fs.writeFile(installedBundle, crashBundle)
  try {
    const crashReload = await page.request.post(`http://127.0.0.1:${fixturePort}/api/plugin-runtime/walnut-demo/reload`)
    expect(crashReload.ok(), await crashReload.text()).toBe(true)
    await expandSidebar(page)
    await page.getByTestId('sidebar-app-walnut-demo:main').click()
    await expect(page).toHaveURL(/\/apps\/walnut-demo~main$/)
    await expect(page.getByText('Walnut Plugin Demo failed to render')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText('Plugin App fixture crash')).toBeVisible()
    await expect(page.locator('.sidebar')).toBeVisible()
  } finally {
    await fs.writeFile(installedBundle, originalBundle)
    const recoveryReload = await page.request.post(`http://127.0.0.1:${fixturePort}/api/plugin-runtime/walnut-demo/reload`)
    if (!recoveryReload.ok()) {
      throw new Error(`Plugin recovery reload failed: ${await recoveryReload.text()}`)
    }
  }
  await openDemo(page)
  await expect(page.getByTestId('plugin-demo-app')).toBeVisible({ timeout: 30_000 })

  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('.sidebar-toggle').click()
  await page.getByTestId('sidebar-app-walnut-demo:main').click()
  await expect(page.locator('.sidebar.open')).toHaveCount(0)
  await expect(page.getByTestId('plugin-demo-layout-mode')).toContainText('compact')
  expect(await page.getByTestId('plugin-demo-app').evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
  const [toggleBounds, kickerBounds] = await Promise.all([
    page.locator('.sidebar-toggle').boundingBox(),
    page.getByText('Native plugin app', { exact: true }).boundingBox(),
  ])
  expect(toggleBounds).not.toBeNull()
  expect(kickerBounds).not.toBeNull()
  expect(kickerBounds!.y).toBeGreaterThanOrEqual(toggleBounds!.y + toggleBounds!.height)
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'mobile.png'), fullPage: true })

  const disable = await page.request.post(`http://127.0.0.1:${fixturePort}/api/plugin-runtime/walnut-demo/disable`)
  expect(disable.ok(), await disable.text()).toBe(true)
  await expect(page.getByTestId('sidebar-app-walnut-demo:main')).toHaveCount(0, { timeout: 30_000 })
  await expect(page.locator('style[data-walnut-plugin="walnut-demo"]')).toHaveCount(0)
  // Disabling the plugin while its App page is open does NOT teleport the reader
  // home. The page says the App is gone and offers the way back, which is what the
  // placement work deliberately replaced the silent bounce to `/` with — a reader
  // dropped on Home cannot tell a typo from a broken plugin.
  await expect(page.getByTestId('plugin-app-not-found')).toBeVisible({ timeout: 30_000 })
  await expect(page).toHaveURL(new RegExp(`^http://127\\.0\\.0\\.1:${fixturePort}/apps/walnut-demo~main$`))
  const statsAfterDisable = await page.request.get(`http://127.0.0.1:${fixturePort}/api/plugins/walnut-demo/stats`)
  expect(statsAfterDisable.status()).toBe(404)

  await page.setViewportSize({ width: 1280, height: 800 })
  // And the way back works: the card's own link, clicked, is how the reader leaves.
  await page.getByRole('link', { name: 'Back to Walnut' }).click()
  await expect(page).toHaveURL(new RegExp(`^http://127\\.0\\.0\\.1:${fixturePort}/$`))
  const composer = page.locator('.main-page-chat .chat-input-textarea')
  await composer.click()
  // Typed, and anchored on an App that IS there: the palette renders nothing when
  // no command matches, so a bare absence assertion would pass even if the
  // palette never opened.
  await composer.pressSequentially('/app:', { delay: 15 })
  await expect(page.locator('.command-palette-item', { hasText: 'app:core:tasks' }))
    .toBeVisible({ timeout: 15_000 })
  await expect(page.locator('.command-palette-item', { hasText: 'app:walnut-demo:main' })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await composer.fill('')
  await openSettings(page)
  await expect(page.getByTestId('settings-nav-walnut-demo:demo')).toHaveCount(0)
  expect(pageErrors).toEqual([])
})
