/**
 * The reader's choices around the comment card (Conversation Mode).
 *
 * Covers: an Ask closed with nothing written (Esc, ×, a click away) leaves
 * nothing behind: no draft row in the sidebar, no composer target, nothing after
 * a reload; words typed into the card keep it as a draft that reopens with them,
 * and emptying it lets it go; opening a question never makes it the composer's
 * target (2026-10-27, the user: "not quote automatically"): only the card's
 * "Quote in chat" does, and then the composer names it (number and title) and its
 * × sends to the main conversation instead, carrying what was typed; a click into
 * the composer during an Ask closes the card (its words kept as a draft), and
 * Quote in chat on that draft asks it from the composer ("Asking about") with the
 * card's words; the card's expand button grows it where it is (same top below
 * its passage, wider, taller), Esc brings it back to its size, × closes; in
 * fullscreen, Esc closes the card and the next Esc leaves fullscreen, and Esc
 * never lets go of a quoted question; the rule beside a question's turn opens
 * its card like its label.
 *
 * Chromium and WebKit. The tagged fixture session.
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import { centreInHistory, openThreadsSession, passageRects, resetThreadsFixture, selectPassage, unfoldQuestions } from './threads-helpers'
import { buildTaggedSession, TAGGED_PASSAGE, TAGGED_READY, TAGGED_SESSION, TAGGED_TASK, TAGGED_TITLES } from './threads-fixture'

const IDS = buildTaggedSession(Date.now()).ids
const PASSAGE = TAGGED_PASSAGE.slice(0, 30)

async function shot(page: Page, name: string, panel?: Locator): Promise<void> {
  const dir = `/tmp/thread-choices/e2e/${test.info().project.name}`
  await fs.mkdir(dir, { recursive: true })
  if (panel) await panel.screenshot({ path: `${dir}/${name}.png` })
  else await page.screenshot({ path: `${dir}/${name}.png` })
}

async function open(page: Page): Promise<Locator> {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.setViewportSize({ width: 1800, height: 800 })
  await page.addStyleTag({ content: `.main-page-session-column:has(.session-panel[data-session-id="${TAGGED_SESSION}"]) {
    flex: 0 0 1100px !important; width: 1100px !important; min-width: 1100px !important; max-width: 1100px !important; }` })
  return openThreadsSession(page, TAGGED_SESSION, TAGGED_TASK, TAGGED_READY, { view: 'linear' })
}

const card = (panel: Locator) => panel.locator('.thread-card')
const unsentRows = (panel: Locator) => panel.locator('.thread-map .thread-map-row[data-kind="draft"], .thread-map .thread-map-row[data-kind="pending"]')
const chip = (panel: Locator) => panel.locator('[data-testid="composer-thread-target"]')
const composer = (panel: Locator) => panel.locator('.session-panel-input .chat-input-textarea').first()

async function ask(page: Page, panel: Locator): Promise<Locator> {
  await centreInHistory(page, panel, PASSAGE)
  await selectPassage(page, panel, PASSAGE)
  await page.locator('[data-testid="quote-pin-pill"] [data-testid="quote-ask-btn"]').click()
  const c = card(panel)
  await expect(c).toHaveAttribute('data-draft', 'true')
  await expect(unsentRows(panel)).toHaveCount(1)
  return c
}

test.describe('Choices around the comment card', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(240_000)

  test.beforeEach(async ({ request }) => {
    await resetThreadsFixture(request, TAGGED_SESSION)
  })

  test('an Ask closed with nothing written leaves nothing: Esc, ×, a click away, and a reload', async ({ page }) => {
    const panel = await open(page)
    // Esc in the card's box.
    let c = await ask(page, panel)
    await c.locator('.thread-card-input').press('Escape')
    await expect(c).toHaveCount(0)
    await expect(unsentRows(panel)).toHaveCount(0)
    await expect(chip(panel)).toHaveCount(0)
    await expect(composer(panel)).toHaveAttribute('placeholder', /Send a message to this session/)
    // The card's ×.
    c = await ask(page, panel)
    await c.locator('.thread-card-close').click()
    await expect(c).toHaveCount(0)
    await expect(unsentRows(panel)).toHaveCount(0)
    // A press on plain text away from the card.
    c = await ask(page, panel)
    await panel.locator(`.session-history [data-message-id="${IDS.R1.a}"]`).click({ position: { x: 12, y: 10 } })
    await expect(c).toHaveCount(0)
    await expect(unsentRows(panel)).toHaveCount(0)
    await expect(chip(panel)).toHaveCount(0)
    // Nothing of it comes back with the page.
    await page.reload()
    await page.waitForLoadState('networkidle')
    const again = await openThreadsSession(page, TAGGED_SESSION, TAGGED_TASK, TAGGED_READY, { view: 'linear' })
    await expect(again.locator('.thread-map .thread-map-row[data-kind="thread"]').first()).toBeVisible()
    await expect(unsentRows(again)).toHaveCount(0)
    await expect(chip(again)).toHaveCount(0)
  })

  test('words typed into the card keep the Ask as a draft that reopens with them; emptied, it goes', async ({ page }) => {
    const panel = await open(page)
    const c = await ask(page, panel)
    await c.locator('.thread-card-input').fill('Half a thought about ties')
    await c.locator('.thread-card-input').press('Escape')
    await expect(c).toHaveCount(0)
    const draft = panel.locator('.thread-map .thread-map-row[data-kind="draft"]')
    await expect(draft).toHaveCount(1)
    await draft.click()
    await expect(card(panel)).toHaveAttribute('data-draft', 'true')
    await expect(card(panel).locator('.thread-card-input')).toHaveValue('Half a thought about ties')
    await card(panel).locator('.thread-card-input').fill('')
    await card(panel).locator('.thread-card-input').press('Escape')
    await expect(card(panel)).toHaveCount(0)
    await expect(unsentRows(panel)).toHaveCount(0)
  })

  test('opening a question leaves the composer on the main conversation; Quote in chat names it, × lets go with the words typed', async ({ page }) => {
    const panel = await open(page)
    const rows = panel.locator('.thread-map .thread-map-row[data-kind="thread"]')
    await composer(panel).fill('Words for the main conversation')
    await rows.nth(0).click()
    await expect(card(panel)).toBeVisible()
    // Opening is not quoting: no chip, the composer's words and placeholder stay.
    await expect(chip(panel)).toHaveCount(0)
    await expect(composer(panel)).toHaveValue('Words for the main conversation')
    await expect(composer(panel)).toHaveAttribute('placeholder', /Send a message to this session/)
    await composer(panel).fill('')
    // Quote in chat: the card closes, the composer names the question.
    await card(panel).getByRole('button', { name: 'Quote in chat' }).click()
    await expect(card(panel)).toHaveCount(0)
    await expect(chip(panel)).toBeVisible()
    await expect(chip(panel)).toContainText('Replying in')
    await expect(chip(panel).locator('.thread-map-num')).toHaveText('1')
    await expect(chip(panel).locator('.pill-title')).toHaveText(TAGGED_TITLES.Q1)
    await expect(composer(panel)).toBeFocused()
    await shot(page, 'composer-chip-reply', panel)
    await composer(panel).fill('This one is for the main thread')
    // The chip's title opens the question's card again; the chip stays.
    await chip(panel).locator('.pill-target').click()
    await expect(card(panel).locator('.thread-card-head .thread-map-num')).toHaveText('1')
    await expect(chip(panel)).toContainText('Replying in')
    // × : the composer posts to the main conversation, the words stay in it.
    await chip(panel).locator('[data-testid="composer-thread-target-clear"]').click()
    await expect(chip(panel)).toHaveCount(0)
    await expect(composer(panel)).toHaveValue('This one is for the main thread')
    await expect(composer(panel)).toHaveAttribute('placeholder', /Send a message to this session/)
    await composer(panel).press('Enter')
    const bubble = panel.locator('.session-history .session-msg', { hasText: 'This one is for the main thread' }).first()
    await expect(bubble).toBeVisible({ timeout: 30_000 })
    await expect(panel.locator('.session-history .session-msg--threaded', { hasText: 'This one is for the main thread' })).toHaveCount(0)
  })

  test('a click into the composer during an Ask closes the card unquoted; Quote in chat on the draft asks it from the composer with the card\'s words', async ({ page }) => {
    const panel = await open(page)
    await ask(page, panel)
    await composer(panel).click()
    await expect(card(panel)).toHaveCount(0)
    await expect(chip(panel)).toHaveCount(0)
    // Nothing written: the Ask goes.
    await expect(unsentRows(panel)).toHaveCount(0)
    // Words typed in the card keep it as a draft; the composer stays empty and unquoted.
    const c = await ask(page, panel)
    await c.locator('.thread-card-input').fill('Why the oldest one')
    await composer(panel).click()
    await expect(card(panel)).toHaveCount(0)
    await expect(chip(panel)).toHaveCount(0)
    await expect(composer(panel)).toHaveValue('')
    const draft = panel.locator('.thread-map .thread-map-row[data-kind="draft"]')
    await expect(draft).toHaveCount(1)
    // Quote in chat from the reopened draft: asked from the composer, with its words.
    await draft.click()
    await expect(card(panel).locator('.thread-card-input')).toHaveValue('Why the oldest one')
    await card(panel).getByRole('button', { name: 'Quote in chat' }).click()
    await expect(card(panel)).toHaveCount(0)
    await expect(chip(panel)).toHaveAttribute('data-pending', 'true')
    await expect(chip(panel)).toContainText('Asking about')
    await expect(composer(panel)).toHaveValue('Why the oldest one')
    await shot(page, 'composer-chip-ask', panel)
    // × : the words go on to the main conversation's composer, the Ask goes.
    await chip(panel).locator('[data-testid="composer-thread-target-clear"]').click()
    await expect(chip(panel)).toHaveCount(0)
    await expect(composer(panel)).toHaveValue('Why the oldest one')
    await expect(unsentRows(panel)).toHaveCount(0)
  })

  test('the expand button grows the card where it is; Esc brings it back to its size; × closes', async ({ page }) => {
    const panel = await open(page)
    // The timeline this test measures in: the questions shown, as a reader who
    // opened them has it (folded, the question with its card open folds too,
    // utils/thread-fold.ts, and the box is barely taller than the text).
    await unfoldQuestions(panel)
    await panel.locator('.thread-map .thread-map-row[data-kind="thread"]').nth(0).click()
    const c = card(panel)
    await expect(c).toBeVisible()
    await page.waitForTimeout(200)
    const passageBottom = async () => {
      const r = (await passageRects(panel, PASSAGE)).at(-1)!
      return r.top + r.height
    }
    const maxHeight = () => c.evaluate((el) => parseFloat(getComputedStyle(el).maxHeight))
    const placed = (await c.boundingBox())!
    const gap = placed.y - (await passageBottom())
    const placedMax = await maxHeight()
    await c.locator('.thread-card-expand').click()
    await expect(c).toHaveAttribute('data-expanded', 'true')
    // Grown in place: no overlay, the same card below its passage at the same
    // gap, wider and allowed to be taller, inside the timeline.
    await expect(panel.locator('.thread-card-backdrop')).toHaveCount(0)
    await expect.poll(async () => (await c.boundingBox())!.width).toBeGreaterThan(placed.width + 100)
    await page.waitForTimeout(400)
    const big = (await c.boundingBox())!
    expect(Math.abs(big.y - (await passageBottom()) - gap)).toBeLessThan(2)
    expect(await maxHeight()).toBeGreaterThan(placedMax * 1.25)
    const hb = (await panel.locator('.session-history').boundingBox())!
    expect(big.x).toBeGreaterThanOrEqual(hb.x)
    expect(big.x + big.width).toBeLessThanOrEqual(hb.x + hb.width + 1)
    // The passage's last line is still in view above it, and the history's
    // jump-to-bottom button (8px + 36px from the bottom) stays clear of it.
    expect(await passageBottom()).toBeGreaterThan(hb.y)
    expect(big.y + big.height).toBeLessThanOrEqual(hb.y + hb.height - 44)
    await expect(c.locator('.thread-card-input')).toBeFocused()
    await shot(page, 'card-expanded', panel)
    // Esc: back to its size, still open, in the same place.
    await c.locator('.thread-card-input').press('Escape')
    await expect(c).not.toHaveAttribute('data-expanded', 'true')
    await expect.poll(async () => Math.round((await c.boundingBox())!.width)).toBe(Math.round(placed.width))
    await expect(c).toBeVisible()
    expect(Math.abs((await c.boundingBox())!.y - (await passageBottom()) - gap)).toBeLessThan(2)
    // × closes from the grown state too.
    await c.locator('.thread-card-expand').click()
    await expect(c).toHaveAttribute('data-expanded', 'true')
    await c.locator('.thread-card-close').click()
    await expect(card(panel)).toHaveCount(0)
  })

  test('fullscreen: Esc closes the card, the next Esc leaves fullscreen; Esc never lets go of a quoted question', async ({ page }) => {
    const panel = await open(page)
    await panel.getByRole('button', { name: 'Expand session to full screen' }).click()
    await expect(panel).toHaveClass(/open-walnut-fullscreen/)
    await panel.locator('.thread-map .thread-map-row[data-kind="thread"]').nth(0).click()
    await expect(card(panel)).toBeVisible()
    await card(panel).locator('.thread-card-input').press('Escape')
    await expect(card(panel)).toHaveCount(0)
    await expect(panel).toHaveClass(/open-walnut-fullscreen/)
    // The second Esc is the panel's; opening the card quoted nothing.
    await page.keyboard.press('Escape')
    await expect(panel).not.toHaveClass(/open-walnut-fullscreen/)
    await expect(chip(panel)).toHaveCount(0)
    // A quoted question: Esc never lets go of it.
    await panel.locator('.thread-map .thread-map-row[data-kind="thread"]').nth(0).click()
    await card(panel).getByRole('button', { name: 'Quote in chat' }).click()
    await expect(chip(panel)).toContainText('Replying in')
    await expect(chip(panel).locator('.thread-map-num')).toHaveText('1')
    await page.keyboard.press('Escape')
    await expect(chip(panel)).toContainText('Replying in')
  })

  test('the rule beside a question\'s turn opens its card, the same as its label', async ({ page }) => {
    const panel = await open(page)
    await unfoldQuestions(panel)
    // The rule beside the question's ANSWER row: any row of the turn counts.
    const bar = panel.locator(`.session-history .session-msg--threaded[data-message-id="${IDS.Q1.a}"]`)
    await expect(bar).toHaveCount(1)
    await centreInHistory(page, panel, bar, { capRow: true })
    const r = (await bar.boundingBox())!
    await page.mouse.click(r.x + 1, r.y + Math.min(r.height / 2, 20))
    await expect(card(panel)).toBeVisible()
    await expect(card(panel).locator('.thread-card-head .thread-map-num')).toHaveText('1')
    await expect(chip(panel)).toHaveCount(0)
  })
})
