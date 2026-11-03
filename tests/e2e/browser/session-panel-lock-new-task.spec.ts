/**
 * A new task started while every panel is pinned is an OPEN: it gets its own column.
 *
 * The report (2026-11-03): with every Home column locked, a task created from the
 * draft column ("+", type, Start) vanished the moment its session became real. The
 * draft rides outside the panel budget while it is a placeholder, and when it turned
 * into a real session the eviction effect trimmed the strip back to the count. Pins
 * are exempt from that trim, so the only column it could take was the one the user
 * had just started. A pill click in the same state takes the lock grant instead
 * (`panelBudget`): one more column, and the count follows. The conversion now does
 * the same: the pins all stay, the new session stays beside them, and the count
 * grows with the hint toast.
 *
 * Driven through the real controls: the header lock buttons, the toolbar "+", the
 * draft's folder picker and Start. Columns are seeded through sessionStorage and the
 * count through the Settings UI (./draft-helpers).
 */

import { test, expect, type Page } from '@playwright/test'
import {
  discoverFixtureRoot, draftComposer, draftPanels, draftSend, homeColumns, loadHome,
  lockLeftmostPanel, openDraftOnCwd, seedColumns, setPanelMode,
} from './draft-helpers'
import { holdPanelCountLock } from './panel-count-lock'

const SCREENSHOT_DIR = process.env.LOCK_NEW_TASK_SHOT_DIR ?? '/tmp/session-panel-lock-new-task'

/** Seeded, stopped sessions from test-server.ts. */
const SIDS = ['pw-normal-session', 'pw-plan-session-completed'] as const

const lockedButtons = (page: Page) => page.locator('.main-page-session-column .session-panel-lock.is-locked')
const hintToast = (page: Page) => page.locator('.notification-toast', { hasText: 'Panels auto-increased from 2 to 3' })

async function stripIds(page: Page): Promise<string[]> {
  return page.locator('.main-page-session-column .session-panel[data-session-id]').evaluateAll(
    (els) => els.map((el) => el.getAttribute('data-session-id') ?? ''),
  )
}

async function savedCount(page: Page): Promise<string | undefined> {
  return (await (await page.request.get('/api/config')).json())?.config?.ui?.session_panels
}

let fixtureRoot = ''
test.beforeAll(async () => { fixtureRoot = await discoverFixtureRoot() })

// A real CLI spawn plus config round-trips that queue behind the fixture's health monitor.
test.setTimeout(180_000)
test.describe.configure({ mode: 'serial' })
holdPanelCountLock('file')

test('every panel pinned: a task started from the draft keeps its column, every pin stays, the count follows', async ({ page }) => {
  await page.setViewportSize({ width: 2400, height: 1000 })
  await setPanelMode(page, '2')
  await seedColumns(page, SIDS)
  await loadHome(page)
  await expect(homeColumns(page)).toHaveCount(2, { timeout: 25_000 })
  for (let n = 1; n <= 2; n++) {
    await lockLeftmostPanel(page)
    await expect(lockedButtons(page)).toHaveCount(n, { timeout: 10_000 })
  }
  const pinned = await stripIds(page)
  expect([...pinned].sort()).toEqual([...SIDS].sort())

  const panel = await openDraftOnCwd(page, `${fixtureRoot}/projects/walnut`, { engine: 'Claude' })
  await expect(homeColumns(page)).toHaveCount(3, { timeout: 10_000 })
  await draftComposer(page).fill(`all pinned new task ${Date.now()}`)
  const launch = page.waitForRequest((req) =>
    req.method() === 'POST' && new URL(req.url()).pathname === '/api/sessions/quick-start')
  await draftSend(panel).click()
  const payload = (await launch).postDataJSON() as { sessionId?: string }
  expect(payload.sessionId, 'native quick-start sends a client session id').toBeTruthy()

  // The draft became a real session panel...
  await expect(draftPanels(page)).toHaveCount(0)
  const newPanel = page.locator(`.main-page-session-column .session-panel[data-session-id="${payload.sessionId}"]`)
  await expect(newPanel).toBeVisible({ timeout: 30_000 })
  // ...the strip took the lock grant, the count followed, and the hint says so.
  await expect(hintToast(page)).toBeVisible({ timeout: 10_000 })
  await expect.poll(() => savedCount(page), { timeout: 20_000 }).toBe('3')

  // Settled: the new panel is still there (it used to be the one trimmed away),
  // both pins kept their columns, and nothing else left.
  await page.waitForTimeout(1_500)
  await expect(newPanel).toBeVisible()
  await expect(homeColumns(page)).toHaveCount(3)
  await expect(lockedButtons(page)).toHaveCount(2)
  const ids = await stripIds(page)
  // The new session leftmost of the real strip, the pins on the right in their order.
  expect(ids).toEqual([payload.sessionId!, ...pinned])
  await page.screenshot({ path: `${SCREENSHOT_DIR}/01-new-task-beside-pins.png`, fullPage: false })

  // Restore the shared count for the rest of the run.
  await setPanelMode(page, '2')
})
