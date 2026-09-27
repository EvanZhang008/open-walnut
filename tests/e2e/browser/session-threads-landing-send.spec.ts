/**
 * Pop landing after a question that was just SENT (C4): the four-deep chain of
 * existing questions landed within 0px, but a new Ask plus a send on a question
 * page came back 44px off its passage. Dense fixture, reset per test.
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import { centreInHistory, DENSE_SESSION, openThreadsSession, passageRects, readRecord, resetThreadsFixture, selectPassage } from './threads-helpers'
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
async function passagePlace(panel: Locator, phrase: string): Promise<{ screen: number; inBox: number }> {
  const top = (await passageRects(panel, phrase))[0].top
  const box = (await panel.locator('.session-history').boundingBox())!
  return { screen: Math.round(top), inBox: Math.round(top - box.y) }
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
      await openAsked(page, panel, 'Late flush risk', 1)
      await openAsked(page, panel, 'Reader skip cost', 2)
      // Part of Q24's passage: an overlap, so a NEW question on this page.
      const phrase = densePassage('Q24').slice(0, 22)
      await centreInHistory(page, panel, phrase, { at, tolerance: 20 })
      const before = (await readRecord(request, DENSE_SESSION)).threadAnchors?.length ?? 0
      await selectPassage(page, panel, phrase)
      // Measured where the page records its landing: at the Ask click.
      const asked = await passagePlace(panel, phrase)
      await page.locator('[data-testid="quote-pin-pill"] [data-testid="quote-ask-btn"]').click()
      await expectDepth(panel, 3)
      const box = panel.locator('.chat-input-textarea').first()
      await box.fill('what does the partial point say')
      await box.press('Enter')
      await expect(box).toHaveValue('')
      await expect.poll(async () => (await readRecord(request, DENSE_SESSION)).threadAnchors?.length ?? 0).toBe(before + 1)
      await expect(panel.locator('.session-history')).toContainText('processed your message', { timeout: 90_000 })
      await page.waitForTimeout(800)
      const tops = await sampleScrollAfterEsc(page, panel)
      await expectDepth(panel, 2)
      const settled = tops.slice(2)
      expect(new Set(settled).size, `scrollTop per frame: ${tops.join(',')}`).toBe(1)
      const landed = await passagePlace(panel, phrase)
      await shot(page, `c4-sent-pop-${at}`)
      // The passage comes back to the same place in the box, and on screen.
      expect(Math.abs(landed.inBox - asked.inBox), `landing drift: asked ${JSON.stringify(asked)}, landed ${JSON.stringify(landed)}`).toBeLessThanOrEqual(8)
      expect(Math.abs(landed.screen - asked.screen), `screen drift: asked ${JSON.stringify(asked)}, landed ${JSON.stringify(landed)}`).toBeLessThanOrEqual(8)
    })
  }
})
