/**
 * Opening a question never quotes it into the chat's composer (2026-10-27, the
 * user: "after click the ask here question it automatically quote, I don't want
 * it ... unless user explicit"). A mark click, a map row, Ask here: the card
 * opens beside the passage, its own box writes to the question, and the composer
 * keeps the main conversation and the words typed there. Only an explicit action
 * quotes: the card's "Quote in chat", or the mark's right-click row. × lets go.
 *
 * Chromium and WebKit. The map fixture session (Conversation Mode), and the
 * send fixture for the sends.
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import { centreInHistory, openThreadsSession, passageRects, readRecord, resetThreadsFixture, selectPassage, switchView } from './threads-helpers'
import { MAP_PASSAGES, MAP_SESSION, MAP_TITLES } from './threads-fixture'

const MAP_TASK = 'pw-task-threads-map'
const MAP_READY = 'Summarize the open risks.'
const PHRASE = MAP_PASSAGES.Q4.slice(0, 32)
const SEND_SESSION = 'pw-threads-send-session'
const SEND_TASK = 'pw-task-threads-send'
const SEND_READY = 'Phase three only verifies checksums.'
const SEND_PHRASE = 'rewrites the index in place'

async function shot(page: Page, name: string): Promise<void> {
  const dir = `/tmp/ask-no-auto-quote/e2e/${test.info().project.name}`
  await fs.mkdir(dir, { recursive: true })
  await page.screenshot({ path: `${dir}/${name}.png` })
}

const chip = (panel: Locator) => panel.locator('[data-testid="composer-thread-target"]')
const composer = (panel: Locator) => panel.locator('.session-panel-input .chat-input-textarea').first()
const card = (panel: Locator) => panel.locator('.thread-card')

async function open(page: Page): Promise<Locator> {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.addStyleTag({ content: `.main-page-session-column:has(.session-panel[data-session-id="${MAP_SESSION}"]) {
    flex: 0 0 820px !important; width: 820px !important; min-width: 820px !important; max-width: 820px !important; }` })
  const panel = await openThreadsSession(page, MAP_SESSION, MAP_TASK, MAP_READY, { view: 'linear' })
  await switchView(panel, 'linear')
  return panel
}

async function markPoint(panel: Locator, page: Page): Promise<{ x: number; y: number }> {
  await centreInHistory(page, panel, PHRASE)
  const r = (await passageRects(panel, PHRASE, '[data-message-id][data-msg-role="assistant"]'))[0]
  return { x: r.left + 20, y: r.top + r.height / 2 }
}

test.describe('no quote without asking', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(180_000)
  test.beforeEach(async ({ request }) => { await resetThreadsFixture(request, MAP_SESSION) })
  test.afterEach(async ({ page }) => {
    await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('draft:')) localStorage.removeItem(k) }).catch(() => {})
  })

  test('a mark click, a map row and Ask here open the card and leave the composer alone', async ({ page }) => {
    const panel = await open(page)
    await composer(panel).fill('my words for the main chat')
    // A mark click.
    const at = await markPoint(panel, page)
    await page.mouse.click(at.x, at.y)
    await expect(card(panel).locator('.thread-card-title')).toHaveText(MAP_TITLES.Q4)
    await expect(chip(panel)).toHaveCount(0)
    await expect(composer(panel)).toHaveValue('my words for the main chat')
    await shot(page, '1-mark-click-no-chip')
    // A map row: another card, still nothing quoted.
    await panel.locator('.thread-map .thread-map-row', { hasText: MAP_TITLES.Q1 }).first().click()
    await expect(card(panel).locator('.thread-card-title')).toHaveText(MAP_TITLES.Q1)
    await expect(chip(panel)).toHaveCount(0)
    await card(panel).locator('.thread-card-input').press('Escape')
    await expect(card(panel)).toHaveCount(0)
    // Ask here on a new passage: a draft card, still nothing quoted.
    const phrase = MAP_PASSAGES.Q5.slice(0, 30)
    await centreInHistory(page, panel, phrase)
    await selectPassage(page, panel, phrase)
    await page.locator('[data-testid="quote-pin-pill"] [data-testid="quote-ask-btn"]').click()
    await expect(card(panel)).toHaveAttribute('data-draft', 'true')
    await expect(chip(panel)).toHaveCount(0)
    await expect(composer(panel)).toHaveValue('my words for the main chat')
    await card(panel).locator('.thread-card-input').press('Escape')
  })

  test('the card sends into its question while the composer sends to the main conversation', async ({ page, request }) => {
    // The send fixture: its turns may grow (the map fixture has no sends).
    const res = await request.patch(`/api/sessions/${SEND_SESSION}`, { data: { thread_anchors: [], pinned_messages: [] } })
    expect(res.ok()).toBe(true)
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    const panel = await openThreadsSession(page, SEND_SESSION, SEND_TASK, SEND_READY, { view: 'linear' })
    await composer(panel).fill('Back to the plan please')
    await centreInHistory(page, panel, SEND_PHRASE)
    await selectPassage(page, panel, SEND_PHRASE)
    await page.locator('[data-testid="quote-pin-pill"] [data-testid="quote-ask-btn"]').click()
    await card(panel).locator('.thread-card-input').fill('Why in place?')
    await card(panel).locator('.thread-card-input').press('Enter')
    await expect.poll(async () => (await readRecord(request, SEND_SESSION)).threadAnchors?.length ?? 0).toBe(1)
    await expect(chip(panel)).toHaveCount(0)
    await expect(composer(panel)).toHaveValue('Back to the plan please')
    await expect(card(panel).locator('.thread-card-body')).toContainText('processed your message', { timeout: 60_000 })
    await card(panel).locator('.thread-card-input').press('Escape')
    await composer(panel).press('Enter')
    const sent = panel.locator('.session-history .session-msg', { hasText: 'Back to the plan please' }).first()
    await expect(sent).toBeVisible({ timeout: 30_000 })
    await expect(panel.locator('.session-history .session-msg--threaded', { hasText: 'Back to the plan please' })).toHaveCount(0)
    await page.waitForTimeout(500)
    expect((await readRecord(request, SEND_SESSION)).threadAnchors?.length ?? 0, 'the main send made no question').toBe(1)
  })

  test('the right-click row and the card button quote it; × lets go', async ({ page }) => {
    const panel = await open(page)
    // Right-click on a mark: its own menu.
    const at = await markPoint(panel, page)
    await page.mouse.click(at.x, at.y, { button: 'right' })
    const menu = page.locator('[data-testid="thread-mark-menu"]')
    await expect(menu).toBeVisible()
    await expect(menu.getByRole('menuitem')).toHaveText(['Open question', 'Quote in chat'])
    await shot(page, '2-mark-menu')
    await menu.getByRole('menuitem', { name: 'Quote in chat' }).click()
    await expect(menu).toHaveCount(0)
    await expect(chip(panel)).toContainText('Replying in')
    await expect(chip(panel).locator('.pill-title')).toHaveText(MAP_TITLES.Q4)
    await expect(composer(panel)).toBeFocused()
    await shot(page, '3-quoted-from-menu')
    // × clears it.
    await chip(panel).locator('[data-testid="composer-thread-target-clear"]').click()
    await expect(chip(panel)).toHaveCount(0)
    // Open from the menu: the card, no quote.
    await page.mouse.click(at.x, at.y, { button: 'right' })
    await menu.getByRole('menuitem', { name: 'Open question' }).click()
    await expect(card(panel).locator('.thread-card-title')).toHaveText(MAP_TITLES.Q4)
    await expect(chip(panel)).toHaveCount(0)
    // The card's Quote in chat.
    await card(panel).getByRole('button', { name: 'Quote in chat' }).click()
    await expect(card(panel)).toHaveCount(0)
    await expect(chip(panel).locator('.pill-title')).toHaveText(MAP_TITLES.Q4)
    await chip(panel).locator('[data-testid="composer-thread-target-clear"]').click()
    await expect(chip(panel)).toHaveCount(0)
  })

  test('× on a quoted Ask that left the path drops it everywhere; a fast × keeps the words in the main draft only', async ({ page }) => {
    const panel = await open(page)
    const phrase = MAP_PASSAGES.Q5.slice(0, 30)
    await centreInHistory(page, panel, phrase)
    await selectPassage(page, panel, phrase)
    await page.locator('[data-testid="quote-pin-pill"] [data-testid="quote-ask-btn"]').click()
    await expect(card(panel)).toHaveAttribute('data-draft', 'true')
    await card(panel).locator('.thread-card-input').fill('Why so slow?')
    await card(panel).getByRole('button', { name: 'Quote in chat' }).click()
    await expect(chip(panel)).toContainText('Asking about')
    await expect(composer(panel)).toHaveValue('Why so slow?')
    // Another question's card: the Ask leaves the path, and stays a draft (quoted).
    await panel.locator('.thread-map .thread-map-row', { hasText: MAP_TITLES.Q1 }).first().click()
    await expect(card(panel).locator('.thread-card-title')).toHaveText(MAP_TITLES.Q1)
    await card(panel).locator('.thread-card-close').click()
    await expect(chip(panel)).toContainText('Asking about')
    // A keystroke, then × at once (inside the composer's 300 ms save delay).
    await composer(panel).click()
    await composer(panel).press('End')
    await composer(panel).pressSequentially(' then')
    await chip(panel).locator('[data-testid="composer-thread-target-clear"]').click()
    await expect(chip(panel)).toHaveCount(0)
    await expect(composer(panel)).toHaveValue('Why so slow? then')
    // No draft row, no dashed mark of the Ask, and its words in one place only: the main draft.
    await expect(panel.locator('.thread-map .thread-map-row[data-kind="draft"]')).toHaveCount(0)
    await page.waitForTimeout(800)
    const held = await page.evaluate(() => Object.keys(localStorage).filter((k) => (localStorage.getItem(k) ?? '').includes('Why so slow')))
    expect(held, JSON.stringify(held)).toEqual([`draft:session:${'pw-threads-map-session'}`])
    // A reload brings no draft back.
    await page.reload()
    await page.waitForLoadState('networkidle')
    const again = page.locator(`.main-page-session-column .session-panel[data-session-id="${MAP_SESSION}"]`)
    await expect(again).toBeVisible({ timeout: 30_000 })
    await expect(again.locator('.thread-map .thread-map-row[data-kind="draft"]')).toHaveCount(0)
    await composer(again).fill('')
  })
})
