/**
 * Conversation Mode folds a question's turns in the main timeline to their label
 * line (2026-10-15, the user, on a question's exchange left open in the main
 * chat: "it should auto collapse in the main chat if it is about a question").
 * Open while it is the composer's target, while its card is open, while its
 * answer is on the way, while it was asked after the main conversation's
 * newest message; a
 * follow-up folds with its question; the chevron shows or folds it by hand
 * until the main conversation's next message.
 *
 * The map fixture has no sends (rules, chevron, target, card); the send fixture
 * walks the user's own case: ask, get the answer, go back to the main
 * conversation, and the question folds.
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import {
  centreInHistory, openThreadsSession, passageRects, resetThreadsFixture, selectPassage, switchView,
} from './threads-helpers'
import { buildMapSession, MAP_SESSION, MAP_TITLES } from './threads-fixture'

const MAP_TASK = 'pw-task-threads-map'
const MAP_READY = 'Summarize the open risks.'
const IDS = buildMapSession(Date.now()).ids
const SEND_SESSION = 'pw-threads-send-session'
const SEND_TASK = 'pw-task-threads-send'
const SEND_READY = 'Phase three only verifies checksums.'
const SEND_PHRASE = 'rewrites the index in place'

async function shot(page: Page, name: string): Promise<void> {
  const dir = `/tmp/conv-fold/e2e/${test.info().project.name}`
  await fs.mkdir(dir, { recursive: true })
  await page.screenshot({ path: `${dir}/${name}.png` })
}

async function open(page: Page, sid: string, task: string, ready: string): Promise<Locator> {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.addStyleTag({ content: '.notification-toaster { display: none !important; }' })
  await page.addStyleTag({ content: `.main-page-session-column:has(.session-panel[data-session-id="${sid}"]) {
    flex: 0 0 720px !important; width: 720px !important; min-width: 720px !important; max-width: 720px !important; }` })
  const panel = await openThreadsSession(page, sid, task, ready, { view: 'linear' })
  // A session with no question yet has no mode pill to switch with.
  if (sid === MAP_SESSION) await switchView(panel, 'linear')
  return panel
}

const history = (panel: Locator) => panel.locator('.session-history')
const row = (panel: Locator, id: string) => history(panel).locator(`[data-message-id="${id}"]`)
const foldLine = (panel: Locator, title: string) => history(panel).locator('[data-thread-fold]', { hasText: title })
const chevronOf = (line: Locator) => line.locator('.thread-turn-fold')
const composerTarget = (panel: Locator) => panel.locator('[data-testid="composer-thread-target"]')
/** A line up the timeline: real wheels bring it on screen first (a box at its
 *  bottom follows the bottom, and WebKit pulls a programmatic scroll back). */
async function press(page: Page, panel: Locator, target: Locator): Promise<void> {
  await centreInHistory(page, panel, target, { capRow: true })
  await target.click()
}

test.describe('Conversation Mode folds questions in the main chat', () => {
  test.setTimeout(240_000)

  test.describe('the rule, on the map fixture', () => {
    test.beforeEach(async ({ request }) => { await resetThreadsFixture(request, MAP_SESSION) })

    test('on the main conversation every question is its label line; follow-ups fold with their question', async ({ page }) => {
      const panel = await open(page, MAP_SESSION, MAP_TASK, MAP_READY)
      // The main conversation is all there (R0 is the Initial Prompt, and the
      // render window starts after it: "Load earlier turns").
      for (const r of ['R1', 'R2', 'R3'] as const) await expect(row(panel, IDS[r].u)).toBeAttached()
      // Every question's rows are gone, its line stands in for them.
      for (const q of ['Q1', 'Q1a', 'Q1b', 'Q2', 'Q4', 'Q4a'] as const) {
        await expect(row(panel, IDS[q].u)).toHaveCount(0)
      }
      const q1 = foldLine(panel, MAP_TITLES.Q1)
      await expect(q1).toHaveCount(1)
      await expect(q1.locator('.thread-map-num')).toHaveText('1')
      await expect(q1.locator('.thread-status-word')).toBeVisible()
      await expect(chevronOf(q1)).toHaveAttribute('aria-expanded', 'false')
      // Its follow-ups have no line of their own.
      await expect(foldLine(panel, MAP_TITLES.Q1a)).toHaveCount(0)
      await expect(foldLine(panel, MAP_TITLES.Q4)).toHaveCount(1)
      // One line, one row's height: about 30px, not a whole exchange.
      expect((await q1.boundingBox())!.height).toBeLessThan(44)
      await shot(page, 'folded')
    })

    test('the chevron shows the turns and folds them again; nothing becomes the target', async ({ page }) => {
      const panel = await open(page, MAP_SESSION, MAP_TASK, MAP_READY)
      await press(page, panel, chevronOf(foldLine(panel, MAP_TITLES.Q1)))
      // Q1's own first turn lies above the render window; its follow-ups show.
      for (const q of ['Q1a', 'Q1b'] as const) await expect(row(panel, IDS[q].u)).toBeAttached()
      // A follow-up's own label has no chevron: the line folds the whole question.
      await expect(row(panel, IDS.Q1a.u).locator('.thread-turn-label')).toHaveCount(1)
      await expect(row(panel, IDS.Q1a.u).locator('.thread-turn-fold')).toHaveCount(0)
      await expect(composerTarget(panel)).toHaveCount(0)
      await expect(row(panel, IDS.Q4.u)).toHaveCount(0)
      await shot(page, 'shown')
      // Q4 shown by hand, then folded again from its own label's chevron.
      await press(page, panel, chevronOf(foldLine(panel, MAP_TITLES.Q4)))
      const q4Head = row(panel, IDS.Q4.u).locator('.thread-turn-head')
      await expect(q4Head.locator('.thread-turn-fold')).toHaveAttribute('aria-expanded', 'true')
      await press(page, panel, q4Head.locator('.thread-turn-fold'))
      await expect(row(panel, IDS.Q4.u)).toHaveCount(0)
      await expect(foldLine(panel, MAP_TITLES.Q4)).toHaveCount(1)
      // Each question keeps its own choice: Q1 is still shown.
      await expect(row(panel, IDS.Q1a.u)).toBeAttached()
    })

    test('the target is open; going back to the main conversation folds it again', async ({ page }) => {
      const panel = await open(page, MAP_SESSION, MAP_TASK, MAP_READY)
      await panel.locator('.thread-map .thread-map-row', { hasText: MAP_TITLES.Q4 }).first().click()
      await expect(composerTarget(panel)).toContainText(MAP_TITLES.Q4)
      await expect(row(panel, IDS.Q4.u)).toBeAttached()
      await expect(row(panel, IDS.Q4a.u)).toBeAttached()
      await expect(row(panel, IDS.Q1.u)).toHaveCount(0)
      // The composer chip's x: back to the main conversation.
      await composerTarget(panel).locator('.pill-close').click()
      await expect(composerTarget(panel)).toHaveCount(0)
      await expect(row(panel, IDS.Q4.u)).toHaveCount(0)
      await expect(foldLine(panel, MAP_TITLES.Q4)).toHaveCount(1)
    })

    test('a folded line\'s title opens its card beside the passage, and the turns show while it is open', async ({ page }) => {
      const panel = await open(page, MAP_SESSION, MAP_TASK, MAP_READY)
      await press(page, panel, foldLine(panel, MAP_TITLES.Q4).locator('.thread-turn-label'))
      await expect(panel.locator('.thread-card')).toBeVisible()
      await expect(row(panel, IDS.Q4.u)).toBeAttached()
      await shot(page, 'card')
      await page.keyboard.press('Escape')
      await expect(panel.locator('.thread-card')).toHaveCount(0)
    })
  })

  test.describe('the user\'s case, on the send fixture', () => {
    test.describe.configure({ mode: 'serial' })
    test.beforeEach(async ({ request }) => {
      const res = await request.patch(`/api/sessions/${SEND_SESSION}`, { data: { thread_anchors: [], pinned_messages: [] } })
      expect(res.ok()).toBe(true)
    })

    test('ask, read the answer, reply in the main conversation: the question folds, and folds again after a look', async ({ page }) => {
      const panel = await open(page, SEND_SESSION, SEND_TASK, SEND_READY)
      await centreInHistory(page, panel, SEND_PHRASE)
      await passageRects(panel, SEND_PHRASE)
      await selectPassage(page, panel, SEND_PHRASE)
      await page.locator('[data-testid="quote-pin-pill"] [data-testid="quote-ask-btn"]').click()
      const box = panel.locator('.session-panel-input .chat-input-textarea')
      await box.click()
      await box.fill('Why in place?')
      await box.press('Enter')
      await expect(box).toHaveValue('')
      const bubble = history(panel).locator('.session-msg--threaded', { hasText: 'Why in place?' }).first()
      await expect(bubble).toBeVisible({ timeout: 30_000 })
      // The question is the target while it is answered: its turn stays open, and
      // the card (open since the Ask) stays where it is.
      await expect(history(panel)).toContainText('processed your message', { timeout: 60_000 })
      await expect(bubble).toBeVisible()
      // Back to the main conversation: the answer that just came in stays open
      // (the reader may still be reading it) until the main conversation speaks.
      await composerTarget(panel).locator('.pill-close').click()
      await expect(composerTarget(panel)).toHaveCount(0)
      const asked = () => history(panel).locator('.session-msg--threaded', { hasText: 'Why in place?' })
      await expect(asked().first()).toBeVisible()
      await expect(history(panel).locator('[data-thread-fold]')).toHaveCount(0)
      const sendMain = async (text: string) => {
        await box.click()
        await box.fill(text)
        await box.press('Enter')
        await expect(history(panel)).toContainText(text, { timeout: 30_000 })
      }
      await sendMain('Back to the plan: what comes after phase three?')
      // The question folds to its line.
      await expect(asked()).toHaveCount(0, { timeout: 30_000 })
      await expect(history(panel).locator('[data-thread-fold]')).toHaveCount(1)
      await shot(page, 'user-case-folded')
      // Shown by hand, then the main conversation moves on again: it folds again.
      await press(page, panel, chevronOf(history(panel).locator('[data-thread-fold]').first()))
      await expect(asked().first()).toBeVisible()
      await expect(history(panel)).toContainText('processed your message: Back to the plan', { timeout: 60_000 })
      await sendMain('And after that?')
      await expect(asked()).toHaveCount(0, { timeout: 30_000 })
      // One line once the reply is in (while it streams, before history catches
      // up, it can be filed under the question for a moment).
      await expect(history(panel)).toContainText('processed your message: And after that?', { timeout: 60_000 })
      await expect(history(panel).locator('[data-thread-fold]')).toHaveCount(1, { timeout: 30_000 })
      await shot(page, 'user-case')
    })
  })
})
