/**
 * The Inbox as a SESSION TAB (todo item O) — the per-session lens on the letter
 * store, through the real UI.
 *
 * What this pins that the cross-session spec (human-inbox.spec.ts) cannot:
 *  - the hop from the notification-center rail INTO the session: the reader's
 *    "Open session ↗" is a `/sessions?id=…&tab=inbox&letter=…` deep link, and the
 *    panel that has to react does not exist yet when it is followed (the click is
 *    what mounts the column), so the arrival rides a parked request;
 *  - the tab is a PEER of Changed / Files / Terminal / Code: the letter renders in
 *    the split column with the LIVE chat beside it, and a chat message sent while
 *    the letter is open reaches the session's CLI and comes back — proof the split
 *    is two live surfaces, not a screenshot of one;
 *  - answering from the tab (not the overlay) records the decision, threads the
 *    human turn, and an agent reply grows that thread with no reload;
 *  - the list is this session's letters ONLY (an `external` letter and another
 *    session's letter belong to no session tab), and the chip's badge is honest
 *    while the tab is CLOSED.
 *
 * Isolation: every test starts its OWN real session, so its letter set is exactly
 * what it seeded and counts can be EXACT rather than floors — the fixture server
 * (and therefore the letter store) is shared with the other inbox spec.
 *
 * Nothing is route-mocked. Letters are created the way an agent creates them
 * (`POST /api/v1/human-inbox` + the caller-sid header the ops executor adds); the
 * sender session is a real quick-start session whose mock CLI parks on its FIFO.
 */
import fs from 'node:fs/promises'
import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'

const SCREENSHOT_DIR = '/tmp/human-inbox-tab'
const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)

/** Provenance header the ops executor sets (src/ops: CALLER_SID_HEADER). */
const CALLER_SID_HEADER = 'x-walnut-caller-sid'

/** A tracked fixture session that is NOT the sender — its letter must not leak in. */
const OTHER_FIXTURE_SID = 'pw-vscode-session'

/** One nonce per run: subjects are how every assertion below scopes itself. */
const NONCE = Date.now().toString(36)

let fixtureRoot = ''

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  ;({ fixtureRoot } = await discoverBrowserFixture(TEST_PORT))
  await fs.mkdir(SCREENSHOT_DIR, { recursive: true })
})

// ── The agent side of the feature, done the way an agent does it ──

/**
 * A REAL session to be the letter's sender AND the live chat beside it.
 * quick-start with an EMPTY message is an init-only spawn: the mock CLI boots and
 * parks on its FIFO instead of running a turn, so the chat send later in the test
 * is a live FIFO write whose receipt is that CLI's own echo.
 */
async function startSession(request: APIRequestContext): Promise<string> {
  const res = await request.post('/api/sessions/quick-start', {
    data: { cwd: `${fixtureRoot}/projects/walnut`, message: '' },
  })
  expect(res.ok(), await res.text()).toBeTruthy()
  const { sessionId } = await res.json() as { sessionId?: string }
  expect(sessionId, 'quick-start returned no sessionId').toBeTruthy()
  return sessionId as string
}

/** `POST /api/v1/human-inbox` — exactly what `wn tools call human_inbox_send` hits. */
async function sendLetter(
  request: APIRequestContext,
  body: Record<string, unknown>,
  callerSid?: string,
): Promise<string> {
  const res = await request.post('/api/v1/human-inbox', {
    data: body,
    ...(callerSid ? { headers: { [CALLER_SID_HEADER]: callerSid } } : {}),
  })
  expect(res.status(), await res.text()).toBe(201)
  const { id } = await res.json() as { id: string }
  expect(id).toMatch(/^lt-/)
  return id
}

// ── UI helpers ──

async function loadHome(page: Page): Promise<void> {
  await page.goto('/')
  await expect(page.locator('.main-page')).toBeVisible({ timeout: 30_000 })
}

/** Open the notification center and switch to its cross-session Inbox rail. */
async function openCenterInbox(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Notifications' }).click()
  const panel = page.locator('.notification-panel')
  await expect(panel).toBeVisible()
  await panel.locator('.nfc-rail-btn', { hasText: 'Inbox' }).click()
  await expect(panel.locator('.hib-toolbar')).toBeVisible()
  return panel
}

/**
 * The whole hop under test: rail row → overlay reader → "Open session ↗".
 * Real clicks only; the URL is the transport, never a `page.goto`.
 */
async function openSessionTabViaLetter(
  page: Page,
  subject: string,
  sessionId: string,
): Promise<Locator> {
  const panel = await openCenterInbox(page)
  const row = panel.locator('.hib-row').filter({ hasText: subject })
  await expect(row).toBeVisible({ timeout: 20_000 })
  await row.click()

  const reader = page.locator('.hib-reader')
  await expect(reader).toBeVisible({ timeout: 20_000 })
  await expect(reader.locator('.hib-reader-subject')).toHaveText(subject)
  await reader.getByRole('button', { name: 'Open session ↗' }).click()

  // The overlay and the panel underneath both go away: the letter continues in
  // the session, it does not open twice.
  await expect(reader).toHaveCount(0, { timeout: 15_000 })
  await expect(page.locator('.notification-panel')).toHaveCount(0)

  const sessionPanel = page.locator(`.session-panel[data-session-id="${sessionId}"]`)
  await expect(sessionPanel).toBeVisible({ timeout: 20_000 })
  return sessionPanel
}

const inboxChip = (panel: Locator): Locator =>
  panel.locator('.session-action-chip').filter({ hasText: 'Inbox' })

/** Chip badge as a NUMBER (0 when absent) — the count while the tab is closed. */
async function chipBadge(panel: Locator): Promise<number> {
  const badge = inboxChip(panel).locator('.session-action-chip-count')
  if (await badge.count() === 0) return 0
  return Number((await badge.textContent())?.replace('+', '') ?? 0)
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `${SCREENSHOT_DIR}/${name}.png` })
}

// ── 1. The whole tab loop: deep link in → letter beside live chat → answer ──

test('a letter opens in the session Inbox tab beside the live chat, and answering it there threads', async ({ page, request }) => {
  // A real CLI spawn plus its echo of two delivered messages — far past the 30s
  // default, and this machine runs several agent sessions at once.
  test.setTimeout(240_000)
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(err.message))

  const subject = `PW TAB decision ${NONCE}`
  const bodyMarker = `TAB-HTML-BODY-${NONCE}`
  const scriptRanMarker = `TAB-SCRIPT-DID-RUN-${NONCE}`

  const sid = await startSession(request)
  const letterId = await sendLetter(request, {
    subject,
    type: 'action_required',
    // Untrusted agent output: the script must never run. With it executing the
    // frame would read scriptRanMarker instead of the document.
    html: `<h2>Index rebuild</h2><p>${bodyMarker}</p>`
      + `<p>The rebuild is ready. Pick when it runs.</p>`
      + `<script>document.body.innerHTML = ${JSON.stringify(scriptRanMarker)}</script>`,
    text: `Index rebuild needs a call: tonight or after the release (${NONCE}).`,
    actions: [
      { id: 'tonight', label: 'Rebuild tonight', description: 'Start as soon as traffic drops' },
      { id: 'after', label: 'Wait for the release', description: 'Hold until the release lands' },
    ],
  }, sid)

  await loadHome(page)
  const panel = await openSessionTabViaLetter(page, subject, sid)

  // ── The tab is a peer of the other views: chip active, pane in the split ──
  await expect(inboxChip(panel)).toHaveClass(/session-action-chip-active/, { timeout: 15_000 })
  const pane = panel.locator('.session-inbox-pane')
  await expect(pane).toBeVisible({ timeout: 20_000 })
  await expect(pane.locator('.session-inbox-bar-title')).toHaveText('Inbox')

  // The letter is open IN PLACE (the deep link carried it), not on the list.
  await expect(pane.locator('.hib-view')).toBeVisible()
  await expect(pane.locator('.hib-reader-subject')).toHaveText(subject)
  // Embedded, not the modal box — the tab fills its column.
  await expect(pane.locator('.hib-view')).toHaveClass(/hib-view-embedded/)
  // Inside the session there is no "Open session" button: you are already there.
  await expect(pane.getByRole('button', { name: 'Open session ↗' })).toHaveCount(0)

  // Same email-client posture as the overlay: popups only, never scripts.
  const frame = pane.locator('.hib-html-frame')
  await expect(frame).toHaveAttribute('sandbox', 'allow-popups allow-popups-to-escape-sandbox')
  const frameBody = page.frameLocator('.session-inbox-pane .hib-html-frame').locator('body')
  await expect(frameBody).toContainText(bodyMarker, { timeout: 20_000 })
  await expect(frameBody).not.toContainText(scriptRanMarker)

  // ── The split: letter left, live chat right (the whole point of a tab) ──
  const split = panel.locator('.session-panel-split')
  await expect(split).toHaveClass(/is-changed-open/)
  await expect(split).not.toHaveClass(/is-chat-collapsed/)
  await expect(panel.locator('.session-panel-diff-col .session-inbox-pane')).toBeVisible()
  const chatCol = panel.locator('.session-panel-chat-col')
  await expect(chatCol).toBeVisible()
  // Resize handle between the two columns comes from the shared split.
  await expect(panel.locator('.session-panel-chat-resize')).toBeVisible()
  // Both columns really have width — a collapsed-to-zero column would still
  // "be visible" to a class check.
  const paneBox = await pane.boundingBox()
  const chatBox = await chatCol.boundingBox()
  expect(paneBox!.width).toBeGreaterThan(200)
  expect(chatBox!.width).toBeGreaterThan(200)
  await shot(page, 'tab-01-letter-beside-chat')

  // ── A chat message sent WHILE the letter is open reaches the CLI ──
  const chatText = `PW TAB chat while reading ${NONCE}`
  const chatInput = panel.getByPlaceholder('Send a message to this session...')
  await expect(chatInput).toBeVisible()
  await chatInput.fill(chatText)
  await panel.locator('.session-panel-input .chat-send-btn-icon').click()
  await expect(chatCol).toContainText(chatText, { timeout: 30_000 })
  await expect(chatInput).toHaveValue('')
  // "Delivered" is a SERVER event (the message reached the session's stdin), not a
  // hopeful client label — that is what makes the column beside the letter live.
  // The CLI's own reply text is deliberately NOT asserted here: the full
  // round-trip through a mock CLI is pinned by human-inbox.spec.ts, and repeating
  // it in the tab spec only adds a starvation-shaped flake under machine load.
  await expect(chatCol).toContainText('Delivered', { timeout: 90_000 })
  // …and reading the letter never lost its place while the chat worked.
  await expect(pane.locator('.hib-reader-subject')).toHaveText(subject)
  await expect(frameBody).toContainText(bodyMarker)
  await shot(page, 'tab-02-chat-sent-letter-still-open')

  // ── The decision, answered FROM THE TAB ──
  const note = `only after the smoke run (${NONCE})`
  await pane.locator('.hib-freetext').fill(note)
  await pane.locator('.hib-action-btn').filter({ hasText: 'Rebuild tonight' }).click()

  await expect(pane.locator('.hib-answered')).toContainText('Rebuild tonight', { timeout: 30_000 })
  await expect(pane.locator('.hib-answered-note')).toContainText(note)
  // Answered = the ask is replaced by the record.
  await expect(pane.locator('.hib-action-btn')).toHaveCount(0)
  await expect(pane.locator('.hib-delivery')).toHaveText('Sent to the agent')
  await expect(pane.locator('.hib-thread')).toContainText('You')
  // Answering must not cost the human the document (the write response carries
  // the body; it used to return the bare index record → an empty white frame).
  await expect(frameBody).toContainText(bodyMarker)
  await shot(page, 'tab-03-answered-from-tab')

  // The receipt is the SERVER's copy of the letter, not what the tab printed: an
  // answer given in the tab is on record in the store with the human's note.
  const answeredRes = await request.get(`/api/v1/human-inbox/${letterId}`)
  expect(answeredRes.ok(), await answeredRes.text()).toBeTruthy()
  const { letter: stored } = await answeredRes.json() as {
    letter: { answered?: { actionId?: string; label?: string; freeText?: string } }
  }
  expect(stored.answered?.actionId).toBe('tonight')
  expect(stored.answered?.label).toBe('Rebuild tonight')
  expect(stored.answered?.freeText).toContain(note)

  // ── The human's own reply threads from the tab's composer ──
  const followUp = `PW TAB follow-up ${NONCE}: keep the old index for a day?`
  await pane.locator('.hib-composer-input').fill(followUp)
  await pane.locator('.hib-send-btn').click()
  await expect(pane.locator('.hib-thread')).toContainText(followUp, { timeout: 30_000 })
  await expect(pane.locator('.hib-turn--human')).toHaveCount(2)
  await expect(pane.locator('.hib-composer-input')).toHaveValue('')

  // ── The agent answers back: the thread grows LIVE, with no reload ──
  const agentMarker = `TAB-AGENT-REPLY-${NONCE}`
  const replyRes = await request.post(`/api/v1/human-inbox/${letterId}/reply`, {
    data: {
      text: `Keeping the old index for 24h (${NONCE}).`,
      markdown: `### Rollback window\n\n${agentMarker}`,
    },
    headers: { [CALLER_SID_HEADER]: sid },
  })
  expect(replyRes.status(), await replyRes.text()).toBe(200)
  await expect(pane.locator('.hib-turn--agent .hib-md-body'))
    .toContainText(agentMarker, { timeout: 40_000 })
  await pane.locator('.hib-turn--agent').last().scrollIntoViewIfNeeded()
  await shot(page, 'tab-04-thread-live-agent-reply')

  // ── Back to the list: the letter carries its decision as a record ──
  await pane.getByRole('button', { name: '← Letters' }).click()
  const row = pane.locator('.hib-row').filter({ hasText: subject })
  await expect(row).toBeVisible({ timeout: 20_000 })
  await expect(row.locator('.hib-answered-chip')).toContainText('Rebuild tonight')
  // Unread again, and that is the contract: an agent reply is new information, so
  // the store flips read=false (same as the rail). Pinned here because the tab's
  // own live re-read used to force read=true over that flag, which left the row
  // and the bell badge on whichever answer happened to arrive last.
  await expect(row).toHaveClass(/hib-unread/, { timeout: 20_000 })
  await expect(row.locator('.hib-chip-thread')).toContainText('3 in thread')
  await shot(page, 'tab-05-list-after-answer')

  expect(pageErrors, `uncaught page errors: ${pageErrors.join(' | ')}`).toEqual([])
})

// ── 2. The list is this session's letters, and the badge is honest when closed ──

test('the tab lists only this session letters and the chip badge counts them while closed', async ({ page, request }) => {
  test.setTimeout(240_000)
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(err.message))

  const mine = `PW TAB mine ${NONCE}`
  const alsoMine = `PW TAB also-mine ${NONCE}`
  const externalSubject = `PW TAB external ${NONCE}`
  const otherSubject = `PW TAB other-session ${NONCE}`

  const sid = await startSession(request)
  // Two for THIS session…
  await sendLetter(request, {
    subject: mine,
    type: 'action_required',
    markdown: `## Migration\n\nPick a lane (${NONCE}).`,
    text: `Migration needs a lane (${NONCE}).`,
    actions: [{ id: 'blue', label: 'Blue/green' }],
  }, sid)
  await sendLetter(request, {
    subject: alsoMine,
    type: 'info',
    markdown: `## Disk\n\nBackup volume at 70% (${NONCE}).`,
    text: `Backup volume at 70% (${NONCE}).`,
  }, sid)
  // …and two that must NOT appear in it: no caller (external) and another session.
  await sendLetter(request, {
    subject: externalSubject,
    type: 'info',
    markdown: `Hand-started agent, no session env (${NONCE}).`,
    text: `Hand-started agent (${NONCE}).`,
  })
  await sendLetter(request, {
    subject: otherSubject,
    type: 'info',
    markdown: `A different session wrote this (${NONCE}).`,
    text: `A different session (${NONCE}).`,
  }, OTHER_FIXTURE_SID)

  await loadHome(page)
  // Enter through the letter that is NOT the first row, so the deep link is
  // proven to carry a specific letter rather than "whatever was on top".
  const panel = await openSessionTabViaLetter(page, alsoMine, sid)
  const pane = panel.locator('.session-inbox-pane')
  await expect(pane.locator('.hib-reader-subject')).toHaveText(alsoMine, { timeout: 20_000 })

  await pane.getByRole('button', { name: '← Letters' }).click()
  const rows = pane.locator('.hib-row')
  // EXACTLY two: this session started clean, so the count is a fact, not a floor.
  await expect(rows).toHaveCount(2, { timeout: 20_000 })
  await expect(pane.locator('.hib-row').filter({ hasText: mine })).toBeVisible()
  await expect(pane.locator('.hib-row').filter({ hasText: alsoMine })).toBeVisible()
  await expect(pane.locator('.hib-row').filter({ hasText: externalSubject })).toHaveCount(0)
  await expect(pane.locator('.hib-row').filter({ hasText: otherSubject })).toHaveCount(0)
  // The bar says the same thing the rows do.
  await expect(pane.locator('.session-inbox-bar-sub')).toContainText('2 letters')
  await shot(page, 'tab-06-only-this-session')

  // Reading `alsoMine` above left exactly one unread: the unanswered decision.
  await expect(pane.locator('.hib-row').filter({ hasText: mine })).toHaveClass(/hib-unread/)
  await expect.poll(() => chipBadge(panel), { timeout: 20_000, intervals: [300, 500] }).toBe(1)
  // An unanswered decision is a stronger signal than unread — the badge says so.
  // The CLASS is not the promise: this stylesheet lands before globals.css in the
  // bundle, so a single-class rule silently lost the colour tie-break and the
  // badge stayed accent-blue. Assert the RENDERED colour.
  const badge = inboxChip(panel).locator('.session-action-chip-count')
  await expect(badge).toHaveClass(/session-action-chip-count-warn/)
  const colors = await badge.evaluate((el) => {
    const root = getComputedStyle(document.documentElement)
    const probe = document.createElement('span')
    document.body.appendChild(probe)
    probe.style.color = root.getPropertyValue('--warning').trim()
    const warning = getComputedStyle(probe).color
    probe.style.color = root.getPropertyValue('--accent').trim()
    const accent = getComputedStyle(probe).color
    probe.remove()
    return { bg: getComputedStyle(el).backgroundColor, warning, accent }
  })
  expect(colors.bg, 'decision badge must render the warning colour').toBe(colors.warning)
  expect(colors.bg).not.toBe(colors.accent)
  await expect(inboxChip(panel)).toHaveAttribute('title', /waiting on a decision/)

  // READING a decision must not clear the badge — deciding later is the entire
  // point of an async ask. Gated on unread alone, the chip went BARE here: the
  // agent was still blocked and the only remaining cue needed a hover.
  await pane.locator('.hib-row').filter({ hasText: mine }).click()
  await expect(pane.locator('.hib-reader-subject')).toHaveText(mine, { timeout: 20_000 })
  await expect(pane.locator('.hib-actions')).toBeVisible() // still unanswered
  await pane.getByRole('button', { name: '← Letters' }).click()
  await expect(pane.locator('.hib-row').filter({ hasText: mine }))
    .not.toHaveClass(/hib-unread/, { timeout: 20_000 })
  await expect.poll(() => chipBadge(panel), { timeout: 20_000, intervals: [300, 500] }).toBe(1)
  await expect(badge).toHaveClass(/session-action-chip-count-warn/)

  // ── The badge is live while the tab is CLOSED (that is the point of it) ──
  await inboxChip(panel).click()
  await expect(panel.locator('.session-inbox-pane')).toHaveCount(0, { timeout: 15_000 })
  await expect(inboxChip(panel)).not.toHaveClass(/session-action-chip-active/)
  expect(await chipBadge(panel)).toBe(1)
  await shot(page, 'tab-07-badge-with-tab-closed')

  // A letter arriving with the tab closed still moves the badge, no click needed.
  await sendLetter(request, {
    subject: `PW TAB late ${NONCE}`,
    type: 'info',
    markdown: `Arrived while the tab was closed (${NONCE}).`,
    text: `Arrived while the tab was closed (${NONCE}).`,
  }, sid)
  await expect.poll(() => chipBadge(panel), { timeout: 30_000, intervals: [500, 1000] }).toBe(2)

  // Re-opening the chip lands on the LIST (the letter was left, not parked).
  await inboxChip(panel).click()
  const reopened = panel.locator('.session-inbox-pane')
  await expect(reopened).toBeVisible({ timeout: 15_000 })
  await expect(reopened.locator('.hib-row')).toHaveCount(3, { timeout: 20_000 })
  await shot(page, 'tab-08-late-letter-in-list')

  expect(pageErrors, `uncaught page errors: ${pageErrors.join(' | ')}`).toEqual([])
})

// ── 3. Narrow window: the letter wins the column, chat is one click away ──

test('below the split floor the tab opens with the chat collapsed and a way back', async ({ page, request }) => {
  test.setTimeout(180_000)
  const subject = `PW TAB narrow ${NONCE}`
  const sid = await startSession(request)
  await sendLetter(request, {
    subject,
    type: 'review',
    markdown: `## Overnight run\n\nRoot cause found (${NONCE}).`,
    text: `Overnight run report (${NONCE}).`,
  }, sid)

  // Under 900px the content pane and the 280px-floor chat column do not both
  // fit, and half a letter is worse than one click on "show chat".
  await page.setViewportSize({ width: 820, height: 900 })
  await loadHome(page)
  const panel = await openSessionTabViaLetter(page, subject, sid)

  const split = panel.locator('.session-panel-split')
  await expect(split).toHaveClass(/is-chat-collapsed/, { timeout: 20_000 })
  await expect(panel.locator('.session-panel-chat-col')).toBeHidden()
  await expect(panel.locator('.session-inbox-pane .hib-reader-subject')).toHaveText(subject)
  // The way back is in the pane's own bar (the shared barRightSlot contract).
  const showChat = panel.locator('.session-inbox-bar-right').getByRole('button', { name: 'Show chat' })
  await expect(showChat).toBeVisible()
  await shot(page, 'tab-09-narrow-chat-collapsed')

  await showChat.click()
  await expect(split).not.toHaveClass(/is-chat-collapsed/, { timeout: 15_000 })
  await expect(panel.locator('.session-panel-chat-col')).toBeVisible()
  await shot(page, 'tab-10-narrow-chat-restored')
})

// ── 4. The same link, PASTED (the /sessions shim, not an in-app click) ──

test('a pasted /sessions?tab=inbox&letter= URL lands on the letter in the session tab', async ({ page, request }) => {
  test.setTimeout(180_000)
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(err.message))
  const subject = `PW TAB pasted ${NONCE}`
  const sid = await startSession(request)
  const letterId = await sendLetter(request, {
    subject,
    type: 'info',
    markdown: `## Nightly report\n\nPASTED-BODY-${NONCE}`,
    text: `Nightly report (${NONCE}).`,
  }, sid)

  // A deliberate exception to "no page.goto": this IS the pasted/bookmarked link,
  // and it is the page's INITIAL load, not navigation around the app. It exercises
  // a different code path from test 1 — `SessionsRedirect` in App.tsx parses the
  // query and hands it to the same mailbox, then replaces the URL with `/`, so the
  // session panel mounts while the route is still changing underneath it.
  await page.goto(`/sessions?id=${sid}&tab=inbox&letter=${letterId}`)
  await expect(page.locator('.main-page')).toBeVisible({ timeout: 30_000 })

  const panel = page.locator(`.session-panel[data-session-id="${sid}"]`)
  await expect(panel).toBeVisible({ timeout: 30_000 })
  // The tab must still be open a beat later: the route settles underneath a column
  // opened from another page, and that used to close it (DEEP_LINK_SETTLE_MS in
  // SessionPanel). A one-shot assertion would have passed on the way past.
  await expect(inboxChip(panel)).toHaveClass(/session-action-chip-active/, { timeout: 20_000 })
  await page.waitForTimeout(3_000)
  await expect(inboxChip(panel)).toHaveClass(/session-action-chip-active/)
  expect(pageErrors, `uncaught page errors: ${pageErrors.join(' | ')}`).toEqual([])
  const pane = panel.locator('.session-inbox-pane')
  await expect(pane.locator('.hib-reader-subject')).toHaveText(subject, { timeout: 20_000 })
  await expect(pane.locator('.hib-md-body')).toContainText(`PASTED-BODY-${NONCE}`)
  // The shim swaps the URL for home; the column is the surface, `/sessions` is not.
  await expect(page).toHaveURL(/localhost:\d+\/(\?.*)?$/)
  await shot(page, 'tab-11-pasted-deep-link')
})

// ── 5. Leaving the page right after a deep link: no stranded backdrop ──

/**
 * The other edge of the settle window. Fullscreen's backdrop is a PORTAL onto
 * document.body, so it outlives the (CSS-hidden) page it belongs to — re-asserting
 * fullscreen because "a deep link is young" put a fixed, blurred, click-blocking
 * sheet over whatever page the user opened next, with no way to dismiss it. That is
 * the 2026-08-09 incident useFullscreen's header documents, and a deep link is the
 * one thing that can re-arm the re-assert.
 *
 * The navigation is a TASK PILL inside the letter, because that is the exit a user
 * actually has here: the fullscreen panel covers the sidebar, so the sidebar link
 * is not clickable (proven: the first version of this test failed on
 * `.hib-reader-body … intercepts pointer events`).
 *
 * The way IN is the in-app link from ANOTHER page (not a paste), because that is
 * both the reported scenario and the FAST one: the SPA is already warm, so the
 * pill click lands inside the young-claim window the guard treats as special. A/B
 * against the pre-fix rule: this test FAILS on it (backdrop over the task page)
 * and passes after. The clock-exact rule is pinned in tests/web/session-inbox-tab.test.ts.
 */
test('leaving the session from inside a deep-linked letter leaves no fullscreen backdrop behind', async ({ page, request }) => {
  test.setTimeout(180_000)
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(err.message))
  const subject = `PW TAB leave ${NONCE}`
  const sid = await startSession(request)
  const taskRes = await request.post('/api/tasks', {
    data: { title: `PW TAB leave task ${NONCE}`, source: 'local' },
  })
  expect(taskRes.status(), await taskRes.text()).toBe(201)
  const { task } = await taskRes.json() as { task: { id: string } }
  await sendLetter(request, {
    subject,
    type: 'info',
    markdown: `## Leaving\n\nLEAVE-BODY-${NONCE}`,
    text: `Leaving (${NONCE}).`,
    task_refs: [task.id],
  }, sid)

  // Follow the letter's own "Open session ↗" from the /tasks page: the deep link
  // then arrives while the route is still catching up, which is what arms the
  // re-assert in the first place.
  await loadHome(page)
  await page.locator('.sidebar-nav a[href="/tasks"]').first().click()
  await expect(page).toHaveURL(/\/tasks$/)
  const panel = await openSessionTabViaLetter(page, subject, sid)
  const pill = panel.locator(`.hib-taskrefs .task-link[data-task-id="${task.id}"]`)
  await expect(pill).toBeVisible({ timeout: 30_000 })
  await pill.click()

  // Poll rather than snapshot: the bug re-entered fullscreen from an effect a beat
  // after the route changed, so a single check could pass on the way past.
  await expect.poll(
    () => page.locator('.open-walnut-fullscreen-backdrop').count(),
    { timeout: 8_000, intervals: [250, 500, 1000] },
  ).toBe(0)
  // …and the page the user asked for is the one they can actually click: the home
  // columns are hidden (we really left), and nothing covers the task page.
  await expect(page).toHaveURL(new RegExp(`/tasks/${task.id}$`))
  await expect(page.locator('.main-page-wrapper-hidden')).toHaveCount(1)
  const covered = await page.evaluate(() => {
    const hit = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2)
    return !!hit?.closest('.open-walnut-fullscreen-backdrop')
  })
  expect(covered, 'the page navigated to must not sit under a fullscreen backdrop').toBe(false)
  await shot(page, 'tab-12-left-session-no-backdrop')
  expect(pageErrors, `uncaught page errors: ${pageErrors.join(' | ')}`).toEqual([])
})
