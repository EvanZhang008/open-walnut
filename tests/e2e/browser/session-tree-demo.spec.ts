/**
 * A recorded walk through Tree Mode's pages on macOS WebKit (the Mac app's
 * engine): two pages side by side (the current one and the one before it, equal
 * by default), a comment that stays on its page, a turn
 * that scrolls only its own page, the sibling above the right page and its swap,
 * and the light composers. It asserts what it shows, so it is a check too; it
 * runs only on macOS WebKit (`walnut-dev webkit`), where its video is the demo.
 */
import { expect } from '@playwright/test'
import { resetThreadsFixture, test } from './threads-helpers'
import { SPLIT_PASSAGES, SPLIT_SESSION, SPLIT_TITLES } from './threads-fixture'
import {
  commentOn, leftHalf, openQuestion, openSheet, pagesOnScreen, rightBody, rightComposer, rowCountOf, scrollBoxOf, scrollTopOf, send, siblingPage,
} from './tree-split-helpers'

test.use({ video: 'on' })

test.describe('Tree Mode demo', () => {
  test.beforeEach(async ({ request }, info) => {
    test.skip(info.project.name !== 'webkit' || process.platform !== 'darwin', 'the demo records on macOS WebKit only')
    await resetThreadsFixture(request, SPLIT_SESSION)
  })

  test('two pages, a comment, a turn, the sibling', async ({ page }) => {
    // The pauses are for the viewer: the walk runs about a minute.
    test.setTimeout(180_000)
    const pause = (ms = 900) => page.waitForTimeout(ms)
    const panel = await openSheet(page)
    await pause()
    await openQuestion(panel, SPLIT_TITLES.Q11)
    await expect.poll(() => pagesOnScreen(panel)).toEqual(['L 1', 'R 1.1'])
    await expect(siblingPage(panel)).toBeVisible()
    await pause(1500)

    // A comment on the left page waits there; nothing moves.
    await commentOn(page, leftHalf(panel), SPLIT_PASSAGES.ASK_Q1, 'Check this against the audit log.')
    await expect(leftHalf(panel).locator('[data-testid="pending-comment-row"]')).toHaveCount(1)
    await pause(1500)
    await send(leftHalf(panel).locator('textarea.chat-input-textarea'), 'Does a read count as a request here?')
    await expect(leftHalf(panel).locator('.session-history')).toContainText('Does a read count', { timeout: 20_000 })
    await expect.poll(() => pagesOnScreen(panel)).toEqual(['L 1', 'R 1.1'])
    await pause(1500)

    // The left page scrolled up stays put while the right page gets its answer.
    const left = leftHalf(panel)
    const lb = (await scrollBoxOf(left).boundingBox())!
    await page.mouse.move(lb.x + lb.width / 2, lb.y + lb.height / 2)
    for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, -3000); await page.waitForTimeout(80) }
    await pause(600)
    const leftTop = await scrollTopOf(left)
    const rows = await rowCountOf(rightBody(panel))
    await send(rightComposer(panel), 'Who reviews the edits?')
    await expect.poll(() => rowCountOf(rightBody(panel)), { timeout: 30_000 }).toBeGreaterThanOrEqual(rows + 2)
    await pause(800)
    expect(await scrollTopOf(left)).toBe(leftTop)
    await pause(1500)

    // Swap with the sibling above, then back with the knob.
    await siblingPage(panel).getByRole('button', { name: 'Swap with the page below' }).click()
    await expect.poll(() => pagesOnScreen(panel)).toEqual(['L 1', 'R 1.2'])
    await pause(3500)
    await siblingPage(panel).locator('.tree-sibling-knob').click()
    await expect.poll(() => pagesOnScreen(panel)).toEqual(['L 1', 'R 1.1'])
    await pause(3500)

    // Cmd+] / Cmd+[ slide the pages; the split never shrinks.
    await openQuestion(panel, SPLIT_TITLES.Q111)
    await expect.poll(() => pagesOnScreen(panel)).toEqual(['L 1.1', 'R 1.1.1'])
    await pause(1200)
    await rightComposer(panel).focus()
    await page.keyboard.press('Meta+BracketLeft')
    await expect.poll(() => pagesOnScreen(panel)).toEqual(['L 1', 'R 1.1'])
    await pause(1200)
    await page.keyboard.press('Meta+BracketLeft')
    await expect.poll(() => pagesOnScreen(panel)).toEqual(['L Main conversation', 'R 1'])
    await pause(1500)
  })
})
