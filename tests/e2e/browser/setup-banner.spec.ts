/**
 * This machine's Claude Code / AI provider notice: quiet while setup is fine,
 * pending or unknown, and a notice with its Settings link or its x when it is
 * not. On Home it lives in the notification panel only (All and Errors lead
 * with it, nfc-local-claude); `.setup-banner` is the first-use screen's form,
 * which no page here may show.
 */
import fs from 'node:fs/promises'
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import { openAskWalnutDrawer, openChatOnLoad } from './draft-helpers'
import { showEverything } from './todo-panel-helpers'
import { openBell } from './host-problems-fixture-helpers'
import { closePanel, panelLocalCard, pickRail } from './host-attention-helpers'

const ready = { hasReadyProvider: true, claudeCliAvailable: true }

test.use({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1 })

const shots = `/tmp/walnut-setup-banner-${Date.now()}`
test.beforeAll(async () => { await fs.mkdir(shots, { recursive: true }) })
test.beforeEach(async ({ page }) => {
  // Every scenario reads the Ask Walnut slot, and the shared fixture boots with the
  // chat closed (it remembers a closed chat).
  await openChatOnLoad(page)
  await page.routeWebSocket('**/ws*', ws => {
    const server = ws.connectToServer()
    server.onMessage(message => {
      const frame = JSON.parse(message.toString())
      if (frame.type !== 'event' || frame.name !== 'system:health') ws.send(message)
    })
  })
})

async function screenshot(page: Page, info: TestInfo, name: string) {
  await page.screenshot({ path: `${shots}/${info.project.name}-${name}.png` })
}

async function settleHealth(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  }))
}

/** Open the bell on All, where the local notice leads when it shows; returns the notice. */
async function openLocalNotice(page: Page): Promise<Locator> {
  await openBell(page)
  await pickRail(page, 'All')
  return panelLocalCard(page)
}

/** No local notice: none on the page, none in the notification panel. */
async function expectQuiet(page: Page) {
  await expect(page.locator('.setup-banner')).toHaveCount(0)
  await expect(await openLocalNotice(page)).toHaveCount(0)
  await closePanel(page, 'escape')
}

async function openHome(page: Page, baseURL: string, waitForHealth = true) {
  const healthLoaded = waitForHealth ? page.waitForResponse('**/api/system/health') : undefined
  await page.setContent(`<a href="${baseURL}/">Open Walnut</a>`)
  await page.getByRole('link', { name: 'Open Walnut' }).click()
  // A cold first load of the chat slot takes longer than the 5 s default.
  await expect(page.locator('[data-testid="ask-walnut-slot"]')).toBeVisible({ timeout: 20_000 })
  if (healthLoaded) {
    await (await healthLoaded).finished()
    await settleHealth(page)
  }
}

test('ready Claude Code stays quiet through an existing session, new chat, and reload', async ({ page, baseURL }, testInfo) => {
  test.setTimeout(120_000)
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/api/system/health', route => route.fulfill({ json: {
    ...ready, mainProvider: 'claude_cli', claudeCliAuth: 'Bedrock (us-west-2)',
  } }))
  await openHome(page, baseURL!)
  await showEverything(page)
  await screenshot(page, testInfo, 'home')
  await expectQuiet(page)

  await page.locator('.todo-search-input').fill('pw-quote-session')
  const task = page.locator('.todo-panel-item[data-task-id="pw-task-quote"]')
  await expect(task).toBeVisible()
  await task.locator('.todo-item-title').click()
  const session = page.locator('.main-page-session-column .session-panel[data-session-id="pw-quote-session"]')
  await expect(session).toBeVisible()
  await expect(session.locator('.session-history')).toBeVisible()
  await expect(page.locator('.setup-banner')).toHaveCount(0)
  await page.locator('.todo-search-input').fill('')
  await screenshot(page, testInfo, 'session')

  const healthReloaded = page.waitForResponse('**/api/system/health')
  await page.reload()
  await (await healthReloaded).finished()
  await settleHealth(page)
  await expect(session).toBeVisible()
  await expectQuiet(page)
  await openAskWalnutDrawer(page)
  await page.getByTestId('ask-walnut-new').click()
  await expect(page.getByTestId('ask-walnut-draft')).toBeVisible()
  await expect(page.locator('.setup-banner')).toHaveCount(0)
  expect(errors).toEqual([])
})

test('an auto-detected provider shows no account notice', async ({ page, baseURL }) => {
  await page.route('**/api/system/health', route => route.fulfill({ json: {
    ...ready, mainProvider: 'bedrock', credentialSource: 'env',
    credentialDetail: 'profile: example-profile-with-a-long-display-name',
  } }))
  await openHome(page, baseURL!)
  await expectQuiet(page)
})

test('pending health stays quiet and incomplete setup keeps its Settings link', async ({ page, baseURL }, testInfo) => {
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  await page.route('**/api/system/health', async route => {
    await pending
    await route.fulfill({ json: { hasReadyProvider: false, claudeCliAvailable: false } })
  })
  let local: Locator
  try {
    await openHome(page, baseURL!, false)
    await expect(page.locator('.setup-banner')).toHaveCount(0)
    // The panel open while the health is still unknown: no notice yet.
    local = await openLocalNotice(page)
    await expect(local).toHaveCount(0)
  } finally {
    release()
  }
  // The answer arrives with the panel open: the notice leads All.
  const banner = local!.getByTestId('setup-banner-install')
  await expect(banner).toBeVisible({ timeout: 10_000 })
  await expect(page.locator('.setup-banner')).toHaveCount(0)
  await screenshot(page, testInfo, 'incomplete-setup')
  await banner.getByRole('button', { name: 'Settings' }).click()
  await expect(page.locator('.notification-panel')).toHaveCount(0)
  await expect(page).toHaveURL(/\/settings#providers$/)
  await expect(page.locator('.settings-layout')).toBeVisible()
  // Pane mode: the deep link opens Advanced, where the API provider is folded.
  await expect(page.getByTestId('settings-nav-advanced')).toHaveAttribute('aria-current', 'page')
  await expect(page.locator('#providers')).toBeVisible({ timeout: 20_000 })
})

test('a failed health request does not invent a setup warning', async ({ page, baseURL }) => {
  await page.route('**/api/system/health', route => route.fulfill({ status: 503, json: { error: 'Temporarily unavailable' } }))
  await openHome(page, baseURL!)
  await expect(page.locator('.setup-banner')).toHaveCount(0)
  const healthReloaded = page.waitForResponse('**/api/system/health')
  await page.reload()
  await (await healthReloaded).finished()
  await settleHealth(page)
  await expect(page.getByTestId('ask-walnut-slot')).toBeVisible()
  await expectQuiet(page)
})

// Local models: Walnut's calls on Ollama, sessions on another engine. Claude Code is
// missing and nothing needs it, so no notice asks for it; Ollama down shows its own notice.
const localModels = {
  hasReadyProvider: true, claudeCliAvailable: false, claudeCodeNeeded: false,
  mainProvider: 'ollama', mainProviderLocal: true, credentialSource: 'config',
  credentialDetail: 'ollama (http://localhost:11434)',
}

test('local models: no Claude Code notice while Ollama answers, a provider notice when it stops', async ({ page, baseURL }, testInfo) => {
  test.setTimeout(120_000)
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  let health: Record<string, unknown> = localModels
  await page.route('**/api/system/health', route => route.fulfill({ json: health }))
  await openHome(page, baseURL!)
  await openLocalNotice(page)
  await expect(page.getByTestId('setup-banner-install')).toHaveCount(0)
  await expect(page.getByTestId('setup-banner-provider')).toHaveCount(0)
  await screenshot(page, testInfo, 'local-models-ready')
  await closePanel(page, 'escape')

  health = { ...localModels, hasReadyProvider: false, credentialSource: 'none', credentialDetail: 'http://localhost:11434' }
  const reloaded = page.waitForResponse('**/api/system/health')
  await page.reload()
  await (await reloaded).finished()
  await settleHealth(page)
  const local = await openLocalNotice(page)
  await expect(local).toHaveAttribute('data-kind', 'provider')
  const card = local.getByTestId('setup-banner-provider')
  await expect(card).toBeVisible()
  await expect(card).toContainText('Walnut runs on Ollama, and it is not answering at http://localhost:11434.')
  await expect(card).not.toContainText('Claude Code')
  await expect(page.getByTestId('setup-banner-install')).toHaveCount(0)
  await screenshot(page, testInfo, 'local-models-ollama-down')

  await card.getByRole('button', { name: 'Dismiss AI provider notice' }).click()
  await expect(page.getByTestId('setup-banner-provider')).toHaveCount(0)
  await expect(local).toHaveCount(0)
  expect(errors).toEqual([])
})
