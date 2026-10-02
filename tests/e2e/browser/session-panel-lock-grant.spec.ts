/**
 * The lock grant: pins never block opening a session, and the count follows.
 *
 * With the panel count at 3 and all 3 columns locked, a pill (or finder) click used
 * to answer with a toast, "All session panels are locked", and nothing else. The
 * budget now follows the pins (`panelBudget` in web/src/pages/sessionColumns.ts):
 * pins that fill the user's count get ONE free slot on top, so the strip grows to 4
 * for the next session. The moment it grows, the SETTING becomes 4 as well
 * (MainPage's openSessionOrToast): a strip of 4 under a picker that still said "3"
 * was confusing, so every picker now shows the number of panels on screen, and
 * going back down is the user's own pick, never a heuristic. Unlocking closes
 * nothing; closing a column shrinks the strip but leaves the count alone.
 *
 * The grant also tells the user, once, with a hint toast whose "See your setting" opens
 * the panel-count picker the user already has: the task panel's Display menu (the
 * sliders button beside New task), with the Session columns row pulsing
 * (web/src/components/tasks/view-dropdown-reveal.ts).
 *
 * Driven through the real controls: the header lock buttons, the session finder
 * (⌘⇧O, the one gesture that opens a session by name), the header ×, the toast
 * button, the Display menu. Columns are seeded through sessionStorage and the count
 * through the Settings UI, the same kit the draft specs use (./draft-helpers).
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
const hintToast = (page: Page) => page.locator('.notification-toast', { hasText: 'Panels auto-increased from 3 to 4' })

/** The task panel's Display menu (the sliders button beside New task) and its Session columns row. */
const viewTrigger = (page: Page) => page.locator('.todo-panel .todo-panel-toolbar button[aria-label="Display"]')
const viewMenu = (page: Page) => page.locator('.dm-menu')
const panelsGroup = (page: Page) => viewMenu(page).locator('.dm-row[data-view-option="session-panels"]')
const panelsSeg = (page: Page) => panelsGroup(page).locator('.dm-seg[aria-label="Session columns"]')

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

/** The persisted `ui.session_panels`, as the server has it. */
async function savedCount(page: Page): Promise<string | undefined> {
  return (await (await page.request.get('/api/config')).json())?.config?.ui?.session_panels
}

/**
 * The menu sits under its own trigger (the sliders button), not at a spot measured while the
 * task panel was still sliding open: top within a few px below the trigger, and overlapping it
 * horizontally (the panel-left placement runs from the task panel's edge across the trigger).
 */
async function expectMenuUnderTrigger(page: Page): Promise<void> {
  // The menu slides in from 4px up over 120ms (`tp-pop-in`): measure the resting box.
  await expect.poll(() => viewMenu(page).evaluate((el) => el.getAnimations().filter((a) => a.playState === 'running').length)).toBe(0)
  const trigger = await viewTrigger(page).boundingBox()
  const menu = await viewMenu(page).boundingBox()
  expect(trigger).not.toBeNull()
  expect(menu).not.toBeNull()
  expect(trigger!.width).toBeGreaterThan(0)
  expect(menu!.y).toBeGreaterThanOrEqual(trigger!.y + trigger!.height)
  expect(menu!.y).toBeLessThan(trigger!.y + trigger!.height + 12)
  expect(menu!.x).toBeLessThanOrEqual(trigger!.x)
  expect(menu!.x + menu!.width).toBeGreaterThan(trigger!.x)
}

/** Count 3, three seeded columns, all pinned through their header controls. */
async function threePinned(page: Page): Promise<void> {
  await setPanelMode(page, '3')
  await seedColumns(page, SIDS)
  await loadHome(page)
  await expect(homeColumns(page)).toHaveCount(3, { timeout: 25_000 })
  for (let n = 1; n <= 3; n++) {
    await lockLeftmostPanel(page)
    await expect(lockedButtons(page)).toHaveCount(n, { timeout: 10_000 })
  }
}

/** Pin all three, open a 4th through the finder, return the hint toast. */
async function growToFour(page: Page) {
  await threePinned(page)
  await openViaFinder(page, SERVICE.query, SERVICE.id)
  await expect(homeColumns(page)).toHaveCount(4)
  const hint = hintToast(page)
  await expect(hint).toBeVisible()
  return hint
}

// The count steps wait on config round-trips that queue behind the fixture's
// session health monitor (see draft-helpers' setPanelMode).
test.setTimeout(180_000)
// Serial: every scenario drives the app-wide `ui.session_panels` setting.
test.describe.configure({ mode: 'serial' })

test('three pinned panels: the next session opens a 4th column and the count becomes 4; lowering it is the user\'s pick', async ({ page }) => {
  await page.setViewportSize({ width: 2400, height: 1000 })
  await threePinned(page)

  // ── 1. Open a session: a 4th column, no refusal, no pin evicted, and the count follows ──
  await openViaFinder(page, SERVICE.query, SERVICE.id)
  await expect(homeColumns(page)).toHaveCount(4)
  await expect(lockedButtons(page)).toHaveCount(3)
  await expect(lockedToast(page)).toHaveCount(0)
  // The new column lands leftmost of the real region, the pins keep the right.
  expect((await stripIds(page))[0]).toBe(SERVICE.id)
  // The strip says what it just did, in two short lines, and why.
  const hint = hintToast(page)
  await expect(hint).toBeVisible()
  await expect(hint).toContainText('All 3 were pinned')
  await expect.poll(() => savedCount(page), { timeout: 20_000 }).toBe('4')
  // Every picker agrees with the screen: the Display menu shows 4 selected.
  await viewTrigger(page).click()
  await expect(viewMenu(page)).toBeVisible()
  await expect(panelsSeg(page).locator('[aria-pressed="true"]')).toHaveText(['4'])
  await page.keyboard.press('Escape')
  await expect(viewMenu(page)).toHaveCount(0)
  await page.screenshot({ path: `${SCREENSHOT_DIR}/01-fourth-column.png`, fullPage: false })

  // ── 2. With 3 pins under a count of 4 the one free slot is shared: one in, one out ──
  await openViaFinder(page, IDREF.query, IDREF.id)
  await expect(homeColumns(page)).toHaveCount(4)
  await expect(column(page, SERVICE.id)).toHaveCount(0)
  await expect(lockedButtons(page)).toHaveCount(3)
  // Not growth: no second hint.
  await expect(page.locator('.notification-toast', { hasText: 'from 4 to 5' })).toHaveCount(0)
  await page.screenshot({ path: `${SCREENSHOT_DIR}/02-slot-reused.png`, fullPage: false })

  // ── 3. Unlocking closes nothing ──
  await page.locator('.main-page-session-column button[aria-label="Unlock session panel"]').first().click()
  await expect(lockedButtons(page)).toHaveCount(2, { timeout: 10_000 })
  await expect(homeColumns(page)).toHaveCount(4)

  // ── 4. Closing a column shrinks the strip; the count stays 4 (no heuristic takes it back) ──
  await column(page, IDREF.id).getByRole('button', { name: 'Close session panel' }).click()
  await expect(homeColumns(page)).toHaveCount(3, { timeout: 10_000 })
  expect(await savedCount(page)).toBe('4')
  const before = await stripIds(page)
  await openViaFinder(page, SERVICE.query, SERVICE.id)
  await expect(homeColumns(page)).toHaveCount(4)
  await expect(lockedButtons(page)).toHaveCount(2)
  expect((await stripIds(page))[0]).toBe(SERVICE.id)
  expect((await stripIds(page)).filter((id) => before.includes(id))).toHaveLength(3)

  // ── 5. Going back down is the user's own pick: 3 in the Display menu trims to 3, pins untouched ──
  await viewTrigger(page).click()
  await expect(viewMenu(page)).toBeVisible()
  await panelsSeg(page).locator('.dm-seg-btn', { hasText: /^3$/ }).click()
  await expect(homeColumns(page)).toHaveCount(3, { timeout: 10_000 })
  await expect(lockedButtons(page)).toHaveCount(2)
  await expect.poll(() => savedCount(page), { timeout: 20_000 }).toBe('3')
  await page.keyboard.press('Escape')
  await page.screenshot({ path: `${SCREENSHOT_DIR}/03-back-to-three.png`, fullPage: false })
})

test('"See your setting" on the hint opens the Display menu beside New task on the pulsing Session columns row', async ({ page }) => {
  await page.setViewportSize({ width: 2400, height: 1000 })
  const hint = await growToFour(page)
  await expect(viewMenu(page)).toHaveCount(0)

  // The button is the whole point: the picker is the one the user already has, right
  // next to the strip, not a Settings page (2026-10-02: "that's too far away").
  await hint.locator('.notification-toast-action', { hasText: 'See your setting' }).click()
  await expect(viewMenu(page)).toBeVisible({ timeout: 10_000 })
  // Still on the home page (the columns ride in the query string), not on Settings.
  expect(new URL(page.url()).pathname).toBe('/')
  await expect(panelsGroup(page)).toBeVisible()
  await expect(panelsGroup(page)).toBeInViewport()
  // The row pulses so the eye lands on it (3s), and it already reads 4.
  await expect(panelsGroup(page)).toHaveClass(/dm-row-flash/)
  await expect(panelsSeg(page).locator('[aria-pressed="true"]')).toHaveText(['4'])
  await expectMenuUnderTrigger(page)
  await page.screenshot({ path: `${SCREENSHOT_DIR}/05-view-menu-highlight.png`, fullPage: false })

  // Lowering it here is the "reduce" path: 3 evicts the free column, the 3 pins stay.
  await panelsSeg(page).locator('.dm-seg-btn', { hasText: /^3$/ }).click()
  await expect(panelsSeg(page).locator('[aria-pressed="true"]')).toHaveText(['3'], { timeout: 20_000 })
  await expect(homeColumns(page)).toHaveCount(3, { timeout: 10_000 })
  await expect(lockedButtons(page)).toHaveCount(3)
  await expect(column(page, SERVICE.id)).toHaveCount(0)
  await expect.poll(() => savedCount(page), { timeout: 20_000 }).toBe('3')
  // Escape closes the menu and the flash goes with it; the next plain open is an ordinary one.
  await page.keyboard.press('Escape')
  await expect(viewMenu(page)).toHaveCount(0)
  await viewTrigger(page).click()
  await expect(viewMenu(page)).toBeVisible()
  await expect(panelsGroup(page)).not.toHaveClass(/dm-row-flash/)
  await page.keyboard.press('Escape')
})

test('"See your setting" brings a hidden task panel back and still lands on the row', async ({ page }) => {
  await page.setViewportSize({ width: 2400, height: 1000 })
  const hint = await growToFour(page)
  // Hide the task panel the way a user does, through its own header control.
  await page.locator('.todo-panel .todo-panel-hide').click()
  await expect(page.locator('.main-page-todo')).toHaveClass(/collapsed/)

  await hint.locator('.notification-toast-action', { hasText: 'See your setting' }).click()
  await expect(page.locator('.main-page-todo')).not.toHaveClass(/collapsed/)
  // The menu waits for the panel's slide to finish, then opens under the trigger.
  await expect(viewMenu(page)).toBeVisible({ timeout: 10_000 })
  await expect(panelsGroup(page)).toHaveClass(/dm-row-flash/)
  await expectMenuUnderTrigger(page)
  await page.screenshot({ path: `${SCREENSHOT_DIR}/06-hidden-panel-reopened.png`, fullPage: false })
})

test('a 4th column saved under a count of 3 is trimmed on reload; the three pins all survive', async ({ page }) => {
  await page.setViewportSize({ width: 2400, height: 1000 })
  // A grant writes the count at once, so a strip wider than the count only comes
  // from a write that never landed or another tab lowering the count: the setting
  // wins, and the pins are what must not be cut (the old positional slice cut one).
  await setPanelMode(page, '3')
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
  await expect(homeColumns(page)).toHaveCount(3, { timeout: 25_000 })
  await expect(lockedButtons(page)).toHaveCount(3)
  await expect(column(page, SERVICE.id)).toHaveCount(0)
  for (const sid of SIDS) await expect(column(page, sid)).toBeVisible()
  await page.screenshot({ path: `${SCREENSHOT_DIR}/04-restored-three-pins.png`, fullPage: false })
})
