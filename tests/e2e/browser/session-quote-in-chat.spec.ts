/**
 * The transcript's selection pill offers both ways to ask (2026-10-15, the user,
 * beside the Files tab's "Ask here / Quote in chat"; named "Quote" on 2026-10-22:
 * "quote goes straight into the input box"). "Ask here" asks about the passage in
 * Conversation Mode (2026-10-23: from Tree Mode the column switches and the card
 * opens beside the passage); "Quote" puts the passage, quoted, at the head of the MAIN
 * conversation's composer, keeps whatever was typed after it, and leaves a
 * question's own draft where it was.
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import {
  AI_SESSION, centreInHistory, openThreadsSession, readRecord, resetThreadsFixture, selectPassage, switchView,
} from './threads-helpers'
import { AI_PASSAGE, buildMapSession, MAP_SESSION, MAP_TITLES } from './threads-fixture'

const AI_TASK = 'pw-task-threads-ai'
const AI_READY = 'How should the reader treat stale copies?'
const MAP_TASK = 'pw-task-threads-map'
const MAP_READY = 'Summarize the open risks.'
const MAP_IDS = buildMapSession(Date.now()).ids

async function shot(page: Page, name: string): Promise<void> {
  const dir = `/tmp/ask-in-chat/e2e/${test.info().project.name}`
  await fs.mkdir(dir, { recursive: true })
  await page.screenshot({ path: `${dir}/${name}.png` })
}

async function open(page: Page, sid: string, task: string, ready: string, view: 'stack' | 'linear' = 'stack'): Promise<Locator> {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.addStyleTag({ content: '.notification-toaster { display: none !important; }' })
  await page.addStyleTag({ content: `.main-page-session-column:has(.session-panel[data-session-id="${sid}"]) {
    flex: 0 0 720px !important; width: 720px !important; min-width: 720px !important; max-width: 720px !important; }` })
  return openThreadsSession(page, sid, task, ready, { view })
}

const pill = (page: Page) => page.locator('[data-testid="quote-pin-pill"]')
const composerOf = (panel: Locator) => panel.locator('.session-panel-input .chat-input-textarea')
const mapRow = (panel: Locator, title: string) => panel.locator('.thread-map .thread-map-row', { hasText: title }).first()

/** The first few words of a reply's first paragraph: a passage no question holds. */
async function plainPhrase(panel: Locator, msgId: string): Promise<string> {
  const text = await panel.locator(`[data-message-id="${msgId}"] .session-msg-content p`).first().innerText()
  return text.split(/\s+/).slice(0, 6).join(' ')
}

test.describe('Selection pill: Ask here and Quote', () => {
  test.setTimeout(180_000)
  test.beforeEach(async ({ request }) => {
    await resetThreadsFixture(request, AI_SESSION)
    await resetThreadsFixture(request, MAP_SESSION)
  })
  test.afterEach(async ({ page, request }) => {
    // Composer drafts live in localStorage; the next test opens a clean box.
    await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('draft:')) localStorage.removeItem(k) }).catch(() => {})
    await resetThreadsFixture(request, AI_SESSION)
    await resetThreadsFixture(request, MAP_SESSION)
  })

  test('the pill names both; Quote quotes the passage ahead of the typed words, with no question made', async ({ page, request }) => {
    const panel = await open(page, AI_SESSION, AI_TASK, AI_READY)
    const composer = composerOf(panel)
    await composer.click()
    await composer.fill('what does this mean')
    const phrase = AI_PASSAGE.slice(0, 40)
    await centreInHistory(page, panel, phrase, { tolerance: 20 })
    await selectPassage(page, panel, phrase)
    await expect(pill(page)).toBeVisible()
    const labels = (await pill(page).locator('button').allInnerTexts()).map((t) => t.trim())
    expect(labels).toEqual(['Pin', 'Ask here', 'Quote', 'Copy'])
    await shot(page, 'pill')

    const before = (await readRecord(request, AI_SESSION)).threadAnchors?.length ?? 0
    await pill(page).getByRole('button', { name: 'Quote' }).click()
    await expect(pill(page)).toHaveCount(0)
    await expect(composer).toBeFocused()
    await expect(composer).toHaveValue(`> ${phrase}\n\nwhat does this mean`)
    // The caret waits right after the quote, ready for the question.
    const caret = await composer.evaluate((el: HTMLTextAreaElement) => el.selectionStart)
    expect(caret).toBe(`> ${phrase}\n\n`.length)
    // No question page, no anchor: the passage is for the main conversation.
    await expect(panel.locator('.thread-stack-header')).toHaveCount(0)
    await expect(panel.locator('[data-testid="composer-thread-target"]')).toHaveCount(0)
    expect((await readRecord(request, AI_SESSION)).threadAnchors?.length ?? 0).toBe(before)
    expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('')
    await shot(page, 'quoted')

    // Ask here still asks about the passage: from Tree Mode the column switches
    // to Conversation Mode and the question's card opens beside the passage, its
    // own box focused, the composer naming the passage. (Quote showed the end of
    // the conversation, where its message will land.)
    await composer.fill('')
    await centreInHistory(page, panel, phrase, { tolerance: 20 })
    await selectPassage(page, panel, phrase)
    await pill(page).getByRole('button', { name: 'Ask here' }).click()
    await expect(panel.locator('.session-history[data-view-mode="linear"]')).toHaveCount(1)
    const card = panel.locator('.thread-card')
    await expect(card).toBeVisible()
    await expect(card.locator('.thread-card-input')).toBeFocused()
    await expect(card.locator('.thread-card-input')).toHaveValue('')
    await expect(panel.locator('[data-testid="composer-thread-target"][data-pending="true"]')).toContainText(phrase)
    await expect(panel.locator('.thread-stack-header')).toHaveCount(0)
    await shot(page, 'ask-here-card')
  })

  test('Tree Mode on a question page: Quote goes back to the main conversation, the question keeps its draft', async ({ page }) => {
    const panel = await open(page, MAP_SESSION, MAP_TASK, MAP_READY)
    await mapRow(panel, MAP_TITLES.Q4).click()
    await expect(panel.locator('.thread-stack')).toHaveAttribute('data-thread-depth', '1')
    const composer = composerOf(panel)
    await composer.click()
    await composer.fill('a follow-up for Q4')
    const phrase = await plainPhrase(panel, MAP_IDS.Q4.a)
    await centreInHistory(page, panel, phrase, { tolerance: 20 })
    await selectPassage(page, panel, phrase)
    await pill(page).getByRole('button', { name: 'Quote' }).click()
    await expect(panel.locator('.thread-stack')).toHaveAttribute('data-thread-depth', '0')
    await expect(composer).toHaveValue(`> ${phrase}\n\n`)
    await expect(composer).toBeFocused()
    await shot(page, 'tree-back-to-main')
    // The question's own words wait on its page.
    await mapRow(panel, MAP_TITLES.Q4).click()
    await expect(panel.locator('.thread-stack')).toHaveAttribute('data-thread-depth', '1')
    await expect(composer).toHaveValue('a follow-up for Q4')
  })

  test('Conversation Mode with a question as the target: Quote lets go of it', async ({ page }) => {
    const panel = await open(page, MAP_SESSION, MAP_TASK, MAP_READY, 'linear')
    await switchView(panel, 'linear')
    await mapRow(panel, MAP_TITLES.Q4).click()
    const target = panel.locator('[data-testid="composer-thread-target"]')
    await expect(target).toContainText(MAP_TITLES.Q4)
    const composer = composerOf(panel)
    await composer.click()
    await composer.fill('a reply in Q4')
    const phrase = await plainPhrase(panel, MAP_IDS.R3.a)
    await centreInHistory(page, panel, phrase, { tolerance: 20 })
    await selectPassage(page, panel, phrase)
    await pill(page).getByRole('button', { name: 'Quote' }).click()
    await expect(target).toHaveCount(0)
    await expect(mapRow(panel, 'Main conversation')).toHaveAttribute('aria-current', 'page')
    await expect(composer).toHaveValue(`> ${phrase}\n\n`)
    await expect(composer).toBeFocused()
    await shot(page, 'linear-main')
    await mapRow(panel, MAP_TITLES.Q4).click()
    await expect(target).toContainText(MAP_TITLES.Q4)
    await expect(composer).toHaveValue('a reply in Q4')
  })
})
