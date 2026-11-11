/**
 * Incoming message cards in the real session timeline.
 *
 * 2026-11-10, the user, of a lead's chat where a turn opened with Walnut's notes
 * and five state notices in one line, each drawn open above the answer: "when they
 * appear they just collapse ... make the message same as the regular collapse, it
 * itself only show to which, and title and summary can be 2 line", and "auto
 * collapse, also it should be collapsed in the bigger collapse, until it is the
 * turn end conversation text AI return".
 *
 * Fixture `pw-inbound-session` (test-server.ts): that line's shape (an org digest
 * and a status push in front, then completed, waiting and stopped notices), a peer
 * note mid-turn, and a turn a trigger started.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'

const SESSION_ID = 'pw-inbound-session'
const TASK_ID = 'pw-task-inbound'
const SHOTS = path.join(process.env.WALNUT_TASK_DIR || '/tmp/wn-inbound-cards', 'shots')

test.describe.configure({ mode: 'serial' })
test.use({ video: process.env.PW_INBOUND_VIDEO ? { mode: 'on', size: { width: 1100, height: 900 } } : 'off', viewport: { width: 1100, height: 900 } })

test.beforeAll(async () => { await fs.mkdir(SHOTS, { recursive: true }) })

async function openSession(page: Page): Promise<Locator> {
  const panel = page.locator(`.session-panel[data-session-id="${SESSION_ID}"]`)
  const task = page.locator(`.todo-panel-item[data-task-id="${TASK_ID}"]`)
  await expect(async () => {
    await page.locator('.todo-search-input').fill(TASK_ID)
    await expect(task).toBeVisible({ timeout: 3_000 })
  }).toPass({ timeout: 30_000 })
  await task.locator('.todo-item-title').click()
  await expect(panel).toBeVisible({ timeout: 15_000 })
  await expect(panel.locator('.session-history')).toContainText('INBOUND_ANSWER_THREE', { timeout: 20_000 })
  return panel
}

/** Bring a target into the timeline's view with real wheel gestures (the timeline follows its bottom). */
async function reveal(page: Page, panel: Locator, target: Locator): Promise<void> {
  const scroller = panel.locator('.session-history')
  const view = (await scroller.boundingBox())!
  await page.mouse.move(view.x + view.width / 2, view.y + view.height / 2)
  for (let i = 0; i < 30; i++) {
    const box = await target.boundingBox()
    if (box && box.y >= view.y && box.y + Math.min(box.height, 200) <= view.y + view.height) return
    await page.mouse.wheel(0, box && box.y < view.y ? -160 : 160)
    await page.waitForTimeout(100)
  }
}

/** The cards on screen right now (a closed fold draws none). */
const shownCards = (panel: Locator) => panel.locator('.provenance-card').evaluateAll(
  (els) => els.filter((e) => (e as HTMLElement).offsetParent !== null).length,
)

test('every incoming message folds into the turn, and reads Who, Title, Summary, Details', async ({ page }) => {
  test.setTimeout(150_000)
  await page.goto('/')
  const panel = await openSession(page)
  const history = panel.locator('.session-history')

  // Closed: no incoming card is on screen, only the folds and the words of the turns.
  expect(await shownCards(panel)).toBe(0)
  await expect(history).toContainText('INBOUND_ANSWER_ONE')
  await expect(history).toContainText('INBOUND_ANSWER_THREE')
  // The person's words behind Walnut's notes are his bubble, not text on the AI side.
  await expect(panel.locator('.session-msg-user', { hasText: 'INBOUND_PERSON_WORDS' })).toBeVisible()
  await expect(panel.locator('.provenance-card', { hasText: 'INBOUND_PERSON_WORDS' })).toHaveCount(0)
  // The notes in front of his message: one closed fold of five, above his bubble.
  const riders = panel.locator('[data-testid="rider-fold"]', { hasText: 'Received 5 messages' })
  await expect(riders).toHaveCount(1)
  await page.screenshot({ path: path.join(SHOTS, 'inbound-closed.png') })

  // Open it: five cards, each folded to its head.
  await reveal(page, panel, riders)
  await riders.locator('.tool-run-toggle').first().click()
  const cards = riders.locator('.provenance-card')
  await expect(cards).toHaveCount(5)
  for (let i = 0; i < 5; i++) {
    const c = cards.nth(i)
    await expect(c).toHaveAttribute('data-folded', 'true')
    await expect(c.locator('.op-card-to')).toBeVisible()
    await expect(c.locator('.op-card-title')).not.toBeEmpty()
    await expect(c.locator('.op-card-more')).toHaveText(/Details/)
    await expect(c.locator('.op-card-detail')).toHaveCount(0)
  }
  // Who: the task each notice is about, as a pill.
  const stopped = cards.filter({ hasText: 'Stopped without completing' })
  await expect(stopped.locator('.op-card-dir')).toHaveText('System, about')
  await expect(stopped.locator('.op-card-to a.task-link[data-task-id="pw-task-001"]')).toBeVisible()
  // Summary: the task's own last words (kept for find and the open card).
  await expect(stopped.locator('.op-card-summary')).toContainText('I decided one thing for you')
  const digest = cards.filter({ hasText: 'Org update since 2 h ago' })
  // A digest's own lines are its summary, never lost.
  await expect(digest.locator('.op-card-summary')).toContainText('Walnut: 2 done, 3 new')
  const done = cards.filter({ hasText: 'Completed its task' })
  // In a fold a card is one row like every step (design 1, 2026-11-11): the summary is in
  // the words it opens to, never a second line under the title.
  await expect(done.locator('.op-card-summary')).toBeHidden()
  expect((await done.boundingBox())!.height).toBeLessThanOrEqual(30)
  const tlh = await done.locator('.op-card-title').evaluate((el) => parseFloat(getComputedStyle(el).lineHeight) || 20)
  expect((await done.locator('.op-card-title').boundingBox())!.height).toBeLessThanOrEqual(tlh + 2)
  await reveal(page, panel, cards.first())
  await page.screenshot({ path: path.join(SHOTS, 'inbound-fold-open.png') })

  // A click opens one card's words; a second folds it again.
  await reveal(page, panel, digest)
  await digest.locator('.op-card-main').click()
  await expect(digest.locator('.op-card-detail')).toContainText('Inbox: 1 done')
  await reveal(page, panel, digest)
  await page.screenshot({ path: path.join(SHOTS, 'inbound-card-open.png') })
  await digest.locator('.op-card-main').click()
  await expect(digest.locator('.op-card-detail')).toHaveCount(0)

  // The peer note mid-turn sits in that turn's fold, with its sender as a pill.
  const turnFold = panel.locator('[data-testid="turn-fold"]', { hasText: 'Received 6 messages' })
  await reveal(page, panel, turnFold)
  await turnFold.locator('.tool-run-toggle').first().click()
  const peer = turnFold.locator('.provenance-card[data-envelope-kind="peer-note"]')
  await expect(peer).toHaveCount(1)
  await expect(peer.locator('.op-card-dir')).toHaveText('From')
  await expect(peer.locator('.op-card-to a.task-link[data-task-id="pw-task-001"]')).toBeVisible()
  await expect(peer.locator('.op-card-title')).toHaveText('The fix is live; nothing else is needed from you.')
  await page.waitForTimeout(600)
})
