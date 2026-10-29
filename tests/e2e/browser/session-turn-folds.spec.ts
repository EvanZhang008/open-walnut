/**
 * Finished work folds; what the reader must see does not.
 *
 * Against the fixture `pw-fold-session` (test-server.ts), in the real panel:
 *  · turn fold: everything before a turn's answer (narration, two reads, two
 *    edits, a message to the lead; notices, sends and replies) is ONE folded
 *    row and only the answer shows; a failure inside says so in the header;
 *  · quiet turns: a turn a peer's message started that ended with the
 *    no-action line is one folded row that counts what happened ("Received 1
 *    message"), never a count of hidden turns;
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
const TAG = '<walnut-turn status="agent-ack"/>'
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

test('everything before a turn\'s answer is one row; the answer shows', async ({ page }) => {
  test.setTimeout(90_000)
  const panel = await openFoldSession(page)
  const history = panel.locator('.session-history')
  await expect(history).toContainText('FOLD_FINAL_A here is the answer.')
  const fold = history.locator('[data-testid="turn-fold"]').first()
  // Counts only: two reads and two edits are four tools, the task_send one sent.
  await expect(fold.locator(':scope > .tool-run-toggle .tool-run-label')).toHaveText('Sent 1 \u00b7 Ran 4 tools')
  await expect(fold).toHaveAttribute('data-open', 'false')
  // Folded, the narration, the steps and the sent card are off screen.
  expect(await history.innerText()).not.toContain('FOLD_NARRATION_A')
  expect(await history.innerText()).not.toContain('FOLD_SENT_TITLE')
  // The person's own message shows.
  await expect(history.locator('.session-msg-user', { hasText: 'FOLD_ASK_ONE' })).toHaveCount(1)
  await reveal(page, panel, fold)
  await shot(page, fold, 'turn-folded')

  await fold.locator('.tool-run-toggle').first().click()
  await expect(fold).toHaveAttribute('data-open', 'true')
  await expect(fold).toContainText('FOLD_NARRATION_A first result is in.')
  await expect(fold).toContainText('FOLD_SENT_TITLE')
  await shot(page, fold, 'turn-open')
})

test('sends, replies and messaging ops fold with the steps, reasoning included; opened, every card is there', async ({ page }) => {
  test.setTimeout(90_000)
  const panel = await openFoldSession(page)
  const history = panel.locator('.session-history')
  await expect(history).toContainText('FOLD_FINAL_I passed it on.')
  // Two task_sends, an org_send and an inbox reply are four sent; task_update is the one tool.
  const fold = history.locator('[data-testid="turn-fold"]').filter({ hasText: 'Sent 4 \u00b7 Ran 1 tool' })
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

test('a failure folded before an answer says so in the header', async ({ page }) => {
  test.setTimeout(90_000)
  const panel = await openFoldSession(page)
  const history = panel.locator('.session-history')
  await expect(history).toContainText('FOLD_FINAL_E it still fails')
  const fold = history.locator('[data-testid="turn-fold"]').filter({ hasText: '2 failed' })
  await expect(fold).toHaveCount(1)
  await expect(fold.locator('.tool-run-toggle .tool-run-fail')).toHaveText('2 failed')
  await reveal(page, panel, fold)
  await fold.locator('.tool-run-toggle').first().click()
  await expect(fold).toContainText('FOLD_NARRATION_E starting.')
  await expect(fold.locator('.tool-run-fail').filter({ hasText: '2 failed' })).toHaveCount(2)
})

test('an answer to the person shows in full even with the line under it; nothing reads "No action needed"', async ({ page }) => {
  // 2026-10-25: a long answer to the user's own question was folded under "No action needed".
  test.setTimeout(90_000)
  const panel = await openFoldSession(page)
  const history = panel.locator('.session-history')
  await expect(history.locator('[data-testid="no-action-fold"]')).toHaveCount(0)
  for (const marker of ['FOLD_NOACTION_B', 'FOLD_NOACTION_G']) {
    const msg = history.locator('.session-msg-assistant', { hasText: marker })
    await expect(msg).toHaveCount(1)
    await expect(msg).toBeVisible()
    expect(await msg.innerText()).not.toContain('walnut-turn')
  }
  await expect(history).toContainText('Second paragraph of it.')
  expect(await history.innerText()).not.toContain('No action needed')
  const msg = history.locator('.session-msg-assistant', { hasText: 'FOLD_NOACTION_B' })
  await reveal(page, panel, msg)
  await shot(page, msg, 'answer-with-line-shown')
  await msg.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Copy message', exact: true }).click()
  const copied = await page.evaluate(() => (window as unknown as { __copied: string[] }).__copied)
  expect(copied.at(-1)).toBe('FOLD_NOACTION_B all handled, nothing for you.\n\nSecond paragraph of it.')
})

test('a turn a peer started that needed nothing is one row counting what happened; it opens to the card', async ({ page }) => {
  test.setTimeout(90_000)
  const panel = await openFoldSession(page)
  const history = panel.locator('.session-history')
  // Both peer FYIs (after turn five's answer, and after G's; the second on the line's first name).
  const hidden = history.locator('[data-testid="turn-fold"]').filter({ hasText: 'Received 1 message' })
  await expect(hidden).toHaveCount(2)
  await expect(hidden.last().locator(':scope > .tool-run-toggle .tool-run-label')).toHaveText('Received 1 message')
  await expect(history).not.toContainText(/hidden turn/)
  // Folded, the note is off screen: its words and its title.
  expect(await history.innerText()).not.toContain('Second status, nothing to do.')
  expect(await history.innerText()).not.toContain('FOLD_PEER_FYI')
  await expect(history.locator('[data-testid="no-action-mark"]')).toHaveCount(0)
  // The raw line prints nowhere but in turn four, which quotes it in code.
  await expect(history.locator('.session-msg', { hasText: '<walnut-turn' })).toHaveCount(1)
  await expect(history.locator('.session-msg', { hasText: '<walnut-turn' })).toContainText('FOLD_QUOTED_D')
  await reveal(page, panel, hidden.last())
  await shot(page, hidden.last(), 'hidden-turns')
  await hidden.last().locator(':scope > .tool-run-toggle').click()
  await expect(hidden.last()).toContainText('FOLD_PEER_FYI_TWO status only')
  await expect(hidden.last().locator('[data-testid="no-action-mark"]')).toHaveCount(1)
  await shot(page, hidden.last(), 'hidden-turns-open')
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
  const fold = history.locator('[data-testid="turn-fold"]').first()
  await reveal(page, panel, fold)
  await fold.locator('.tool-run-toggle').first().click()
  await expect(fold).toHaveAttribute('data-open', 'true')
  const box = panel.locator('.chat-input-textarea').first()
  await box.click()
  // One fixture server serves every project and retry: a marker of their own.
  const marker = `FOLD_LIVE_${test.info().project.name}_${test.info().retry}`
  await box.fill(`${marker} one more turn`)
  await box.press('Enter')
  await expect(history.locator('.session-msg-assistant', { hasText: marker })).toBeVisible({ timeout: 90_000 })
  await expect(history.locator('[data-testid="turn-fold"]').first()).toHaveAttribute('data-open', 'true')
  await expect(history.locator('.session-msg-user', { hasText: marker })).toHaveCount(1)
})
