/**
 * A question asked while the main conversation's turn runs is not answered by
 * that turn's reply (2026-11-03, the user: "this is not answer question of this
 * thread somehow consider as result of the thread").
 *
 * The main conversation's turn was building a page when the user asked a
 * question on a passage. Claude Code took the question mid-turn (at a tool
 * boundary) and the turn went on with its own work; its final reply, with no
 * `[Qn]` tag, showed in the question's card under "Answering…" as the answer,
 * and the main conversation lost it. Every reader took "the words after a
 * question's line" as its answer: the live owners (stream/chat-order.ts) and,
 * once the transcript landed, every row reader after tagged-reply-split.ts.
 *
 * Now a question taken mid-turn claims only the words under its own tag: the
 * turn's own reply stays in the main conversation, live, after the transcript
 * lands, and after a reload; a question the model did answer in the turn keeps
 * that answer.
 *
 * The mock CLI's `MOCK_TAKE_MIDTURN` takes a line sent during a slow turn the way
 * Claude Code does (lifecycle started, queued_command attachment), and
 * `MOCK_MIDTURN_ANSWER` in the question makes the model answer it inside its
 * `<walnut-ask-answer>` tag (the strict protocol, utils/ask-answer.ts).
 * Chromium and WebKit, on pw-threads-midturn-session (threads-fixture.ts).
 */
import { expect, type Locator, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import { centreInHistory, openThreadsSession, resetThreadsFixture, selectPassage, test } from './threads-helpers'
import { MIDTURN_PASSAGES, MIDTURN_READY, MIDTURN_SESSION, MIDTURN_TASK } from './threads-fixture'

async function shot(page: Page, name: string, target?: Locator): Promise<void> {
  const dir = `${process.env.WALNUT_TASK_DIR ?? '/tmp'}/midturn-main-reply/e2e/${test.info().project.name}`
  await fs.mkdir(dir, { recursive: true })
  if (target) await target.screenshot({ path: `${dir}/${name}.png` })
  else await page.screenshot({ path: `${dir}/${name}.png` })
}

async function open(page: Page, reload = false): Promise<Locator> {
  if (reload) await page.reload()
  else await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.setViewportSize({ width: 1800, height: 900 })
  await page.addStyleTag({ content: `.main-page-session-column:has(.session-panel[data-session-id="${MIDTURN_SESSION}"]) {
    flex: 0 0 1100px !important; width: 1100px !important; min-width: 1100px !important; max-width: 1100px !important; }
    .notification-toaster { display: none !important; }` })
  return openThreadsSession(page, MIDTURN_SESSION, MIDTURN_TASK, MIDTURN_READY, { view: 'linear' })
}

const card = (panel: Locator) => panel.locator('.thread-card')
const composer = (panel: Locator) => panel.locator('.chat-input-textarea').first()

/** The main chat shows `text` on screen (not inside a question's card). */
function mainChatShows(panel: Locator, text: string): Promise<boolean> {
  return panel.evaluate((root, needle) => {
    const box = root.querySelector('.session-history')
    if (!box) return false
    const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement
      if (!el || !(n as Text).data.includes(needle)) continue
      if (el.closest('.thread-card, .thread-card-layer, .thread-review-sidebar')) continue
      if (el.getClientRects().length > 0) return true
    }
    return false
  }, text)
}

async function sendMain(panel: Locator, text: string): Promise<void> {
  const box = composer(panel)
  await box.click()
  await box.fill(text)
  await box.press('Enter')
  await expect(box).toHaveValue('')
  // The turn runs: the composer offers Stop.
  await expect(panel.locator('.chat-stop-btn-icon').first()).toBeVisible({ timeout: 30_000 })
}

/** Ask on `passage` from Conversation Mode while the turn runs; the card opens beside it. */
async function askWhileRunning(page: Page, panel: Locator, passage: string, question: string): Promise<void> {
  await centreInHistory(page, panel, passage)
  await selectPassage(page, panel, passage)
  await page.locator('[data-testid="quote-pin-pill"] [data-testid="quote-ask-btn"]').click()
  await expect(card(panel)).toBeVisible()
  const input = card(panel).locator('.thread-card-input')
  await input.fill(question)
  await input.press('Enter')
  await expect(input).toHaveValue('')
  // Still the main turn running: the question went to the CLI mid-turn.
  await expect(panel.locator('.chat-stop-btn-icon').first()).toBeVisible()
}

/** The card of the question asked on `passage`, opened from its mark. */
async function openCardOf(page: Page, panel: Locator, passage: string): Promise<void> {
  if (await card(panel).count() > 0 && (await card(panel).locator('.thread-card-body').innerText()).includes(passage.slice(0, 20))) return
  await centreInHistory(page, panel, passage)
  const rects = await panel.evaluate((root, needle) => {
    for (const body of Array.from(root.querySelectorAll('.session-history [data-message-id] .session-msg-content'))) {
      const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT)
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const at = (n as Text).data.indexOf(needle)
        if (at < 0) continue
        const r = document.createRange()
        r.setStart(n, at)
        r.setEnd(n, at + needle.length)
        const b = r.getClientRects()[0]
        return b ? { x: b.left + 8, y: b.top + b.height / 2 } : null
      }
    }
    return null
  }, passage)
  expect(rects, `passage "${passage}" on screen`).not.toBeNull()
  await page.mouse.click(rects!.x, rects!.y)
  await expect(card(panel)).toBeVisible()
}

test.describe('a question taken mid-turn is not answered by the main turn\'s reply', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(240_000)

  test.beforeEach(async ({ request }) => {
    await resetThreadsFixture(request, MIDTURN_SESSION)
  })

  test('no tag: the reply stays in the main chat, live, after the turn and after a reload; the question waits for its answer', async ({ page }) => {
    const MAIN = 'Rebuild the guide page.'
    const REPLY = `processed your message: ${MAIN}`
    const QUESTION = 'Can a pod use an account from another namespace?'
    const panel = await open(page)
    await sendMain(panel, `slow:14000 MOCK_TAKE_MIDTURN ${MAIN}`)
    await askWhileRunning(page, panel, MIDTURN_PASSAGES.ASK, QUESTION)
    const body = card(panel).locator('.thread-card-body')
    await expect(body).toContainText(QUESTION)
    await shot(page, '1-asked', panel)

    // The main turn's reply lands: in the main chat, never in the card.
    await expect(panel.locator('.session-history')).toContainText(REPLY, { timeout: 60_000 })
    await shot(page, '2-landed', panel)
    await expect(body).not.toContainText(REPLY)
    await expect.poll(() => mainChatShows(panel, REPLY), { timeout: 10_000 }).toBe(true)
    await expect(panel.locator('.chat-stop-btn-icon')).toHaveCount(0, { timeout: 30_000 })
    // The transcript is read again at the turn's end: still the main chat's, and
    // the question still waits for its tagged answer (a strict question,
    // utils/ask-answer.ts: never "Answered" over "No answer").
    for (let i = 0; i < 4; i++) {
      await page.waitForTimeout(1_000)
      expect(await mainChatShows(panel, REPLY), 'the reply stays in the main chat').toBe(true)
      await expect(body).not.toContainText(REPLY)
    }
    await expect(card(panel).locator('.thread-status-word')).toHaveAttribute('data-kind', 'waiting', { timeout: 30_000 })
    await expect(card(panel).locator('.thread-card-noanswer')).toHaveText('Waiting for its answer…')
    await shot(page, '3-no-answer', panel)

    // A reload reads the transcript only.
    const again = await open(page, true)
    await expect.poll(() => mainChatShows(again, REPLY), { timeout: 30_000 }).toBe(true)
    await openCardOf(page, again, MIDTURN_PASSAGES.ASK)
    await expect(card(again).locator('.thread-card-body')).toContainText(QUESTION)
    await expect(card(again).locator('.thread-card-body')).not.toContainText(REPLY)
    await expect(card(again).locator('.thread-status-word')).toHaveAttribute('data-kind', 'waiting')
    await shot(page, '4-reload', again)
  })

  test('its own tag: the part under it is the question\'s answer, the turn\'s reply stays in the main chat', async ({ page }) => {
    const MAIN = 'Check the admission rules.'
    const REPLY = `processed your message: ${MAIN}`
    const QUESTION = 'When does the check run?'
    const ANSWER = `Mid-turn answer: ${QUESTION}`
    const panel = await open(page)
    await sendMain(panel, `slow:14000 MOCK_TAKE_MIDTURN ${MAIN}`)
    await askWhileRunning(page, panel, MIDTURN_PASSAGES.ASK2, `MOCK_MIDTURN_ANSWER ${QUESTION}`)
    const body = card(panel).locator('.thread-card-body')
    // Answered in the turn, under its tag: the card holds it, the main chat does not.
    await expect(body).toContainText(ANSWER, { timeout: 30_000 })
    expect(await mainChatShows(panel, ANSWER)).toBe(false)
    await shot(page, '5-tag-answer', panel)

    // The turn's own reply after it is the main chat's.
    await expect.poll(() => mainChatShows(panel, REPLY), { timeout: 60_000 }).toBe(true)
    await expect(body).not.toContainText(REPLY)
    await expect(body).toContainText(ANSWER)
    await expect(panel.locator('.chat-stop-btn-icon')).toHaveCount(0, { timeout: 30_000 })
    for (let i = 0; i < 4; i++) {
      await page.waitForTimeout(1_000)
      expect(await mainChatShows(panel, REPLY), 'the reply stays in the main chat').toBe(true)
      await expect(body).not.toContainText(REPLY)
      await expect(body).toContainText(ANSWER)
    }
    await expect(card(panel).locator('.thread-status-word')).not.toHaveAttribute('data-kind', 'failed')
    await shot(page, '6-tag-landed', panel)

    const again = await open(page, true)
    await expect.poll(() => mainChatShows(again, REPLY), { timeout: 30_000 }).toBe(true)
    expect(await mainChatShows(again, ANSWER)).toBe(false)
    await openCardOf(page, again, MIDTURN_PASSAGES.ASK2)
    await expect(card(again).locator('.thread-card-body')).toContainText(ANSWER)
    await expect(card(again).locator('.thread-card-body')).not.toContainText(REPLY)
    await shot(page, '7-tag-reload', again)
  })
})
