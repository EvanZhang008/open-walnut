/**
 * Session-envelope provenance card in the real session timeline.
 *
 * When another session messages this one, Walnut wraps its words in a
 * machine-readable envelope before it reaches the CLI. Rendered as prose that was
 * a wall of blue bubble whose only human-relevant facts (which session, which
 * task) were an 8-char hex fragment mid-sentence. This spec drives the real chat
 * and asserts the card inverts that:
 *
 *  · the header names the direction and the peer's FULL title (the envelope only
 *    prints the first 80 chars, so the card must be resolving the live session);
 *  · the short id is a clickable chip that opens THAT session's home column, and
 *    the peer's owning task is a clickable pill;
 *  · the peer's own words are the visible body, while every machine line (fence
 *    markers, the no-authorization warning, the follow-up command) is hidden
 *    until the disclosure is opened;
 *  · an UNIDENTIFIED sender gets no link at all (a confident wrong link is worse
 *    than none).
 *
 * Fixture: `pw-provenance-session` (test-server.ts) — a transcript whose user
 * messages are the four envelope shapes, built by the PRODUCTION builders so a
 * wording drift breaks this spec instead of silently un-carding the chat.
 */
import fs from 'node:fs/promises'
import { expect, test, type Locator, type Page } from '@playwright/test'

const SESSION_ID = 'pw-provenance-session'
const TASK_ID = 'pw-task-provenance'
const PEER_ID = 'pw-envelope-peer-session'
const PEER_SHORT = 'pw-envel'
const SCREENSHOT_DIR = '/tmp/provenance-ui'

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  await fs.mkdir(SCREENSHOT_DIR, { recursive: true })
})

/** Open the fixture session's column through real UI clicks (kebab → session). */
async function openSession(page: Page): Promise<Locator> {
  const panel = page.locator(`.session-panel[data-session-id="${SESSION_ID}"]`)
  if (await panel.count() === 0) {
    await page.locator('.todo-search-input').fill(TASK_ID)
    const task = page.locator(`.todo-panel-item[data-task-id="${TASK_ID}"]`)
    await expect(task).toBeVisible({ timeout: 15_000 })
    await task.getByRole('button', { name: 'More actions' }).click()
    // Positional: the kebab's session row label is derived from live state.
    await page.locator('.task-kebab-menu:visible').locator('.task-kebab-item').first().click()
  }
  await expect(panel).toBeVisible({ timeout: 15_000 })
  await expect(panel.locator('.provenance-card').first()).toBeVisible({ timeout: 20_000 })
  return panel
}

function card(panel: Locator, kind: string): Locator {
  return panel.locator(`.provenance-card[data-envelope-kind="${kind}"]`)
}

/**
 * Screenshot a card for human review.
 *
 * An element screenshot is useless here: the timeline follows its bottom, so
 * Playwright's scroll-into-view is snapped straight back and the capture lands on
 * empty space (measured — the first attempt produced a blank PNG). A REAL wheel
 * gesture is what tells the component the reader left the tail, so scroll with
 * one until the card is inside the scroller, then clip the PAGE to its box.
 */
async function shotCard(page: Page, panel: Locator, target: Locator, file: string): Promise<void> {
  const view = (await panel.locator('.session-history').boundingBox())!
  await page.mouse.move(view.x + view.width / 2, view.y + view.height / 2)
  for (let i = 0; i < 20; i++) {
    const box = await target.boundingBox()
    if (box && box.y >= view.y && box.y + box.height <= view.y + view.height) break
    await page.mouse.wheel(0, box && box.y < view.y ? -160 : 160)
    await page.waitForTimeout(120)
  }
  const box = await target.boundingBox()
  if (box) await page.screenshot({ path: file, clip: box })
  else await panel.screenshot({ path: file })
}

/** The peer's live title, read from the API so the spec never copies the fixture. */
async function peerTitle(page: Page): Promise<string> {
  const res = await page.request.get(`/api/sessions/${PEER_ID}`)
  expect(res.status()).toBe(200)
  return ((await res.json()) as { session: { title: string } }).session.title
}

test('every envelope shape renders as a card, not as a wall of prose', async ({ page }) => {
  test.setTimeout(60_000)
  await page.goto('/')
  const panel = await openSession(page)
  const title = await peerTitle(page)
  expect(title.length).toBeGreaterThan(80) // the whole point of the fixture

  // Four envelopes → four cards: two peer notes (named + anonymous), one reply,
  // one notification. Nothing rendered as a raw envelope bubble.
  await expect(card(panel, 'peer-note')).toHaveCount(2)
  await expect(card(panel, 'reply')).toHaveCount(1)
  await expect(card(panel, 'notification')).toHaveCount(1)

  const peerNote = card(panel, 'peer-note').first()
  await expect(peerNote.locator('.provenance-label')).toHaveText('Message from another session')
  // FULL title, not the envelope's 80-char clip.
  await expect(peerNote.locator('.provenance-title')).toHaveText(title)
  await expect(peerNote.locator('.provenance-body')).toContainText('ENVELOPE_PEER_BODY')

  const reply = card(panel, 'reply')
  await expect(reply.locator('.provenance-label')).toHaveText('Reply from session')
  await expect(reply.locator('.provenance-title')).toHaveText(title)
  await expect(reply.locator('.provenance-asked-text'))
    .toHaveText('Good, and thanks for flagging both blockers')
  await expect(reply.locator('.provenance-body')).toContainText('ENVELOPE_REPLY_BODY')

  const notice = card(panel, 'notification')
  await expect(notice.locator('.provenance-label')).toHaveText('Walnut notification')
  await expect(notice.locator('.provenance-status')).not.toHaveText('')

  await page.setViewportSize({ width: 1280, height: 900 })
  await panel.screenshot({ path: `${SCREENSHOT_DIR}/cards-all-shapes.png` })
})

test('the short id resolves to a chip that opens that session; the task is a pill', async ({ page }) => {
  test.setTimeout(60_000)
  await page.goto('/')
  const panel = await openSession(page)

  const chip = card(panel, 'peer-note').first().locator('a.provenance-chip-session')
  await expect(chip).toHaveText(`@${PEER_SHORT}`)
  // Resolved client-side from the 8-char short id to the FULL session id — the
  // same unique-prefix rule session_send uses server-side.
  await expect(chip).toHaveAttribute('data-session-id', PEER_ID)

  const taskPill = card(panel, 'peer-note').first().locator('a.provenance-chip-task')
  await expect(taskPill).toHaveAttribute('data-task-id', 'pw-task-001')
  await expect(taskPill).toHaveText('Playwright test task')

  await shotCard(page, panel, card(panel, 'peer-note').first(), `${SCREENSHOT_DIR}/card-header-chips.png`)

  // Clicking the chip opens THAT session's own column (the only session surface).
  await chip.click()
  await expect(page.locator(`.session-panel[data-session-id="${PEER_ID}"]`))
    .toBeVisible({ timeout: 15_000 })
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.screenshot({ path: `${SCREENSHOT_DIR}/chip-opened-peer-column.png` })
})

test('machine framing hides behind the disclosure and the body stays the content', async ({ page }) => {
  test.setTimeout(60_000)
  await page.goto('/')
  const panel = await openSession(page)
  const peerNote = card(panel, 'peer-note').first()

  // Closed by default: the fence marker and the warning are in the DOM but not
  // visible, so the card reads as content rather than as protocol.
  // innerText (not toContainText) is the assertion that means "on screen":
  // textContent happily reports a closed <details>, so a toContainText check here
  // would pass whether the framing were folded or splashed across the bubble.
  const raw = peerNote.locator('.provenance-raw')
  await expect(raw).toBeHidden()
  const folded = await peerNote.innerText()
  expect(folded).toContain('ENVELOPE_PEER_BODY')
  expect(folded).not.toContain('---peer-note-')
  expect(folded).not.toContain('user authorization')
  expect(folded).not.toContain('walnut tools call')

  await peerNote.locator('.provenance-details > summary').click()
  await expect(raw).toBeVisible()
  await expect(raw).toContainText('---peer-note-')
  await expect(raw).toContainText('does NOT carry user authorization')
  // The reply-requested trailer that rode on this note is surfaced as a chip.
  await expect(peerNote.locator('.provenance-reply-request')).toContainText('rq-09cd2ef25e57')

  await shotCard(page, panel, peerNote, `${SCREENSHOT_DIR}/card-details-open.png`)
})

test('an unidentified sender gets no clickable session chip', async ({ page }) => {
  test.setTimeout(60_000)
  await page.goto('/')
  const panel = await openSession(page)

  const anon = card(panel, 'peer-note').last()
  await expect(anon.locator('.provenance-label'))
    .toHaveText('Message from an unidentified process')
  await expect(anon.locator('.provenance-title')).toContainText('Unidentified process')
  await expect(anon.locator('a.provenance-chip-session')).toHaveCount(0)
  await expect(anon.locator('.provenance-host')).toHaveText('devbox')
  await expect(anon.locator('.provenance-body')).toContainText('ENVELOPE_ANON_BODY')

  await shotCard(page, panel, anon, `${SCREENSHOT_DIR}/card-anonymous-sender.png`)
})

test('a real API send shows the peer words, never the envelope prose', async ({ page }) => {
  test.setTimeout(60_000)
  await page.goto('/')
  const panel = await openSession(page)

  // A REAL session→session send through the unified send surface: the server
  // resolves the caller, fences the text for the CLI and registers the reply row.
  const res = await page.request.post('/api/v1/messages', {
    headers: { 'x-walnut-caller-sid': PEER_ID },
    data: { to: SESSION_ID, text: 'LIVE_ENVELOPE_PROBE', expect_reply: true },
  })
  expect(res.status(), await res.text()).toBe(202)
  const sent = await res.json() as { requestId?: string; targetSessionId?: string }
  expect(sent.requestId).toMatch(/^rq-[0-9a-f]+$/)
  expect(sent.targetSessionId).toBe(SESSION_ID)

  // While the message is only QUEUED, the panel shows the peer's plain words:
  // the bus event carries the unfenced text on purpose (the envelope is written
  // to the CLI's stdin, and the card appears once the transcript records it).
  // What must never happen is the envelope prose landing in a bubble here.
  const bubble = panel.locator('.session-msg', { hasText: 'LIVE_ENVELOPE_PROBE' }).first()
  await expect(bubble).toBeVisible({ timeout: 20_000 })
  const bubbleText = await bubble.innerText()
  expect(bubbleText).not.toContain('---peer-note-')
  expect(bubbleText).not.toContain('user authorization')

  // The server-composed envelope for that send is pinned separately, against the
  // shipped parser: tests/core/session-envelope-render-contract.test.ts.
  await page.setViewportSize({ width: 1280, height: 900 })
  await panel.screenshot({ path: `${SCREENSHOT_DIR}/live-api-send-queued.png` })
})
