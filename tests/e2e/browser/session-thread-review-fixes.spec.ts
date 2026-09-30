/**
 * Review fixes for the question stack + tree drawer slice, each pinned by the
 * user path that showed it:
 *  - R1: a pin jump from the drawer lands ONCE; a later return to that page
 *    (push into a question, Esc back) lands on the passage it left, not the pin.
 *  - R2: the first Ask in a session WITHOUT questions, then Esc with an empty
 *    composer, lands back on the passage (within 8px) and flashes it.
 *  - R4: moving the pointer across a question mark never re-renders the
 *    timeline (a dev-only render counter), while the tip still follows.
 *  - R9: fullscreen, root page, a selection bar up: one Esc closes the bar only.
 *  - R12: the root page of a session with questions has the geometry of a
 *    session without them (scroll box top, its padding, the first row).
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import {
  centreInHistory, DENSE_SESSION, NO_THREAD_SESSION, openThreadsSession, passageRects, resetThreadsFixture, selectPassage, openQuestionList,
} from './threads-helpers'
import { densePassage } from './threads-fixture'

const DENSE_TASK = 'pw-task-threads-dense'
const DENSE_READY = 'Walk me through part 6 of the storage notes.'
const NO_THREAD_TASK = 'pw-task-outline-window'
const NO_THREAD_READY = 'outline filler reply 230'

async function shot(page: Page, name: string): Promise<void> {
  const dir = `/tmp/thread-review-fix/e2e/${test.info().project.name}`
  await fs.mkdir(dir, { recursive: true })
  await page.screenshot({ path: `${dir}/${name}.png` })
}

async function boot(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
}

async function expectDepth(panel: Locator, depth: number): Promise<void> {
  await expect(panel.locator('.thread-stack')).toHaveAttribute('data-thread-depth', String(depth), { timeout: 15_000 })
}

/** Wheel the timeline until `target` sits near 40% of the box. */
async function centre(page: Page, panel: Locator, target: Locator): Promise<void> {
  await centreInHistory(page, panel, target, { at: 0.4, tolerance: 60, capRow: true })
}

/** The passage's top inside the scroll box, in px from the box's top edge. */
async function passageTop(panel: Locator, phrase: string): Promise<number> {
  const rects = await passageRects(panel, phrase)
  const box = (await panel.locator('.session-history').boundingBox())!
  return rects[0].top - box.y
}

async function flashText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const hl = (CSS as unknown as { highlights?: Map<string, Set<Range>> }).highlights?.get('walnut-pin-flash')
    return Array.from(hl ?? []).map((r) => r.toString()).join(' | ')
  })
}

/** Put a marked passage mid-box and the pointer on it, until the timeline says
 *  the pointer is on a mark. Returns the passage's first rect. */
async function hoverMark(page: Page, panel: Locator, phrase: string) {
  const row = panel.locator('.session-history [data-message-id] .session-msg-content', { hasText: phrase }).first()
  await expect(row).toBeVisible()
  const hover = panel.locator('[data-thread-mark-hover]')
  let r = (await passageRects(panel, phrase))[0]
  for (let attempt = 0; attempt < 5 && await hover.count() === 0; attempt++) {
    await centre(page, panel, row)
    await page.waitForTimeout(400)
    r = (await passageRects(panel, phrase))[0]
    await page.mouse.move(r.left + 12 + attempt, r.top + r.height / 2, { steps: 3 })
    await page.waitForTimeout(250)
  }
  await expect(hover).toHaveCount(1)
  return r
}

const historyRenders = (page: Page, sessionId: string) =>
  page.evaluate((sid) => (window as unknown as { __walnutHistoryRenders?: Record<string, number> }).__walnutHistoryRenders?.[sid] ?? 0, sessionId)

test.describe('Question stack review fixes', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(240_000)

  test.beforeEach(async ({ request }) => {
    await resetThreadsFixture(request, DENSE_SESSION)
  })

  test('R1: a drawer pin jump lands once; Esc back from a question lands on the passage it left, not the pin', async ({ page }) => {
    await boot(page)
    const panel = await openThreadsSession(page, DENSE_SESSION, DENSE_TASK, DENSE_READY)
    await expectDepth(panel, 0)
    // A root pin from the drawer's Pinned filter: the quote pinned on R2 (Q5's passage).
    const drawer = await openQuestionList(page, panel)
    await drawer.locator('.thread-drawer-chip', { hasText: 'Pinned' }).click()
    const pinRow = drawer.locator('.thread-tree-row[data-kind="pin"]', { hasText: densePassage('Q5').slice(0, 24) })
    await expect(pinRow).toBeVisible()
    await pinRow.click()
    await expect(drawer).toBeHidden()
    await expectDepth(panel, 0)
    await expect.poll(() => flashText(page), { timeout: 15_000 }).toContain(densePassage('Q5').slice(0, 20))
    await page.waitForTimeout(1600)

    // Push into Q9 (a mark on R5, far from the pin), then Esc back to root.
    const phrase = densePassage('Q9')
    const r = await hoverMark(page, panel, phrase)
    const askedAt = r.top - (await panel.locator('.session-history').boundingBox())!.y
    await page.mouse.click(r.left + 12, r.top + r.height / 2)
    await expectDepth(panel, 1)
    await page.waitForTimeout(500)
    await page.keyboard.press('Escape')
    await expectDepth(panel, 0)
    await page.waitForTimeout(1200)
    const landed = await passageTop(panel, phrase)
    await shot(page, 'r1-esc-back-after-pin-jump')
    expect(Math.abs(landed - askedAt), `landing drift: asked ${askedAt}, landed ${landed}`).toBeLessThanOrEqual(8)
  })

  test('R2: first Ask in a session without questions, Esc with an empty composer: the passage is back and flashed', async ({ page }) => {
    await boot(page)
    const panel = await openThreadsSession(page, NO_THREAD_SESSION, NO_THREAD_TASK, NO_THREAD_READY)
    await expect(panel.locator('.thread-stack-off')).toHaveCount(1)
    const phrase = 'outline filler reply 222'
    const row = panel.locator('.session-history [data-message-id] .session-msg-content', { hasText: phrase }).first()
    await centre(page, panel, row)
    await page.waitForTimeout(500)
    const history = panel.locator('.session-history')
    const boxTopBefore = (await history.boundingBox())!.y
    const askedAt = await passageTop(panel, phrase)
    const scrollBefore = await history.evaluate((el) => el.scrollTop)
    expect(scrollBefore).toBeGreaterThan(200)
    await selectPassage(page, panel, phrase)
    await page.locator('[data-testid="quote-pin-pill"] [data-testid="quote-ask-btn"]').click()
    await expectDepth(panel, 1)
    await page.waitForTimeout(400)
    await page.keyboard.press('Escape')
    // The pending page is gone and so is the stack: back to the frame that adds nothing.
    await expect(panel.locator('.thread-stack-off')).toHaveCount(1, { timeout: 15_000 })
    await expect.poll(() => flashText(page), { timeout: 10_000 }).toContain(phrase)
    await page.waitForTimeout(600)
    const landed = await passageTop(panel, phrase)
    const boxTopAfter = (await history.boundingBox())!.y
    await shot(page, 'r2-first-ask-esc-back')
    expect(Math.abs(boxTopAfter - boxTopBefore), `scroll box moved: ${boxTopBefore} -> ${boxTopAfter}`).toBeLessThanOrEqual(1)
    expect(Math.abs(landed - askedAt), `landing drift: asked ${askedAt}, landed ${landed}`).toBeLessThanOrEqual(8)
  })

  test('R4: moving the pointer across a question mark never re-renders the timeline; the tip follows', async ({ page }) => {
    await boot(page)
    const panel = await openThreadsSession(page, DENSE_SESSION, DENSE_TASK, DENSE_READY)
    await expectDepth(panel, 0)
    const phrase = densePassage('Q9')
    const r = await hoverMark(page, panel, phrase)
    const tip = page.locator('.thread-hover-tip')
    await expect(tip).toBeVisible()
    await expect(tip).toContainText('Open')
    await page.waitForTimeout(500)
    const tipBefore = (await tip.boundingBox())!
    const before = await historyRenders(page, DENSE_SESSION)
    expect(before, 'the dev render counter is live').toBeGreaterThan(0)
    // 30 frames of pointer movement along the marked passage.
    const y = r.top + r.height / 2
    for (let i = 1; i <= 30; i++) {
      await page.mouse.move(r.left + 12 + i * 4, y)
      await page.evaluate(() => new Promise((res) => requestAnimationFrame(() => res(null))))
    }
    await page.waitForTimeout(300)
    const after = await historyRenders(page, DENSE_SESSION)
    await expect(panel.locator('[data-thread-mark-hover]')).toHaveCount(1)
    await expect(tip).toBeVisible()
    const tipAfter = (await tip.boundingBox())!
    expect(after - before, `timeline renders while the pointer moved over the mark: ${after - before}`).toBe(0)
    expect(Math.abs(tipAfter.x - tipBefore.x) + Math.abs(tipAfter.y - tipBefore.y), 'the tip follows the pointer').toBeGreaterThan(20)
  })

  test('R9: fullscreen, root page, a selection bar up: one Esc closes the bar only', async ({ page }) => {
    await boot(page)
    const panel = await openThreadsSession(page, NO_THREAD_SESSION, NO_THREAD_TASK, NO_THREAD_READY)
    await panel.locator('button[title="Expand to full screen"]').click()
    await expect(panel).toHaveClass(/open-walnut-fullscreen/)
    await page.waitForTimeout(400)
    await selectPassage(page, panel, 'outline filler reply 229')
    const pill = page.locator('[data-testid="quote-pin-pill"]')
    await expect(pill).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(pill).toHaveCount(0)
    await page.waitForTimeout(400)
    await expect(panel).toHaveClass(/open-walnut-fullscreen/)
    await shot(page, 'r9-fullscreen-esc-closes-bar-only')
    // The next Esc, with nothing open, leaves fullscreen as always.
    await page.keyboard.press('Escape')
    await expect(panel).not.toHaveClass(/open-walnut-fullscreen/)
  })

  test('R12: the root page of a session with questions has the geometry of one without', async ({ page }) => {
    await boot(page)
    const geometry = async (panel: Locator) => {
      const history = panel.locator('.session-history')
      // Scroll-independent: a windowed timeline loads more when sent to the top.
      return history.evaluate((el) => {
        const panelEl = el.closest('.session-panel') as HTMLElement
        const p = panelEl.getBoundingClientRect().top
        const box = el.getBoundingClientRect()
        // The first message row with a box (wrappers may be display: contents).
        let first: HTMLElement | null = null
        for (const n of Array.from(el.querySelectorAll<HTMLElement>('.session-msg'))) {
          const r = n.getBoundingClientRect()
          if (r.height > 0 && getComputedStyle(n).position !== 'absolute' && getComputedStyle(n).position !== 'sticky') { first = n; break }
        }
        return {
          firstKind: first ? `${first.tagName}.${String(first.className).split(' ')[0]}` : null,
          boxTop: Math.round((box.top - p) * 10) / 10,
          boxBottomGap: Math.round((panelEl.getBoundingClientRect().bottom - box.bottom) * 10) / 10,
          paddingTop: parseFloat(getComputedStyle(el).paddingTop),
          // Where the first row starts in the scroll content (at scrollTop 0 it
          // sits this far below the box top).
          firstRowTop: first ? Math.round((first.getBoundingClientRect().top - box.top + el.scrollTop) * 10) / 10 : null,
        }
      })
    }
    const plain = await openThreadsSession(page, NO_THREAD_SESSION, NO_THREAD_TASK, NO_THREAD_READY)
    const withQuestions = await openThreadsSession(page, DENSE_SESSION, DENSE_TASK, DENSE_READY)
    await expectDepth(withQuestions, 0)
    await expect(withQuestions.locator('.thread-stack')).toHaveAttribute('data-thread-bare', '')
    const a = await geometry(plain)
    const b = await geometry(withQuestions)
    await shot(page, 'r12-root-geometry')
    expect(Math.abs(a.boxTop - b.boxTop), `scroll box top: ${JSON.stringify({ a, b })}`).toBeLessThanOrEqual(1)
    expect(Math.abs(a.paddingTop - b.paddingTop), `padding: ${JSON.stringify({ a, b })}`).toBeLessThanOrEqual(1)
    expect(Math.abs(a.boxBottomGap - b.boxBottomGap), `scroll box bottom: ${JSON.stringify({ a, b })}`).toBeLessThanOrEqual(1)
    expect(a.firstRowTop).not.toBeNull()
    expect(Math.abs(a.firstRowTop! - b.firstRowTop!), `first row top: ${JSON.stringify({ a, b })}`).toBeLessThanOrEqual(1)
    // The transcript scrolls UNDER the glass header on the root page, as before.
    expect(b.boxTop, 'the scroll box starts at the panel top').toBeLessThanOrEqual(a.boxTop + 1)
  })
})
