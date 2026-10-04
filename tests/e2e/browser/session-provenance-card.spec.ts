/**
 * Session-envelope provenance card in the real session timeline.
 *
 * When another session messages this one, Walnut wraps its words in a
 * machine-readable envelope before it reaches the CLI. Rendered as raw text that
 * was a wall of blue bubble whose only human-relevant facts (which session, which
 * task) were an 8-char fragment inside framing. This spec drives the real chat
 * and asserts the card inverts that:
 *
 *  · the header names the direction and the peer's FULL title (the envelope only
 *    prints the first 80 chars, so the card must be resolving the live session);
 *  · the short id is a clickable chip that opens THAT session's home column, and
 *    the peer's owning task is a clickable pill;
 *  · the peer's own words are the visible body, while every machine line (the tag
 *    itself, the no-authorization note, the reply command) is hidden until the
 *    disclosure is opened;
 *  · an UNIDENTIFIED sender gets no link at all (a confident wrong link is worse
 *    than none).
 *
 * Fixture: `pw-provenance-session` (test-server.ts) — a transcript whose user
 * messages are the v2 `<walnut-message …>` kinds, built by the PRODUCTION builders
 * so a wording drift breaks this spec instead of silently un-carding the chat,
 * plus ONE frozen pre-v2 prose envelope: immutable JSONL history means the card's
 * legacy path must keep working, so it keeps being driven here.
 */
import fs from 'node:fs/promises'
import { expect, test, type Locator, type Page } from '@playwright/test'

const SESSION_ID = 'pw-provenance-session'
const TASK_ID = 'pw-task-provenance'
const PEER_ID = 'pw-envelope-peer-session'
const PEER_SHORT = 'pw-envel'
const SCREENSHOT_DIR = '/tmp/wn-envelope-v2/provenance-ui'

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  await fs.mkdir(SCREENSHOT_DIR, { recursive: true })
})

/** Open the fixture session's column through real UI clicks (kebab → session). */
async function openSession(page: Page): Promise<Locator> {
  const panel = page.locator(`.session-panel[data-session-id="${SESSION_ID}"]`)
  if (await panel.count() === 0) {
    const task = page.locator(`.todo-panel-item[data-task-id="${TASK_ID}"]`)
    // A fill that lands while the board is still hydrating can be reset; type again until it holds.
    await expect(async () => {
      await page.locator('.todo-search-input').fill(TASK_ID)
      await expect(task).toBeVisible({ timeout: 3_000 })
    }).toPass({ timeout: 30_000 })
    // Click the row's title: the task menu has no open-session row.
    await task.locator('.todo-item-title').click()
  }
  await expect(panel).toBeVisible({ timeout: 15_000 })
  await expect(panel.locator('.provenance-card').first()).toBeVisible({ timeout: 20_000 })
  return panel
}

function card(panel: Locator, kind: string): Locator {
  return panel.locator(`.provenance-card[data-envelope-kind="${kind}"]`)
}

/** The v2 tag envelope (first in the transcript). */
function v2PeerNote(panel: Locator): Locator {
  return card(panel, 'peer-note').first()
}

/** The frozen pre-v2 prose envelope, pinned by its folded title (the first
 *  sentence of its body): it is no longer the last peer note (the Claude Code
 *  native card follows it), and a legacy card carries no `data-envelope-source`
 *  (absent means Walnut). */
function legacyPeerNote(panel: Locator): Locator {
  return card(panel, 'peer-note').filter({ hasText: "last August's note." })
}

/** Claude Code's own cross-session delivery, pinned by source. */
function nativePeerNote(panel: Locator): Locator {
  return panel.locator('.provenance-card[data-envelope-source="claude-code"]')
}

/** Pinned by the attribute, not by position: an anonymous card has no id to name. */
function anonPeerNote(panel: Locator): Locator {
  return panel.locator('.provenance-card[data-envelope-kind="peer-note"][data-anonymous="true"]')
}

/**
 * Bring a card inside the timeline's scroller.
 *
 * The timeline follows its bottom, so Playwright's scroll-into-view is snapped
 * straight back (measured: the first screenshot attempt produced a blank PNG,
 * and a click on a card above the fold never lands). A REAL wheel gesture is
 * what tells the component the reader left the tail, so wheel until the card is
 * in view. Headless WebKit honours only the first synthetic wheel, so once that
 * one has released the tail, finish by setting the scroller's scrollTop.
 */
async function revealCard(page: Page, panel: Locator, target: Locator): Promise<void> {
  const scroller = panel.locator('.session-history')
  const view = (await scroller.boundingBox())!
  const inView = async () => {
    const box = await target.boundingBox()
    return Boolean(box && box.y >= view.y && box.y + box.height <= view.y + view.height)
  }
  await page.mouse.move(view.x + view.width / 2, view.y + view.height / 2)
  for (let i = 0; i < 20 && !(await inView()); i++) {
    const box = await target.boundingBox()
    await page.mouse.wheel(0, box && box.y < view.y ? -160 : 160)
    await page.waitForTimeout(120)
  }
  if (await inView()) return
  await target.evaluate((el) => {
    const history = el.closest('.session-history')
    if (!history) return
    const offset = el.getBoundingClientRect().top - history.getBoundingClientRect().top
    history.scrollTop += offset - 8
  })
  await expect.poll(inView, { timeout: 5_000 }).toBe(true)
}

/** Screenshot a card for human review: reveal it, then clip the PAGE to its box. */
async function shotCard(page: Page, panel: Locator, target: Locator, file: string): Promise<void> {
  await revealCard(page, panel, target).catch(() => {})
  const box = await target.boundingBox()
  if (box) await page.screenshot({ path: file, clip: box })
  else await panel.screenshot({ path: file })
}

/** Open a folded card: its who + title line is the toggle. */
async function openCard(page: Page, panel: Locator, target: Locator): Promise<void> {
  const fold = target.locator('.provenance-fold').first()
  await revealCard(page, panel, fold)
  await fold.click()
  await expect(fold).toHaveAttribute('aria-expanded', 'true')
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

  // Eight envelopes → eight cards: four peer notes (v2 named, v2 anonymous, one
  // legacy prose, one Claude Code native), one reply, two notifications (a request
  // fallback and a subtask status notice), one trigger fire. None rendered as a raw bubble.
  await expect(card(panel, 'peer-note')).toHaveCount(4)
  await expect(card(panel, 'reply')).toHaveCount(1)
  await expect(card(panel, 'notification')).toHaveCount(2)

  // Every card starts FOLDED to who + title: no session's words are on screen yet.
  await expect(panel.locator('.provenance-card[data-folded="true"]')).toHaveCount(10)
  await expect(panel.locator('.provenance-card[data-folded="false"]')).toHaveCount(0)
  await expect(panel.locator('.provenance-body')).toHaveCount(0)
  await page.setViewportSize({ width: 1280, height: 900 })
  await panel.screenshot({ path: `${SCREENSHOT_DIR}/cards-all-folded.png` })

  const peerNote = v2PeerNote(panel)
  await expect(peerNote).toHaveAttribute('data-envelope-source', 'walnut')
  await expect(peerNote.locator('.provenance-fold-dir')).toHaveText('From')
  // Who: the sender's task; its FULL session title (not the envelope's 80-char clip) is the tooltip.
  await expect(peerNote.locator('.provenance-fold-sender')).toHaveText('Playwright test task')
  await expect(peerNote.locator('.provenance-fold-sender')).toHaveAttribute('title', title)
  // What: the title the sender gave.
  await expect(peerNote.locator('.provenance-fold-title')).toHaveText('Proxy restarted clean, daemon on 2.1.255')
  await openCard(page, panel, peerNote)
  await expect(peerNote).toHaveAttribute('data-folded', 'false')
  await expect(peerNote.locator('.provenance-body')).toContainText('ENVELOPE_PEER_BODY')

  // The pre-v2 prose still cards; with no title its first sentence stands in.
  const legacy = legacyPeerNote(panel)
  await expect(legacy.locator('.provenance-fold-sender')).toHaveText('Playwright test task')
  await expect(legacy.locator('.provenance-fold-title')).toHaveText("last August's note.")
  await openCard(page, panel, legacy)
  await expect(legacy.locator('.provenance-body')).toContainText('ENVELOPE_LEGACY_BODY')

  const reply = card(panel, 'reply')
  await expect(reply.locator('.provenance-fold-dir')).toHaveText('Reply from')
  await expect(reply.locator('.provenance-fold-title')).toHaveText('Both blockers cleared')
  await openCard(page, panel, reply)
  await expect(reply.locator('.provenance-asked-text'))
    .toHaveText('Good, and thanks for flagging both blockers')
  await expect(reply.locator('.provenance-body')).toContainText('ENVELOPE_REPLY_BODY')

  const notice = card(panel, 'notification').filter({ hasText: 'WITHOUT an explicit reply' })
  await expect(notice).toHaveCount(1)
  await expect(notice.locator('.provenance-fold-dir')).toHaveText('Walnut, about')
  // A notice folds to the first sentence of its outcome; open, the whole outcome reads.
  await expect(notice.locator('.provenance-fold-title'))
    .toHaveText('It marked its task COMPLETE WITHOUT an explicit reply to your request.')
  await openCard(page, panel, notice)
  await expect(notice.locator('.provenance-status')).toHaveText('It marked its task COMPLETE WITHOUT an explicit reply '
    + 'to your request. Its last message and the actions after it are quoted below.')
  // "Quoted below" is true on screen: the child's words (markdown), then the calls
  // after them as plain one-line rows; the Next: commands stay in the disclosure.
  const quotes = notice.locator('.provenance-quote')
  await expect(quotes).toHaveCount(2)
  await expect(quotes.nth(0).locator('.provenance-quote-label')).toHaveText('Its last message')
  await expect(quotes.nth(0).locator('.provenance-body strong')).toHaveText('green')
  await expect(quotes.nth(0).locator('.provenance-body')).toContainText('ENVELOPE_NOTICE_QUOTE')
  await expect(quotes.nth(1).locator('.provenance-quote-label')).toHaveText('Its actions after that message')
  const actions = quotes.nth(1).locator('.provenance-actions li')
  await expect(actions).toHaveText(['Write: /repo/marina/NOTES.md', /^Bash: run the long verification suite/])
  // A long call stays one row (ellipsis) inside the card; its full text is the row's title.
  const cardBox = (await notice.boundingBox())!
  const longRow = actions.nth(1)
  const rowBox = (await longRow.boundingBox())!
  expect(rowBox.height).toBeLessThanOrEqual(20)
  expect(rowBox.x + rowBox.width).toBeLessThanOrEqual(cardBox.x + cardBox.width + 0.5)
  await expect(longRow).toHaveAttribute('title', /run the long verification suite$/)

  // A subtask's status notice has no request behind it: the same card, the status
  // line says what happened and who started the turn, the child's words are the
  // one quote, and the child's session resolves to its full title and a chip.
  const subtask = card(panel, 'notification').filter({ hasText: 'Stopped without completing' })
  await expect(subtask).toHaveCount(1)
  await expect(subtask.locator('.provenance-fold-sender')).toHaveText('Playwright test task')
  await expect(subtask.locator('.provenance-fold-sender')).toHaveAttribute('title', title)
  // The sender line names the child, so the title is the outcome alone, even under a long task title.
  await expect(subtask.locator('.provenance-fold-title'))
    .toHaveText('Stopped without completing its task; its last turn was started by the user.')
  await openCard(page, panel, subtask)
  await expect(subtask.locator('.provenance-status')).toContainText('stopped without completing its task; '
    + 'its last turn was started by the user. It is waiting for input. Its last message is quoted below.')
  await expect(subtask.locator('.provenance-quote')).toHaveCount(1)
  await expect(subtask.locator('.provenance-quote .provenance-body')).toContainText('ENVELOPE_SUBTASK_QUOTE')
  await expect(subtask.locator('a.provenance-chip-session')).toHaveCount(1)
  expect(await subtask.innerText()).not.toContain('<walnut-message')

  // A walnut-trigger fire comes from a routine, not a session: the card names the
  // routine, shows the daemon's "fired …, N new items" line, keeps the delivery
  // (prompt + items JSON + input) as the body, and offers no session chip.
  const fire = card(panel, 'trigger')
  await expect(fire).toHaveCount(1)
  await expect(fire.locator('.provenance-fold-dir')).toHaveText('Trigger')
  await expect(fire.locator('.provenance-fold-sender')).toHaveText('PR comments')
  await expect(fire.locator('.provenance-fold-title')).toHaveText(/^fired 20\d\d-.*, 2 new items$/)
  await openCard(page, panel, fire)
  await expect(fire.locator('.provenance-body')).toContainText('ENVELOPE_TRIGGER_BODY')
  await expect(fire.locator('.provenance-body')).toContainText('"id": "c1"')
  await expect(fire.locator('.provenance-body')).toContainText('two threads')
  await expect(fire.locator('a.provenance-chip-session')).toHaveCount(0)
  const fireText = await fire.innerText()
  expect(fireText).not.toContain('<walnut-message')

  await panel.screenshot({ path: `${SCREENSHOT_DIR}/cards-all-shapes.png` })
  await shotCard(page, panel, fire, `${SCREENSHOT_DIR}/card-trigger-fire.png`)
  await shotCard(page, panel, notice, `${SCREENSHOT_DIR}/card-notification-quote.png`)
  await shotCard(page, panel, subtask, `${SCREENSHOT_DIR}/card-subtask-notice.png`)
})

test('a folded card is two short lines, opens and closes by click or keyboard, and only itself', async ({ page }) => {
  test.setTimeout(60_000)
  await page.goto('/')
  const panel = await openSession(page)
  const reply = card(panel, 'reply')
  const peerNote = v2PeerNote(panel)
  const fold = reply.locator('.provenance-fold')

  await revealCard(page, panel, fold)
  // Who + title: two lines, nothing else.
  const folded = (await reply.boundingBox())!
  expect(folded.height).toBeLessThanOrEqual(72)
  await expect(fold).toHaveAttribute('aria-expanded', 'false')

  await fold.click()
  await expect(reply).toHaveAttribute('data-folded', 'false')
  await expect(reply.locator('.provenance-body')).toContainText('ENVELOPE_REPLY_BODY')
  expect((await reply.boundingBox())!.height).toBeGreaterThan(folded.height + 40)
  // Opening one card opens nothing else.
  await expect(peerNote).toHaveAttribute('data-folded', 'true')
  await expect(panel.locator('.provenance-card[data-folded="false"]')).toHaveCount(1)
  await shotCard(page, panel, reply, `${SCREENSHOT_DIR}/card-reply-open.png`)

  // A chip inside the open card is a link, not the toggle.
  await expect(reply.locator('a.provenance-chip-session')).toHaveAttribute('data-session-id', PEER_ID)

  await fold.click()
  await expect(reply).toHaveAttribute('data-folded', 'true')
  await expect(reply.locator('.provenance-body')).toHaveCount(0)

  // The keyboard reaches the same toggle, twice in a row.
  await fold.focus()
  await page.keyboard.press('Enter')
  await expect(reply).toHaveAttribute('data-folded', 'false')
  await page.keyboard.press('Space')
  await expect(reply).toHaveAttribute('data-folded', 'true')
  await shotCard(page, panel, reply, `${SCREENSHOT_DIR}/card-reply-folded.png`)
})

test('the short id resolves to a chip that opens that session; the task is a pill', async ({ page }) => {
  test.setTimeout(60_000)
  await page.goto('/')
  const panel = await openSession(page)
  await openCard(page, panel, v2PeerNote(panel))
  await openCard(page, panel, legacyPeerNote(panel))

  const chip = v2PeerNote(panel).locator('a.provenance-chip-session')
  await expect(chip).toHaveText(`@${PEER_SHORT}`)
  await expect(chip).toHaveAttribute('data-session-id', PEER_ID)

  const taskPill = v2PeerNote(panel).locator('a.provenance-chip-task')
  await expect(taskPill).toHaveAttribute('data-task-id', 'pw-task-001')
  await expect(taskPill).toHaveText('Playwright test task')

  // The legacy shape prints ONLY the 8-char short id, so its chip proves the
  // unique-prefix resolution path (the same rule session_send uses server-side)
  // still turns a fragment into the full session the card links to.
  const legacyChip = legacyPeerNote(panel).locator('a.provenance-chip-session')
  await expect(legacyChip).toHaveText(`@${PEER_SHORT}`)
  await expect(legacyChip).toHaveAttribute('data-session-id', PEER_ID)

  await shotCard(page, panel, v2PeerNote(panel), `${SCREENSHOT_DIR}/card-header-chips.png`)

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
  const peerNote = v2PeerNote(panel)

  // Closed by default: the tag and its note attribute are in the DOM but not
  // visible, so the card reads as content rather than as protocol.
  // innerText (not toContainText) is the assertion that means "on screen":
  // textContent happily reports a closed <details>, so a toContainText check here
  // would pass whether the framing were folded or splashed across the bubble.
  const raw = peerNote.locator('.provenance-raw')
  await expect(raw).toBeHidden()
  const folded = await peerNote.innerText()
  expect(folded).not.toContain('ENVELOPE_PEER_BODY')
  expect(folded).not.toContain('<walnut-message')
  expect(folded).not.toContain('user authorization')
  await openCard(page, panel, peerNote)
  await expect(raw).toBeHidden()
  const opened = await peerNote.innerText()
  expect(opened).toContain('ENVELOPE_PEER_BODY')
  expect(opened).not.toContain('<walnut-message')
  expect(opened).not.toContain('user authorization')
  expect(opened).not.toContain('walnut tools call')

  // The first card sits above the fold once the cards below it are tall.
  await revealCard(page, panel, peerNote.locator('.provenance-details > summary'))
  await peerNote.locator('.provenance-details > summary').click()
  await expect(raw).toBeVisible()
  await expect(raw).toContainText('<walnut-message kind="peer-note"')
  await expect(raw).toContainText('carries no user authorization')
  // The trailer line that rode on this note is surfaced as a chip.
  await expect(peerNote.locator('.provenance-reply-request')).toContainText('rq-09cd2ef25e57')

  await shotCard(page, panel, peerNote, `${SCREENSHOT_DIR}/card-details-open.png`)
})

test('the legacy prose envelope folds its fence away just the same', async ({ page }) => {
  test.setTimeout(60_000)
  await page.goto('/')
  const panel = await openSession(page)
  const legacy = legacyPeerNote(panel)

  const raw = legacy.locator('.provenance-raw')
  await openCard(page, panel, legacy)
  await expect(raw).toBeHidden()
  const folded = await legacy.innerText()
  expect(folded).toContain('ENVELOPE_LEGACY_BODY')
  expect(folded).not.toContain('---peer-note-')
  expect(folded).not.toContain('user authorization')

  await revealCard(page, panel, legacy.locator('.provenance-details > summary'))
  await legacy.locator('.provenance-details > summary').click()
  await expect(raw).toBeVisible()
  await expect(raw).toContainText('---peer-note-')
  await expect(raw).toContainText('does NOT carry user authorization')

  await shotCard(page, panel, legacy, `${SCREENSHOT_DIR}/card-legacy-details-open.png`)
})

test('an unidentified sender gets no clickable session chip', async ({ page }) => {
  test.setTimeout(60_000)
  await page.goto('/')
  const panel = await openSession(page)

  const anon = anonPeerNote(panel)
  await expect(anon.locator('.provenance-fold-dir')).toHaveText('From')
  await expect(anon.locator('.provenance-fold-sender')).toHaveText('an unidentified process')
  await expect(anon.locator('.provenance-fold-title')).toHaveText('cron finished on the box.')
  await openCard(page, panel, anon)
  await expect(anon.locator('a.provenance-chip-session')).toHaveCount(0)
  await expect(anon.locator('.provenance-host')).toHaveText('devbox')
  await expect(anon.locator('.provenance-body')).toContainText('ENVELOPE_ANON_BODY')

  await shotCard(page, panel, anon, `${SCREENSHOT_DIR}/card-anonymous-sender.png`)
})

test("Claude Code's own cross-session message cards, framing folded, no context row", async ({ page }) => {
  test.setTimeout(60_000)
  await page.goto('/')
  const panel = await openSession(page)

  // The CLI writes it as an injected line. It must be a card, with the CLI named
  // as the routing system, and NOT a collapsed "Injected context" row.
  const native = nativePeerNote(panel)
  await expect(native).toHaveCount(1)
  await expect(native).toHaveAttribute('aria-label', 'Message from another Claude Code session: marina-api-71')
  await expect(native.locator('.provenance-fold-dir')).toHaveText('Claude Code session')
  await expect(native.locator('.provenance-fold-sender')).toHaveText('marina-api-71')
  await expect(native.locator('.provenance-fold-title')).toHaveText('Rebased onto main, tests green.')
  await openCard(page, panel, native)
  await expect(native.locator('.provenance-body')).toContainText('ENVELOPE_NATIVE_BODY')
  await expect(native.locator('.provenance-body')).not.toContainText('permission laundering')
  // A CLI `[ref]` is not a Walnut id: no chip can be minted from it.
  await expect(native.locator('a.provenance-chip-session')).toHaveCount(0)
  // The framing prose is recoverable behind the disclosure and nowhere else.
  await revealCard(page, panel, native.locator('.provenance-details > summary'))
  await native.locator('.provenance-details > summary').click()
  await expect(native.locator('.provenance-raw')).toContainText('Another Claude session sent a message')
  await expect(native.locator('.provenance-raw')).toContainText('permission laundering')
  // The card rides the ordinary message path: same wrapper as every other row.
  await expect(native.locator('xpath=ancestor::*[contains(@class,"session-msg-envelope")]')).toHaveCount(1)

  await shotCard(page, panel, native, `${SCREENSHOT_DIR}/card-claude-code-native.png`)
})

test('an injected skill dump that quotes an envelope stays a collapsed context row', async ({ page }) => {
  test.setTimeout(60_000)
  await page.goto('/')
  const panel = await openSession(page)

  // The dump has prose of its own, so it is not "nothing but envelopes": it keeps
  // the collapsed row, and its quoted example never becomes a card.
  const rows = panel.locator('.tool-run-label', { hasText: /skill|context/i })
  await expect(rows).toHaveCount(1)
  await expect(panel.locator('.provenance-body', { hasText: 'example body only' })).toHaveCount(0)
  await expect(panel.locator('.provenance-fold-title', { hasText: 'example body only' })).toHaveCount(0)
  await expect(panel.getByText('ENVELOPE_SKILL_DUMP')).toHaveCount(0)
})

/** The outbound card renders SOLO in the timeline: a send is conversation, so
 *  it must never fold into a collapsed "Ran a command" run (that is asserted). */
async function revealOutboundCard(panel: Locator, foldTitle = 'Blockers cleared on my side'): Promise<Locator> {
  // Two sends in the fixture: the peer note, then a reply whose answer was cut.
  await expect(panel.locator('.provenance-card[data-envelope-kind="outbound"]')).toHaveCount(2)
  const outbound = panel.locator('.provenance-card[data-envelope-kind="outbound"]')
    .filter({ has: panel.page().locator('.provenance-fold-title', { hasText: foldTitle }) })
  await expect(outbound).toHaveCount(1)
  await expect(outbound).toBeVisible()
  await expect(panel.locator('.tool-run-toggle', { hasText: 'Ran a command' })).toHaveCount(0)
  return outbound
}

test('this session messaging another one cards too, mirroring the inbound card', async ({ page }) => {
  test.setTimeout(60_000)
  await page.goto('/')
  const panel = await openSession(page)
  const title = await peerTitle(page)

  const outbound = await revealOutboundCard(panel)
  await expect(outbound).toHaveAttribute('data-outbound-via', 'cli')
  await expect(outbound).toHaveAttribute('aria-label', 'Message to another session: Playwright test task')
  // Folded: to whom (the target's task) and the title this session gave.
  await expect(outbound.locator('.provenance-fold-dir')).toHaveText('To')
  await expect(outbound.locator('.provenance-fold-sender')).toHaveText('Playwright test task')
  // The FULL live title, same as the inbound card: the server's answer only
  // printed an 80-char clip, so anything longer proves the target was resolved.
  await expect(outbound.locator('.provenance-fold-sender')).toHaveAttribute('title', title)
  await expect(outbound.locator('.provenance-body')).toHaveCount(0)
  await openCard(page, panel, outbound)
  await expect(outbound.locator('.provenance-body')).toContainText('ENVELOPE_OUTBOUND_BODY')

  // Same chips, same click contract as the receiving side.
  const chip = outbound.locator('a.provenance-chip-session')
  await expect(chip).toHaveText(`@${PEER_SHORT}`)
  await expect(chip).toHaveAttribute('data-session-id', PEER_ID)
  await expect(outbound.locator('a.provenance-chip-task')).toHaveAttribute('data-task-id', 'pw-task-001')

  // The whole point: the send is provenance, so its generic Bash block is gone.
  await expect(panel.locator('.chat-tool-block').filter({ hasText: 'task_send' })).toHaveCount(0)
  // The command and the server's answer stay recoverable, folded.
  const raw = outbound.locator('.provenance-raw').first()
  await expect(raw).toBeHidden()
  expect(await outbound.innerText()).not.toContain('walnut tools call')
  await revealCard(page, panel, outbound.locator('.provenance-details > summary'))
  await outbound.locator('.provenance-details > summary').click()
  await expect(raw).toContainText('walnut tools call task_send')
  await expect(outbound.locator('.provenance-raw').last()).toContainText('"delivery":"queued"')

  await shotCard(page, panel, outbound, `${SCREENSHOT_DIR}/card-outbound.png`)

  // Existing counts are untouched: a send is a new kind, not a fifth peer note.
  await expect(card(panel, 'peer-note')).toHaveCount(4)
})

test('a reply whose answer was cut from the transcript still names the session that asked', async ({ page }) => {
  test.setTimeout(60_000)
  // The card asks the server who sent the request: watch that call happen, once.
  const lookups: string[] = []
  page.on('request', (r) => { if (r.url().includes('/api/v1/requests/')) lookups.push(r.url()) })
  await page.goto('/')
  const panel = await openSession(page)
  const title = await peerTitle(page)

  // `walnut tools call task_send … | tail -3` kept only the answer's closing lines,
  // so nothing in the transcript names the target. This card used to say "Unknown session".
  // No title on this one: the first sentence of the words stands in.
  const reply = await revealOutboundCard(panel, 'Ack, I am the only worker now.')
  await expect(reply.locator('.provenance-fold-dir')).toHaveText('Reply to')
  await expect(reply.locator('.provenance-fold-sender')).toHaveText('Playwright test task')
  await expect(reply.locator('.provenance-fold-sender')).toHaveAttribute('title', title)
  await openCard(page, panel, reply)
  await expect(reply.locator('.provenance-rq')).toHaveText('rq-0c07a5e1e7a1')
  const chip = reply.locator('a.provenance-chip-session')
  await expect(chip).toHaveText(`@${PEER_SHORT}`)
  await expect(chip).toHaveAttribute('data-session-id', PEER_ID)
  await expect(reply.locator('a.provenance-chip-task')).toHaveAttribute('data-task-id', 'pw-task-001')
  // Nothing claims a delivery state the transcript does not hold.
  await expect(reply.locator('.provenance-status')).toHaveCount(0)
  expect(lookups.filter((u) => u.endsWith('/api/v1/requests/rq-0c07a5e1e7a1'))).toHaveLength(1)
  // The full answer card above it asked nothing: the server had named its target.
  expect(lookups.filter((u) => !u.endsWith('/rq-0c07a5e1e7a1'))).toEqual([])

  await shotCard(page, panel, reply, `${SCREENSHOT_DIR}/card-outbound-cut-reply.png`)
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
  expect(bubbleText).not.toContain('<walnut-message')
  expect(bubbleText).not.toContain('---peer-note-')
  expect(bubbleText).not.toContain('user authorization')

  // The server-composed envelope for that send is pinned separately, against the
  // shipped parser: tests/core/session-envelope-render-contract.test.ts.
  await page.setViewportSize({ width: 1280, height: 900 })
  await panel.screenshot({ path: `${SCREENSHOT_DIR}/live-api-send-queued.png` })
})
