/**
 * Three defects the main agent's screenshot walk found after the review fixes:
 *  - a sliver tip ("Back to …") stayed up after Esc popped the page under a
 *    resting pointer, naming a page that was no longer an ancestor;
 *  - a question's subtitle started at the row's left edge instead of under the
 *    title once its pending page became the question (the indent hook watched
 *    the replaced, detached title node);
 *  - the Done toast on the root page covered the session header, because the
 *    root transcript runs under the glass header and the toast took the scroll
 *    box's top edge as the top of the content.
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import { centreInHistory, DENSE_SESSION, openThreadsSession, resetThreadsFixture, selectPassage } from './threads-helpers'

const TASK = 'pw-task-threads-dense'

async function openDense(page: Page): Promise<Locator> {
  await page.setViewportSize({ width: 1280, height: 860 })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  const panel = await openThreadsSession(page, DENSE_SESSION, TASK)
  await expect(panel.locator('.thread-drawer-toggle')).toBeVisible({ timeout: 30_000 })
  return panel
}

async function goTo(panel: Locator, query: string, title: RegExp): Promise<void> {
  await panel.locator('.thread-drawer-toggle').click()
  const drawer = panel.locator('.thread-drawer')
  await expect(drawer).toHaveAttribute('data-mode', 'open')
  await drawer.locator('.thread-drawer-chip', { hasText: /^All\b/ }).click()
  const search = drawer.locator('.thread-drawer-search-input')
  await search.fill(query)
  await search.press('Enter')
  await expect(drawer).toHaveCount(0)
  await expect(panel.locator('.thread-stack-header .thread-stack-title')).toHaveText(title)
}

const rectOf = (loc: Locator) => loc.evaluate((el) => {
  const r = el.getBoundingClientRect()
  return { left: r.left, top: r.top, bottom: r.bottom }
})

/** Wheel `phrase` to the middle of the timeline (a direct scroll when WebKit drops the wheel). */
async function centre(page: Page, panel: Locator, phrase: string): Promise<void> {
  await centreInHistory(page, panel, phrase)
}

test.describe('question stack visual fixes', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(240_000)
  test.beforeEach(async ({ request }) => { await resetThreadsFixture(request, DENSE_SESSION) })

  test('a sliver tip never outlives the page it was shown for', async ({ page }) => {
    const panel = await openDense(page)
    await goTo(panel, 'point 21 change', /^Point 21:/)
    await expect(panel.locator('.thread-stack')).toHaveAttribute('data-thread-depth', '3')
    const bars = panel.locator('.thread-sliver-bar')
    await expect(bars).toHaveCount(3)
    const last = (await bars.nth(2).boundingBox())!
    await page.mouse.move(last.x + last.width / 2, last.y + 40)
    await page.mouse.move(last.x + last.width / 2, last.y + 44)
    const tip = page.locator('.thread-hover-tip')
    await expect(tip).toHaveText(/^Back to Point 11:/)
    // Pop with the pointer resting where it is: no pointermove follows.
    await page.keyboard.press('Escape')
    await expect(panel.locator('.thread-stack')).toHaveAttribute('data-thread-depth', '2')
    await expect(page.locator('.thread-hover-tip', { hasText: /^Back to Point 11:/ })).toHaveCount(0)
  })

  test('a new question keeps its subtitle under its title; the Done toast stays under the session header', async ({ page }) => {
    const panel = await openDense(page)
    const phrase = await panel.evaluate((root) => {
      const rows = Array.from(root.querySelectorAll('.session-history .session-msg-assistant .markdown-body p'))
      const words = (rows[rows.length - 1]?.textContent ?? '').split(/\s+/).filter(Boolean)
      return words.slice(2, 8).join(' ')
    })
    await centre(page, panel, phrase)
    await selectPassage(page, panel, phrase)
    await page.locator('[data-testid="quote-pin-pill"] [data-testid="quote-ask-btn"]').click()
    await expect(panel.locator('.thread-stack')).toHaveAttribute('data-thread-depth', '1')
    const box = panel.locator('.chat-input-textarea').first()
    await box.fill('where does the subtitle start')
    await box.press('Enter')
    const header = panel.locator('.thread-stack-header')
    const subtitle = header.locator('.thread-stack-subtitle')
    await expect(subtitle).toHaveText('where does the subtitle start', { timeout: 30_000 })
    await expect.poll(async () => {
      const title = await rectOf(header.locator('.thread-stack-title'))
      const pad = await subtitle.evaluate((el) => parseFloat(getComputedStyle(el).paddingLeft) || 0)
      const sub = await rectOf(subtitle)
      return Math.abs(sub.left + pad - title.left)
    }, { timeout: 5_000 }).toBeLessThanOrEqual(1)
    await expect(panel.locator('.session-history')).toContainText('processed your message', { timeout: 90_000 })

    await header.locator('.thread-stack-done').click()
    await expect(panel.locator('.thread-stack')).toHaveAttribute('data-thread-depth', '0')
    const toast = panel.locator('.thread-toast')
    await expect(toast).toBeVisible()
    await expect(toast).toContainText('Done:')
    const sessionHeader = await rectOf(panel.locator('.session-panel-header'))
    const t = await rectOf(toast)
    expect(t.top, 'the toast sits below the session header').toBeGreaterThanOrEqual(sessionHeader.bottom)
  })
})
