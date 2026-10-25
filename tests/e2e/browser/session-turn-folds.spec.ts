/**
 * Finished work folds; what the reader must see does not.
 *
 * Against the fixture `pw-fold-session` (test-server.ts), in the real panel:
 *  · process fold: a turn's finished steps after its narration (two reads, two
 *    edits, a message to the lead) are ONE folded row, "Read 2 files, edited 2
 *    files, sent a message"; the narration and the answer stay on screen; a run
 *    with a failed tool stays out of any fold;
 *  · no-action fold: a clean finished turn whose answer ends with the no-action
 *    line is one "No action needed" row; opened, the whole answer is there and
 *    copies without the line; a turn with a failure keeps its answer open (the
 *    line never prints); a marker quoted in code is ordinary text;
 *  · a fold the reader opened stays open when a new turn runs and history is
 *    fetched again.
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import { REAL_PANEL } from './draft-helpers'

const SESSION_ID = 'pw-fold-session'
const TASK_ID = 'pw-task-fold'
const TAG = '<walnut-turn status="no-action"/>'
const SHOTS = process.env.RIDER_SHOT_DIR ?? '/tmp/turn-folds'

test.describe.configure({ mode: 'serial' })

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __copied: string[] }
    w.__copied = []
    const clip = navigator.clipboard
    if (clip) {
      clip.writeText = async (t: string) => { w.__copied.push(t) }
      clip.write = async () => { w.__copied.push('[rich]') }
    }
  })
})

async function openFoldSession(page: Page): Promise<Locator> {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/')
  await page.evaluate(() => localStorage.setItem('walnut:session-view.default', 'linear'))
  const panel = page.locator(`${REAL_PANEL}[data-session-id="${SESSION_ID}"]`)
  if (await panel.count() === 0) {
    await page.locator('.todo-search-input').fill(TASK_ID)
    const task = page.locator(`.todo-panel-item[data-task-id="${TASK_ID}"]`)
    await expect(task).toBeVisible({ timeout: 30_000 })
    await task.locator('.todo-item-title').click()
  }
  await expect(panel).toBeVisible({ timeout: 20_000 })
  await expect(panel.locator('.session-history')).toContainText('FOLD_FINAL_E', { timeout: 30_000 })
  return panel
}

/**
 * Bring a row into the history viewport with a REAL wheel gesture. The timeline
 * follows its own bottom and snaps Playwright's scroll-into-view straight back
 * (session-injected-banner.spec.ts), so clicks and clips need the reader's way.
 */
async function reveal(page: Page, panel: Locator, target: Locator): Promise<void> {
  const view = (await panel.locator('.session-history').boundingBox())!
  await page.mouse.move(view.x + view.width / 2, view.y + view.height / 2)
  for (let i = 0; i < 40; i++) {
    const box = await target.boundingBox()
    if (box && box.y >= view.y && box.y + Math.min(box.height, view.height - 40) <= view.y + view.height) return
    await page.mouse.wheel(0, box && box.y < view.y ? -200 : 200)
    await page.waitForTimeout(120)
  }
}

/** Evidence only: a clip of the row, never a reason for the test to fail. */
async function shot(page: Page, target: Locator, name: string): Promise<void> {
  const box = await target.boundingBox().catch(() => null)
  if (!box || box.width < 1 || box.height < 1) return
  const vp = page.viewportSize()!
  const y = Math.max(0, box.y)
  const clip = { x: Math.max(0, box.x), y, width: Math.min(box.width, vp.width - Math.max(0, box.x)), height: Math.min(box.height, vp.height - y) }
  if (clip.width < 1 || clip.height < 1) return
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-${name}.png`, clip }).catch(() => {})
}

test('a turn\'s steps fold into one row; narration and answer stay', async ({ page }) => {
  test.setTimeout(90_000)
  const panel = await openFoldSession(page)
  const history = panel.locator('.session-history')
  await expect(history).toContainText('FOLD_NARRATION_A first result is in.')
  await expect(history).toContainText('FOLD_FINAL_A here is the answer.')
  const fold = history.locator('[data-testid="process-fold"]').first()
  await expect(fold.locator('.tool-run-label')).toHaveText('Read 2 files, edited 2 files, sent a message')
  await expect(fold).toHaveAttribute('data-open', 'false')
  // Folded, the steps and the sent card are off screen.
  expect(await history.innerText()).not.toContain('FOLD_SENT_TITLE')
  await reveal(page, panel, fold)
  await shot(page, fold, 'process-folded')

  await fold.locator('.tool-run-toggle').click()
  await expect(fold).toHaveAttribute('data-open', 'true')
  await expect(fold).toContainText('FOLD_SENT_TITLE')
  await expect(fold.locator('.tool-run-toggle').nth(1)).toBeVisible()
  await shot(page, fold, 'process-open')
})

test('sends, replies and messaging ops fold with the steps, reasoning included; opened, every card is there', async ({ page }) => {
  test.setTimeout(90_000)
  const panel = await openFoldSession(page)
  const history = panel.locator('.session-history')
  await expect(history).toContainText('FOLD_FINAL_I passed it on.')
  const fold = history.locator('[data-testid="process-fold"]').filter({ hasText: 'sent 4 messages' })
  await expect(fold).toHaveCount(1)
  expect(await history.innerText()).not.toContain('FOLD_SENT_NINE')
  expect(await history.innerText()).not.toContain('FOLD_REPLY_NINE')
  await reveal(page, panel, fold)
  await shot(page, fold, 'sends-folded')
  await fold.locator('.tool-run-toggle').first().click()
  await expect(fold).toContainText('FOLD_SENT_NINE')
  await expect(fold).toContainText('FOLD_REPLY_NINE')
  await shot(page, fold, 'sends-open')
})

test('a failed run stays out of every fold', async ({ page }) => {
  test.setTimeout(90_000)
  const panel = await openFoldSession(page)
  const history = panel.locator('.session-history')
  await expect(history).toContainText('FOLD_NARRATION_E starting.')
  // Turn five's failed run (two failures, unlike turn three's one) is its own
  // row on screen, never inside a fold; no fold holds a failure at all.
  await expect(history.locator('.tool-run-fail').filter({ hasText: '2 failed' })).toBeVisible()
  const folds = history.locator('[data-testid="process-fold"]')
  for (let i = 0; i < await folds.count(); i++) {
    await reveal(page, panel, folds.nth(i))
    await folds.nth(i).locator('.tool-run-toggle').first().click()
    await expect(folds.nth(i).locator('.tool-run-fail')).toHaveCount(0)
  }
  // The sent message after it folds alone (it holds a card); the answer stays.
  await expect(history).toContainText('FOLD_FINAL_E it still fails')
})

test('a clean turn that needs nothing folds to "No action needed"; opened, it is all there', async ({ page }) => {
  test.setTimeout(90_000)
  const panel = await openFoldSession(page)
  const history = panel.locator('.session-history')
  const folds = history.locator('[data-testid="no-action-fold"]')
  // B, and G (whose turn a peer's FYI followed: that background turn is its own).
  await expect(folds).toHaveCount(2)
  await expect(folds.nth(1).locator('.no-action-fold-preview')).toHaveText('FOLD_NOACTION_G nothing left, all clean.')
  const fold = folds.first()
  await expect(fold.locator('.tool-run-label')).toHaveText('No action needed')
  // Folded, the row still says what the answer was: its first sentence, nothing more.
  await expect(fold.locator('.no-action-fold-preview')).toHaveText('FOLD_NOACTION_B all handled, nothing for you.')
  expect(await history.innerText()).not.toContain('Second paragraph of it.')
  await reveal(page, panel, fold)
  await shot(page, fold, 'no-action-folded')

  await fold.locator('.tool-run-toggle').first().click()
  await expect(fold).toContainText('FOLD_NOACTION_B all handled, nothing for you.')
  await expect(fold).toContainText('Second paragraph of it.')
  expect(await fold.innerText()).not.toContain('walnut-turn')
  await shot(page, fold, 'no-action-open')

  const msg = fold.locator('.session-msg-assistant').first()
  await reveal(page, panel, msg)
  await msg.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Copy message', exact: true }).click()
  const copied = await page.evaluate(() => (window as unknown as { __copied: string[] }).__copied)
  expect(copied.at(-1)).toBe('FOLD_NOACTION_B all handled, nothing for you.\n\nSecond paragraph of it.')
})

test('a background turn that needs nothing ends as one small row, no bubble, no filler', async ({ page }) => {
  test.setTimeout(90_000)
  const panel = await openFoldSession(page)
  const history = panel.locator('.session-history')
  // Both peer FYIs (after turn five's open answer, and after G's folded one).
  const marks = history.locator('[data-testid="no-action-mark"]')
  await expect(marks).toHaveCount(2)
  const mark = marks.last()
  await expect(mark).toHaveText('No action needed')
  await expect(mark.locator('button')).toHaveCount(0)
  // The raw line prints nowhere but in turn four, which quotes it in code.
  await expect(history.locator('.session-msg', { hasText: '<walnut-turn' })).toHaveCount(1)
  await expect(history.locator('.session-msg', { hasText: '<walnut-turn' })).toContainText('FOLD_QUOTED_D')
  await reveal(page, panel, mark)
  await shot(page, mark, 'no-action-mark')
})

test('a failure keeps the answer open, the line never prints; a quoted marker is text', async ({ page }) => {
  test.setTimeout(90_000)
  const panel = await openFoldSession(page)
  const history = panel.locator('.session-history')
  await expect(history).toContainText('FOLD_FAILED_C the build failed, but I logged it.')
  const failed = history.locator('.session-msg-assistant', { hasText: 'FOLD_FAILED_C' })
  expect(await failed.innerText()).not.toContain('walnut-turn')
  const quoted = history.locator('.session-msg-assistant', { hasText: 'FOLD_QUOTED_D' })
  await expect(quoted).toContainText(TAG)
})

test('an opened fold stays open through a new turn and a history refetch', async ({ page }) => {
  test.setTimeout(150_000)
  const panel = await openFoldSession(page)
  const history = panel.locator('.session-history')
  const fold = history.locator('[data-testid="process-fold"]').first()
  await reveal(page, panel, fold)
  await fold.locator('.tool-run-toggle').click()
  await expect(fold).toHaveAttribute('data-open', 'true')
  const box = panel.locator('.chat-input-textarea').first()
  await box.click()
  // One fixture server serves every project and retry: a marker of their own.
  const marker = `FOLD_LIVE_${test.info().project.name}_${test.info().retry}`
  await box.fill(`${marker} one more turn`)
  await box.press('Enter')
  await expect(history.locator('.session-msg-assistant', { hasText: marker })).toBeVisible({ timeout: 90_000 })
  await expect(history.locator('[data-testid="process-fold"]').first()).toHaveAttribute('data-open', 'true')
  await expect(history.locator('.session-msg-user', { hasText: marker })).toHaveCount(1)
})
