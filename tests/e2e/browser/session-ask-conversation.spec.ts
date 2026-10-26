/**
 * Ask here always asks in Conversation Mode, and the question's own turns fold
 * in the main chat (2026-10-23, the user: "ask here when click default should
 * be conversation mode not in treemode", "the response thread should be
 * automatically collapsed").
 *
 * From a column in Tree Mode: Ask switches it to Conversation Mode and opens
 * the card beside the passage with its input focused, while the passage stays
 * where the reader selected it. Sent, the question is one label line in the
 * main chat while its answer streams into the card (the main timeline does not
 * move) and after it lands; the chevron shows and folds it; a follow-up typed
 * in the card keeps it folded. Closing the card with words leaves them for the
 * next Ask on that passage, and a reload keeps Conversation Mode. Asked on a
 * passage inside a question's answer (from its page), that question stays open.
 *
 * Chromium and WebKit. The tagged fixture session (it has questions, so Tree
 * Mode is a real stack: a session without any renders Conversation Mode); the
 * new question is on a passage of the first answer no question holds yet. The
 * mock CLI answers a message that starts with `slow:<ms>` after that delay.
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import {
  centreInHistory, openThreadsSession, resetThreadsFixture, selectPassage, sessionPanel, switchView,
} from './threads-helpers'
import { buildTaggedSession, filler, TAGGED_READY, TAGGED_SESSION, TAGGED_TASK, TAGGED_TITLES } from './threads-fixture'

/** The first answer opens with `filler(201, 60)`: its first words, in no question. */
const PHRASE = filler(201, 60).slice(0, 40)
const ROW = buildTaggedSession(Date.now()).ids.R1.a
/** Q1's answer: a passage inside a question, asked about from that question's page. */
const Q1_PHRASE = filler(203, 40).slice(0, 30)
const Q1_ROW = buildTaggedSession(Date.now()).ids.Q1.a
const QUESTION = 'what does this mean for stale copies?'

async function shot(page: Page, name: string): Promise<void> {
  const dir = `/tmp/ask-conv/e2e/${test.info().project.name}`
  await fs.mkdir(dir, { recursive: true })
  await page.screenshot({ path: `${dir}/${name}.png` })
}

const history = (panel: Locator) => panel.locator('.session-history')
const card = (panel: Locator) => panel.locator('.thread-card')
const foldLines = (panel: Locator) => history(panel).locator('[data-thread-fold]')
/** The question's own bubble in the main timeline (not the card's copy). */
const askedBubble = (panel: Locator, text: string) => history(panel).locator('.session-msg--threaded', { hasText: text })

/** Where the passage's paragraph sits on screen, and the timeline's scroll. */
async function place(panel: Locator, row = ROW): Promise<{ top: number; scroll: number }> {
  return panel.evaluate((root, needle) => {
    const box = root.querySelector('.session-history') as HTMLElement
    const el = root.querySelector(`.session-history [data-message-id="${needle}"]`) as HTMLElement | null
    return { top: el ? el.getBoundingClientRect().top : NaN, scroll: box.scrollTop }
  }, row)
}

async function openInTree(page: Page): Promise<Locator> {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.addStyleTag({ content: '.notification-toaster { display: none !important; }' })
  const panel = await openThreadsSession(page, TAGGED_SESSION, TAGGED_TASK, TAGGED_READY, { view: 'stack', map: 'default' })
  // The session's own saved view (an earlier Ask switched it) wins over the
  // helper's default: take the pill to Tree Mode.
  await switchView(panel, 'stack')
  await expect(history(panel)).toHaveAttribute('data-view-mode', 'stack')
  await centreInHistory(page, panel, PHRASE, { tolerance: 20 })
  return panel
}

async function askFromTree(page: Page, panel: Locator): Promise<number> {
  await selectPassage(page, panel, PHRASE)
  const before = (await place(panel)).top
  await page.locator('[data-testid="quote-pin-pill"] [data-testid="quote-ask-btn"]').click()
  await expect(history(panel)).toHaveAttribute('data-view-mode', 'linear')
  await expect(card(panel)).toBeVisible()
  return before
}

test.describe('Ask here asks in Conversation Mode; the question folds in the main chat', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(240_000)
  test.beforeEach(async ({ request }) => { await resetThreadsFixture(request, TAGGED_SESSION) })
  test.afterAll(async ({ request }) => { await resetThreadsFixture(request, TAGGED_SESSION) })

  test('from Tree Mode: Conversation Mode, the card beside a still passage; sent, one line while it streams and after', async ({ page }) => {
    const panel = await openInTree(page)
    const before = await askFromTree(page, panel)
    // The fixture's own questions are lines already; the new one adds one.
    const lines0 = await foldLines(panel).count()
    // The card is on screen, its own input focused, and no question page was pushed.
    const cardBox = (await card(panel).boundingBox())!
    expect(cardBox.y).toBeGreaterThanOrEqual(0)
    expect(cardBox.y + cardBox.height).toBeLessThanOrEqual(900)
    await expect(card(panel)).toHaveAttribute('data-draft', 'true')
    await expect(card(panel).locator('.thread-card-input')).toBeFocused()
    await expect(panel.locator('.thread-stack')).toHaveCount(0)
    // The passage stays where it was selected, also once the new view settles.
    for (const wait of [0, 300, 900]) {
      await page.waitForTimeout(wait)
      expect(Math.abs((await place(panel)).top - before), `passage moved after ${wait}ms`).toBeLessThanOrEqual(3)
    }
    await shot(page, '1-card')

    await card(panel).locator('.thread-card-input').fill(`slow:12000 ${QUESTION}`)
    await card(panel).locator('.thread-card-input').press('Enter')
    await expect(card(panel)).toHaveAttribute('data-answering', 'true', { timeout: 30_000 })
    // While it is answered: one label line in the main chat, never the turns, and
    // the main timeline holds still under the reader.
    await expect(foldLines(panel)).toHaveCount(lines0 + 1, { timeout: 15_000 })
    const during = await place(panel)
    for (let i = 0; i < 4; i += 1) {
      await page.waitForTimeout(1_000)
      await expect(askedBubble(panel, QUESTION)).toHaveCount(0)
      await expect(foldLines(panel)).toHaveCount(lines0 + 1)
      const now = await place(panel)
      expect(Math.abs(now.top - during.top), 'the main timeline moved while the answer streamed').toBeLessThanOrEqual(3)
    }
    await shot(page, '2-answering')
    // Landed: in the card, and still one line in the main chat.
    await expect(card(panel)).toContainText(`processed your message: ${QUESTION}`, { timeout: 60_000 })
    await expect(card(panel)).not.toHaveAttribute('data-answering', 'true', { timeout: 15_000 })
    await expect(askedBubble(panel, QUESTION)).toHaveCount(0)
    await expect(foldLines(panel)).toHaveCount(lines0 + 1)
    expect(Math.abs((await place(panel)).top - during.top)).toBeLessThanOrEqual(3)
    await shot(page, '3-landed')

    // A follow-up typed in the card: answered there, the question stays one line.
    const reply = card(panel).locator('.thread-card-input')
    await reply.fill('and the second copy?')
    await reply.press('Enter')
    await expect(card(panel)).toContainText('processed your message: and the second copy?', { timeout: 60_000 })
    await expect(askedBubble(panel, 'and the second copy?')).toHaveCount(0)
    await expect(foldLines(panel)).toHaveCount(lines0 + 1)

    // The chevron shows the turns, and folds them again.
    await card(panel).locator('.thread-card-close').click()
    await expect(card(panel)).toHaveCount(0)
    const line = foldLines(panel).last()
    await centreInHistory(page, panel, line, { capRow: true })
    await line.locator('.thread-turn-fold').click()
    await expect(askedBubble(panel, QUESTION).first()).toBeVisible()
    await shot(page, '4-shown')
    const head = history(panel).locator('.thread-turn-head .thread-turn-fold[aria-expanded="true"]').first()
    await centreInHistory(page, panel, head, { capRow: true })
    await head.click()
    await expect(askedBubble(panel, QUESTION)).toHaveCount(0)
    await expect(foldLines(panel)).toHaveCount(lines0 + 1)

    // A reload keeps Conversation Mode (the Ask switched it for this session) and
    // the fold. The mock CLI keeps no turns for this fixture session across a
    // reload (only the reload fixtures persist), so the history comes back as the
    // fixture wrote it: its own questions, each still one line.
    await page.reload()
    await page.waitForLoadState('networkidle')
    const again = sessionPanel(page, TAGGED_SESSION)
    await expect(again).toBeVisible({ timeout: 30_000 })
    await expect(history(again)).toHaveAttribute('data-view-mode', 'linear', { timeout: 30_000 })
    await expect(foldLines(again)).toHaveCount(lines0, { timeout: 30_000 })
    await expect(askedBubble(again, QUESTION)).toHaveCount(0)
  })

  test('closing the card with words keeps them for the next Ask on that passage', async ({ page }) => {
    const panel = await openInTree(page)
    await askFromTree(page, panel)
    await card(panel).locator('.thread-card-input').fill('half a question')
    await card(panel).locator('.thread-card-close').click()
    await expect(card(panel)).toHaveCount(0)
    await expect(history(panel)).toHaveAttribute('data-view-mode', 'linear')
    await centreInHistory(page, panel, PHRASE, { tolerance: 20 })
    await selectPassage(page, panel, PHRASE)
    await page.locator('[data-testid="quote-pin-pill"] [data-testid="quote-ask-btn"]').click()
    await expect(card(panel)).toBeVisible()
    await expect(card(panel).locator('.thread-card-input')).toHaveValue('half a question')
    await shot(page, '5-restored')
  })

  test('from a question\'s page in Tree Mode: the passage in its answer stays on screen beside the card', async ({ page }) => {
    const panel = await openInTree(page)
    await panel.locator('.thread-asked-row:not(.is-draft)', { hasText: TAGGED_TITLES.Q1 }).first().click()
    await expect(panel.locator('.thread-stack')).toHaveAttribute('data-thread-depth', '1', { timeout: 15_000 })
    await centreInHistory(page, panel, Q1_PHRASE, { tolerance: 20 })
    await selectPassage(page, panel, Q1_PHRASE)
    const before = (await place(panel, Q1_ROW)).top
    expect(Number.isFinite(before)).toBe(true)
    await page.locator('[data-testid="quote-pin-pill"] [data-testid="quote-ask-btn"]').click()
    await expect(history(panel)).toHaveAttribute('data-view-mode', 'linear')
    await expect(card(panel)).toBeVisible()
    // Q1 holds the passage, so the fold keeps it open: its answer is still there.
    await expect(history(panel).locator(`[data-message-id="${Q1_ROW}"]`)).toBeVisible()
    await page.waitForTimeout(800)
    const after = (await place(panel, Q1_ROW)).top
    expect(Math.abs(after - before), `passage moved on Ask: ${before} -> ${after}`).toBeLessThanOrEqual(8)
    await shot(page, '6-ask-in-a-question')
  })
})
