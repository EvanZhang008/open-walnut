/**
 * Pop landing after a question that was just SENT (C4): the four-deep chain of
 * existing questions landed within 0px, but a new Ask plus a send on a question
 * page came back 44px off its passage. Dense fixture, reset per test.
 */
import { expect, type Locator, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import { centreInHistory, DENSE_SESSION, mainComposer, mainPage, openThreadsSession, passageRects, readRecord, resetThreadsFixture, selectPassage, test } from './threads-helpers'
import { densePassage } from './threads-fixture'

const DENSE_TASK = 'pw-task-threads-dense'
const DENSE_READY = 'Walk me through part 6 of the storage notes.'

async function shot(page: Page, name: string): Promise<void> {
  const dir = `/tmp/threads-landing-send/e2e/${test.info().project.name}`
  await fs.mkdir(dir, { recursive: true })
  await page.screenshot({ path: `${dir}/${name}.png` })
}

async function expectDepth(panel: Locator, depth: number): Promise<void> {
  await expect(panel.locator('.thread-stack')).toHaveAttribute('data-thread-depth', String(depth), { timeout: 15_000 })
}

async function openAsked(page: Page, panel: Locator, text: string | RegExp, depth: number): Promise<void> {
  const row = panel.locator('.thread-asked-row', { hasText: text }).first()
  await expect(row).toBeVisible()
  await centreInHistory(page, panel, row)
  await row.click()
  await expectDepth(panel, depth)
}

/** Where the passage sits, on screen and inside the timeline box, from ONE read. */
async function passagePlace(panel: Locator, phrase: string): Promise<{ screen: number; inBox: number; boxTop: number }> {
  const top = (await passageRects(panel, phrase))[0].top
  const box = (await panel.locator('.session-history').boundingBox())!
  return { screen: Math.round(top), inBox: Math.round(top - box.y), boxTop: Math.round(box.y) }
}

/** The bottom edge of the page's own header row (single page or right half). */
async function headerBottom(view: Locator): Promise<number> {
  const box = (await view.locator('.thread-stack-header').first().boundingBox())!
  return Math.round(box.y + box.height)
}

/** Record scrollTop on every frame after the next Esc. */
async function sampleScrollAfterEsc(page: Page, panel: Locator): Promise<number[]> {
  await panel.locator('.session-history').evaluate((el) => {
    const w = window as unknown as { __tops: number[] }
    w.__tops = []
    const tick = () => { w.__tops.push(el.scrollTop); if (w.__tops.length < 30) requestAnimationFrame(tick) }
    window.addEventListener('keydown', () => requestAnimationFrame(tick), { capture: true, once: true })
  })
  await page.keyboard.press('Escape')
  await expect.poll(() => page.evaluate(() => (window as unknown as { __tops: number[] }).__tops.length)).toBe(30)
  return page.evaluate(() => (window as unknown as { __tops: number[] }).__tops)
}

test.describe('Question stack landing after a send', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(240_000)

  test.beforeEach(async ({ request }) => {
    const res = await request.patch(`/api/sessions/${DENSE_SESSION}`, { data: { thread_anchors: [] } })
    expect(res.ok()).toBe(true)
    await resetThreadsFixture(request, DENSE_SESSION)
  })

  // `at`: where the passage sits when it is asked, as a fraction of the box
  // height. Near the top edge is a real reading position too (the passage the
  // reader just scrolled up to), and the one a failed centring once left.
  for (const [label, at] of [['mid-box', 0.45], ['near the top edge', 0.06]] as const) {
    test(`a new question asked and sent on a question page pops back onto its passage, ${label} (C4)`, async ({ page, request }) => {
      await page.goto('/')
      await page.waitForLoadState('networkidle')
      const panel = await openThreadsSession(page, DENSE_SESSION, DENSE_TASK, DENSE_READY)
      // The panel's own page: the right half once the Ask below splits the pane
      // (the page it was asked on goes left, and comes back right on Esc).
      const view = mainPage(panel)
      await openAsked(page, view, 'Late flush risk', 1)
      await openAsked(page, view, 'Reader skip cost', 2)
      // Part of Q24's passage: an overlap, so a NEW question on this page.
      const phrase = densePassage('Q24').slice(0, 22)
      await centreInHistory(page, view, phrase, { at, tolerance: 20 })
      const before = (await readRecord(request, DENSE_SESSION)).threadAnchors?.length ?? 0
      await selectPassage(page, view, phrase)
      // Measured where the page records its landing: at the Ask click.
      const asked = await passagePlace(view, phrase)
      const askedHead = await headerBottom(view)
      // In Tree Mode Ask here goes one level down from the page the passage is
      // on (depth 2 -> 3), never back to the main conversation, and the panel's
      // composer is the new page's box.
      await page.locator('[data-testid="quote-pin-pill"] [data-testid="quote-ask-btn"]').click()
      await expectDepth(view, 3)
      // The column is wide enough for two halves: the Ask splits it, the page it
      // was asked on goes left.
      await expect(panel.locator('.tree-split-left')).toBeVisible()
      await expect(view.locator('.session-history[data-view-mode="stack"]')).toHaveCount(1)
      await expect(panel.locator('.thread-card')).toHaveCount(0)
      const box = mainComposer(panel)
      await expect(box).toBeFocused()
      await box.fill('what does the partial point say')
      await box.press('Enter')
      await expect(box).toHaveValue('')
      await expect.poll(async () => (await readRecord(request, DENSE_SESSION)).threadAnchors?.length ?? 0).toBe(before + 1)
      await expect(view.locator('.session-history')).toContainText('processed your message', { timeout: 90_000 })
      await page.waitForTimeout(800)
      const tops = await sampleScrollAfterEsc(page, view)
      await expectDepth(view, 2)
      const settled = tops.slice(2)
      expect(new Set(settled).size, `scrollTop per frame: ${tops.join(',')}`).toBe(1)
      const landed = await passagePlace(view, phrase)
      await shot(page, `c4-sent-pop-${at}`)
      // Esc keeps the split: the page comes back as the RIGHT half, whose
      // one-line row (and the path bar above) moved its timeline box.
      await expect(panel.locator('.tree-split-left')).toBeVisible()
      await expect(view.locator('.thread-stack-header[data-half="R"]')).toBeVisible()
      // The box moved exactly as far as the page's header row did (the
      // single page's header with its subtitle, then the half's one-line row),
      // and it did move: this is the split case, not a skipped check.
      const moved = landed.boxTop - asked.boxTop
      const headMoved = (await headerBottom(view)) - askedHead
      expect(moved, `box moved ${moved}, header moved ${headMoved}`).not.toBe(0)
      expect(Math.abs(moved - headMoved), `box moved ${moved}, header moved ${headMoved}`).toBeLessThanOrEqual(1)
      // The passage comes back to the same place on screen, so inside the box it
      // is off by the box's move and nothing else.
      expect(Math.abs(landed.screen - asked.screen), `screen drift: asked ${JSON.stringify(asked)}, landed ${JSON.stringify(landed)}`).toBeLessThanOrEqual(8)
      expect(Math.abs((landed.inBox - asked.inBox) + moved), `landing drift in the box: asked ${JSON.stringify(asked)}, landed ${JSON.stringify(landed)}, box moved ${moved}`).toBeLessThanOrEqual(8)
    })
  }
})
