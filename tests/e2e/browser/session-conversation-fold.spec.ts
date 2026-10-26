/**
 * Conversation Mode folds a question's turns in the main timeline to their label
 * line (2026-10-15, the user, on a question's exchange left open in the main
 * chat: "it should auto collapse in the main chat if it is about a question").
 * Since 2026-10-23 it folds even while it is the composer's target, while its
 * card is open and while its answer is on the way (the user: "the response
 * thread should be automatically collapsed"): the card is where its turns are
 * read. Only a question holding the passage of one of those (a follow-up's
 * passage is in its parent's answer) stays open. A follow-up folds with its
 * question; the chevron shows or folds it by hand until the main conversation's
 * next message.
 *
 * The map fixture has no sends (rules, chevron, target, card); the send fixture
 * walks the user's own case: ask, read the answer in the card, go back to the
 * main conversation, and the question stays one line.
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

    test('the target folds to its line too; a follow-up as the target keeps its question open', async ({ page }) => {
      const panel = await open(page, MAP_SESSION, MAP_TASK, MAP_READY)
      const card = panel.locator('.thread-card')
      await panel.locator('.thread-map .thread-map-row', { hasText: MAP_TITLES.Q4 }).first().click()
      await expect(composerTarget(panel)).toContainText(MAP_TITLES.Q4)
      await expect(card).toBeVisible()
      // The target and its open card: the line stands in for the turns, the card
      // holds them.
      await expect(foldLine(panel, MAP_TITLES.Q4)).toHaveCount(1)
      await expect(row(panel, IDS.Q4.u)).toHaveCount(0)
      await expect(row(panel, IDS.Q4a.u)).toHaveCount(0)
      await expect(row(panel, IDS.Q1.u)).toHaveCount(0)
      await card.locator('.thread-card-input').press('Escape')
      await expect(card).toHaveCount(0)
      // The composer chip's x: back to the main conversation, still one line.
      await composerTarget(panel).locator('.pill-close').click()
      await expect(composerTarget(panel)).toHaveCount(0)
      await expect(row(panel, IDS.Q4.u)).toHaveCount(0)
      await expect(foldLine(panel, MAP_TITLES.Q4)).toHaveCount(1)
      // A follow-up as the target: its passage is in its question's answer, so
      // that question stays open (and the follow-up shows within it).
      await panel.locator('.thread-map .thread-map-row', { hasText: MAP_TITLES.Q4a }).first().click()
      await expect(composerTarget(panel)).toContainText(MAP_TITLES.Q4a)
      await expect(row(panel, IDS.Q4.u)).toBeAttached()
      await expect(foldLine(panel, MAP_TITLES.Q4)).toHaveCount(0)
      await expect(row(panel, IDS.Q1.u)).toHaveCount(0)
      await shot(page, 'follow-up-target')
    })

    test('a folded line\'s title opens its card beside the passage, and the turns stay folded while it is open', async ({ page }) => {
      const panel = await open(page, MAP_SESSION, MAP_TASK, MAP_READY)
      await press(page, panel, foldLine(panel, MAP_TITLES.Q4).locator('.thread-turn-label'))
      const card = panel.locator('.thread-card')
      await expect(card).toBeVisible()
      await expect(card.locator('.thread-card-title')).toHaveText(MAP_TITLES.Q4)
      await expect(card.locator('.thread-card-q').first()).toBeVisible()
      // The card is where its turns are read: the main chat keeps the one line.
      await expect(row(panel, IDS.Q4.u)).toHaveCount(0)
      await expect(foldLine(panel, MAP_TITLES.Q4)).toHaveCount(1)
      await shot(page, 'card')
      await page.keyboard.press('Escape')
      await expect(card).toHaveCount(0)
    })
  })

  test.describe('the user\'s case, on the send fixture', () => {
    test.describe.configure({ mode: 'serial' })
    test.beforeEach(async ({ request }) => {
      const res = await request.patch(`/api/sessions/${SEND_SESSION}`, { data: { thread_anchors: [], pinned_messages: [] } })
      expect(res.ok()).toBe(true)
    })

    test('ask, read the answer in the card, reply in the main conversation: the question is one line throughout, and folds again after a look', async ({ page }) => {
      const panel = await open(page, SEND_SESSION, SEND_TASK, SEND_READY)
      await centreInHistory(page, panel, SEND_PHRASE)
      await passageRects(panel, SEND_PHRASE)
      await selectPassage(page, panel, SEND_PHRASE)
      await page.locator('[data-testid="quote-pin-pill"] [data-testid="quote-ask-btn"]').click()
      const card = panel.locator('.thread-card')
      await expect(card).toBeVisible()
      const box = panel.locator('.session-panel-input .chat-input-textarea')
      // Into the composer: the Ask stays the target ("Asking about").
      await box.click()
      await expect(composerTarget(panel)).toHaveAttribute('data-pending', 'true')
      await box.fill('Why in place?')
      await box.press('Enter')
      await expect(box).toHaveValue('')
      const asked = () => history(panel).locator('.session-msg--threaded', { hasText: 'Why in place?' })
      const fold = history(panel).locator('[data-thread-fold]')
      // The question is the target while it is answered, and still it folds to
      // its line in the main chat (2026-10-23).
      await expect(fold).toHaveCount(1, { timeout: 30_000 })
      await expect(asked()).toHaveCount(0)
      // The line's title opens its card, which shows the answer; the main chat
      // keeps the line.
      await press(page, panel, fold.first().locator('.thread-turn-label'))
      await expect(card).toBeVisible()
      await expect(card.locator('.thread-card-body')).toContainText('processed your message', { timeout: 60_000 })
      await expect(asked()).toHaveCount(0)
      await expect(fold).toHaveCount(1)
      await card.locator('.thread-card-input').press('Escape')
      await expect(card).toHaveCount(0)
      // Back to the main conversation: still one line.
      await composerTarget(panel).locator('.pill-close').click()
      await expect(composerTarget(panel)).toHaveCount(0)
      await expect(asked()).toHaveCount(0)
      await expect(fold).toHaveCount(1)
      const sendMain = async (text: string) => {
        await box.click()
        await box.fill(text)
        await box.press('Enter')
        await expect(history(panel)).toContainText(text, { timeout: 30_000 })
      }
      await sendMain('Back to the plan: what comes after phase three?')
      await expect(asked()).toHaveCount(0)
      await expect(fold).toHaveCount(1)
      await shot(page, 'user-case-folded')
      // Shown by hand, then the main conversation moves on again: it folds again.
      await press(page, panel, chevronOf(fold.first()))
      await expect(asked().first()).toBeVisible()
      await expect(history(panel)).toContainText('processed your message: Back to the plan', { timeout: 60_000 })
      await sendMain('And after that?')
      await expect(asked()).toHaveCount(0, { timeout: 30_000 })
      // One line once the reply is in (while it streams, before history catches
      // up, it can be filed under the question for a moment).
      await expect(history(panel)).toContainText('processed your message: And after that?', { timeout: 60_000 })
      await expect(fold).toHaveCount(1, { timeout: 30_000 })
      await shot(page, 'user-case')
    })
  })
})
