/**
 * Runtime errors belong in the notification center, not the main chat.
 *
 * This uses the real Homepage Quick Session flow and the real mock-daemon
 * pipeline. The mock Claude CLI exits non-zero for the exact prompt "error",
 * producing the same session:error event used in production.
 */
import fs from 'node:fs/promises'
import { test, expect, type Page } from '@playwright/test'

const API = `http://localhost:${process.env.PW_TEST_PORT ?? 3457}`
const SCREENSHOT_DIR = '/tmp/error-notification-routing'

let fixtureRoot = ''

test.beforeAll(async () => {
  const res = await fetch(`${API}/api/sessions/working-dirs`)
  const body = await res.json() as { dirs: Array<{ cwd: string }> }
  const walnut = body.dirs.find((dir) => /\/ps-fixture\/projects\/walnut$/.test(dir.cwd))
  if (!walnut) throw new Error('Playwright working-directory fixture is missing')
  fixtureRoot = walnut.cwd.replace(/\/projects\/walnut$/, '')
  await fs.mkdir(SCREENSHOT_DIR, { recursive: true })
})

async function startFailingQuickSession(page: Page): Promise<void> {
  await page.goto('/')
  await expect(page.locator('.main-page')).toBeVisible()

  await page.locator('.quick-access-pill', { hasText: /Quick session|\+ Session/ }).click()
  await expect(page.locator('.session-path-selector')).toBeVisible()

  const localTab = page.locator('.sps-host-tab', { hasText: 'Local' })
  if (await localTab.isVisible()) await localTab.click()

  const pathInput = page.locator('.sps-search-input')
  await pathInput.fill(`${fixtureRoot}/projects/walnut`)
  await pathInput.press('Shift+Enter')

  const quickStartResponse = page.waitForResponse((response) =>
    response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/sessions/quick-start')
  const chatInput = page.locator('.main-page-chat .chat-input-textarea')
  await chatInput.fill('error')
  await chatInput.press('Enter')
  await quickStartResponse
}

test('session errors appear only in Notifications, never in main chat', async ({ page }) => {
  await startFailingQuickSession(page)

  await expect.poll(async () => {
    const response = await page.request.get('/api/notifications')
    const data = await response.json() as {
      feed: Array<{ title: string; body?: string; sessionId?: string }>
    }
    return data.feed.some((item) => item.title === 'Session Error' && !!item.sessionId)
  }, { timeout: 15_000 }).toBe(true)

  const mainChat = page.locator('.main-page-chat')
  await expect(mainChat.locator('.chat-message-notification-error')).toHaveCount(0)
  await expect(mainChat).not.toContainText('Session Error')
  await expect(mainChat).not.toContainText('Session Delivery Failed')

  await page.getByRole('button', { name: 'Notifications' }).click()
  const panel = page.locator('.notification-panel')
  await expect(panel).toBeVisible()
  await expect(panel.locator('.notification-feed-item-title', { hasText: 'Session Error' }).first()).toBeVisible()

  await page.screenshot({
    path: `${SCREENSHOT_DIR}/session-error-notification-only.png`,
    fullPage: true,
  })
})
