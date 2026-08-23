/**
 * Human Inbox — the P1 loop through the REAL UI: an agent's letter lands in the
 * notification center's Inbox rail, the human reads it in the reader, one click
 * answers it, the choice reaches the ORIGIN SESSION's live CLI, and the reply
 * threads under the letter.
 *
 * Nothing here is route-mocked. The letters are created the way an agent creates
 * them (`POST /api/v1/human-inbox` with the caller-sid header the ops executor
 * adds), the origin session is a REAL quick-start session whose mock CLI idles on
 * its FIFO, and the receipt that delivery worked is that CLI's own echo of the
 * wrapped text in the session's history — not a status field the UI printed.
 *
 * Serial + subject-scoped: the fixture server is SHARED, so the letter store is
 * global state. Every assertion is scoped to a `PW LTR …<nonce>` subject and
 * every count claim is a FLOOR — an absolute count would be a race against a
 * leftover letter from an earlier run, not a test of the feature.
 *
 * Never clicks "Clear All" (that deletes the shared notification feed other specs
 * assert on) and never marks another spec's notifications read beyond what
 * opening the panel already does by design.
 */
import fs from 'node:fs/promises'
import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'

const SCREENSHOT_DIR = '/tmp/human-inbox'
const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)

/** Provenance header the ops executor sets (src/ops: CALLER_SID_HEADER). */
const CALLER_SID_HEADER = 'x-walnut-caller-sid'

/** One nonce per run: subjects are how every assertion below scopes itself. */
const NONCE = Date.now().toString(36)
const DECISION_SUBJECT = `PW LTR decision ${NONCE}`
const INFO_SUBJECT = `PW LTR filing ${NONCE}`
const UNREAD_SUBJECT = `PW LTR quiet ${NONCE}`

/** Markers that must survive (or must NOT appear) inside the sandboxed body. */
const HTML_BODY_MARKER = `LETTER-HTML-BODY-${NONCE}`
const SCRIPT_RAN_MARKER = `SCRIPT-DID-RUN-${NONCE}`

let fixtureRoot = ''
/** The origin session every delivery assertion is made against. */
let originSid = ''

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  ;({ fixtureRoot } = await discoverBrowserFixture(TEST_PORT))
  await fs.mkdir(SCREENSHOT_DIR, { recursive: true })
})

// ── Seeding (the agent side of the feature, done the way an agent does it) ──

/**
 * A REAL session to be the letter's sender: quick-start with an EMPTY message is
 * an init-only spawn, so the mock CLI boots and parks on its FIFO instead of
 * running a turn. That is what makes the later delivery a live FIFO write whose
 * receipt is the CLI's own echo.
 */
async function startOriginSession(request: APIRequestContext): Promise<string> {
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

async function openCenter(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Notifications' }).click()
  const panel = page.locator('.notification-panel')
  await expect(panel).toBeVisible()
  return panel
}

const rail = (panel: Locator, label: string): Locator =>
  panel.locator('.nfc-rail-btn', { hasText: label })

/** Rail badge as a NUMBER (0 when absent) — every claim on it is a floor. */
async function railBadge(panel: Locator, label: string): Promise<number> {
  const badge = rail(panel, label).locator('.nfc-rail-badge')
  if (await badge.count() === 0) return 0
  return Number((await badge.textContent())?.replace('+', '') ?? 0)
}

async function openInbox(panel: Locator): Promise<void> {
  await rail(panel, 'Inbox').click()
  // aria-current, not aria-selected: the rail is plain buttons on purpose.
  await expect(rail(panel, 'Inbox')).toHaveAttribute('aria-current', 'true')
  await expect(panel.locator('.hib-toolbar')).toBeVisible()
}

const envelope = (panel: Locator, subject: string): Locator =>
  panel.locator('.hib-row').filter({ hasText: subject })

/** Row action buttons are exact-named so 'Pin' can never match 'Unpin'. */
const rowButton = (row: Locator, name: string): Locator =>
  row.getByRole('button', { name, exact: true })

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `${SCREENSHOT_DIR}/${name}.png` })
}

// ── 1. The whole loop: arrive → read → decide → deliver → reply ──

test('an action_required letter arrives, reads in the reader, and one click answers it', async ({ page, request }) => {
  // Spawns a real CLI and waits for its echo of the delivered text — well past
  // the 30s default, and this machine runs several agent sessions at once.
  test.setTimeout(180_000)
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(err.message))

  originSid = await startOriginSession(request)
  const letterId = await sendLetter(request, {
    subject: DECISION_SUBJECT,
    type: 'action_required',
    // The body is UNTRUSTED agent output, so it carries a script that must never
    // run: with it executing, the frame body would read SCRIPT_RAN_MARKER instead.
    html: `<h2>Cache rollout</h2><p>${HTML_BODY_MARKER}</p>`
      + `<p>The new cache halves cold reads. Pick how it ships.</p>`
      + `<p><a href="https://example.invalid/report">Full report</a></p>`
      + `<script>document.body.innerHTML = ${JSON.stringify(SCRIPT_RAN_MARKER)}</script>`,
    text: `Cache rollout needs a call: ship now or hold for review (${NONCE}).`,
    actions: [
      { id: 'ship', label: 'Ship it now', description: 'Roll out to every host tonight' },
      { id: 'hold', label: 'Hold for review', description: 'Wait for a second pair of eyes' },
    ],
  }, originSid)

  await loadHome(page)

  // The bell counts unread letters. FLOOR, not equality: the feed is shared.
  const bellBadge = page.locator('.notification-badge-count')
  await expect(bellBadge).toBeVisible({ timeout: 15_000 })
  expect(Number((await bellBadge.textContent())?.replace('+', '') ?? 0)).toBeGreaterThanOrEqual(1)

  const panel = await openCenter(page)

  // An unanswered action_required letter blocks work like a permission ask, so it
  // is LISTED in Needs Action too (a badge whose section shows nothing loses it).
  await rail(panel, 'Needs Action').click()
  await expect(envelope(panel, DECISION_SUBJECT)).toBeVisible({ timeout: 15_000 })
  expect(await railBadge(panel, 'Needs Action')).toBeGreaterThanOrEqual(1)

  await openInbox(panel)
  expect(await railBadge(panel, 'Inbox')).toBeGreaterThanOrEqual(1)

  // The envelope is entirely system-stamped: type, sender session, task, host.
  const row = envelope(panel, DECISION_SUBJECT)
  await expect(row).toBeVisible({ timeout: 15_000 })
  await expect(row).toHaveClass(/hib-unread/)
  await expect(row.locator('.hib-type')).toHaveText('Action needed')
  await expect(row.locator('.hib-preview')).toContainText(`ship now or hold for review (${NONCE})`)
  await expect(row.locator('.hib-row-chips')).toContainText('Session: walnut')
  await expect(row.locator('.hib-row-chips')).toContainText('local')
  await shot(page, 'e2e-01-inbox-rail')

  // ── The reader ──
  await row.click()
  const reader = page.locator('.hib-reader')
  await expect(reader).toBeVisible({ timeout: 15_000 })
  await expect(reader.locator('.hib-reader-subject')).toHaveText(DECISION_SUBJECT)

  // Email-client posture: popups only (so a link is not a dead click), never scripts.
  const frame = reader.locator('.hib-html-frame')
  await expect(frame).toHaveAttribute('sandbox', 'allow-popups allow-popups-to-escape-sandbox')
  const frameBody = page.frameLocator('.hib-html-frame').locator('body')
  await expect(frameBody).toContainText(HTML_BODY_MARKER, { timeout: 15_000 })
  await expect(frameBody).not.toContainText(SCRIPT_RAN_MARKER)
  await shot(page, 'e2e-02-reader-html-body')

  // ── The decision ──
  const shipButton = reader.locator('.hib-action-btn').filter({ hasText: 'Ship it now' })
  await expect(shipButton).toBeVisible()
  await reader.locator('.hib-freetext').fill(`only after the smoke run (${NONCE})`)
  await shipButton.click()

  await expect(reader.locator('.hib-answered')).toContainText('Ship it now', { timeout: 20_000 })
  await expect(reader.locator('.hib-answered-note')).toContainText(`only after the smoke run (${NONCE})`)
  // Answered = the buttons are gone; the record replaces the ask.
  await expect(reader.locator('.hib-action-btn')).toHaveCount(0)
  await expect(reader.locator('.hib-delivery')).toHaveText('Sent to the agent')
  await expect(reader.locator('.hib-thread')).toContainText('You')
  // Answering must not COST the human the document: the reader replaces its
  // loaded letter with the write response, so that response has to carry the
  // body (it used to return the bare index record → an empty white frame).
  await expect(frameBody).toContainText(HTML_BODY_MARKER)
  await shot(page, 'e2e-03-answered')

  // ── The receipt: the ORIGIN SESSION's own CLI processed the wrapped text ──
  // (mock-claude echoes "Hello! I processed your message: <msg>", so this is the
  // agent side of the loop, not a status the UI printed.)
  await expect.poll(async () => {
    const res = await request.get(`/api/sessions/${originSid}/history`)
    return res.ok() ? await res.text() : ''
  }, { timeout: 45_000, intervals: [500, 1000, 2000] }).toContain('[Letter reply]')

  const delivered = await (await request.get(`/api/sessions/${originSid}/history`)).text()
  expect(delivered).toContain(DECISION_SUBJECT)
  expect(delivered).toContain('Ship it now')
  // The one instruction the wrapper carries: answer back in the thread.
  expect(delivered).toContain('human_inbox_reply')
  expect(delivered).toContain(letterId)

  // ── The human's free-text reply threads under the letter ──
  const followUp = `PW LTR follow-up ${NONCE}: does this cover the Tuesday incident?`
  await reader.locator('.hib-composer-input').fill(followUp)
  await reader.locator('.hib-send-btn').click()
  await expect(reader.locator('.hib-thread')).toContainText(followUp, { timeout: 20_000 })
  await expect(reader.locator('.hib-turn--human')).toHaveCount(2)
  await expect(reader.locator('.hib-composer-input')).toHaveValue('')
  await expect(frameBody).toContainText(HTML_BODY_MARKER)
  await reader.locator('.hib-turn--human').last().scrollIntoViewIfNeeded()
  await shot(page, 'e2e-04-thread-and-composer')

  // Closing the reader leaves the decision on the envelope, as a record.
  await reader.getByRole('button', { name: 'Close letter' }).click()
  await expect(reader).toHaveCount(0)
  await expect(envelope(panel, DECISION_SUBJECT).locator('.hib-answered-chip'))
    .toContainText('Ship it now')

  // …and an answered letter is no longer a to-do: it leaves Needs Action but
  // stays in the Inbox as the record of the decision.
  await rail(panel, 'Needs Action').click()
  await expect(envelope(panel, DECISION_SUBJECT)).toHaveCount(0, { timeout: 15_000 })
  await openInbox(panel)
  await expect(envelope(panel, DECISION_SUBJECT)).toBeVisible()

  // ── The agent answers back: `human_inbox_reply` threads under the letter,
  // flips it unread, and the open panel picks that up with NO reload ──
  const agentBodyMarker = `AGENT-REPLY-BODY-${NONCE}`
  const replyRes = await request.post(`/api/v1/human-inbox/${letterId}/reply`, {
    data: {
      text: `Yes — the Tuesday incident has the same root cause (${NONCE}).`,
      markdown: `### Tuesday incident\n\n${agentBodyMarker}`,
    },
    headers: { [CALLER_SID_HEADER]: originSid },
  })
  expect(replyRes.status(), await replyRes.text()).toBe(200)

  const answeredRow = envelope(panel, DECISION_SUBJECT)
  await expect(answeredRow).toHaveClass(/hib-unread/, { timeout: 20_000 })
  await expect(answeredRow.locator('.hib-chip-thread')).toContainText('3 in thread')

  await answeredRow.click()
  const reopened = page.locator('.hib-reader')
  await expect(reopened.locator('.hib-turn--agent .hib-md-body'))
    .toContainText(agentBodyMarker, { timeout: 20_000 })
  await reopened.locator('.hib-turn--agent').last().scrollIntoViewIfNeeded()
  await shot(page, 'e2e-05-agent-reply-threaded')

  expect(pageErrors, `uncaught page errors: ${pageErrors.join(' | ')}`).toEqual([])
})

// ── 2. Human state: pin, read/unread, archive ──

test('pin, mark unread and archive each move the envelope', async ({ page, request }) => {
  test.setTimeout(120_000)
  const marker = `LETTER-MD-BODY-${NONCE}`
  await sendLetter(request, {
    subject: INFO_SUBJECT,
    type: 'info',
    markdown: `## Disk watch\n\n${marker}\n\nThe backup volume is at 70%.`,
    text: `Disk watch: backup volume at 70% (${NONCE}).`,
  })

  await loadHome(page)
  const panel = await openCenter(page)
  await openInbox(panel)

  const row = envelope(panel, INFO_SUBJECT)
  await expect(row).toBeVisible({ timeout: 15_000 })
  // No caller sid → the honest `external` sender, never a guess.
  await expect(row.locator('.hib-row-chips')).toContainText('External agent')

  // ── Pin: pinned letters sort ahead of newer unpinned ones ──
  await rowButton(row, 'Pin').click()
  await expect(row).toHaveClass(/hib-pinned/)
  await expect(rowButton(row, 'Unpin')).toBeVisible()
  const order = await panel.locator('.hib-row .hib-subject').allTextContents()
  expect(order.indexOf(INFO_SUBJECT)).toBeGreaterThanOrEqual(0)
  expect(order.indexOf(INFO_SUBJECT)).toBeLessThan(order.indexOf(DECISION_SUBJECT))
  await shot(page, 'e2e-06-pinned-first')

  // ── Reading the letter (and only that) marks it read ──
  await expect(row).toHaveClass(/hib-unread/)
  await row.click()
  const reader = page.locator('.hib-reader')
  await expect(reader.locator('.hib-md-body')).toContainText(marker, { timeout: 15_000 })
  await reader.getByRole('button', { name: 'Close letter' }).click()
  await expect(reader).toHaveCount(0)
  await expect(row).not.toHaveClass(/hib-unread/, { timeout: 15_000 })

  // ── …and the human can put it back to unread ──
  await rowButton(row, 'Mark unread').click()
  await expect(row).toHaveClass(/hib-unread/, { timeout: 15_000 })

  // ── Archive: out of the feed, into the Archived view ──
  await rowButton(row, 'Archive').click()
  await expect(envelope(panel, INFO_SUBJECT)).toHaveCount(0, { timeout: 15_000 })
  await panel.getByRole('button', { name: 'Archived' }).click()
  const archivedRow = envelope(panel, INFO_SUBJECT)
  await expect(archivedRow).toBeVisible({ timeout: 15_000 })
  await expect(rowButton(archivedRow, 'Unarchive')).toBeVisible()
  await shot(page, 'e2e-07-archived-view')

  // Back to the live feed: the archived letter is not in it.
  await panel.getByRole('button', { name: '← Back to inbox' }).click()
  await expect(envelope(panel, INFO_SUBJECT)).toHaveCount(0, { timeout: 15_000 })
})

// ── 3. The deliberate exception: opening the panel never reads a letter ──

test('opening the notification panel does not mark a letter read', async ({ page, request }) => {
  test.setTimeout(120_000)
  await sendLetter(request, {
    subject: UNREAD_SUBJECT,
    type: 'review',
    markdown: `# Overnight run\n\nRoot cause found; details below (${NONCE}).`,
    text: `Overnight investigation report (${NONCE}).`,
  })

  await loadHome(page)

  // Opening the panel marks the FEED read — the letter must survive that.
  const panel = await openCenter(page)
  await openInbox(panel)
  const row = envelope(panel, UNREAD_SUBJECT)
  await expect(row).toBeVisible({ timeout: 15_000 })
  await expect(row).toHaveClass(/hib-unread/)
  await expect(row.locator('.hib-dot')).not.toHaveClass(/hib-dot-read/)
  expect(await railBadge(panel, 'Inbox')).toBeGreaterThanOrEqual(1)
  await shot(page, 'e2e-08-unread-survives-panel-open')

  // Close and reopen: still unread, and the bell still counts it.
  await panel.locator('.notification-panel-close').click()
  await expect(panel).toHaveCount(0)
  const bellBadge = page.locator('.notification-badge-count')
  await expect(bellBadge).toBeVisible({ timeout: 15_000 })

  const reopened = await openCenter(page)
  await openInbox(reopened)
  await expect(envelope(reopened, UNREAD_SUBJECT)).toHaveClass(/hib-unread/, { timeout: 15_000 })
})
