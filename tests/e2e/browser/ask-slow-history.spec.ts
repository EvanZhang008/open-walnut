/**
 * A new ask shows its reply as it streams, however slow the history read is.
 *
 * 2026-11-08, the user: "ask walnut is broken". A new ask from the Ask Walnut
 * slot on a loaded Mac: its history reads took 15 to 45 s on the server, the CLI
 * answered both of the user's messages within seconds, the browser received
 * every text delta, and the slot showed only the two questions under "Claude
 * Code is working... 23s" until the history read came back.
 *
 * Every history read here is held HOLD_MS, so all a reply can come through is
 * the live stream. Real UI, real daemon, the mock CLI (it answers
 * `I processed your message: <prompt>`).
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import { loadHome, openAskWalnutDrawer, openChatOnLoad } from './draft-helpers'

const STAMP = Date.now().toString(36)
const FIRST = `slow history hello ${STAMP}`
const SECOND = `slow history second ${STAMP}`
const replyTo = (prompt: string): string => `I processed your message: ${prompt}`
const HOLD_MS = 40_000
/** How long a streamed reply may take to show: far under HOLD_MS. */
const SHOWN_WITHIN_MS = 15_000
const SHOT_DIR = process.env.ASK_SLOW_SHOT_DIR ?? '/tmp/ask-slow-history'

test.describe.configure({ mode: 'serial' })
test.setTimeout(180_000)

const slotSession = (page: Page): Locator => page.locator('[data-testid="ask-walnut-session"]')
const slotDraftComposer = (page: Page): Locator =>
  page.locator('[data-testid="ask-walnut-draft"]').locator('.chat-input-textarea')

/** Hold every history read of every session HOLD_MS, then let it through.
 *  Returns the count of reads that came back. */
async function holdHistory(page: Page): Promise<() => number> {
  let answered = 0
  await page.route('**/api/sessions/*/history**', async (route) => {
    await new Promise((r) => setTimeout(r, HOLD_MS))
    await route.fallback().catch(() => {})
    answered++
  })
  return () => answered
}

test.beforeEach(async ({ page }) => { await openChatOnLoad(page) })

test('a new ask streams both replies while every history read hangs', async ({ page }) => {
  const answered = await holdHistory(page)
  await loadHome(page)
  await openAskWalnutDrawer(page)
  await page.locator('[data-testid="ask-walnut-new"]').click()

  const composer = slotDraftComposer(page)
  await expect(composer).toBeVisible({ timeout: 30_000 })
  const quickStart = page.waitForResponse((r) => r.request().method() === 'POST'
    && new URL(r.url()).pathname === '/api/sessions/quick-start')
  await composer.fill(FIRST)
  await composer.press('Enter')
  const launch = await quickStart
  expect(launch.status(), await launch.text()).toBe(200)
  const { sessionId } = (await launch.json()) as { sessionId: string }
  await expect(slotSession(page)).toHaveAttribute('data-session-id', sessionId, { timeout: 30_000 })

  // The first reply shows from the stream, long before any history read answers.
  await expect(slotSession(page).getByText(replyTo(FIRST)).first()).toBeVisible({ timeout: SHOWN_WITHIN_MS })
  expect(answered(), 'a history read answered, so the stream was not what showed the reply').toBe(0)

  // The second message, still before any history answer: its reply streams in too,
  // and the first reply stays on screen while the second turn runs.
  const sessionComposer = slotSession(page).locator('.chat-input-textarea')
  await sessionComposer.fill(SECOND)
  await sessionComposer.press('Enter')
  await expect(slotSession(page).getByText(replyTo(SECOND)).first()).toBeVisible({ timeout: SHOWN_WITHIN_MS })
  await expect(slotSession(page).getByText(replyTo(FIRST)).first()).toBeVisible()
  expect(answered(), 'a history read answered before the second reply showed').toBe(0)
  await page.screenshot({ path: `${SHOT_DIR}/both-replies-before-history.png` })

  // Once a history read of this session came back and merged, each reply is there exactly once.
  await page.waitForResponse((r) => r.url().includes(`/api/sessions/${sessionId}/history`) && r.status() === 200,
    { timeout: HOLD_MS + 30_000 })
  await page.waitForTimeout(1500)
  await expect.poll(async () => {
    const text = (await slotSession(page).locator('.session-history').first().textContent()) ?? ''
    return [text.split(replyTo(FIRST)).length - 1, text.split(replyTo(SECOND)).length - 1]
  }, { timeout: HOLD_MS + 30_000 }).toEqual([1, 1])
})
