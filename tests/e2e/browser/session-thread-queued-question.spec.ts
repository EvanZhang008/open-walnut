/**
 * A question the CLI took mid-turn (2026-10-08, the user's real session, in
 * Conversation Mode): "why I ask this but question reply to this, also I asked
 * it before not response ever".
 *
 * The question was sent while a turn ran, so the CLI wrote no user line for it,
 * only a `queued_command` attachment holding the uuid it was sent under. Walnut
 * read the row by its synthetic `queue-…` id, which no anchor or meta names:
 * the question lost its number and title, took number 1 (the archived first
 * question's), and a follow-up typed in its card went out as `[Question Q1]`
 * and was filed under question 1. Its reply had been the tag and tool calls, yet
 * the card said `Answered`.
 *
 * Now: the server hands the sent uuid over (`sourceUuid`), the question keeps
 * its number, title and marks, its card says `No answer`, and a follow-up goes
 * out under its own number and is answered in its own card.
 *
 * Chromium and WebKit, on pw-threads-queued-session (threads-fixture.ts).
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import { openThreadsSession, resetThreadsFixture } from './threads-helpers'
import { QUEUED_PASSAGES, QUEUED_QUESTION, QUEUED_READY, QUEUED_SESSION, QUEUED_TASK, QUEUED_TITLES } from './threads-fixture'

async function shot(page: Page, name: string, target?: Locator): Promise<void> {
  const dir = `/tmp/q-misfile/e2e/${test.info().project.name}`
  await fs.mkdir(dir, { recursive: true })
  if (target) await target.screenshot({ path: `${dir}/${name}.png` })
  else await page.screenshot({ path: `${dir}/${name}.png` })
}

async function open(page: Page): Promise<Locator> {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.setViewportSize({ width: 1800, height: 800 })
  await page.addStyleTag({ content: `.main-page-session-column:has(.session-panel[data-session-id="${QUEUED_SESSION}"]) {
    flex: 0 0 1100px !important; width: 1100px !important; min-width: 1100px !important; max-width: 1100px !important; }` })
  return openThreadsSession(page, QUEUED_SESSION, QUEUED_TASK, QUEUED_READY, { view: 'linear' })
}

const highlightTexts = (page: Page, name: string) => page.evaluate((n) => {
  const h = CSS.highlights?.get(n)
  return h ? Array.from(h as unknown as Iterable<Range>).map((r) => r.toString()) : []
}, name)

test.describe('a question the CLI took mid-turn keeps its number, and its follow-up stays in it', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(180_000)

  test.beforeEach(async ({ request }) => {
    await resetThreadsFixture(request, QUEUED_SESSION)
  })

  test('number, title and status come from the sent uuid; a follow-up goes out as its own number', async ({ page }) => {
    // Every message the page sends over the socket, to read the banner the follow-up carries.
    const sent: string[] = []
    page.on('websocket', (ws) => ws.on('framesent', (f) => { if (typeof f.payload === 'string') sent.push(f.payload) }))
    const panel = await open(page)
    const map = panel.locator('.thread-map')
    const card = panel.locator('.thread-card')
    const threadRows = map.locator('.thread-map-row[data-kind="thread"]')

    // Question 1 is archived (folded), question 2 is the open one, under its own number and name.
    await expect(map.locator('.thread-map-row[data-kind="done-group"]')).toHaveText(/1 archived/)
    await expect(threadRows).toHaveCount(1)
    await expect(threadRows.nth(0).locator('.thread-map-label')).toHaveText(QUEUED_TITLES.Q2)
    await expect(threadRows.nth(0).locator('.thread-map-num')).toHaveText('2')
    // Its passage wears the open mark, question 1's the archived one.
    await expect.poll(() => highlightTexts(page, 'thread-mark-neutral')).toContain(QUEUED_PASSAGES.Q2)
    await expect.poll(() => highlightTexts(page, 'thread-mark-done-neutral')).toContain(QUEUED_PASSAGES.Q1)

    // Its card: number 2, its title, and `No answer` (the reply was the tag and tool calls).
    await threadRows.nth(0).click()
    await expect(card.locator('.thread-card-head .thread-map-num')).toHaveText('2')
    await expect(card.locator('.thread-card-title')).toHaveText(QUEUED_TITLES.Q2)
    await expect(card.locator('.thread-status-word')).toHaveAttribute('data-kind', 'failed')
    await expect(card.locator('.thread-status-word')).toHaveText('No answer')
    await expect(card.locator('.thread-card-body')).toContainText(QUEUED_QUESTION)
    await expect(card.locator('.thread-card-noanswer')).toHaveText('No answer')
    await shot(page, 'card-before', panel)

    // A follow-up from the card goes out under question 2 and is answered there.
    await card.locator('.thread-card-input').fill('slow:12000 And for a burst of retries?')
    await card.locator('.thread-card-input').press('Enter')
    await expect.poll(() => sent.some((f) => f.includes('[Question Q2]')), { timeout: 15_000 }).toBe(true)
    expect(sent.some((f) => f.includes('[Question Q1]')), 'no send is numbered as question 1').toBe(false)
    await expect(card).toHaveAttribute('data-answering', 'true', { timeout: 30_000 })
    await expect(threadRows.nth(0)).toHaveAttribute('data-status', 'answering')
    await expect(card.locator('.thread-card-body')).toContainText('processed your message', { timeout: 60_000 })
    await expect(card.locator('.thread-card-body')).toContainText('And for a burst of retries?')
    // The first turn still says it got no answer; the new one has its answer.
    await expect(card.locator('.thread-card-noanswer')).toHaveCount(1)
    await expect(map.locator('.thread-map-row[data-status="answering"]')).toHaveCount(0, { timeout: 30_000 })
    // Answered now: the status is not `No answer` any more; question 1 stays archived and folded.
    await expect(card.locator('.thread-status-word')).not.toHaveAttribute('data-kind', 'failed')
    await expect(map.locator('.thread-map-row[data-kind="done-group"]')).toHaveText(/1 archived/)
    await expect(threadRows).toHaveCount(1)
    await shot(page, 'card-after', panel)

    // Question 1's card holds nothing of it.
    await map.locator('.thread-map-row[data-kind="done-group"]').click()
    const q1 = map.locator('.thread-map-row[data-kind="thread"]', { hasText: QUEUED_TITLES.Q1 })
    await q1.click()
    await expect(card.locator('.thread-card-title')).toHaveText(QUEUED_TITLES.Q1)
    await expect(card.locator('.thread-card-head .thread-map-num')).toHaveText('1')
    await expect(card.locator('.thread-card-body')).not.toContainText('burst of retries')
    await expect(card.locator('.thread-card-body')).not.toContainText('processed your message')
  })
})
