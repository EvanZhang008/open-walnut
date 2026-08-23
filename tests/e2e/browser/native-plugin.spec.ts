import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, test } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'

const SCREENSHOT_DIR = '/tmp/walnut-native-plugin'
let child: ChildProcessWithoutNullStreams | null = null
let fixturePort = 0
let fixtureHome = ''
let output = ''

test.setTimeout(180_000)
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
      throw new Error(`Native Plugin fixture exited early (${child?.exitCode})\n${output.slice(-12_000)}`)
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/dashboard`)
      if (response.ok) return
    } catch {
      // Startup is still in progress.
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`Timed out waiting for Native Plugin fixture\n${output.slice(-12_000)}`)
}

async function stopChild(): Promise<void> {
  if (!child || child.exitCode !== null) return
  const stopped = new Promise<void>((resolve) => child?.once('exit', () => resolve()))
  child.kill('SIGTERM')
  await Promise.race([
    stopped,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Native Plugin fixture did not stop')), 20_000)),
  ])
}

async function expandSidebar(page: import('@playwright/test').Page): Promise<void> {
  await expect(page.locator('.sidebar')).toBeVisible({ timeout: 30_000 })
  if (await page.locator('.sidebar.collapsed').count()) {
    await page.locator('.sidebar-collapse-btn').click()
    await expect(page.locator('.sidebar.collapsed')).toHaveCount(0)
  }
}

async function openSettings(page: import('@playwright/test').Page): Promise<void> {
  await expandSidebar(page)
  await page.locator('.sidebar a[href="/settings"]').click()
  await expect(page).toHaveURL(/\/settings$/)
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible({ timeout: 30_000 })
}

async function openDashboard(page: import('@playwright/test').Page): Promise<void> {
  await expandSidebar(page)
  await page.locator('.sidebar a[href="/dashboard"]').click()
  await expect(page).toHaveURL(/\/dashboard$/)
  await expect(page.getByTestId('plugin-dashboard')).toBeVisible({ timeout: 30_000 })
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

test('installs, renders, reloads, isolates a crash, recovers, and disables a Native Plugin', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  await page.goto(`http://127.0.0.1:${fixturePort}/`)
  await openSettings(page)
  await page.getByTestId('settings-nav-plugin-store').click()
  const sourceUrl = pathToFileURL(path.join(fixtureHome, 'native-plugin-repo')).href
  const pluginStore = page.locator('#plugin-store')
  await pluginStore.locator('#plugin-source-url').fill(sourceUrl)
  // Installing a plugin grants it full access, so Add stays disabled until the
  // one-time trust checkbox is ticked.
  const addButton = pluginStore.getByRole('button', { name: 'Add', exact: true })
  await expect(addButton).toBeDisabled()
  await pluginStore.getByTestId('plugin-trust-confirm').check()
  await expect(addButton).toBeEnabled()
  await addButton.click()
  await expect(page.getByText(/Added.*found 1 plugin/)).toBeVisible({ timeout: 30_000 })
  // Trust is granted per install, never sticky.
  await expect(pluginStore.getByTestId('plugin-trust-confirm')).not.toBeChecked()
  const sourceCard = page.locator('.settings-collapsible').filter({ hasText: 'native-plugin-repo' })
  await expect(sourceCard.getByText('Reference Walnut Plugin')).toBeVisible()
  await expect(sourceCard.getByText('active', { exact: true })).toBeVisible()

  await pluginStore.locator('#plugin-source-url').fill('walnut-plugin-browser-fixture@latest')
  await expect(addButton).toBeDisabled()
  await pluginStore.getByTestId('plugin-trust-confirm').check()
  await addButton.click()
  await expect(page.getByText(/Added \(walnut-plugin-browser-fixture@1\.0\.0\).*found 1 plugin/))
    .toBeVisible({ timeout: 30_000 })
  await expect(pluginStore.getByTestId('plugin-trust-confirm')).not.toBeChecked()
  const npmSourceCard = page.locator('.settings-collapsible').filter({ hasText: 'npm-walnut-plugin-browser-fixture' })
  await expect(npmSourceCard.getByText('npm Browser Fixture')).toBeVisible()
  await expect(npmSourceCard.getByText('active', { exact: true })).toBeVisible()
  await expect(npmSourceCard.getByTitle('sha512-BROWSER==')).toBeVisible()

  const agentPath = encodeURIComponent('reference-walnut:observer')
  const conversationResponseA = await page.request.post(
    `http://127.0.0.1:${fixturePort}/api/agents/${agentPath}/conversations`,
    { data: { title: 'Plugin view A' } },
  )
  const conversationResponseB = await page.request.post(
    `http://127.0.0.1:${fixturePort}/api/agents/${agentPath}/conversations`,
    { data: { title: 'Plugin view B' } },
  )
  expect(conversationResponseA.status()).toBe(201)
  expect(conversationResponseB.status()).toBe(201)
  const conversationA = (await conversationResponseA.json() as { conversation: { id: string } }).conversation.id
  const conversationB = (await conversationResponseB.json() as { conversation: { id: string } }).conversation.id

  const pluginNav = page.getByTestId('sidebar-plugin-reference-walnut:reference')
  await expect(pluginNav).toBeVisible({ timeout: 30_000 })
  await pluginNav.click()
  await expect(page).toHaveURL(/\/plugins\/reference-walnut$/)
  const pluginPage = page.getByTestId('reference-plugin-page')
  await expect(pluginPage).toBeVisible()
  await pluginPage.getByRole('button', { name: /Shared React count/ }).click()
  await pluginPage.getByRole('button', { name: /Shared React count/ }).click()
  await expect(pluginPage.getByRole('button', { name: 'Shared React count: 2' })).toBeVisible()

  await pluginPage.getByRole('button', { name: 'Show CalendarView' }).click()
  await expect(page.getByTestId('reference-plugin-calendar')).toBeVisible()
  await expect(page.getByText('Morning brief')).toBeVisible({ timeout: 30_000 })

  await openSettings(page)
  await page.getByTestId('settings-nav-reference-walnut:reference').click()
  const pluginSettings = page.locator('#reference-walnut\\:reference')
  await expect(pluginSettings).toBeVisible()
  await expect(pluginSettings.getByText('Native Plugin setting (on)')).toBeVisible()
  await pluginSettings.getByRole('checkbox').uncheck()
  await expect(pluginSettings.getByText('Native Plugin setting (off)')).toBeVisible()

  await openDashboard(page)
  let overviewPanel = page.getByTestId('plugin-panel-reference-walnut:overview')
  let activityPanel = page.getByTestId('plugin-panel-reference-walnut:activity')
  await expect(overviewPanel).toBeVisible()
  await expect(activityPanel).toBeVisible()
  await expect(overviewPanel.getByTestId('reference-plugin-server-status')).toHaveText('Server activations: 1')
  await expect(overviewPanel).toHaveAttribute('style', /grid-column: span 2/)
  await expect(activityPanel.getByTestId('reference-plugin-activity')).toBeVisible()

  await overviewPanel.getByLabel('Session ID').fill('pw-vscode-session')
  await overviewPanel.getByRole('button', { name: 'Open SessionView' }).click()
  const sessionView = overviewPanel.getByTestId('reference-plugin-session-view')
  await expect(sessionView.locator('.session-panel[data-session-id="pw-vscode-session"]')).toBeVisible({ timeout: 30_000 })
  await expect(sessionView.getByRole('button', { name: 'Close session panel' })).toBeVisible()
  await sessionView.getByRole('button', { name: 'Close session panel' }).click()
  await expect(sessionView).toHaveCount(0)

  await overviewPanel.getByRole('button', { name: 'Move Reference Overview right' }).click()
  const cells = page.locator('.plugin-dashboard-cell')
  await expect(cells.nth(0)).toHaveAttribute('data-panel-key', 'reference-walnut:activity')
  await expect(cells.nth(1)).toHaveAttribute('data-panel-key', 'reference-walnut:overview')
  await overviewPanel.getByRole('button', { name: 'Change Reference Overview width' }).click()
  await expect(overviewPanel).toHaveAttribute('style', /grid-column: span 3/)

  await overviewPanel.getByRole('button', { name: 'Show TaskView' }).click()
  const taskView = overviewPanel.getByTestId('reference-plugin-task-view')
  await expect(taskView.getByTestId('plugin-task-view')).toBeVisible({ timeout: 30_000 })
  await expect(taskView.getByText('Playwright test task')).toBeVisible()
  await taskView.getByTitle('Sort by Title').click()
  await expect.poll(() => page.evaluate(() => localStorage.getItem(
    'open-walnut-plugin:reference-walnut:task-view:overview-tasks:sort',
  ))).toContain('title')

  await overviewPanel.getByLabel('Conversation ID A').fill(conversationA)
  await overviewPanel.getByLabel('Conversation ID B').fill(conversationB)
  await overviewPanel.getByRole('button', { name: 'Open ChatViews' }).click()
  const chatA = overviewPanel.getByTestId('reference-plugin-chat-a')
  const chatB = overviewPanel.getByTestId('reference-plugin-chat-b')
  await expect(chatA.getByTestId('plugin-chat-view')).toBeVisible({ timeout: 30_000 })
  await expect(chatB.getByTestId('plugin-chat-view')).toBeVisible({ timeout: 30_000 })
  const mainDraftBefore = await page.evaluate(() => localStorage.getItem('draft:main-chat'))
  await chatA.locator('textarea').fill('Draft only in A')
  await chatB.locator('textarea').fill('Draft only in B')
  await expect.poll(() => page.evaluate(() => ({
    a: localStorage.getItem('open-walnut-plugin:reference-walnut:chat:overview-chat-a'),
    b: localStorage.getItem('open-walnut-plugin:reference-walnut:chat:overview-chat-b'),
    main: localStorage.getItem('draft:main-chat'),
  }))).toEqual({ a: 'Draft only in A', b: 'Draft only in B', main: mainDraftBefore })
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'plugin-views.png'), fullPage: true })

  await page.locator('.sidebar a[href="/"]').click()
  await expect(page).toHaveURL(new RegExp(`^http://127\\.0\\.0\\.1:${fixturePort}/$`))
  await openDashboard(page)
  overviewPanel = page.getByTestId('plugin-panel-reference-walnut:overview')
  activityPanel = page.getByTestId('plugin-panel-reference-walnut:activity')
  await expect(page.locator('.plugin-dashboard-cell').nth(0)).toHaveAttribute('data-panel-key', 'reference-walnut:activity')
  await expect(page.locator('.plugin-dashboard-cell').nth(1)).toHaveAttribute('data-panel-key', 'reference-walnut:overview')
  await expect(overviewPanel).toHaveAttribute('style', /grid-column: span 3/)
  await overviewPanel.getByRole('button', { name: 'Show TaskView' }).click()
  await expect(overviewPanel.getByTestId('reference-plugin-task-view').getByTitle('Sort by Title')).toContainText('▲')
  await overviewPanel.getByLabel('Conversation ID A').fill(conversationA)
  await overviewPanel.getByLabel('Conversation ID B').fill(conversationB)
  await overviewPanel.getByRole('button', { name: 'Open ChatViews' }).click()
  await expect(overviewPanel.getByTestId('reference-plugin-chat-a').locator('textarea')).toHaveValue('Draft only in A')
  await expect(overviewPanel.getByTestId('reference-plugin-chat-b').locator('textarea')).toHaveValue('Draft only in B')

  const installedBundle = path.join(
    fixtureHome,
    'plugin-stores',
    'native-plugin-repo',
    'dist',
    'web.mjs',
  )
  const originalBundle = await fs.readFile(installedBundle, 'utf8')
  expect(originalBundle).toContain('Reference Plugin')
  await fs.writeFile(installedBundle, originalBundle.replaceAll('Reference Plugin', 'Reference Plugin Reloaded'))
  const reload = await page.request.post(`http://127.0.0.1:${fixturePort}/api/plugin-runtime/reference-walnut/reload`)
  expect(reload.ok(), await reload.text()).toBe(true)
  await expect(pluginNav).toBeVisible({ timeout: 30_000 })
  await pluginNav.click()
  await expect(page.getByRole('heading', { name: 'Reference Plugin Reloaded' })).toBeVisible({ timeout: 30_000 })

  const crashBundle = `
const React = globalThis.__WALNUT_PLUGIN_HOST__.React;
export async function activate(walnut) {
  function CrashPage() { throw new Error('Native Plugin fixture crash'); }
  walnut.ui.nav({ id: 'reference', label: 'Reference', path: '/plugins/reference-walnut' });
  walnut.ui.page({ id: 'reference', path: '/plugins/reference-walnut', title: 'Crash fixture', component: CrashPage });
}
`
  await fs.writeFile(installedBundle, crashBundle)
  const crashReload = await page.request.post(`http://127.0.0.1:${fixturePort}/api/plugin-runtime/reference-walnut/reload`)
  expect(crashReload.ok(), await crashReload.text()).toBe(true)
  await expect(pluginNav).toBeVisible({ timeout: 30_000 })
  await pluginNav.click()
  await expect(page.getByText('Reference Walnut Plugin failed to render')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText('Native Plugin fixture crash')).toBeVisible()
  await expect(page.locator('.sidebar')).toBeVisible()

  await fs.writeFile(installedBundle, originalBundle)
  const recoveryReload = await page.request.post(`http://127.0.0.1:${fixturePort}/api/plugin-runtime/reference-walnut/reload`)
  expect(recoveryReload.ok(), await recoveryReload.text()).toBe(true)
  await expect(pluginNav).toBeVisible({ timeout: 30_000 })
  await pluginNav.click()
  await expect(page.getByTestId('reference-plugin-page')).toBeVisible({ timeout: 30_000 })
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'reference-page.png'), fullPage: true })

  const disable = await page.request.post(`http://127.0.0.1:${fixturePort}/api/plugin-runtime/reference-walnut/disable`)
  expect(disable.ok(), await disable.text()).toBe(true)
  await expect(pluginNav).toHaveCount(0, { timeout: 30_000 })
  await expect(page.locator('style[data-walnut-plugin="reference-walnut"]')).toHaveCount(0)
  await expect(page).toHaveURL(new RegExp(`^http://127\\.0\\.0\\.1:${fixturePort}/$`))

  await openDashboard(page)
  const missingActivity = page.getByTestId('plugin-panel-missing-reference-walnut:activity')
  const missingOverview = page.getByTestId('plugin-panel-missing-reference-walnut:overview')
  await expect(missingActivity).toBeVisible()
  await expect(missingOverview).toBeVisible()
  await expect(missingOverview).toContainText('Plugin is unavailable (disabled)')
  await expect(page.locator('.plugin-dashboard-cell').nth(0)).toHaveAttribute('data-panel-key', 'reference-walnut:activity')
  await expect(page.locator('.plugin-dashboard-cell').nth(1)).toHaveAttribute('data-panel-key', 'reference-walnut:overview')
  await expect(missingOverview).toHaveAttribute('style', /grid-column: span 3/)

  const restore = await page.request.post(`http://127.0.0.1:${fixturePort}/api/plugin-runtime/reference-walnut/reload`)
  expect(restore.ok(), await restore.text()).toBe(true)
  await expect(pluginNav).toBeVisible({ timeout: 30_000 })
  overviewPanel = page.getByTestId('plugin-panel-reference-walnut:overview')
  await expect(overviewPanel).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('.plugin-dashboard-cell').nth(0)).toHaveAttribute('data-panel-key', 'reference-walnut:activity')
  await expect(page.locator('.plugin-dashboard-cell').nth(1)).toHaveAttribute('data-panel-key', 'reference-walnut:overview')
  await expect(overviewPanel).toHaveAttribute('style', /grid-column: span 3/)
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'dashboard.png'), fullPage: true })

  const finalDisable = await page.request.post(`http://127.0.0.1:${fixturePort}/api/plugin-runtime/reference-walnut/disable`)
  expect(finalDisable.ok(), await finalDisable.text()).toBe(true)
  await expect(pluginNav).toHaveCount(0, { timeout: 30_000 })
  const finalMissingOverview = page.getByTestId('plugin-panel-missing-reference-walnut:overview')
  await expect(finalMissingOverview).toBeVisible({ timeout: 30_000 })
  await finalMissingOverview.getByRole('button', { name: 'Remove reference-walnut:overview' }).click()
  await expect(finalMissingOverview).toHaveCount(0)
  await expect(page.locator('style[data-walnut-plugin="reference-walnut"]')).toHaveCount(0)
  expect(pageErrors).toEqual([])
})
