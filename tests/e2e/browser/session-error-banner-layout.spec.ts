/**
 * Playwright browser test: an error banner must not leave a blank band under it.
 *
 * Reported (2026-09-11, Mac app): a session in `error` showed its red banner and
 * then ~76px of empty panel before the Files toolbar / chat. Root cause: the
 * glass header is position:absolute, so BOTH the banner (margin-top) and the
 * content below it (split padding-top, history padding-top) compensate for the
 * header height. With a banner in flow the second compensation is dead space.
 *
 * What this spec drives with real clicks, in chat-only AND split (Files) mode:
 *   - with a banner: the content below it starts within a few px of the banner;
 *   - without a banner: the content still clears the glass header (the
 *     compensation is only dropped when a flow sibling already provides it).
 *
 * Only the session HTTP responses are shaped (the fixture session is healthy, so
 * 'error' has to be injected); every click and every layout is the real app.
 */
import fs from 'node:fs/promises'
import { test, expect, type Locator, type Page } from '@playwright/test'

const SESSION_ID = 'pw-vscode-session'
const TASK_ID = 'pw-task-vscode'
const SCREENSHOT_DIR = '/tmp/session-error-banner-layout'
const FROZEN_ERROR = 'Connection lost — unable to reach remote host'
/** Banner margin-bottom is 4px; anything beyond a hairline over that is the bug. */
const MAX_GAP_PX = 12

test.use({ viewport: { width: 1280, height: 860 } })

test.beforeAll(async () => {
  await fs.mkdir(SCREENSHOT_DIR, { recursive: true })
})

/** Make the fixture session look frozen-in-error to the whole app (record + status snapshot). */
async function freezeSessionInError(page: Page): Promise<void> {
  await page.route(/\/api\/sessions\/pw-vscode-session(\?|$)/, async (route) => {
    const response = await route.fetch()
    const body = await response.json() as { session?: Record<string, unknown> }
    await route.fulfill({
      json: {
        ...body,
        session: {
          ...(body.session ?? {}),
          host: 'devhost',
          hostname: 'devhost.example',
          process_status: 'error',
          errorMessage: FROZEN_ERROR,
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
        ...existing,
        process_status: 'error',
        errorMessage: FROZEN_ERROR,
        statusRevision: Number(existing.statusRevision ?? 0) + 1000,
        statusUpdatedAt: new Date().toISOString(),
      }
    }
    await route.fulfill({ json: { ...body, statuses } })
  })
  // The recheck proves nothing, so the banner keeps its sentence and stays put.
  await page.route(/\/api\/sessions\/pw-vscode-session\/recheck$/, async (route) => {
    await route.fulfill({ json: {
      sessionId: SESSION_ID, checked: false, reachable: false, processStatus: 'error',
      infraClaim: true, reason: 'no_pooled_connection',
    } })
  })
}

/** Open the fixture session's panel from the homepage (real clicks, no deep link). */
async function openSessionPanel(page: Page): Promise<Locator> {
  await page.locator('.todo-search-input').fill(SESSION_ID)
  const task = page.locator(`.todo-panel-item[data-task-id="${TASK_ID}"]`)
  await expect(task).toBeVisible()
  await task.locator('.todo-item-title').click()
  const panel = page.locator(`.session-panel[data-session-id="${SESSION_ID}"]`)
  await expect(panel).toBeVisible()
  return panel
}

async function openFiles(panel: Locator): Promise<void> {
  await panel.getByRole('button', { name: 'Files' }).click()
  await expect(panel.locator('.session-file-explorer')).toBeVisible({ timeout: 15_000 })
}

async function box(locator: Locator) {
  const b = await locator.boundingBox()
  expect(b, `${locator} must be laid out`).not.toBeNull()
  return b!
}

async function paddingTop(locator: Locator): Promise<number> {
  return locator.evaluate((el) => parseFloat(getComputedStyle(el).paddingTop))
}

test.describe.configure({ timeout: 90_000 })

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {})
})

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.todo-search-input')).toBeVisible({ timeout: 60_000 })
})

test('error banner + Files split: the toolbars start right under the banner', async ({ page }) => {
  await freezeSessionInError(page)
  const panel = await openSessionPanel(page)
  const banner = panel.locator('.session-error-banner').first()
  await expect(banner).toContainText('Connection lost')
  await openFiles(panel)

  const split = panel.locator('.session-panel-split.is-changed-open')
  // Banner bottom → column top, read in one settled frame (the header height is
  // live, and the banner rides on it).
  const gaps = async () => {
    const b = await box(banner)
    const filesCol = await box(panel.locator('.session-panel-diff-col').first())
    const chatBar = await box(panel.locator('.session-chat-bar'))
    return { files: filesCol.y - (b.y + b.height), chat: chatBar.y - (b.y + b.height) }
  }
  await expect.poll(async () => Math.max(...Object.values(await gaps())), {
    message: 'Files column / chat bar must start right under the banner',
  }).toBeLessThanOrEqual(MAX_GAP_PX)
  const settled = await gaps()
  expect(settled.files, `Files column sits ${settled.files}px below the banner`).toBeLessThanOrEqual(MAX_GAP_PX)
  expect(settled.chat, `Chat bar sits ${settled.chat}px below the banner`).toBeLessThanOrEqual(MAX_GAP_PX)
  expect(await paddingTop(split), 'split must not pad for a header the banner already cleared').toBeLessThanOrEqual(1)
  await panel.screenshot({ path: `${SCREENSHOT_DIR}/files-split-with-banner.png` })
})

test('error banner + chat only: the history starts right under the banner', async ({ page }) => {
  await freezeSessionInError(page)
  const panel = await openSessionPanel(page)
  const banner = panel.locator('.session-error-banner').first()
  await expect(banner).toContainText('Connection lost')

  const history = panel.locator('.session-history')
  await expect(history).toBeVisible()
  const bannerBox = await box(banner)
  const historyBox = await box(history)

  await panel.screenshot({ path: `${SCREENSHOT_DIR}/chat-only-with-banner.png` })

  const gap = historyBox.y - (bannerBox.y + bannerBox.height)
  expect(gap, `history box sits ${gap}px below the banner`).toBeLessThanOrEqual(MAX_GAP_PX)
  // The scroll area's own top padding is the second half of the double count.
  expect(await paddingTop(history), 'history must not pad for a header the banner already cleared').toBeLessThanOrEqual(16)
})

test('no banner: content still clears the glass header (Files split and chat only)', async ({ page }) => {
  const panel = await openSessionPanel(page)
  await expect(panel.locator('.session-error-banner')).toHaveCount(0)
  const header = panel.locator('.session-panel-header')

  // Chat only: the history extends under the header and pads for it. The header
  // height is live (a ResizeObserver feeds --sp-header-h), so read both in the
  // same settled frame rather than comparing against an earlier measurement.
  const history = panel.locator('.session-history')
  await expect.poll(async () => (await paddingTop(history)) - (await box(header)).height, {
    message: 'without a banner the history keeps its header padding',
  }).toBeGreaterThanOrEqual(0)

  // Files split: the columns start below the header, not under it.
  await openFiles(panel)
  await expect.poll(async () => {
    const h = await box(header)
    const filesCol = await box(panel.locator('.session-panel-diff-col').first())
    const chatBar = await box(panel.locator('.session-chat-bar'))
    return Math.min(filesCol.y, chatBar.y) - (h.y + h.height)
  }, { message: 'Files column and chat bar must not be buried under the header' }).toBeGreaterThanOrEqual(-1)
  await panel.screenshot({ path: `${SCREENSHOT_DIR}/files-split-no-banner.png` })
})
