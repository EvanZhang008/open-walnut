/**
 * Playwright browser test: a session stuck on "Prompt is too long" offers the action that works.
 *
 * Reported (2026-11-05): every turn of a session answered "Prompt is too long" and the red banner
 * offered only Reconnect, which cannot help. The banner now says the conversation no longer fits,
 * says when Walnut is compacting it by itself, and otherwise offers Compact and resend, which posts
 * the same Retry route (the server compacts for this error: src/core/sessions/context-full-recovery.ts).
 *
 * Only the session HTTP responses are shaped (the fixture session is healthy, so the error has to
 * be injected); every click is the real app.
 */
import fs from 'node:fs/promises'
import { test, expect, type Locator, type Page } from '@playwright/test'
import { dropFakes } from './route-teardown'

const SESSION_ID = 'pw-vscode-session'
const TASK_ID = 'pw-task-vscode'
const SCREENSHOT_DIR = '/tmp/session-context-full-banner'

test.use({ viewport: { width: 1280, height: 860 } })
test.describe.configure({ timeout: 90_000 })

test.beforeAll(async () => {
  await fs.mkdir(SCREENSHOT_DIR, { recursive: true })
})

/** Make the fixture session read as stuck on a full context, with `recovery` as Walnut's state. */
async function fullContext(page: Page, recovery?: Record<string, unknown>): Promise<void> {
  const at = new Date().toISOString()
  await page.route(/\/api\/sessions\/pw-vscode-session(\?|$)/, async (route) => {
    const response = await route.fetch()
    const body = await response.json() as { session?: Record<string, unknown> }
    await route.fulfill({
      json: {
        ...body,
        session: {
          ...(body.session ?? {}),
          host: 'devhost', hostname: 'devhost.example',
          process_status: 'error', errorMessage: 'Prompt is too long', last_status_change: at,
          ...(recovery ? { contextRecovery: { at, attempts: [], ...recovery } } : {}),
        },
      },
    })
  })
  await page.route(/\/api\/sessions\/status\?/, async (route) => {
    const response = await route.fetch()
    const body = await response.json() as { statuses?: Record<string, Record<string, unknown>> }
    const statuses = { ...(body.statuses ?? {}) }
    const existing = statuses[SESSION_ID]
    if (existing) {
      statuses[SESSION_ID] = {
        ...existing, process_status: 'error', errorMessage: 'Prompt is too long',
        statusRevision: Number(existing.statusRevision ?? 0) + 1000, statusUpdatedAt: at,
      }
    }
    await route.fulfill({ json: { ...body, statuses } })
  })
  await page.route(/\/api\/sessions\/pw-vscode-session\/recheck$/, async (route) => {
    await route.fulfill({ json: { sessionId: SESSION_ID, checked: false, reachable: false, processStatus: 'error', infraClaim: false } })
  })
}

async function openSessionPanel(page: Page): Promise<Locator> {
  await page.locator('.todo-search-input').fill(SESSION_ID)
  const task = page.locator(`.todo-panel-item[data-task-id="${TASK_ID}"]`)
  await expect(task).toBeVisible()
  await task.locator('.todo-item-title').click()
  const panel = page.locator(`.session-panel[data-session-id="${SESSION_ID}"]`)
  await expect(panel).toBeVisible()
  return panel
}

test.afterEach(async ({ page }) => {
  await dropFakes(page)
})

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.todo-search-input')).toBeVisible({ timeout: 60_000 })
})

test('stuck on "Prompt is too long": Compact and resend, never Reconnect', async ({ page }) => {
  await fullContext(page)
  let retried = 0
  await page.route(/\/api\/sessions\/pw-vscode-session\/retry$/, async (route) => {
    retried++
    await route.fulfill({ json: { status: 'compacting', sessionId: SESSION_ID } })
  })
  const panel = await openSessionPanel(page)
  const banner = panel.locator('.session-error-banner[data-context-full]')
  await expect(banner).toContainText('no longer fits the model’s context window')
  await expect(banner).toContainText('Compact it to go on')
  await expect(panel.locator('.session-error-banner', { hasText: 'Reconnect' })).toHaveCount(0)
  await expect(panel.getByRole('button', { name: 'Reconnect' })).toHaveCount(0)
  await banner.screenshot({ path: `${SCREENSHOT_DIR}/stuck.png` })

  await banner.getByRole('button', { name: 'Compact and resend' }).click()
  await expect.poll(() => retried).toBe(1)
})

test('while Walnut compacts it, the banner says so and offers no button', async ({ page }) => {
  await fullContext(page, { state: 'compacting' })
  const panel = await openSessionPanel(page)
  const banner = panel.locator('.session-error-banner[data-context-full]')
  await expect(banner).toContainText('Walnut is compacting it, then resends the messages that got no answer')
  await expect(banner.getByRole('button')).toHaveCount(0)
  await banner.screenshot({ path: `${SCREENSHOT_DIR}/compacting.png` })
})

test('when the recovery failed, the banner gives its reason and the button again', async ({ page }) => {
  await fullContext(page, { state: 'failed', reason: 'The compaction itself did not fit the context window.' })
  const panel = await openSessionPanel(page)
  const banner = panel.locator('.session-error-banner[data-context-full]')
  await expect(banner).toContainText('The compaction itself did not fit the context window.')
  await expect(banner.getByRole('button', { name: 'Compact and resend' })).toBeVisible()
  await banner.screenshot({ path: `${SCREENSHOT_DIR}/failed.png` })
})
