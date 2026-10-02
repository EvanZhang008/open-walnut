/**
 * The lock grant: pins never block opening a session.
 *
 * With the panel count at 3 and all 3 columns locked, a pill (or finder) click used
 * to answer with a toast, "All session panels are locked", and nothing else. The
 * budget now follows the pins (`panelBudget` in web/src/pages/sessionColumns.ts):
 * pins that fill the user's count get ONE free slot on top, so the strip grows to 4
 * for the next session. The grant is derived from the pins, not stored, which is
 * what answers "how does it go back to 3": the free slot is shared (the next open
 * reuses it, one in one out), unlocking closes nothing, and closing any column
 * puts the strip back under the user's count, where the normal eviction resumes.
 *
 * Driven through the real controls: the header lock buttons, the session finder
 * (⌘⇧O, the one gesture that opens a session by name), the header ×. Columns are
 * seeded through sessionStorage and the count through the Settings UI, the same
 * kit the draft specs use (./draft-helpers).
 */

import { test, expect, type Page } from '@playwright/test'
import { homeColumns, loadHome, lockLeftmostPanel, seedColumns, setPanelMode } from './draft-helpers'

const SCREENSHOT_DIR = process.env.LOCK_GRANT_SHOT_DIR ?? '/tmp/session-panel-lock-grant'

/** Seeded, stopped sessions from test-server.ts: three to fill a count of 3. */
const SIDS = ['pw-normal-session', 'pw-plan-session-completed', 'pw-vscode-session'] as const
/** Two more, opened through the finder by their titles. */
const SERVICE = { id: 'pw-service-session', query: 'Service preview' }
const IDREF = { id: 'pw-idref-session', query: 'Task id refs' }

const lockedButtons = (page: Page) => page.locator('.main-page-session-column .session-panel-lock.is-locked')
const column = (page: Page, sid: string) =>
  page.locator(`.main-page-session-column .session-panel[data-session-id="${sid}"]`)
const lockedToast = (page: Page) => page.getByText('session panels are locked', { exact: false })

/** Open a session as a home column through the finder (⌘⇧O → type → click). */
async function openViaFinder(page: Page, query: string, sid: string): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.keyboard.press('ControlOrMeta+Shift+O')
  const finder = page.locator('.session-search-panel')
  await expect(finder).toBeVisible()
  await finder.locator('.session-search-input').fill(query)
  const result = finder.locator('.session-search-result').filter({ has: page.locator('.session-search-title', { hasText: query }) })
  await expect(result).toHaveCount(1, { timeout: 10_000 })
  await result.click()
  await expect(column(page, sid)).toBeVisible({ timeout: 20_000 })
}

/** Session ids of the real columns, in strip order. */
async function stripIds(page: Page): Promise<string[]> {
  return page.locator('.main-page-session-column .session-panel[data-session-id]').evaluateAll(
    (els) => els.map((el) => el.getAttribute('data-session-id') ?? ''),
  )
}

// The count steps wait on config round-trips that queue behind the fixture's
// session health monitor (see draft-helpers' setPanelMode).
test.setTimeout(180_000)
// Serial: both scenarios drive the app-wide `ui.session_panels` setting.
test.describe.configure({ mode: 'serial' })

test('three pinned panels: the next session opens a 4th column, the slot is shared, and closing shrinks back', async ({ page }) => {
  await page.setViewportSize({ width: 2400, height: 1000 })
  await setPanelMode(page, '3')
  await seedColumns(page, SIDS)
  await loadHome(page)
  await expect(homeColumns(page)).toHaveCount(3, { timeout: 25_000 })

  // Pin all three through their real header controls.
  for (let n = 1; n <= 3; n++) {
    await lockLeftmostPanel(page)
    await expect(lockedButtons(page)).toHaveCount(n, { timeout: 10_000 })
  }

  // ── 1. Open a session: a 4th column, no toast, no pin evicted ──
  await openViaFinder(page, SERVICE.query, SERVICE.id)
  await expect(homeColumns(page)).toHaveCount(4)
  await expect(lockedButtons(page)).toHaveCount(3)
  await expect(lockedToast(page)).toHaveCount(0)
  // The new column lands leftmost of the real region, the pins keep the right.
  expect((await stripIds(page))[0]).toBe(SERVICE.id)
  await page.screenshot({ path: `${SCREENSHOT_DIR}/01-fourth-column.png`, fullPage: false })

  // ── 2. The free slot is shared: the next open replaces it, strip stays at 4 ──
  await openViaFinder(page, IDREF.query, IDREF.id)
  await expect(homeColumns(page)).toHaveCount(4)
  await expect(column(page, SERVICE.id)).toHaveCount(0)
  await expect(lockedButtons(page)).toHaveCount(3)
  await page.screenshot({ path: `${SCREENSHOT_DIR}/02-slot-reused.png`, fullPage: false })

  // ── 3. Unlocking closes nothing ──
  await page.locator('.main-page-session-column button[aria-label="Unlock session panel"]').first().click()
  await expect(lockedButtons(page)).toHaveCount(2, { timeout: 10_000 })
  await expect(homeColumns(page)).toHaveCount(4)

  // ── 4. Closing a column is what shrinks the strip; from there the count rules ──
  await column(page, IDREF.id).getByRole('button', { name: 'Close session panel' }).click()
  await expect(homeColumns(page)).toHaveCount(3, { timeout: 10_000 })
  const before = await stripIds(page)
  await openViaFinder(page, SERVICE.query, SERVICE.id)
  // Back under the count: one in, one out, the two remaining pins untouched.
  await expect(homeColumns(page)).toHaveCount(3)
  await expect(lockedButtons(page)).toHaveCount(2)
  const after = await stripIds(page)
  expect(after[0]).toBe(SERVICE.id)
  expect(after.filter((id) => before.includes(id))).toHaveLength(2)
  await page.screenshot({ path: `${SCREENSHOT_DIR}/03-back-to-three.png`, fullPage: false })
})

test('a granted 4th column survives a reload with its three pins', async ({ page }) => {
  await page.setViewportSize({ width: 2400, height: 1000 })
  await setPanelMode(page, '3')
  // Three pins and the free column they earned, as the previous visit saved them.
  await page.addInitScript((ids) => {
    try {
      sessionStorage.setItem(
        'open-walnut-home-session-columns',
        JSON.stringify([
          { id: ids[0], locked: false },
          ...ids.slice(1).map((id: string) => ({ id, locked: true })),
        ]),
      )
    } catch { /* ignore */ }
  }, [SERVICE.id, ...SIDS])
  await loadHome(page)
  // The old positional cut would have dropped the rightmost pin here.
  await expect(homeColumns(page)).toHaveCount(4, { timeout: 25_000 })
  await expect(lockedButtons(page)).toHaveCount(3)
  await expect(column(page, SERVICE.id)).toBeVisible()
  await page.screenshot({ path: `${SCREENSHOT_DIR}/04-restored-four.png`, fullPage: false })
})
