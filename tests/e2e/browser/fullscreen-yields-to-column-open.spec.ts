/**
 * A fullscreen panel yields when the user's action opens ANOTHER column.
 *
 * Fullscreen (Files / Changed / Terminal, or the plain Expand) is per-panel local
 * state: the panel becomes a `position:fixed; z-index:9001` sheet over the home
 * columns, and it used to leave only on Escape, backdrop click, its own buttons,
 * or a pathname change. Several home-page actions reveal a column WITHOUT
 * changing the pathname, so the sheet stayed and covered what the click had
 * opened (reported 2026-09-15: "I click Open session and the full screen keeps
 * here; same with fork"):
 *
 *  - "Open session ↗" on a permission toast (the toaster is z-index 9999, so it
 *    is clickable ON TOP of the fullscreen sheet) → openSessionOnHome adds the
 *    target column and navigates to '/', which is a no-op when already home.
 *  - "Fork" in the fullscreen panel's own chip row → a fork draft column opens
 *    leftmost, behind the sheet.
 *  - "Go to task" in the header → the task highlights in the todo list, which
 *    sits under the sheet exactly like a new column does.
 *
 * All of them go through MainPage's two column-opening entry points, which
 * broadcast `fullscreen:yield`; useFullscreen listens and drops the sheet. Asserted
 * with a hit test (`elementFromPoint` at the revealed element's centre), not just
 * the class: "the column exists in the DOM" was already true before the fix.
 *
 * Test 7 pins the ORDER of the two dispatches in openSessionOnHome (yield, then
 * arm the Inbox deep link): an already-fullscreen panel following its own letter
 * link must end fullscreen ON the letter, not collapsed with the tab closed. That
 * holds only while both dispatches share one React batch, which no unit test can
 * see, so it is pinned here through the real toast action button.
 *
 * Before the fix: tests 1, 2, 3, 5 and 6 failed on `.open-walnut-fullscreen`
 * still being present; the no-fullscreen control (4) passed.
 *
 * The Mac app runs this UI in WebKit; the sibling
 * fullscreen-yields-to-column-open.webkit.spec.ts runs the core case there.
 */
import { test, expect } from '@playwright/test'
import { DRAFT_PANEL } from './draft-helpers'
import {
  FULLSCREEN_SESSION, FULLSCREEN_TASK, NONCE, SCREENSHOT_DIR, TARGET_SESSION,
  columnPanel, ensureScreenshotDir, enterFilesFullscreen, expectNoFullscreen, expectOnTop,
  openSessionFromToastRevealsTargetColumn, openSessionPanel, prepareHome,
  raiseActionToast, raisePermissionToast, sendLetter,
} from './fullscreen-yield-helpers'

test.beforeAll(ensureScreenshotDir)
test.beforeEach(async ({ page }) => { await prepareHome(page) })

test('1. Open session ↗ on a toast for ANOTHER session drops the fullscreen sheet and reveals that column', async ({ page }) => {
  await openSessionFromToastRevealsTargetColumn(page)
})

test('2. Fork from the fullscreen chip row drops the sheet and reveals the fork draft', async ({ page }) => {
  const panel = await openSessionPanel(page)
  await enterFilesFullscreen(page, panel)

  await panel.getByRole('button', { name: 'Fork session into a child task' }).click()

  await expectNoFullscreen(page)
  await expect(panel).toBeVisible()
  const draft = page.locator(DRAFT_PANEL)
  await expect(draft).toBeVisible({ timeout: 10_000 })
  await expect(draft.locator('.session-panel-title')).toHaveText('Fork Session')
  await expect(draft.locator('.draft-bound-task')).toContainText('fork of:')
  await expectOnTop(draft)
  // Where the user types next. (Focus is independent of z-order, so this is not
  // the regression guard — expectOnTop above is.)
  await expect(draft.locator('.chat-input-textarea')).toBeFocused({ timeout: 5_000 })
  await page.screenshot({ path: `${SCREENSHOT_DIR}/4-fork-draft-revealed.png` })
})

test('3. Open session ↗ for the fullscreen panel’s OWN session also returns to the column view', async ({ page }) => {
  // The ask lives in the session's chat. Fullscreen may have that chat collapsed
  // or narrow; "Open session" means "take me to the session", and the honest
  // answer is the plain column with the ask in it — never a silent no-op.
  const panel = await openSessionPanel(page)
  await enterFilesFullscreen(page, panel)

  const toast = await raisePermissionToast(page, FULLSCREEN_SESSION, 'self')
  await toast.getByRole('button', { name: 'Open session ↗' }).click()

  await expectNoFullscreen(page)
  await expect(panel).toBeVisible()
  await expectOnTop(panel)
  await expect(panel.locator('.chat-input-textarea').first()).toBeVisible()
})

test('4. a toast Open session with NO fullscreen behaves as before: the column opens, nothing else changes', async ({ page }) => {
  const panel = await openSessionPanel(page)
  const toast = await raisePermissionToast(page, TARGET_SESSION, 'plain')
  await toast.getByRole('button', { name: 'Open session ↗' }).click()

  const target = columnPanel(page, TARGET_SESSION)
  await expect(target).toBeVisible({ timeout: 10_000 })
  await expect(panel).toBeVisible()
  await expectNoFullscreen(page)
})

test('5. the sheet yields every time, not only the first: fullscreen → open → fullscreen → fork', async ({ page }) => {
  const panel = await openSessionPanel(page)

  await enterFilesFullscreen(page, panel)
  const toast = await raisePermissionToast(page, TARGET_SESSION, 'repeat')
  await toast.getByRole('button', { name: 'Open session ↗' }).click()
  await expectNoFullscreen(page)
  await expect(columnPanel(page, TARGET_SESSION)).toBeVisible({ timeout: 10_000 })

  // Back into fullscreen on the SAME panel, then a different reveal (fork).
  await enterFilesFullscreen(page, panel)
  await panel.getByRole('button', { name: 'Fork session into a child task' }).click()
  await expectNoFullscreen(page)
  const draft = page.locator(DRAFT_PANEL)
  await expect(draft).toBeVisible({ timeout: 10_000 })
  await expectOnTop(draft)

  // …and fullscreen still works afterwards (yielding did not wedge the hook).
  await enterFilesFullscreen(page, panel)
  await page.keyboard.press('Escape')
  await expectNoFullscreen(page)
})

test('6. "Go to task" in the fullscreen header drops the sheet and shows the task highlighted in the list', async ({ page }) => {
  // The header button and a task link in the chat both route through
  // handleFocusTaskById → openSessionOrToast. The task's session IS this panel, so
  // no new column appears; what the gesture reveals is the todo row, which sits
  // under the sheet just like a new column would. Decided in useFullscreen.tsx.
  const panel = await openSessionPanel(page)
  await enterFilesFullscreen(page, panel)

  await panel.getByRole('button', { name: 'Locate task' }).click()

  await expectNoFullscreen(page)
  await expect(panel).toBeVisible()
  const row = page.locator(`.todo-panel-item[data-task-id="${FULLSCREEN_TASK}"]`)
  await expect(row).toHaveClass(/task-focused/)
  await expectOnTop(row)
  await page.screenshot({ path: `${SCREENSHOT_DIR}/5-go-to-task-revealed.png` })
})

test('7. an Inbox deep link for the panel that is ALREADY fullscreen lands on the letter, still fullscreen', async ({ page, request }) => {
  // openSessionOnHome dispatches the yield BEFORE it arms the Inbox request. In one
  // React batch the arm's enterFullscreen lands last, so the panel never commits
  // "fullscreen off + tab open" — the state in which its exit guard would close the
  // tab the link just asked for. Driven through a real notification action button,
  // which is `navigateToTarget` with the link verbatim.
  const subject = `PW yield letter ${NONCE}`
  const letterId = await sendLetter(request, subject, FULLSCREEN_SESSION)

  const panel = await openSessionPanel(page)
  await enterFilesFullscreen(page, panel)

  const toast = await raiseActionToast(
    page, 'inbox', `/sessions?id=${FULLSCREEN_SESSION}&tab=inbox&letter=${letterId}`,
  )
  await toast.getByRole('button', { name: 'Open letter' }).click()

  // Still fullscreen — on the Inbox tab, on that letter; Files is gone.
  const pane = panel.locator('.session-inbox-pane')
  await expect(pane).toBeVisible({ timeout: 15_000 })
  await expect(pane.locator('.hib-reader-subject')).toHaveText(subject)
  await expect(panel).toHaveClass(/open-walnut-fullscreen/)
  await expect(page.locator('.open-walnut-fullscreen-backdrop')).toHaveCount(1)
  await expect(panel.locator('.session-file-explorer')).toHaveCount(0)
  // And it STAYS: the exit guard runs on the commit after; give it a beat.
  await page.waitForTimeout(500)
  await expect(panel).toHaveClass(/open-walnut-fullscreen/)
  await expect(pane.locator('.hib-reader-subject')).toHaveText(subject)
  await page.screenshot({ path: `${SCREENSHOT_DIR}/6-inbox-deep-link-stays-fullscreen.png` })
})
