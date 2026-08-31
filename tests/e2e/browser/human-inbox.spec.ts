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
import { TINY_MP3_BASE64 } from './fixtures/tiny-audio'
import { TINY_MP4_BASE64 } from './fixtures/tiny-video'
import { LETTER_HTML_MAX_BYTES } from '../../../src/core/human-inbox/types.js'

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
/** The audio-digest letter: subject scope + a tail marker a clip would eat. */
const AUDIO_SUBJECT = `PW LTR audio ${NONCE}`
const AUDIO_TAIL_MARKER = `LETTER-AUDIO-TAIL-${NONCE}`
const VIDEO_SUBJECT = `PW LTR video ${NONCE}`
const VIDEO_TAIL_MARKER = `LETTER-VIDEO-TAIL-${NONCE}`

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

/**
 * The document the reader's iframe is actually showing, from EITHER lane.
 *
 * A small body arrives inline and the console feeds it to the iframe as `srcdoc`.
 * A body over the inline threshold (a real digest with audio or a clip) is NOT in
 * the letter JSON at all — the iframe points at `/api/v1/human-inbox/:id/body?frame=1`
 * and the server streams it wrapped in the identical frame. Both cases have to be
 * verifiable the same way, or the media checks below would silently stop covering
 * the size that matters.
 */
async function readerDocument(
  request: APIRequestContext,
  frame: Locator,
): Promise<{ document: string; lane: 'inline' | 'streamed' }> {
  const srcdoc = await frame.getAttribute('srcdoc')
  if (srcdoc) return { document: srcdoc, lane: 'inline' }
  const src = await frame.getAttribute('src')
  expect(src, 'the reader iframe has neither srcdoc nor src').toBeTruthy()
  expect(src, 'a deferred body must be fetched with the reader frame applied').toContain('frame=1')
  const res = await request.get(src!)
  expect(res.status(), `GET ${src}`).toBe(200)
  return { document: await res.text(), lane: 'streamed' }
}

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

// ── 4. The audio digest: a multi-MB html letter whose podcast has to PLAY ──

/**
 * The daily digest case, through the real UI.
 *
 * Two failures this pins, both of which shipped and both of which are silent:
 *   - a body clipped anywhere (the phone did it at 60k chars) cuts the base64 in
 *     half, so the player renders and then fails to DECODE — nothing logs;
 *   - `default-src 'none'` with no `media-src` refuses a `data:` audio source
 *     outright, so the player renders and never plays — also nothing logs.
 *
 * The receipt for both is a DURATION read off the element. The reader's iframe
 * has no `allow-scripts`, so nothing can be evaluated inside it; the check
 * instead loads the identical document the console fed that iframe (its `srcdoc`,
 * CSP meta included) in a plain page and measures the media there.
 */
test('a multi-MB letter with embedded base64 audio arrives whole and plays', async ({ page, request, browser }) => {
  test.setTimeout(180_000)

  // Over 1MB, the way a real digest is: a data-URI player plus enough prose to
  // push the body past every cap in the chain (gateway line, express, store).
  const filler = `<p>${'Yesterday the sync queue drained cleanly. '.repeat(30_000)}</p>`
  const html = `<h2>Audio digest</h2>`
    + `<audio controls preload="metadata" src="data:audio/mpeg;base64,${TINY_MP3_BASE64}"></audio>`
    + `${filler}<p>${AUDIO_TAIL_MARKER}</p>`
  expect(Buffer.byteLength(html)).toBeGreaterThan(1024 * 1024)

  await sendLetter(request, {
    subject: AUDIO_SUBJECT,
    type: 'info',
    html,
    text: `Audio digest with an embedded player (${NONCE}).`,
  })

  await loadHome(page)
  const panel = await openCenter(page)
  await openInbox(panel)

  // The envelope stays phone-sized: the base64 must not reach the list.
  const row = envelope(panel, AUDIO_SUBJECT)
  await expect(row).toBeVisible({ timeout: 15_000 })
  expect(await row.textContent() ?? '').not.toContain(TINY_MP3_BASE64.slice(0, 40))

  await row.click()
  const reader = page.locator('.hib-reader')
  await expect(reader).toBeVisible({ timeout: 15_000 })
  const frame = reader.locator('.hib-html-frame')
  await expect(frame).toBeVisible({ timeout: 15_000 })

  // Nothing was clipped: the audio source is byte-identical AND the paragraph
  // that follows a megabyte of prose is still there (a tail check catches a
  // truncation the src alone would not).
  const audio = page.frameLocator('.hib-html-frame').locator('audio')
  await expect(audio).toHaveCount(1, { timeout: 15_000 })
  expect(await audio.getAttribute('src')).toBe(`data:audio/mpeg;base64,${TINY_MP3_BASE64}`)
  await expect(page.frameLocator('.hib-html-frame').locator('body')).toContainText(AUDIO_TAIL_MARKER)
  await shot(page, 'e2e-09-audio-letter-reader')

  // The security floor is unchanged, and media is allowed from data:/blob: ONLY.
  await expect(frame).toHaveAttribute('sandbox', 'allow-popups allow-popups-to-escape-sandbox')
  const { document: readerDoc, lane } = await readerDocument(request, frame)
  // A body this size MUST take the streamed lane: if it came back inline, the
  // deferral regressed and the letter JSON is carrying megabytes again.
  expect(lane).toBe('streamed')
  const policy = readerDoc.match(/content="(default-src[^"]*)"/)?.[1] ?? ''
  expect(policy).toContain("default-src 'none'")
  expect(policy).toContain('media-src data: blob:')
  expect(policy).not.toMatch(/https?:/)

  // Does it actually decode? Same document, same CSP, a page that can be asked.
  const probe = await browser.newPage()
  const blocked: string[] = []
  probe.on('console', (m) => {
    if (/Content Security Policy|Refused to load/i.test(m.text())) blocked.push(m.text())
  })
  await probe.setContent(readerDoc, { waitUntil: 'load' })
  const media = await probe.evaluate(async () => {
    const el = document.querySelector('audio') as HTMLAudioElement | null
    if (!el) return { duration: 0, error: 'no audio element' }
    await new Promise<void>((resolve) => {
      if (el.readyState >= 1) return resolve()
      el.addEventListener('loadedmetadata', () => resolve(), { once: true })
      el.addEventListener('error', () => resolve(), { once: true })
      setTimeout(() => resolve(), 15_000)
    })
    return { duration: el.duration, error: el.error ? `code ${el.error.code}` : null }
  })
  await probe.close()
  expect(blocked, `CSP blocked the letter's own audio: ${blocked.join(' | ')}`).toHaveLength(0)
  expect(media.error).toBeNull()
  expect(media.duration).toBeGreaterThan(0)
})

/**
 * The same contract for VIDEO, at a size the original 10MB cap refused.
 *
 * Two things this pins that the audio test cannot. First, the raised cap is real
 * end to end: a >10MB body has to clear the store cap, the express parser mounted
 * on the inbox routes, and the gateway line, and a stale limit anywhere in that
 * chain fails here. Second, `<video>` decodes under the same policy as `<audio>`
 * — `media-src` covers both, so a letter can carry a clip, and reading a DURATION
 * off it is the only proof that separates "allowed" from "rendered and silently
 * refused".
 */
test('a >10MB letter with embedded base64 video arrives whole and plays', async ({ page, request, browser }) => {
  test.setTimeout(300_000)

  // Deliberately past the ORIGINAL 10MB html cap: this is the case the user hit.
  const filler = `<p>${'The overnight run finished and the digest was cut. '.repeat(230_000)}</p>`
  const html = `<h2>Video digest</h2>`
    + `<audio controls preload="metadata" src="data:audio/mpeg;base64,${TINY_MP3_BASE64}"></audio>`
    + `<video controls preload="metadata" src="data:video/mp4;base64,${TINY_MP4_BASE64}"></video>`
    + `${filler}<p>${VIDEO_TAIL_MARKER}</p>`
  const bytes = Buffer.byteLength(html)
  expect(bytes).toBeGreaterThan(10 * 1024 * 1024)
  expect(bytes).toBeLessThan(LETTER_HTML_MAX_BYTES)

  await sendLetter(request, {
    subject: VIDEO_SUBJECT,
    type: 'info',
    html,
    text: `Video digest with an embedded clip (${NONCE}).`,
  })

  await loadHome(page)
  const panel = await openCenter(page)
  await openInbox(panel)

  const row = envelope(panel, VIDEO_SUBJECT)
  await expect(row).toBeVisible({ timeout: 20_000 })
  // A 12MB body must not reach the envelope the list (and the push) reads.
  expect(await row.textContent() ?? '').not.toContain(TINY_MP4_BASE64.slice(0, 40))

  await row.click()
  const frame = page.locator('.hib-reader .hib-html-frame')
  await expect(frame).toBeVisible({ timeout: 30_000 })

  const inner = page.frameLocator('.hib-html-frame')
  const video = inner.locator('video')
  await expect(video).toHaveCount(1, { timeout: 30_000 })
  // Byte-identical sources, and a tail marker after 12MB of prose: together they
  // rule out truncation anywhere in the body.
  expect(await video.getAttribute('src')).toBe(`data:video/mp4;base64,${TINY_MP4_BASE64}`)
  expect(await inner.locator('audio').getAttribute('src')).toBe(`data:audio/mpeg;base64,${TINY_MP3_BASE64}`)
  await expect(inner.locator('body')).toContainText(VIDEO_TAIL_MARKER, { timeout: 30_000 })
  await shot(page, 'e2e-10-video-letter-reader')

  const { document: readerDoc, lane } = await readerDocument(request, frame)
  expect(lane).toBe('streamed')
  const policy = readerDoc.match(/content="(default-src[^"]*)"/)?.[1] ?? ''
  expect(policy).toContain('media-src data: blob:')
  expect(policy).not.toMatch(/https?:/)

  // Does the clip actually decode? Same document, same CSP, in a page that can
  // be asked (the reader iframe has no allow-scripts, so it cannot answer).
  const probe = await browser.newPage()
  const blocked: string[] = []
  probe.on('console', (m) => {
    if (/Content Security Policy|Refused to load/i.test(m.text())) blocked.push(m.text())
  })
  await probe.setContent(readerDoc, { waitUntil: 'load' })
  const clip = await probe.evaluate(async () => {
    const el = document.querySelector('video') as HTMLVideoElement | null
    if (!el) return { duration: 0, width: 0, error: 'no video element' }
    await new Promise<void>((resolve) => {
      if (el.readyState >= 1) return resolve()
      el.addEventListener('loadedmetadata', () => resolve(), { once: true })
      el.addEventListener('error', () => resolve(), { once: true })
      setTimeout(() => resolve(), 20_000)
    })
    return { duration: el.duration, width: el.videoWidth, error: el.error ? `code ${el.error.code}` : null }
  })
  await probe.close()
  expect(blocked, `CSP blocked the letter's own video: ${blocked.join(' | ')}`).toHaveLength(0)
  expect(clip.error).toBeNull()
  expect(clip.duration).toBeGreaterThan(0)
  // videoWidth only becomes non-zero once a real frame was decoded.
  expect(clip.width).toBeGreaterThan(0)
})

/**
 * A 30MB letter — bigger than every frame and parser on its path — read in the
 * real UI. This is the test that says the size limit is gone.
 *
 * The distinction it draws is the whole design. 30MB cannot be INLINED at all:
 * the inbox routes' express parser stops at 24mb, because a cloud replica relays
 * an inline letter JSON to the primary in one WebSocket frame and `ws` answers an
 * oversized frame by closing the socket with 1009. So the body is STAGED first
 * (raw bytes streamed to a file, no JSON parser involved) and the letter carries
 * only `html_ref`; the reader then streams the document back from
 * `/:id/body?frame=1`. Both halves are asserted here, plus the negative control
 * that the inline lane really would have refused it.
 */
test('a 30MB letter (past every inline limit) is staged, read, and plays', async ({ page, request, browser }) => {
  test.setTimeout(300_000)

  const subject = `Overnight digest, unabridged (${NONCE})`
  const tail = `STAGED-TAIL-${NONCE}`
  // Derive the repeat count from the target so the body cannot quietly drift back
  // under 30MB when the sentence is reworded (it did once, by 130KB).
  const SENTENCE = 'The overnight run finished and nothing was cut this time. '
  const filler = `<p>${SENTENCE.repeat(Math.ceil((31 * 1024 * 1024) / SENTENCE.length))}</p>`
  const html = `<h2>Unabridged digest</h2>`
    + `<audio controls preload="metadata" src="data:audio/mpeg;base64,${TINY_MP3_BASE64}"></audio>`
    + `<video controls preload="metadata" src="data:video/mp4;base64,${TINY_MP4_BASE64}"></video>`
    + `${filler}<p>${tail}</p>`
  const bytes = Buffer.byteLength(html)
  expect(bytes).toBeGreaterThan(30 * 1024 * 1024)
  expect(bytes).toBeLessThan(LETTER_HTML_MAX_BYTES)

  // Negative control FIRST: inline really is refused at this size, and the 413
  // names the way through rather than reading as a product limit.
  const refused = await request.post('/api/v1/human-inbox', {
    data: { subject: `${subject} (inline attempt)`, type: 'info', html },
  })
  expect(refused.status()).toBe(413)
  const refusedBody = await refused.json() as { error: { code: string; message: string } }
  expect(refusedBody.error.code).toBe('too_large')
  expect(refusedBody.error.message).toMatch(/human-inbox\/body/)

  // The lane that works: raw bytes up, then a letter carrying the ref.
  const staged = await request.post('/api/v1/human-inbox/body', {
    headers: { 'Content-Type': 'application/octet-stream' },
    data: Buffer.from(html, 'utf-8'),
  })
  expect(staged.status(), await staged.text()).toBe(201)
  const { ref, bytes: stagedBytes } = await staged.json() as { ref: string; bytes: number }
  expect(stagedBytes).toBe(bytes)

  const sent = await request.post('/api/v1/human-inbox', {
    data: { subject, type: 'info', html_ref: ref, text: `Unabridged digest (${NONCE}).` },
  })
  expect(sent.status(), await sent.text()).toBe(201)

  await loadHome(page)
  const panel = await openCenter(page)
  await openInbox(panel)

  const row = envelope(panel, subject)
  await expect(row).toBeVisible({ timeout: 20_000 })
  // 30MB of body must not reach the envelope the list (and the phone push) reads.
  expect(await row.textContent() ?? '').not.toContain(TINY_MP4_BASE64.slice(0, 40))

  await row.click()
  const frame = page.locator('.hib-reader .hib-html-frame')
  await expect(frame).toBeVisible({ timeout: 60_000 })

  const inner = page.frameLocator('.hib-html-frame')
  await expect(inner.locator('video')).toHaveCount(1, { timeout: 60_000 })
  expect(await inner.locator('video').getAttribute('src')).toBe(`data:video/mp4;base64,${TINY_MP4_BASE64}`)
  expect(await inner.locator('audio').getAttribute('src')).toBe(`data:audio/mpeg;base64,${TINY_MP3_BASE64}`)
  // The marker sits after 30MB of prose: it can only render if nothing anywhere
  // in the chain truncated the document.
  await expect(inner.locator('body')).toContainText(tail, { timeout: 60_000 })
  await shot(page, 'e2e-11-staged-30mb-letter')

  const { document: readerDoc, lane } = await readerDocument(request, frame)
  expect(lane).toBe('streamed')
  expect(Buffer.byteLength(readerDoc)).toBeGreaterThan(bytes)
  const policy = readerDoc.match(/content="(default-src[^"]*)"/)?.[1] ?? ''
  expect(policy).toContain("default-src 'none'")
  expect(policy).toContain('media-src data: blob:')
  expect(policy).not.toMatch(/https?:/)

  // Range works on the raw document, which is what makes a resumable or seeking
  // reader possible at this size rather than an all-or-nothing download.
  const detail = await request.get(`/api/v1/human-inbox`)
  const letters = (await detail.json() as { letters: Array<{ id: string; subject: string }> }).letters
  const id = letters.find(l => l.subject === subject)?.id
  expect(id).toBeTruthy()
  const ranged = await request.get(`/api/v1/human-inbox/${id}/body`, { headers: { Range: 'bytes=0-63' } })
  expect(ranged.status()).toBe(206)
  expect(ranged.headers()['content-range']).toBe(`bytes 0-63/${bytes}`)

  // And it decodes: same document, same CSP, in a page that can be asked.
  const probe = await browser.newPage()
  const blocked: string[] = []
  probe.on('console', (m) => {
    if (/Content Security Policy|Refused to load/i.test(m.text())) blocked.push(m.text())
  })
  await probe.setContent(readerDoc, { waitUntil: 'load' })
  const clip = await probe.evaluate(async () => {
    const el = document.querySelector('video') as HTMLVideoElement | null
    if (!el) return { duration: 0, width: 0, error: 'no video element' }
    await new Promise<void>((resolve) => {
      if (el.readyState >= 1) return resolve()
      el.addEventListener('loadedmetadata', () => resolve(), { once: true })
      el.addEventListener('error', () => resolve(), { once: true })
      setTimeout(() => resolve(), 30_000)
    })
    return { duration: el.duration, width: el.videoWidth, error: el.error ? `code ${el.error.code}` : null }
  })
  await probe.close()
  expect(blocked, `CSP blocked the staged letter's video: ${blocked.join(' | ')}`).toHaveLength(0)
  expect(clip.error).toBeNull()
  expect(clip.duration).toBeGreaterThan(0)
  expect(clip.width).toBeGreaterThan(0)
})
