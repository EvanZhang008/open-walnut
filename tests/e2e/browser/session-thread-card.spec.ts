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
  settledScrollTop, trackHistoryScroll, unfoldQuestions,
} from './threads-helpers'
import { buildTaggedSession, TAGGED_PASSAGE, TAGGED_READY, TAGGED_SESSION, TAGGED_TASK, TAGGED_TEXT, TAGGED_TITLES } from './threads-fixture'
import { REVIEW_COUNT, REVIEW_READY, REVIEW_SESSION, REVIEW_TASK, reviewPassage } from './threads-review-fixture'

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
    // The questions shown (they fold to their lines on the main conversation,
    // utils/thread-fold.ts), so the timeline is the long one this test reads.
    await unfoldQuestions(panel)
    await hist.evaluate((el) => { el.scrollTop = el.scrollHeight })
    // Start at the bottom (where a session opens); the first message is far above.
    const before = await hist.evaluate((el) => el.scrollTop)
    expect(before).toBeGreaterThan(200)

    const rows = panel.locator('.thread-map .thread-map-row[data-kind="thread"]')
    const moves = await trackHistoryScroll(panel)
    await rows.nth(0).click()
    const c = card(panel)
    await expect(c).toBeVisible()
    // ONE move to the passage: the card's own reveal used to scroll first (to the
    // card, still placed off screen) and the jump second, with the passage under
    // the header in between, for a second in WebKit (2026-10-31).
    await page.waitForTimeout(600)
    const path = await moves.stop()
    expect(path.length, `the timeline moved in one step: ${path.join(' -> ')}`).toBe(2)
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
    // The row is current; the composer is not quoted into it (2026-10-27).
    await expect(rows.nth(0)).toHaveAttribute('aria-current', 'page')
    await expect(panel.locator('[data-testid="composer-thread-target"]')).toHaveCount(0)
    await expect(panel.locator('.chat-input-textarea').first()).not.toHaveAttribute('placeholder', new RegExp(TAGGED_TITLES.Q1))
    await shot(page, 'card-q1', panel)

    // Esc closes the card and leaves the timeline where it is.
    const top = await hist.evaluate((el) => el.scrollTop)
    await c.locator('.thread-card-input').press('Escape')
    await expect(c).toHaveCount(0)
    expect(await hist.evaluate((el) => el.scrollTop)).toBe(top)

    // The passage already on screen: a row click moves NOTHING (the 2026-09-30
    // report: every click landed on the first message).
    // Somewhere else than where the open left it, the passage still in view (the
    // open lands it near the top of what can scroll, 0.3 down can be that place).
    await centreInHistory(page, panel, TAGGED_PASSAGE.slice(0, 30), { at: 0.3 })
    if (Math.abs(await hist.evaluate((el) => el.scrollTop) - top) < 30) await hist.evaluate((el) => { el.scrollTop += 80 })
    const held = await hist.evaluate((el) => el.scrollTop)
    expect(held).not.toBe(top)
    const seen = (await passageRects(panel, TAGGED_PASSAGE.slice(0, 30)))[0]
    const hv = await rect(hist)
    expect(seen.top).toBeGreaterThan(hv.y)
    expect(seen.top + seen.height).toBeLessThan(hv.y + hv.height - 40)
    await rows.nth(0).click()
    await expect(card(panel)).toBeVisible()
    await page.waitForTimeout(400)
    expect(await hist.evaluate((el) => el.scrollTop), 'the timeline stayed put').toBe(held)

    // Another row, the card still open: it swaps to question 2 (anchored to its
    // reply, no quote) in one move. The open card keeps its instance, so at the
    // switch it still wore question 1's place, and its own reveal scrolled back
    // toward it (review, 2026-10-31).
    const swap = await trackHistoryScroll(panel)
    await rows.nth(1).click()
    await expect(card(panel).locator('.thread-card-head .thread-map-num')).toHaveText('2')
    await page.waitForTimeout(600)
    const swapPath = await swap.stop()
    expect(swapPath.length, `the swap moved the timeline at most once: ${swapPath.join(' -> ')}`).toBeLessThanOrEqual(2)
    await expect(card(panel)).toBeInViewport()
    await expect(card(panel).locator('.thread-card-q')).toHaveText([T.q2])
    await expect(card(panel).locator('.thread-card-body')).toContainText(T.a2)
    // Only the answer: not the thought, the step before the tool call, or the
    // tool (2026-10-06, the user: "just the final message").
    await expect(card(panel).locator('.thread-card-body')).not.toContainText(T.step2)
    await expect(card(panel).locator('.thread-card-body')).not.toContainText(T.tool2)
    await expect(card(panel).locator('.thread-card-body .tool-run-row')).toHaveCount(0)
    expect(await card(panel).locator('.thread-card-body').innerText()).not.toMatch(/Thinking/)
    // The timeline still has the step: inside its turn's fold, the work before
    // the answer, which opens to it.
    const stepFold = history(panel).locator('.process-fold', { hasText: 'Ran 1 tool' })
    await expect(stepFold).toHaveCount(1)
    await expect(history(panel)).not.toContainText(T.step2)
    await stepFold.locator('.tool-run-toggle').first().click()
    await expect(history(panel)).toContainText(T.step2)
    await stepFold.locator('.tool-run-toggle').first().click()
    // A click on plain text, away from the card (and from any turn label,
    // which would open another card), closes it.
    await row(panel, IDS.R1.a).click({ position: { x: 12, y: 10 } })
    await expect(card(panel)).toHaveCount(0)
  })

  test('the asked passage is marked and a click on it opens the card; the card scrolls with its passage', async ({ page }) => {
    const panel = await open(page)
    // A timeline long enough to scroll 120px both ways: folded (the question
    // with its card open folds too, utils/thread-fold.ts), it is barely taller
    // than the box.
    await unfoldQuestions(panel)
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
    // A timeline long enough to scroll: folded, this one is barely taller than
    // the box, and a box at its bottom follows it (utils/thread-fold.ts).
    await unfoldQuestions(panel)
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
    // The timeline has the same turn with the same number, folded to its one line
    // while the card holds it (utils/thread-fold.ts), and the sidebar a third row.
    const line = history(panel).locator('[data-thread-fold]')
      .filter({ has: page.locator('.thread-map-num', { hasText: new RegExp(`^${next}$`) }) })
    await expect(line).toHaveCount(1)
    await expect(panel.locator('.session-history .session-msg--threaded', { hasText: 'Which page wins a tie?' })).toHaveCount(0)
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
    await map.locator('.thread-map-rail').click()
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

// A card already open swaps to another question whose passage is drawn but off
// screen: the card keeps its instance (and, at the switch, the last question's
// place), so its own reveal used to scroll back toward that place (review,
// 2026-10-31). One move, and the card lands under the new passage.
test.describe('Swapping the open card between drawn passages', () => {
  test.setTimeout(240_000)
  test.beforeEach(async ({ request }) => { await resetThreadsFixture(request, REVIEW_SESSION) })

  test('the card follows to the new passage in one move', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    await pinPanelWidth(page, 1100)
    const panel = await openThreadsSession(page, REVIEW_SESSION, REVIEW_TASK, REVIEW_READY, { view: 'linear' })
    const hist = history(panel)
    const rows = panel.locator('.thread-map .thread-map-row[data-kind="thread"]')
    await expect(rows).toHaveCount(REVIEW_COUNT)
    for (const [from, to] of [[0, 19], [19, 2]] as const) {
      if (from === 0) {
        await rows.nth(from).click()
        await expect(card(panel).locator('.thread-card-head .thread-map-num')).toHaveText(String(from + 1))
        await expect(card(panel)).toBeInViewport()
      }
      await settledScrollTop(hist)
      const moves = await trackHistoryScroll(panel)
      await rows.nth(to).click()
      await expect(card(panel).locator('.thread-card-head .thread-map-num')).toHaveText(String(to + 1))
      await page.waitForTimeout(600)
      const path = await moves.stop()
      expect(path.length, `${from + 1} -> ${to + 1} moved once: ${path.join(' -> ')}`).toBe(2)
      // Both read in one frame: the card hangs under the passage's last line.
      const gap = await panel.evaluate((root, needle) => {
        const c = root.querySelector('.thread-card') as HTMLElement
        for (const body of Array.from(root.querySelectorAll('.session-history [data-message-id] .session-msg-content'))) {
          const tw = document.createTreeWalker(body, NodeFilter.SHOW_TEXT)
          for (let n = tw.nextNode(); n; n = tw.nextNode()) {
            const at = (n as Text).data.indexOf(needle)
            if (at < 0) continue
            const r = document.createRange(); r.setStart(n, at); r.setEnd(n, at + needle.length)
            const rects = r.getClientRects()
            return c.getBoundingClientRect().top - rects[rects.length - 1].bottom
          }
        }
        return null
      }, reviewPassage(to).slice(0, 24))
      expect(gap, 'the passage is drawn').not.toBeNull()
      expect(gap!).toBeGreaterThanOrEqual(-1)
      expect(gap!).toBeLessThan(40)
      await expect(card(panel)).toBeInViewport()
      expect(await hist.evaluate((el) => el.scrollTop)).toBe(path[path.length - 1])
    }
  })
})
