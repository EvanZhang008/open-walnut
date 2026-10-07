/**
 * The comment card (Conversation Mode): a question opens beside the passage it
 * is about, like a comment in a document, and nothing moves the timeline to its
 * top any more.
 *
 * Covers: a sidebar row keeps the scroll position (the 2026-09-30 report: every
 * click landed on the first message) and opens the card below the passage, with
 * the number, the title, the status word, the question without its quote, each
 * turn's final answer alone (no thought, no step before a tool), and no `[Qn]` tag; Esc and an outside click close it; a click on the
 * marked passage opens it; Ask on a selection opens a draft card whose own
 * composer is focused, the first send turns it into the question's card (number
 * 3) and the reply arrives inside it; Tree Mode has no card; the card follows
 * the scroll (content coordinates) and stays inside the panel.
 *
 * Chromium and WebKit. The tagged fixture session is this file's own.
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import {
  centreInHistory, modePill, nextQuestionNumber, openThreadsSession, passageRects, resetThreadsFixture, selectPassage, switchView,
} from './threads-helpers'
import { buildTaggedSession, TAGGED_PASSAGE, TAGGED_READY, TAGGED_SESSION, TAGGED_TASK, TAGGED_TEXT, TAGGED_TITLES } from './threads-fixture'

const IDS = buildTaggedSession(Date.now()).ids
const T = TAGGED_TEXT

async function shot(page: Page, name: string, panel?: Locator): Promise<void> {
  const dir = `/tmp/one-sidebar/e2e/${test.info().project.name}`
  await fs.mkdir(dir, { recursive: true })
  if (panel) await panel.screenshot({ path: `${dir}/${name}.png` })
  else await page.screenshot({ path: `${dir}/${name}.png` })
}

async function pinPanelWidth(page: Page, width: number): Promise<void> {
  if (width > 700) await page.setViewportSize({ width: 1800, height: 800 })
  await page.addStyleTag({ content: `.main-page-session-column:has(.session-panel[data-session-id="${TAGGED_SESSION}"]) {
    flex: 0 0 ${width}px !important; width: ${width}px !important; min-width: ${width}px !important; max-width: ${width}px !important; }` })
}

async function open(page: Page, width = 1100): Promise<Locator> {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await pinPanelWidth(page, width)
  return openThreadsSession(page, TAGGED_SESSION, TAGGED_TASK, TAGGED_READY, { view: 'linear' })
}

const history = (panel: Locator) => panel.locator('.session-history')
const card = (panel: Locator) => panel.locator('.thread-card')
const row = (panel: Locator, id: string) => panel.locator(`.session-history [data-message-id="${id}"]`)
const rect = async (l: Locator) => (await l.boundingBox())!

test.describe('The comment card in Conversation Mode', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(240_000)

  test.beforeEach(async ({ request }) => {
    await resetThreadsFixture(request, TAGGED_SESSION)
  })

  test('a sidebar row keeps the scroll position and opens the card below the passage, with the whole question in it', async ({ page }) => {
    const panel = await open(page)
    const hist = history(panel)
    // Start at the bottom (where a session opens); the first message is far above.
    const before = await hist.evaluate((el) => el.scrollTop)
    expect(before).toBeGreaterThan(200)

    const rows = panel.locator('.thread-map .thread-map-row[data-kind="thread"]')
    await rows.nth(0).click()
    const c = card(panel)
    await expect(c).toBeVisible()
    await expect(c.locator('.thread-card-head .thread-map-num')).toHaveText('1')
    await expect(c.locator('.thread-card-title')).toHaveText(TAGGED_TITLES.Q1)
    await expect(c.locator('.thread-card-status')).toHaveText(/Answered|New/)
    // Every turn filed under question 1: the question as typed (no quote block),
    // then its answer; the lost and the merged turns too; never the tag.
    const qs = c.locator('.thread-card-q')
    await expect(qs).toHaveText([T.q1, T.lost, T.merged])
    const body = c.locator('.thread-card-body')
    await expect(body).toContainText(T.a1)
    await expect(body).toContainText(T.aLost)
    await expect(body).toContainText(T.aMerged)
    expect(await body.innerText()).not.toMatch(/\[Q\s?\d+\]/)
    expect(await body.innerText()).not.toContain(TAGGED_PASSAGE)

    // Below the passage, inside the panel, and the passage is on screen (the
    // row jumped there because it was off screen), not the first message.
    const passage = (await passageRects(panel, TAGGED_PASSAGE.slice(0, 30)))
    const last = passage[passage.length - 1]
    const lastBottom = last.top + last.height
    const cb = await rect(c)
    const hb = await rect(hist)
    expect(cb.y).toBeGreaterThanOrEqual(lastBottom - 1)
    expect(cb.y - lastBottom).toBeLessThan(40)
    expect(cb.x).toBeGreaterThanOrEqual(hb.x)
    expect(cb.x + cb.width).toBeLessThanOrEqual(hb.x + hb.width + 1)
    expect(cb.width).toBeGreaterThanOrEqual(260)
    await expect(c).toBeInViewport()
    // The target follows: the row is current and the composer names the question.
    await expect(rows.nth(0)).toHaveAttribute('aria-current', 'page')
    await expect(panel.locator('.chat-input-textarea').first()).toHaveAttribute('placeholder', new RegExp(TAGGED_TITLES.Q1))
    await shot(page, 'card-q1', panel)

    // Esc closes the card and leaves the timeline where it is.
    const top = await hist.evaluate((el) => el.scrollTop)
    await c.locator('.thread-card-input').press('Escape')
    await expect(c).toHaveCount(0)
    expect(await hist.evaluate((el) => el.scrollTop)).toBe(top)

    // The passage already on screen: a row click moves NOTHING (the 2026-09-30
    // report: every click landed on the first message).
    await centreInHistory(page, panel, TAGGED_PASSAGE.slice(0, 30), { at: 0.3 })
    const held = await hist.evaluate((el) => el.scrollTop)
    expect(held).not.toBe(top)
    await rows.nth(0).click()
    await expect(card(panel)).toBeVisible()
    await page.waitForTimeout(400)
    expect(await hist.evaluate((el) => el.scrollTop), 'the timeline stayed put').toBe(held)
    await card(panel).locator('.thread-card-input').press('Escape')
    await expect(card(panel)).toHaveCount(0)

    // Another row: the card swaps to question 2 (anchored to its reply, no quote).
    await rows.nth(1).click()
    await expect(card(panel).locator('.thread-card-head .thread-map-num')).toHaveText('2')
    await expect(card(panel).locator('.thread-card-q')).toHaveText([T.q2])
    await expect(card(panel).locator('.thread-card-body')).toContainText(T.a2)
    // Only the answer: not the thought, the step before the tool call, or the
    // tool (2026-10-06, the user: "just the final message").
    await expect(card(panel).locator('.thread-card-body')).not.toContainText(T.step2)
    await expect(card(panel).locator('.thread-card-body')).not.toContainText(T.tool2)
    await expect(card(panel).locator('.thread-card-body .tool-run-row')).toHaveCount(0)
    expect(await card(panel).locator('.thread-card-body').innerText()).not.toMatch(/Thinking/)
    // The timeline still has the step.
    await expect(history(panel)).toContainText(T.step2)
    // A click on plain text, away from the card (and from any turn label,
    // which would open another card), closes it.
    await row(panel, IDS.R1.a).click({ position: { x: 12, y: 10 } })
    await expect(card(panel)).toHaveCount(0)
  })

  test('the asked passage is marked and a click on it opens the card; the card scrolls with its passage', async ({ page }) => {
    const panel = await open(page)
    await centreInHistory(page, panel, TAGGED_PASSAGE.slice(0, 30))
    const rects = await passageRects(panel, TAGGED_PASSAGE.slice(0, 30))
    const r = rects[0]
    await page.mouse.click(r.left + 12, r.top + r.height / 2)
    const c = card(panel)
    await expect(c).toBeVisible()
    await expect(c.locator('.thread-card-title')).toHaveText(TAGGED_TITLES.Q1)
    // Content coordinates: the card moves exactly as far as the text does.
    const hist = history(panel)
    const top = () => hist.evaluate((el) => el.scrollTop)
    const s0 = await top()
    const y0 = (await rect(c)).y
    await hist.evaluate((el) => { el.scrollTop += 120 })
    await expect.poll(async () => (await rect(c)).y).toBeLessThan(y0 - 50)
    const s1 = await top()
    expect(Math.abs((y0 - (await rect(c)).y) - (s1 - s0))).toBeLessThan(4)
    await hist.evaluate((el) => { el.scrollTop -= 120 })
    await expect.poll(async () => (await rect(c)).y).toBeGreaterThan(y0 - 50)
    const s2 = await top()
    expect(Math.abs(((await rect(c)).y - y0) - (s0 - s2))).toBeLessThan(4)
  })

  test('Ask on a selection opens a draft card with its own composer; the first send numbers it and the reply lands inside', async ({ page, request }) => {
    const panel = await open(page)
    const next = String(await nextQuestionNumber(request, TAGGED_SESSION))
    await centreInHistory(page, panel, TAGGED_PASSAGE.slice(0, 30))
    const before = await history(panel).evaluate((el) => el.scrollTop)
    await selectPassage(page, panel, TAGGED_PASSAGE.slice(0, 30))
    await page.locator('[data-testid="quote-pin-pill"] [data-testid="quote-ask-btn"]').click()
    const c = card(panel)
    await expect(c).toBeVisible()
    await expect(c).toHaveAttribute('data-draft', 'true')
    await expect(c.locator('.thread-card-title')).toHaveText('New question')
    await expect(c.locator('.thread-card-body')).toHaveCount(0)
    const input = c.locator('.thread-card-input')
    await expect(input).toBeFocused()
    await expect(input).toHaveAttribute('placeholder', 'Ask about this passage…')
    // Still Conversation Mode, and the timeline did not move.
    await expect(modePill(panel)).toHaveAttribute('data-view-mode', 'linear')
    await page.waitForTimeout(300)
    expect(await history(panel).evaluate((el) => el.scrollTop)).toBe(before)

    await input.fill('Which page wins a tie?')
    await input.press('Enter')
    // The card becomes the question's: the next number, the question as typed, then the answer.
    await expect(c).not.toHaveAttribute('data-draft', 'true', { timeout: 30_000 })
    await expect(c.locator('.thread-card-head .thread-map-num')).toHaveText(next)
    await expect(c.locator('.thread-card-q').first()).toHaveText('Which page wins a tie?')
    await expect(c.locator('.thread-card-body')).toContainText('processed your message', { timeout: 60_000 })
    await expect.poll(() => c.locator('.thread-card-body').innerText()).not.toMatch(/\[Q\s?\d+\]/)
    // The reader stays with the card: a send from it never follows the timeline
    // to the bottom, so the card (and the passage) are still on screen.
    await expect(c).toBeInViewport()
    expect(Math.abs((await history(panel).evaluate((el) => el.scrollTop)) - before)).toBeLessThan(3)
    await expect(c.locator('.thread-card-status')).toHaveText(/Answered|New|To check/)
    await expect(input).toHaveValue('')
    await expect(input).toHaveAttribute('placeholder', /Reply in/)
    // The timeline has the same turn with the same number, and the sidebar a third row.
    const bubble = panel.locator('.session-history .session-msg--threaded', { hasText: 'Which page wins a tie?' }).first()
    await expect(bubble.locator('.thread-turn-label .thread-map-num')).toHaveText(next)
    await expect(panel.locator('.thread-map .thread-map-row[data-kind="thread"]')).toHaveCount(3)
    await shot(page, 'card-asked', panel)
  })

  test('Tree Mode has no card: the pill closes it and the question is a page', async ({ page }) => {
    const panel = await open(page)
    await panel.locator('.thread-map .thread-map-row[data-kind="thread"]').nth(0).click()
    await expect(card(panel)).toBeVisible()
    await switchView(panel, 'stack')
    await expect(card(panel)).toHaveCount(0)
    await expect(panel.locator('.thread-stack-header .thread-stack-title')).toHaveText(TAGGED_TITLES.Q1)
    await switchView(panel, 'linear')
    await expect(card(panel)).toHaveCount(0)
  })

  test('a 480px column: the card is as wide as the text and the rail still opens it', async ({ page }) => {
    const panel = await open(page, 480)
    const map = panel.locator('.thread-map')
    await expect(map).toHaveAttribute('data-shape', 'rail')
    await map.locator('.thread-map-rail').hover()
    await expect(map.locator('.thread-map-overlay')).toBeVisible()
    await map.locator('.thread-map-overlay .thread-map-row[data-kind="thread"]').nth(0).click()
    const c = card(panel)
    await expect(c).toBeVisible()
    const cb = await rect(c)
    const hb = await rect(history(panel))
    expect(cb.x).toBeGreaterThanOrEqual(hb.x)
    expect(cb.x + cb.width).toBeLessThanOrEqual(hb.x + hb.width + 1)
    await expect(c.locator('.thread-card-body')).toContainText(T.a1)
    await shot(page, 'card-narrow')
  })
})
