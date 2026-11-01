/**
 * Runtime errors belong in the notification center, not the main chat.
 *
 * This uses the real Homepage Quick Session flow and the real mock-daemon
 * pipeline. The mock Claude CLI exits non-zero for the exact prompt "error",
 * producing the same session:error event used in production.
 *
 * The launch route is now a DRAFT session column ("+" → an empty column whose
 * cwd pill opens the same picker); the draft morphs into the `pending:` column
 * in place on Start, so the error surface asserted below is unchanged.
 */
import fs from 'node:fs/promises'
import { test, expect, type Page } from '@playwright/test'
import { draftComposer, openChatOnLoad, openDraftOnCwd } from './draft-helpers'

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

// The card's title as the feed shows it: the server publishes 'Session Error' and the
// notification humanizer words it (src/core/notifications/humanize.ts, rule session-error).
const SESSION_ERROR_CARD = 'A session hit an error'

async function startFailingQuickSession(page: Page): Promise<void> {
  // The main chat is open (the shared fixture boots with it closed), so "never in
  // main chat" is a claim about a mounted chat.
  await openChatOnLoad(page)
  await page.goto('/')
  await expect(page.locator('.main-page')).toBeVisible()

  await openDraftOnCwd(page, `${fixtureRoot}/projects/walnut`)

  const quickStartResponse = page.waitForResponse((response) =>
    response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/sessions/quick-start')
  // Send from the DRAFT column's composer (the main chat's textarea would go to
  // the Personal AI instead of launching a session).
  const chatInput = draftComposer(page)
  await chatInput.fill('error')
  await chatInput.press('Enter')
  await quickStartResponse
}

test('session errors appear only in Notifications, never in main chat', async ({ page }) => {
  await startFailingQuickSession(page)

  await expect.poll(async () => {
    const response = await page.request.get('/api/notifications')
    const data = await response.json() as {
      feed: Array<{ title: string; body?: string; sessionId?: string; taskId?: string }>
    }
    return data.feed.some((item) =>
      item.title === SESSION_ERROR_CARD && !!(item.sessionId || item.taskId))
  }, { timeout: 15_000 }).toBe(true)

  const mainChat = page.locator('.main-page-chat')
  await expect(mainChat.locator('.chat-message-notification-error')).toHaveCount(0)
  await expect(mainChat).not.toContainText('Session Error')
  await expect(mainChat).not.toContainText(SESSION_ERROR_CARD)
  await expect(mainChat).not.toContainText('Session Delivery Failed')

  // Error context stays where it is actionable: the failed start opens the session's own
  // panel (no longer a pending placeholder), which shows the error and keeps its composer,
  // so the user can send again from there.
  const sessionPanel = page.locator('.main-page-session-column .session-panel')
    .filter({ has: page.locator('.session-error-banner') }).first()
  await expect(sessionPanel.locator('.session-error-banner')).toContainText('Claude Code could not start')
  await expect(sessionPanel.locator('.chat-input-textarea')).toBeEditable()

  await page.getByRole('button', { name: 'Notifications' }).click()
  const panel = page.locator('.notification-panel')
  await expect(panel).toBeVisible()
  await expect(panel.locator('.notification-feed-item-title', { hasText: SESSION_ERROR_CARD }).first()).toBeVisible()

  // A refresh reloads persisted chat history and the durable notification feed.
  // The error must stay out of chat and remain available in Notifications.
  await page.reload()
  await expect(page.locator('.main-page')).toBeVisible()
  const reloadedMainChat = page.locator('.main-page-chat')
  await expect(reloadedMainChat.locator('.chat-message-notification-error')).toHaveCount(0)
  await expect(reloadedMainChat).not.toContainText('Session Error')
  await expect(reloadedMainChat).not.toContainText(SESSION_ERROR_CARD)
  await expect(reloadedMainChat).not.toContainText('Session Delivery Failed')

  await page.getByRole('button', { name: 'Notifications' }).click()
  await expect(panel).toBeVisible()
  await expect(panel.locator('.notification-feed-item-title', { hasText: SESSION_ERROR_CARD }).first()).toBeVisible()

  await page.screenshot({
    path: `${SCREENSHOT_DIR}/session-error-notification-only.png`,
    fullPage: true,
  })
})
