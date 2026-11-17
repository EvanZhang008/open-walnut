/**
 * A session's runtime error shows in the session's own panel and in Walnut Health, never in
 * the main chat, as a toast or in the bell (src/core/notifications/audience.ts: it is Walnut's
 * to fix; 2026-11-17, the user: only the errors he needs to see).
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
  await expect(page.locator('.main-page')).toBeVisible({ timeout: 45_000 })

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

/** The bell's Errors view holds no card for it; its one line leads to Walnut Health, which does. */
async function expectOnlyInWalnutHealth(page: Page, dedupKey: string): Promise<void> {
  await page.getByRole('button', { name: 'Notifications' }).click()
  const panel = page.locator('.notification-panel')
  await expect(panel).toBeVisible()
  await panel.locator('.nfc-rail-btn', { hasText: 'Errors' }).first().click()
  await expect(panel.locator('.notification-feed-item-title', { hasText: SESSION_ERROR_CARD })).toHaveCount(0)
  await panel.getByTestId('nfc-health-link').click()
  const row = page.locator(`[data-testid=health-errors-row][data-key="${dedupKey}"]`)
  await expect(row).toBeVisible({ timeout: 20_000 })
  await expect(row).toContainText(SESSION_ERROR_CARD)
}

test('session errors appear in their panel and in Walnut Health, never in main chat or the bell', async ({ page }) => {
  await startFailingQuickSession(page)

  let dedupKey = ''
  await expect.poll(async () => {
    const response = await page.request.get('/api/notifications')
    const data = await response.json() as {
      feed: Array<{ title: string; dedupKey: string; audience?: string; sessionId?: string; taskId?: string; lastTimestamp?: number; timestamp: number }>
    }
    const item = data.feed
      .filter((n) => n.title === SESSION_ERROR_CARD && !!(n.sessionId || n.taskId) && n.audience === 'health')
      .sort((a, b) => (b.lastTimestamp ?? b.timestamp) - (a.lastTimestamp ?? a.timestamp))[0]
    dedupKey = item?.dedupKey ?? ''
    return !!item
  }, { timeout: 15_000 }).toBe(true)
  await expect(page.locator('.notification-toast', { hasText: SESSION_ERROR_CARD })).toHaveCount(0)

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

  await expectOnlyInWalnutHealth(page, dedupKey)

  // A refresh reloads persisted chat history and the durable feed: the error stays out of
  // chat and the bell, and stays in Walnut Health. (A fresh load of Home: the step above left
  // the page on Settings.)
  await page.goto('/')
  await expect(page.locator('.main-page')).toBeVisible({ timeout: 45_000 })
  const reloadedMainChat = page.locator('.main-page-chat')
  await expect(reloadedMainChat.locator('.chat-message-notification-error')).toHaveCount(0)
  await expect(reloadedMainChat).not.toContainText('Session Error')
  await expect(reloadedMainChat).not.toContainText(SESSION_ERROR_CARD)
  await expect(reloadedMainChat).not.toContainText('Session Delivery Failed')

  await expectOnlyInWalnutHealth(page, dedupKey)

  await page.screenshot({
    path: `${SCREENSHOT_DIR}/session-error-walnut-health-only.png`,
    fullPage: true,
  })
})
