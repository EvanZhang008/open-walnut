/**
 * Two things the user saw in a real session (2026-10-06), in Conversation Mode:
 *
 * 1. One turn answered two questions (a question line the CLI took mid-turn).
 *    The first question's card kept saying "Answering…" after its answer was
 *    out, and the second never showed in progress. The live turn now belongs to
 *    its NEWEST `[Qn]` tag: the question it left is answered, the one it moved
 *    on to is answering, each card holds only its own words, and each passage's
 *    scanning line follows.
 * 2. Done is the user's archive: `Mark done` (no check glyph, it is an action)
 *    folds the question into the map's `N done` row, which shows it again on a
 *    click; its passage keeps its line, in green; Reopen brings it all back.
 *
 * Chromium and WebKit. The tagged fixture session; the mock CLI answers
 * `slow:<ms> MOCK_TAG_SWITCH:<n>:<ms>` with its own question first and then
 * question n, in one turn.
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import { centreInHistory, openThreadsSession, passageRects, resetThreadsFixture, selectPassage } from './threads-helpers'
import { TAGGED_PASSAGE, TAGGED_READY, TAGGED_SESSION, TAGGED_TASK, TAGGED_TEXT, TAGGED_TITLES } from './threads-fixture'

const T = TAGGED_TEXT

async function shot(page: Page, name: string, target?: Locator): Promise<void> {
  const dir = `/tmp/thread-live/e2e/${test.info().project.name}`
  await fs.mkdir(dir, { recursive: true })
  if (target) await target.screenshot({ path: `${dir}/${name}.png` })
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

/** The texts a highlight's ranges cover, so a spec can tell which passage wears which paint. */
const highlightTexts = (page: Page, name: string) => page.evaluate((n) => {
  const h = CSS.highlights?.get(n)
  return h ? Array.from(h as unknown as Iterable<Range>).map((r) => r.toString()) : []
}, name)

test.describe('Conversation Mode: a turn that moves on, and done as an archive', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(240_000)

  test.beforeEach(async ({ request }) => {
    await resetThreadsFixture(request, TAGGED_SESSION)
  })

  test('a turn that moves on to another question: the newer one is answering, the one it left is answered', async ({ page }) => {
    const panel = await open(page)
    const history = panel.locator('.session-history')
    const map = panel.locator('.thread-map')
    const card = panel.locator('.thread-card')
    const lines = history.locator('.thread-live-layer .thread-live-line')
    const q1Row = map.locator('.thread-map-row[data-kind="thread"]').nth(0)
    await expect(q1Row.locator('.thread-map-label')).toHaveText(TAGGED_TITLES.Q1)

    // A new question on the main line's answer; its turn answers it, then goes
    // back to question 1 three seconds in.
    await centreInHistory(page, panel, T.aRoot)
    await selectPassage(page, panel, T.aRoot)
    await page.locator('[data-testid="quote-pin-pill"] [data-testid="quote-ask-btn"]').click()
    await expect(card).toHaveAttribute('data-draft', 'true')
    await card.locator('.thread-card-input').fill('slow:12000 MOCK_TAG_SWITCH:1:4000 Which copy is that?')
    await card.locator('.thread-card-input').press('Enter')

    // Its own answer first: the new question is answering, in its card and the map.
    await expect(card).toHaveAttribute('data-answering', 'true', { timeout: 30_000 })
    await expect(card.locator('.thread-card-body')).toContainText('First, this question: Which copy is that?', { timeout: 30_000 })
    const newRow = map.locator('.thread-map-row[data-kind="thread"]').nth(2)
    await expect(newRow).toHaveAttribute('data-status', 'answering')
    await expect(q1Row).not.toHaveAttribute('data-status', 'answering')
    await expect(lines.first()).toBeVisible({ timeout: 10_000 })
    const rootPassage = await passageRects(panel, T.aRoot)
    expect(Math.abs((await lines.first().boundingBox())!.y - (rootPassage[0].top + rootPassage[0].height)), 'the line is under the new question\'s passage').toBeLessThan(4)
    await shot(page, 'switch-before', panel)

    // The turn moves on: question 1 is answering, the new one is answered, and
    // its card holds only its own words.
    await expect(q1Row).toHaveAttribute('data-status', 'answering', { timeout: 15_000 })
    await expect(newRow).not.toHaveAttribute('data-status', 'answering')
    await expect(card).not.toHaveAttribute('data-answering', 'true')
    await expect(card.locator('.thread-card-answering')).toHaveCount(0)
    await expect(card.locator('.thread-card-body')).toContainText('First, this question')
    await expect(card.locator('.thread-card-body')).not.toContainText('Now back to question 1')
    // The scanning line moved to question 1's passage.
    await centreInHistory(page, panel, TAGGED_PASSAGE.slice(0, 30))
    await expect.poll(async () => {
      const bar = await lines.first().boundingBox().catch(() => null)
      const r = (await passageRects(panel, TAGGED_PASSAGE.slice(0, 30)))[0]
      return bar ? Math.abs(bar.y - (r.top + r.height)) : 999
    }, { timeout: 10_000 }).toBeLessThan(4)
    await shot(page, 'switch-after', panel)

    // Question 1's card has the words the turn wrote for it, and says it is answering.
    await q1Row.click()
    await expect(card.locator('.thread-card-head .thread-map-num')).toHaveText('1')
    await expect(card).toHaveAttribute('data-answering', 'true')
    await expect(card.locator('.thread-card-body')).toContainText('Now back to question 1.')
    await expect(card.locator('.thread-card-body')).not.toContainText('First, this question')

    // The turn ends: nothing is answering any more.
    await expect(card.locator('.thread-card-body')).toContainText('processed your message', { timeout: 60_000 })
    await expect(map.locator('.thread-map-row[data-status="answering"]')).toHaveCount(0, { timeout: 15_000 })
    await expect(lines).toHaveCount(0, { timeout: 15_000 })
  })

  test('Mark done folds the question into "1 done", its line stays in green, and Reopen brings it back', async ({ page }) => {
    const panel = await open(page)
    const map = panel.locator('.thread-map')
    const card = panel.locator('.thread-card')
    const threadRows = map.locator('.thread-map-row[data-kind="thread"]')
    const doneGroup = map.locator('.thread-map-row[data-kind="done-group"]')
    await expect(threadRows).toHaveCount(2)
    await expect(doneGroup).toHaveCount(0)
    await expect.poll(() => highlightTexts(page, 'thread-mark-neutral')).toContain(TAGGED_PASSAGE)

    // The card's menu: `Mark done` is an action, so no check glyph in front of it.
    await threadRows.nth(0).click()
    await expect(card.locator('.thread-card-title')).toHaveText(TAGGED_TITLES.Q1)
    await card.locator('.thread-stack-more').click()
    const item = page.locator('.thread-menu [data-item="done"]')
    await expect(item).toHaveText('Mark done')
    await expect(item.locator('.thread-menu-icon svg')).toHaveCount(0)
    await shot(page, 'menu-mark-done', page.locator('.thread-menu'))
    await item.click()

    // Out of the map, behind "1 done"; the card closes; the passage keeps a green line.
    await expect(card).toHaveCount(0)
    await expect(threadRows).toHaveCount(1)
    await expect(threadRows.nth(0).locator('.thread-map-label')).toHaveText(TAGGED_TITLES.Q2)
    await expect(doneGroup).toHaveText(/1 done/)
    await expect(doneGroup).toHaveAttribute('aria-expanded', 'false')
    await expect.poll(() => highlightTexts(page, 'thread-mark-done-neutral')).toContain(TAGGED_PASSAGE)
    expect(await highlightTexts(page, 'thread-mark-neutral')).not.toContain(TAGGED_PASSAGE)
    const paint = await page.evaluate(() => {
      for (const sheet of Array.from(document.styleSheets)) {
        let list: CSSRuleList
        try { list = sheet.cssRules } catch { continue }
        for (const r of Array.from(list)) {
          const sr = r as CSSStyleRule
          if (sr.selectorText === '::highlight(thread-mark-done-neutral)') return { bg: sr.style.backgroundColor, deco: sr.style.getPropertyValue('text-decoration') }
        }
      }
      return null
    })
    expect(paint, 'the done paint is a rule of its own').toBeTruthy()
    // Green, not the open mark's grey: the fill and the line both carry it.
    const greenish = (c: string) => {
      const v = (c.match(/[\d.]+/g) ?? []).map(Number)
      if (/hsl/.test(c)) return v[0] >= 100 && v[0] <= 170 && v[1] >= 25
      return v[1] > v[0] + 20 && v[1] > v[2]
    }
    expect(greenish(paint!.bg), `fill ${paint!.bg}`).toBe(true)
    expect(paint!.deco).not.toContain('dotted')
    await centreInHistory(page, panel, TAGGED_PASSAGE.slice(0, 30))
    const r = (await passageRects(panel, TAGGED_PASSAGE.slice(0, 30)))[0]
    // The jump's yellow flash fades first: the picture is of the done paint.
    await expect.poll(() => page.evaluate(() => CSS.highlights?.has('walnut-pin-flash') ?? false), { timeout: 10_000 }).toBe(false)
    await page.screenshot({ path: `/tmp/thread-live/e2e/${test.info().project.name}/done-mark.png`, clip: { x: Math.max(0, r.left - 40), y: Math.max(0, r.top - 50), width: 700, height: 140 } })
    await shot(page, 'done-folded', panel)

    // "1 done" shows it again, and hides it again.
    await doneGroup.click()
    await expect(doneGroup).toHaveAttribute('aria-expanded', 'true')
    await expect(threadRows).toHaveCount(2)
    await expect(map.locator('.thread-map-row[data-kind="thread"]', { hasText: TAGGED_TITLES.Q1 })).toHaveCount(1)
    await shot(page, 'done-shown', panel)
    await doneGroup.click()
    await expect(threadRows).toHaveCount(1)

    // The mark still opens its card; Reopen puts the question back in the map.
    await page.mouse.click(r.left + 8, r.top + r.height / 2)
    await expect(card.locator('.thread-card-title')).toHaveText(TAGGED_TITLES.Q1)
    await card.locator('.thread-stack-more').click()
    await page.locator('.thread-menu [data-item="reopen"]').click()
    await expect(threadRows).toHaveCount(2)
    await expect(doneGroup).toHaveCount(0)
    await expect.poll(() => highlightTexts(page, 'thread-mark-neutral')).toContain(TAGGED_PASSAGE)
  })
})
