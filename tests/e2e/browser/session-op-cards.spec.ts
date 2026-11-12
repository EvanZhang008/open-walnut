/**
 * Walnut op cards in the real session timeline (SessionOutboundCard).
 *
 * 2026-11-09, the user, of a lead's chat: every send read "Payload from file —
 * the text is not in this transcript", twice, over the raw command. The lead had
 * written each payload into /tmp with a heredoc and sent `@/tmp/x.json`, and
 * updated two threads in the same command. His design for the card: "To Who,
 * Title, Summary, detail collapse".
 *
 * Fixture `pw-opcards-session` (test-server.ts): that exact command shape (a send,
 * a thread merge, a thread update from a heredoc file), a letter sent from a file
 * the transcript never saw (its words only in Walnut's record of the call,
 * WALNUT_HOME/op-calls), and an MCP brief_write. Every card must read To, Title
 * and Summary folded, and open its full words with the raw call on a click.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { openAllTurnFolds } from './turn-fold-helpers'

const SESSION_ID = 'pw-opcards-session'
const TASK_ID = 'pw-task-opcards'
const SHOTS = path.join(process.env.WALNUT_TASK_DIR || '/tmp/wn-op-cards', 'shots')

test.describe.configure({ mode: 'serial' })
test.use({ video: process.env.PW_OPCARDS_VIDEO ? 'on' : 'off', viewport: { width: 1100, height: 900 } })

test.beforeAll(async () => { await fs.mkdir(SHOTS, { recursive: true }) })

async function openSession(page: Page): Promise<Locator> {
  const panel = page.locator(`.session-panel[data-session-id="${SESSION_ID}"]`)
  if (await panel.count() === 0) {
    const task = page.locator(`.todo-panel-item[data-task-id="${TASK_ID}"]`)
    await expect(async () => {
      await page.locator('.todo-search-input').fill(TASK_ID)
      await expect(task).toBeVisible({ timeout: 3_000 })
    }).toPass({ timeout: 30_000 })
    await task.locator('.todo-item-title').click()
  }
  await expect(panel).toBeVisible({ timeout: 15_000 })
  // The sends sit in the turn's "Sent N" fold, folded like every turn's steps.
  await expect(panel.locator('.session-history')).toContainText('Handed on; the browser task owns it now.', { timeout: 20_000 })
  await openAllTurnFolds(panel)
  await expect(panel.locator('.op-card').first()).toBeVisible({ timeout: 20_000 })
  return panel
}

/** Bring a card into the timeline's view with real wheel gestures (the timeline follows its bottom). */
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

test('every op card reads To, Title and Summary, and opens its words with the call', async ({ page }) => {
  test.setTimeout(150_000)
  await page.goto('/')
  const panel = await openSession(page)
  const cards = panel.locator('.op-card')
  await expect(cards).toHaveCount(5)
  // Nothing says the words are missing: the heredoc file, the record and MCP all hold them.
  await expect(panel).not.toContainText('not in this transcript')
  await expect(panel).not.toContainText('kept no copy')

  const send = panel.locator('.op-card[data-op="task_send"]')
  await expect(send.locator('.op-card-dir')).toHaveText('To')
  await expect(send.locator('.op-card-to a.task-link[data-task-id="pw-task-001"]')).toBeVisible()
  await expect(send.locator('.op-card-title')).toHaveText('Tab list out of step with Chrome')
  await expect(send.locator('.op-card-summary')).toContainText('The card lists two tabs while the agent window holds nine.')
  // Folded: in a turn's fold the card is one row like every step (design 1, 2026-11-11), the
  // summary in the words it opens to; the full words and the raw command are not drawn.
  await expect(send.locator('.op-card-summary')).toBeHidden()
  expect((await send.boundingBox())!.height).toBeLessThanOrEqual(30)
  await expect(send.locator('.op-card-detail')).toHaveCount(0)
  await expect(send.locator('.provenance-details')).toHaveCount(0)

  const threads = panel.locator('.op-card[data-op="thread_update"]')
  await expect(threads).toHaveCount(2)
  await expect(threads.nth(0).locator('.op-card-title')).toHaveText('Merged into another thread (th-cards-2).')
  await expect(threads.nth(1)).toContainText('Handed to the browser task with the screenshot')
  await expect(threads.nth(1).locator('.op-card-to-label')).toHaveText('Thread')
  await expect(threads.nth(1).locator('a.task-link')).toHaveCount(0)

  const letter = panel.locator('.op-card[data-op="human_inbox_send"]')
  await expect(letter.locator('.op-card-to-label')).toHaveText('Your inbox')
  await expect(letter.locator('.op-card-title')).toHaveText('Pick the rollout plan')
  await expect(letter.locator('.op-card-summary')).toContainText('Two plans are ready.')

  const brief = panel.locator('.op-card[data-op="brief_write"]')
  await expect(brief.locator('.op-card-title')).toHaveText('Brief rewritten')
  await expect(brief.locator('.op-card-to-label')).toHaveText('Brief')
  await expect(brief.locator('.op-card-summary')).toContainText('Needs you: Nothing.')

  await reveal(page, panel, send)
  await page.screenshot({ path: path.join(SHOTS, 'op-cards-folded.png') })

  // A click opens the full words, then the call and its answer inside them.
  await send.locator('.op-card-main').click()
  await expect(send.locator('.op-card-detail')).toContainText('Evidence: a screenshot of both side by side.')
  const details = send.locator('.provenance-details')
  await expect(details).toBeVisible()
  await details.locator('summary').click()
  await expect(details.locator('pre.provenance-raw').first()).toContainText('walnut tools call task_send @/tmp/pw-send.json')
  await reveal(page, panel, details)
  await page.screenshot({ path: path.join(SHOTS, 'op-cards-open.png') })
  // The letter's words come from Walnut's record, the file long gone.
  await reveal(page, panel, letter)
  await letter.locator('.op-card-main').click()
  await expect(letter.locator('.op-card-detail')).toContainText('My pick is B: the old importer drops attachments.')
  await reveal(page, panel, letter)
  await page.screenshot({ path: path.join(SHOTS, 'op-cards-letter-open.png') })
  // And a second click folds it again.
  await reveal(page, panel, send)
  await send.locator('.op-card-main').click()
  await expect(send.locator('.op-card-detail')).toHaveCount(0)
  await page.waitForTimeout(600)
})
