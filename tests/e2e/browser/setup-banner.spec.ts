import fs from 'node:fs/promises'
import { expect, test, type Page, type TestInfo } from '@playwright/test'
import { openAskWalnutDrawer } from './draft-helpers'
import { showEverything } from './todo-panel-helpers'

const ready = { hasReadyProvider: true, claudeCliAvailable: true }

test.use({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1 })

const shots = `/tmp/walnut-setup-banner-${Date.now()}`
test.beforeAll(async () => { await fs.mkdir(shots, { recursive: true }) })
test.beforeEach(async ({ page }) => {
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

async function openHome(page: Page, baseURL: string, waitForHealth = true) {
  const healthLoaded = waitForHealth ? page.waitForResponse('**/api/system/health') : undefined
  await page.setContent(`<a href="${baseURL}/">Open Walnut</a>`)
  await page.getByRole('link', { name: 'Open Walnut' }).click()
  await expect(page.locator('[data-testid="ask-walnut-slot"]')).toBeVisible()
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
  await expect(page.locator('.setup-banner')).toHaveCount(0)

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
  await expect(page.locator('.setup-banner')).toHaveCount(0)
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
  await expect(page.locator('.setup-banner')).toHaveCount(0)
})

test('pending health stays quiet and incomplete setup keeps its Settings link', async ({ page, baseURL }, testInfo) => {
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  await page.route('**/api/system/health', async route => {
    await pending
    await route.fulfill({ json: { hasReadyProvider: false, claudeCliAvailable: false } })
  })
  try {
    await openHome(page, baseURL!, false)
    await expect(page.locator('.setup-banner')).toHaveCount(0)
  } finally {
    release()
  }
  const banner = page.getByTestId('setup-banner-install')
  await expect(banner).toBeVisible()
  await screenshot(page, testInfo, 'incomplete-setup')
  await banner.getByRole('button', { name: 'Settings' }).click()
  await expect(page).toHaveURL(/\/settings#providers$/)
  await expect(page.locator('.settings-layout')).toBeVisible()
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
  await expect(page.locator('.setup-banner')).toHaveCount(0)
})
