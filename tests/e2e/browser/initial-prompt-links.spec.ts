/**
 * The pinned "Initial Prompt" bubble renders the user's text as markdown, the
 * same way every other user bubble does, so a URL typed into the first prompt
 * is a clickable link there too.
 *
 * Report (2026-10-01): a session started with a prompt holding a ticket URL; the
 * conversation grew past the render window, the first turn folded into the
 * pinned bubble, and that bubble printed the URL as plain text while the same
 * URL in any later bubble was a link. The bubble used to render the raw string.
 *
 * Fixture: pw-vscode-session's first user turn carries a bare URL and a code
 * span, followed by 60+ rows so the pinned bubble actually appears.
 */
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { test, expect, type Page } from '@playwright/test'

const SESSION_ID = 'pw-vscode-session'
const TASK_ID = 'pw-task-vscode'
const TICKET_URL = 'https://example.com/tickets/326fd366-3c61-4fe0-a167-377fbc8783cd'
const SHOTS = process.env.INITIAL_PROMPT_SHOT_DIR ?? '/tmp/initial-prompt-links'

/** Open the fixture session's panel from the homepage (real clicks, no page.goto).
 *  Generous timeouts: search is debounced and this machine runs several agents. */
async function openSessionPanel(page: Page) {
  const search = page.locator('.todo-search-input')
  await expect(search).toBeVisible({ timeout: 30_000 })
  await search.fill(SESSION_ID)
  const task = page.locator(`.todo-panel-item[data-task-id="${TASK_ID}"]`)
  await expect(task).toBeVisible({ timeout: 20_000 })
  await task.locator('.todo-item-title').click()
  const panel = page.locator(`.session-panel[data-session-id="${SESSION_ID}"]`)
  await expect(panel).toBeVisible({ timeout: 20_000 })
  return panel
}

test.describe('pinned Initial Prompt bubble', () => {
  test('a URL in the first prompt is a link that opens in a new tab', async ({ page, context }, testInfo) => {
    test.setTimeout(90_000)
    // Never reach the real internet from a test: answer example.com locally.
    await context.route('https://example.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>stub</title>ok' }))
    await page.goto('/')
    await page.waitForLoadState('domcontentloaded')
    const panel = await openSessionPanel(page)

    const bubble = panel.locator('.session-initial-prompt')
    await expect(bubble).toBeVisible({ timeout: 30_000 })
    await expect(bubble).toContainText('Where did you put the notes?')

    // The URL is an anchor, not text: same renderer as the full bubble, so the
    // external-link contract (new tab, no opener) holds here too.
    const link = bubble.locator(`a[href="${TICKET_URL}"]`)
    await expect(link).toBeVisible()
    await expect(link).toHaveAttribute('target', '_blank')
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer')

    // Markdown semantics apply to the whole prompt, not just the URL.
    await expect(bubble.locator('code', { hasText: 'release-notes' })).toBeVisible()
    // Evidence shot: the pinned bubble sits at the TOP of a timeline that opens
    // scrolled to the bottom, so scroll the timeline up and shoot the scroller
    // itself (an element shot of a row outside the scroller's viewport is blank).
    // The timeline only honours a scroll away from the bottom that follows real
    // input (its echo guard snaps a bare scrollTop write back), so a pointer tap
    // in the middle of the scroller stands in for the reader's hand on the wheel.
    mkdirSync(SHOTS, { recursive: true })
    const history = panel.locator('.session-history')
    const hb = await history.boundingBox()
    if (!hb) throw new Error('timeline has no box')
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2)
    await page.mouse.down()
    await page.mouse.up()
    await history.evaluate((el) => { el.scrollTop = 0 })
    // Evidence only, never a verdict: the link assertions above are the test.
    await page.waitForTimeout(300)
    await history.screenshot({ path: path.join(SHOTS, `bubble-${testInfo.project.name}.png`) })

    const before = page.url()
    const [popup] = await Promise.all([
      context.waitForEvent('page', { timeout: 10_000 }),
      link.click(),
    ])
    expect(popup.url()).toContain('example.com/tickets/326fd366')
    await popup.close()
    // The console itself did not navigate.
    expect(page.url()).toBe(before)
    await expect(panel).toBeVisible()
  })
})
