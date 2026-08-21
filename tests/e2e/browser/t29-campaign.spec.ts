/**
 * T29 campaign verification — real-UI checks for three surfaces:
 *
 *  1. Session finder (SessionSearchPanel): opens from the QuickAccessBar pill
 *     and via the keyboard shortcut, filters server-side (`/api/sessions/recent?q=`),
 *     and Escape clears-then-closes.
 *  2. TODO panel quick-add: Enter creates a task that appears in the list;
 *     Escape abandons a draft without poisoning the next quick-add.
 *  3. NotificationPanel host status: Remote Hosts rows say Connected/Disconnected
 *     (never the old 'Idle') and the bridge marker renders only when a cloud
 *     bridge is configured (fixture has none → marker absent, no crash).
 *
 * The last test is a continuous demo of flows 1+2 recorded to video
 * (file-level `video: 'on'`); the runner copies the .webm out of test-results.
 *
 * All interactions are real UI clicks/keys — the only page.goto() is the
 * initial load, matching the house rule.
 */
import fs from 'node:fs/promises'
import { test, expect, type Page } from '@playwright/test'
import { presetPanelView } from './todo-panel-helpers'

const SCREENSHOT_DIR = '/tmp/t29-campaign/shots'

// Quick-add mutates shared server task state; run this file's tests in order
// on one worker instead of fullyParallel to keep list assertions deterministic.
test.describe.configure({ mode: 'default' })

test.use({ video: { mode: 'on', size: { width: 1280, height: 800 } }, viewport: { width: 1280, height: 800 } })

test.beforeAll(async () => {
  await fs.mkdir(SCREENSHOT_DIR, { recursive: true })
})

/** The session-finder pill ("⌕ Sessions") — distinct from the "+ Session" launcher pill. */
function finderPill(page: Page) {
  return page.locator('.quick-access-pill', { hasText: 'Sessions' })
}

async function openHome(page: Page) {
  await page.goto('/')
  await expect(page.locator('.main-page')).toBeVisible()
}

test('session finder: pill opens, query filters results, Escape clears then closes', async ({ page }) => {
  await openHome(page)

  await finderPill(page).click()
  const panel = page.locator('.session-search-panel')
  await expect(panel).toBeVisible()
  const input = panel.locator('.session-search-input')
  await expect(input).toBeFocused()

  // Empty query = recent list (the fixture seeds hundreds of sessions).
  await expect(panel.locator('.session-search-result').first()).toBeVisible({ timeout: 10_000 })

  // Multi-term query: both terms must match, so only the plan session survives.
  await input.fill('plan investigate')
  const results = panel.locator('.session-search-result')
  await expect(results).toHaveCount(1, { timeout: 10_000 })
  await expect(results.first().locator('.session-search-title')).toHaveText('Plan: investigate auth module')

  await page.screenshot({ path: `${SCREENSHOT_DIR}/finder-open-filtered.png` })

  // First Escape clears the query (panel stays), second closes the panel.
  await input.press('Escape')
  await expect(input).toHaveValue('')
  await expect(panel).toBeVisible()
  await input.press('Escape')
  await expect(panel).toBeHidden()
})

test('session finder: keyboard shortcut toggles the panel', async ({ page }) => {
  await openHome(page)

  await page.keyboard.press('ControlOrMeta+Shift+O')
  const panel = page.locator('.session-search-panel')
  await expect(panel).toBeVisible()
  await expect(panel.locator('.session-search-input')).toBeFocused()

  await page.keyboard.press('ControlOrMeta+Shift+O')
  await expect(panel).toBeHidden()
})

test('quick add: Enter creates a task; Escape abandons a draft without side effects', async ({ page }) => {
  // Stacked "All" section + unscoped project chip so the quick-add form and
  // the main task list are both mounted on first render.
  await presetPanelView(page, { section: 'all', project: '' })
  await openHome(page)

  const addInput = page.locator('.todo-panel-add input[placeholder="Quick add task..."]')
  await expect(addInput).toBeVisible({ timeout: 15_000 })

  // 1. Enter creates the task and it shows up in the list.
  const stamp = Date.now()
  const title = `T29 quick add ${stamp}`
  await addInput.fill(title)
  await addInput.press('Enter')
  // .first(): the optimistic tmp-* row and the confirmed row can coexist for a
  // frame — either proves the task rendered in the list.
  await expect(page.locator('.todo-panel-item', { hasText: title }).first()).toBeVisible({ timeout: 10_000 })
  await expect(addInput).toHaveValue('')
  await page.screenshot({ path: `${SCREENSHOT_DIR}/quick-add-task-added.png` })

  // 2. Escape abandons a draft: input clears (and blurs)…
  const draft = `T29 abandoned draft ${stamp}`
  await addInput.fill(draft)
  await addInput.press('Escape')
  await expect(addInput).toHaveValue('')
  await expect(addInput).not.toBeFocused()
  await page.screenshot({ path: `${SCREENSHOT_DIR}/quick-add-escape-cleared.png` })

  // …and the abandoned draft never became a task.
  await expect(page.locator('.todo-panel-item', { hasText: draft })).toHaveCount(0)

  // 3. The next quick-add is unaffected by the abandoned draft.
  const title2 = `T29 quick add after escape ${stamp}`
  await addInput.fill(title2)
  await addInput.press('Enter')
  await expect(page.locator('.todo-panel-item', { hasText: title2 }).first()).toBeVisible({ timeout: 10_000 })
})

test('notification panel: Remote Hosts rows say Connected/Disconnected, never Idle', async ({ page }) => {
  await openHome(page)

  await page.locator('button[aria-label="Notifications"]').click()
  const panel = page.locator('.notification-panel')
  await expect(panel).toBeVisible()

  // System-zone cards live behind the System rail tab now.
  await panel.locator('.nfc-rail-btn', { hasText: 'System' }).click()
  // Wait for the System zone to finish loading (health fetch).
  await expect(panel.locator('.notification-card-label', { hasText: 'Data Backup' })).toBeVisible({ timeout: 10_000 })

  const hostsCard = panel.locator('.notification-card', {
    has: page.locator('.notification-card-label', { hasText: 'Remote Hosts' }),
  })
  if (await hostsCard.count() === 0) {
    // Fixture without configured hosts: the panel must still render cleanly.
    await expect(panel.locator('.nfc-body')).toBeVisible()
    test.info().annotations.push({ type: 'note', description: 'No daemons card in fixture — presence-only check.' })
  } else {
    await expect(hostsCard).toBeVisible()
    const rows = hostsCard.locator('.notification-detail-row')
    const rowCount = await rows.count()
    expect(rowCount).toBeGreaterThan(0)
    for (let i = 0; i < rowCount; i++) {
      const status = rows.nth(i).locator('.notification-detail-value').first()
      await expect(status).toContainText(/Connected|Disconnected/)
    }
    // The old bug rendered 'Idle' for connected:false — must be gone.
    await expect(hostsCard).not.toContainText('Idle')
    // No cloud bridge configured in the fixture → the ✓/✗ marker is absent,
    // and its conditional rendering must not crash the card.
    await expect(hostsCard.getByText('bridge')).toHaveCount(0)
  }

  await page.screenshot({ path: `${SCREENSHOT_DIR}/notification-panel.png` })

  await panel.locator('button[aria-label="Close"]').click()
  await expect(panel).toBeHidden()
})

test('demo: session finder then quick add (continuous recording)', async ({ page }) => {
  await presetPanelView(page, { section: 'all', project: '' })
  await openHome(page)

  // Flow 1 — session finder.
  await finderPill(page).click()
  const panel = page.locator('.session-search-panel')
  await expect(panel).toBeVisible()
  const input = panel.locator('.session-search-input')
  await expect(panel.locator('.session-search-result').first()).toBeVisible({ timeout: 10_000 })
  await input.pressSequentially('plan investigate', { delay: 60 })
  await expect(panel.locator('.session-search-result')).toHaveCount(1, { timeout: 10_000 })
  await page.waitForTimeout(600) // let the filtered state register on video
  await input.press('Escape')
  await expect(input).toHaveValue('')
  await input.press('Escape')
  await expect(panel).toBeHidden()

  // Flow 2 — quick add.
  const addInput = page.locator('.todo-panel-add input[placeholder="Quick add task..."]')
  await expect(addInput).toBeVisible({ timeout: 15_000 })
  const title = `T29 demo task ${Date.now()}`
  await addInput.pressSequentially(title, { delay: 40 })
  await addInput.press('Enter')
  await expect(page.locator('.todo-panel-item', { hasText: title }).first()).toBeVisible({ timeout: 10_000 })
  await addInput.fill('draft abandoned on camera')
  await addInput.press('Escape')
  await expect(addInput).toHaveValue('')
  await page.waitForTimeout(600) // hold the final frame
})
