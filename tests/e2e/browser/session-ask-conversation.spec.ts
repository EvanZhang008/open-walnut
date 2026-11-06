/**
 * Ask here asks in the view on screen, the pill's caret picks the other one,
 * and a question asked inline folds in the main chat (2026-10-23, the user:
 * "the response thread should be automatically collapsed"; 2026-11-03: "when i
 * tree conversation mode, I ask here one more time it jump to main conversation
 * ... it should directly go to next level since we are in treemode", and "in ask
 * here people can select inline mode or tree mode for this one").
 *
 * In Tree Mode, a plain Ask pushes a new question page one level below the page
 * the passage is on and stays in Tree Mode, also from a question's page (one
 * more level, never back to the main conversation). "Ask inline" from Tree Mode
 * switches the column to Conversation Mode and opens the card beside the
 * passage with its input focused, while the passage stays where the reader
 * selected it. Sent, the question is one label line in the main chat while its
 * answer streams into the card (the main timeline does not move) and after it
 * lands; the chevron shows and folds it; a follow-up typed in the card keeps it
 * folded. Closing the card with words leaves them for the next Ask on that
 * passage, and a reload keeps Conversation Mode. Asked inline on a passage
 * inside a question's answer (from its page), that question stays open. "Ask in
 * Tree" from Conversation Mode switches to Tree Mode and pushes the page.
 *
 * Chromium and WebKit. The tagged fixture session (it has questions, so Tree
 * Mode is a real stack: a session without any renders Conversation Mode); the
 * new question is on a passage of the first answer no question holds yet. The
 * mock CLI answers a message that starts with `slow:<ms>` after that delay.
 */
import { expect, type Locator, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import {
  askInline, centreInHistory, mainComposer, mainPage, openThreadsSession, resetThreadsFixture, selectPassage, sessionPanel, switchView, test,
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

const history = (panel: Locator) => mainPage(panel).locator('.session-history')
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
  await centreInHistory(page, mainPage(panel), PHRASE, { tolerance: 20 })
  return panel
}

const pill = (page: Page) => page.locator('[data-testid="quote-pin-pill"]')

/** The words the chat's question marks paint (CSS highlights named thread-mark*). */
async function markedTexts(panel: Locator): Promise<string[]> {
  return history(panel).evaluate((root) => {
    const reg = (CSS as unknown as { highlights: Map<string, Set<Range>> }).highlights
    const out: string[] = []
    reg.forEach((h, name) => {
      if (!String(name).startsWith('thread-mark')) return
      h.forEach((r) => { if (root.contains(r.commonAncestorContainer)) out.push(r.toString()) })
    })
    return out
  })
}
const stackDepth = (panel: Locator) => mainPage(panel).locator('.thread-stack')
const composer = (panel: Locator) => mainComposer(panel)

/** "Ask inline" from Tree Mode: the column goes to Conversation Mode, the card opens. */
async function askInlineFromTree(page: Page, panel: Locator): Promise<number> {
  await selectPassage(page, mainPage(panel), PHRASE)
  const before = (await place(panel)).top
  await askInline(page)
  await expect(history(panel)).toHaveAttribute('data-view-mode', 'linear')
  await expect(card(panel)).toBeVisible()
  return before
}

/** A plain Ask here in Tree Mode: a new pending page at `depth`, no card, still Tree Mode. */
async function expectTreeAsk(page: Page, panel: Locator, depth: number, phrase: string): Promise<void> {
  await pill(page).locator('[data-testid="quote-ask-btn"]').click()
  await expect(stackDepth(panel)).toHaveAttribute('data-thread-depth', String(depth), { timeout: 15_000 })
  await expect(history(panel)).toHaveAttribute('data-view-mode', 'stack')
  await expect(card(panel)).toHaveCount(0)
  await expect(mainPage(panel).locator('.thread-quote-head')).toContainText(phrase)
  await expect(composer(panel)).toBeFocused()
}

test.describe('Ask here asks in the view on screen; Ask inline and Ask in Tree pick the other', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(240_000)
  test.beforeEach(async ({ request }) => { await resetThreadsFixture(request, TAGGED_SESSION) })
  test.afterAll(async ({ request }) => { await resetThreadsFixture(request, TAGGED_SESSION) })

  test('Ask inline from Tree Mode: Conversation Mode, the card beside a still passage; sent, one line while it streams and after', async ({ page }) => {
    const panel = await openInTree(page)
    const before = await askInlineFromTree(page, panel)
    // The fixture's own questions are lines already; the new one adds one.
    const lines0 = await foldLines(panel).count()
    // The card is on screen, its own input focused, and no question page was pushed.
    const cardBox = (await card(panel).boundingBox())!
    expect(cardBox.y).toBeGreaterThanOrEqual(0)
    expect(cardBox.y + cardBox.height).toBeLessThanOrEqual(900)
    await expect(card(panel)).toHaveAttribute('data-draft', 'true')
    await expect(card(panel).locator('.thread-card-input')).toBeFocused()
    // The selection is gone once the card opens: a mark says which words it is about.
    await expect.poll(async () => (await markedTexts(panel)).join(' ').replace(/\s+/g, ' '), { message: 'the asked words are marked while the draft is open' })
      .toContain(PHRASE)
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
    await centreInHistory(page, mainPage(panel), line, { capRow: true })
    await line.locator('.thread-turn-fold').click()
    await expect(askedBubble(panel, QUESTION).first()).toBeVisible()
    await shot(page, '4-shown')
    const head = history(panel).locator('.thread-turn-head .thread-turn-fold[aria-expanded="true"]').first()
    await centreInHistory(page, mainPage(panel), head, { capRow: true })
    await head.click()
    await expect(askedBubble(panel, QUESTION)).toHaveCount(0)
    await expect(foldLines(panel)).toHaveCount(lines0 + 1)

    // A reload keeps Conversation Mode (Ask inline switched it for this session) and
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
    await askInlineFromTree(page, panel)
    await card(panel).locator('.thread-card-input').fill('half a question')
    await card(panel).locator('.thread-card-close').click()
    await expect(card(panel)).toHaveCount(0)
    await expect(history(panel)).toHaveAttribute('data-view-mode', 'linear')
    await centreInHistory(page, mainPage(panel), PHRASE, { tolerance: 20 })
    await selectPassage(page, mainPage(panel), PHRASE)
    await page.locator('[data-testid="quote-pin-pill"] [data-testid="quote-ask-btn"]').click()
    await expect(card(panel)).toBeVisible()
    await expect(card(panel).locator('.thread-card-input')).toHaveValue('half a question')
    await shot(page, '5-restored')
  })

  test('Ask here in Tree Mode goes one level down and stays in Tree Mode; asked again on that page\'s answer, one more level, never the main conversation', async ({ page }) => {
    const panel = await openInTree(page)
    // The pill names the view on screen as the current choice.
    await selectPassage(page, mainPage(panel), PHRASE)
    await pill(page).locator('[data-testid="quote-ask-mode-btn"]').click()
    await expect(page.locator('[data-testid="quote-pin-menu"] [data-testid="quote-ask-tree"]')).toHaveClass(/is-current/)
    await expect(page.locator('[data-testid="quote-pin-menu"] [data-testid="quote-ask-inline"]')).not.toHaveClass(/is-current/)
    // Esc closes the choices' menu and leaves the pill's buttons; a second Esc closes the pill.
    await page.keyboard.press('Escape')
    await expect(page.locator('[data-testid="quote-ask-modes"]')).toHaveCount(0)
    await expect(pill(page).locator('[data-testid="quote-ask-mode-btn"]')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(pill(page)).toHaveCount(0)
    await centreInHistory(page, mainPage(panel), PHRASE, { tolerance: 20 })
    // On the main conversation: a page one level down, its composer focused.
    await selectPassage(page, mainPage(panel), PHRASE)
    await expectTreeAsk(page, panel, 1, PHRASE)
    await shot(page, '6-tree-ask-root')
    // Sent from that page and answered there, then asked again on a passage of
    // its answer: the user's 2026-11-03 report, where the second Ask went back
    // to the main conversation. It goes one level further down.
    await composer(panel).fill(QUESTION)
    await composer(panel).press('Enter')
    const answer = `processed your message: ${QUESTION}`
    const answerRow = '[data-message-id][data-msg-role="assistant"]'
    await expect(mainPage(panel).locator(`.session-history ${answerRow}`, { hasText: answer })).toBeVisible({ timeout: 60_000 })
    await expect(stackDepth(panel)).toHaveAttribute('data-thread-depth', '1')
    await centreInHistory(page, mainPage(panel), 'processed your message', { tolerance: 40 })
    await selectPassage(page, mainPage(panel), 'processed your message', answerRow)
    await expectTreeAsk(page, panel, 2, 'processed your message')
    await expect(history(panel)).toHaveAttribute('data-view-mode', 'stack')
    await expect(panel.locator('.tree-path-seg')).toHaveCount(3)
    await shot(page, '7-tree-ask-again')
    // Esc lets the unsent one go: back on the page it was asked from.
    await page.keyboard.press('Escape')
    await expect(stackDepth(panel)).toHaveAttribute('data-thread-depth', '1', { timeout: 15_000 })
  })

  test('Ask here on a fixture question\'s page in Tree Mode: the new page is one level below it', async ({ page }) => {
    const panel = await openInTree(page)
    await panel.locator('.thread-asked-row:not(.is-draft)', { hasText: TAGGED_TITLES.Q1 }).first().click()
    await expect(stackDepth(panel)).toHaveAttribute('data-thread-depth', '1', { timeout: 15_000 })
    await centreInHistory(page, mainPage(panel), Q1_PHRASE, { tolerance: 20 })
    await selectPassage(page, mainPage(panel), Q1_PHRASE)
    await expectTreeAsk(page, panel, 2, Q1_PHRASE)
    await expect(panel.locator('.tree-path-seg')).toHaveCount(3)
  })

  test('Ask inline from a question\'s page in Tree Mode: the passage in its answer stays on screen beside the card', async ({ page }) => {
    const panel = await openInTree(page)
    await panel.locator('.thread-asked-row:not(.is-draft)', { hasText: TAGGED_TITLES.Q1 }).first().click()
    await expect(stackDepth(panel)).toHaveAttribute('data-thread-depth', '1', { timeout: 15_000 })
    await centreInHistory(page, mainPage(panel), Q1_PHRASE, { tolerance: 20 })
    await selectPassage(page, mainPage(panel), Q1_PHRASE)
    const before = (await place(panel, Q1_ROW)).top
    expect(Number.isFinite(before)).toBe(true)
    await askInline(page)
    await expect(history(panel)).toHaveAttribute('data-view-mode', 'linear')
    await expect(card(panel)).toBeVisible()
    // Q1 holds the passage, so the fold keeps it open: its answer is still there.
    await expect(history(panel).locator(`[data-message-id="${Q1_ROW}"]`)).toBeVisible()
    await page.waitForTimeout(800)
    const after = (await place(panel, Q1_ROW)).top
    expect(Math.abs(after - before), `passage moved on Ask: ${before} -> ${after}`).toBeLessThanOrEqual(8)
    await shot(page, '8-ask-inline-in-a-question')
  })

  test('Conversation Mode: Ask here opens the card; Ask in Tree switches to Tree Mode and pushes the page', async ({ page }) => {
    const panel = await openInTree(page)
    await switchView(panel, 'linear')
    await expect(history(panel)).toHaveAttribute('data-view-mode', 'linear')
    await centreInHistory(page, mainPage(panel), PHRASE, { tolerance: 20 })
    // A plain Ask asks in the view on screen: the card.
    await selectPassage(page, mainPage(panel), PHRASE)
    await pill(page).locator('[data-testid="quote-ask-btn"]').click()
    await expect(card(panel)).toBeVisible()
    await expect(history(panel)).toHaveAttribute('data-view-mode', 'linear')
    await expect(stackDepth(panel)).toHaveCount(0)
    await card(panel).locator('.thread-card-close').click()
    await expect(card(panel)).toHaveCount(0)
    // The caret's other choice: Tree Mode, a page one level below the main conversation.
    await centreInHistory(page, mainPage(panel), PHRASE, { tolerance: 20 })
    await selectPassage(page, mainPage(panel), PHRASE)
    await pill(page).locator('[data-testid="quote-ask-mode-btn"]').click()
    await expect(page.locator('[data-testid="quote-pin-menu"] [data-testid="quote-ask-inline"]')).toHaveClass(/is-current/)
    await page.locator('[data-testid="quote-pin-menu"] [data-testid="quote-ask-tree"]').click()
    await expect(stackDepth(panel)).toHaveAttribute('data-thread-depth', '1', { timeout: 15_000 })
    await expect(history(panel)).toHaveAttribute('data-view-mode', 'stack')
    await expect(card(panel)).toHaveCount(0)
    await expect(mainPage(panel).locator('.thread-quote-head')).toContainText(PHRASE)
    await shot(page, '9-ask-in-tree')
  })
})
