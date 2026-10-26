/**
 * Question stack, asking and sending (spec slice 1, section 5.4 and 5.10): a
 * question is written once, by its first send, and its answer lives on its page.
 *
 * Covers C3 (the bubble and the answer land on the question page, never on root),
 * C41 (Esc while the answer is still coming: the turn goes on), C25 (live
 * Asked-from states), C82 (unread dot until the page is viewed), C59 (the same
 * passage goes to the existing page; a partial overlap opens a new one), C60
 * (per-page drafts, the `New question (draft)` row, reload), and C68 (a failed
 * turn reads `No answer · Retry`; Retry resends on the same question), C55 (the
 * first send is one PATCH with the anchor and its meta), and C49 (three Asks during
 * one answer: all three reach the CLI while it is still answering, under their own
 * uuids, and are answered in order, each on its page).
 *
 * The mock CLI answers "Hello! I processed your message: <text>", and a message
 * that STARTS with `slow:<ms>` is answered after that delay (a follow-up on the
 * newest question is sent verbatim, so it can start with it). Sends grow the
 * transcript, so this file has its own session (`pw-threads-send-session`) and
 * finds rows by their text, never by count.
 */
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import {
  centreInHistory, DENSE_SESSION, FAILED_SESSION, openThreadsSession, passageRects, readRecord, resetThreadsFixture, selectPassage, modePill, openQuestionList, switchView,
} from './threads-helpers'
import { FAILED_ERROR_TEXT, FAILED_PASSAGES, PARKED_FOLLOW_UP, densePassage } from './threads-fixture'
import { discoverBrowserFixture } from './codex-test-audit'

const SEND_SESSION = 'pw-threads-send-session'
const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const SEND_TASK = 'pw-task-threads-send'
const FAILED_TASK = 'pw-task-threads-failed'
const PHRASE = 'rewrites the index in place'
const READY = 'Phase three only verifies checksums.'
const PARAGRAPH_ROW = '0199bc04-0000-4aaa-8bbb-000000000001'
const DENSE_TASK = 'pw-task-threads-dense'
const DENSE_READY = 'Walk me through part 6 of the storage notes.'

async function shot(page: Page, name: string): Promise<void> {
  const dir = `/tmp/threads-p3/e2e/${test.info().project.name}`
  await fs.mkdir(dir, { recursive: true })
  await page.screenshot({ path: `${dir}/${name}.png` })
}

async function boot(page: Page): Promise<void> {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
}

async function expectDepth(panel: Locator, depth: number): Promise<void> {
  await expect(panel.locator('.thread-stack')).toHaveAttribute('data-thread-depth', String(depth), { timeout: 15_000 })
}

async function resetSend(request: APIRequestContext): Promise<void> {
  const res = await request.patch(`/api/sessions/${SEND_SESSION}`, { data: { thread_anchors: [], pinned_messages: [] } })
  expect(res.ok()).toBe(true)
}

/** Wheel the paragraph into the middle of the box. */
async function centreParagraph(page: Page, panel: Locator): Promise<void> {
  const target = panel.locator(`[data-message-id="${PARAGRAPH_ROW}"]`)
  await expect(target).toBeVisible()
  await centreInHistory(page, panel, target, { maxStep: 600 })
}

/** Wheel the message text holding `phrase` into the middle of the box. */
async function centreText(page: Page, panel: Locator, phrase: string): Promise<void> {
  await centreInHistory(page, panel, phrase)
}

/** Press Ask on the selected passage. Ask here asks in Conversation Mode
 *  (2026-10-23): the column switches and the card opens beside the passage with
 *  its own box focused. */
async function pressAsk(page: Page, panel: Locator): Promise<Locator> {
  await page.locator('[data-testid="quote-pin-pill"] [data-testid="quote-ask-btn"]').click()
  await expect(panel.locator('.session-history[data-view-mode="linear"]')).toHaveCount(1)
  const card = panel.locator('.thread-card')
  await expect(card).toBeVisible()
  await expect(card.locator('.thread-card-input')).toBeFocused()
  return card
}

/** Back to Tree Mode through the pill: the question is the page on screen. The
 *  switch leaves focus on the pill, so the reader clicks into the composer. */
async function backToPage(panel: Locator): Promise<void> {
  await switchView(panel, 'stack')
  await expectDepth(panel, 1)
  await composer(panel).click()
}

/** Select `phrase` in the paragraph, press Ask and land on its page in Tree
 *  Mode. A session without a question has no mode pill yet: there the question
 *  is sent from its card first (`first`), and the pill that comes with it takes
 *  the column back to the page. */
async function askAbout(page: Page, panel: Locator, phrase: string, first?: string): Promise<void> {
  await centreParagraph(page, panel)
  await passageRects(panel, phrase)
  await selectPassage(page, panel, phrase)
  const card = await pressAsk(page, panel)
  if (first !== undefined) {
    const input = card.locator('.thread-card-input')
    await input.fill(first)
    await input.press('Enter')
    await expect(input).toHaveValue('')
    await expect(modePill(panel)).toBeVisible({ timeout: 15_000 })
  }
  await backToPage(panel)
}

function composer(panel: Locator): Locator {
  return panel.locator('.chat-input-textarea').first()
}

async function send(panel: Locator, text: string): Promise<void> {
  const box = composer(panel)
  await box.click()
  await box.fill(text)
  await box.press('Enter')
  await expect(box).toHaveValue('')
}

/** The session's queue rows (server truth): a row leaves once the CLI starts (takes)
 *  its line, not when that line's turn is done. */
type QueueRow = { message: string; status: string; userUuid?: string; lineUuid?: string; heldReason?: string }
async function queueRows(request: APIRequestContext): Promise<QueueRow[]> {
  const res = await request.get(`/api/v1/sessions/${SEND_SESSION}/queue`)
  expect(res.ok(), `GET queue: ${res.status()}`).toBe(true)
  return ((await res.json()) as { messages: QueueRow[] }).messages
}

/** Asked-from rows that are real questions (not a draft row). */
function askedRows(panel: Locator): Locator {
  return panel.locator('.thread-asked-row:not(.is-draft)')
}

/** The question's entry in the map: its row in the labelled panel, its mark on
 *  the rail (the column's width picks the shape). */
async function mapEntry(panel: Locator): Promise<{ entry: Locator; rail: boolean }> {
  const map = panel.locator('.thread-map')
  await expect(map).toHaveCount(1)
  const rail = (await map.getAttribute('data-shape')) === 'rail'
  return { entry: map.locator(rail ? '.thread-map-mark[data-kind="thread"]' : '.thread-map-row[data-kind="thread"]').first(), rail }
}
async function expectMapUnread(panel: Locator, on: boolean): Promise<void> {
  const { entry, rail } = await mapEntry(panel)
  // The panel row says `New` (a status word, no colour dot) while the newest answer is unseen.
  if (!rail) await expect(entry.locator('.thread-status-word[data-kind="new"]')).toHaveCount(on ? 1 : 0, { timeout: 60_000 })
  else if (on) await expect(entry).toHaveAttribute('data-unread', 'true', { timeout: 60_000 })
  else await expect(entry).not.toHaveAttribute('data-unread', 'true')
}

test.describe('Question stack: asking and sending', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(240_000)

  test.beforeEach(async ({ request }) => {
    await resetSend(request)
    await resetThreadsFixture(request, FAILED_SESSION)
  })

  test('the first send writes the question once; its answer lands on its page, also after Esc mid-answer', async ({ page, request }) => {
    await boot(page)
    const panel = await openThreadsSession(page, SEND_SESSION, SEND_TASK, READY)
    const history = panel.locator('.session-history')
    await centreParagraph(page, panel)
    await passageRects(panel, PHRASE)
    await selectPassage(page, panel, PHRASE)
    // Ask here asks in Conversation Mode; the first question is sent from its
    // card (the mode pill comes with the first question).
    const card = await pressAsk(page, panel)
    expect((await readRecord(request, SEND_SESSION)).threadAnchors ?? []).toHaveLength(0)
    // C55: the first send is ONE PATCH carrying the anchor and its meta together.
    const patches: Array<Record<string, unknown>> = []
    page.on('request', (r) => {
      if (r.method() !== 'PATCH' || !r.url().includes(`/api/sessions/${SEND_SESSION}`)) return
      try { patches.push(JSON.parse(r.postData() ?? '{}') as Record<string, unknown>) } catch { patches.push({}) }
    })
    // C3: the bubble shows in the card at once, and on the question's page.
    const input = card.locator('.thread-card-input')
    await input.fill('what does phase two cost')
    await input.press('Enter')
    await expect(input).toHaveValue('')
    await expect(card.locator('.thread-card-q')).toHaveText(['what does phase two cost'])
    await expect(modePill(panel)).toBeVisible({ timeout: 15_000 })
    await backToPage(panel)
    await expect(history).toContainText('what does phase two cost')
    // Map C9: the sent page is a question in the map now, still the current one.
    const map = panel.locator('.thread-map')
    await expect(map.locator('.thread-map-row[data-kind="pending"], .thread-map-mark[data-kind="pending"]')).toHaveCount(0, { timeout: 15_000 })
    await expect((await mapEntry(panel)).entry).toHaveAttribute('data-current', 'true')
    // The mock answers like a model: the words asked, never the quote or the
    // orientation line it was sent with (the record below holds the quote).
    await expect(history).toContainText('processed your message: what does phase two cost', { timeout: 60_000 })
    await shot(page, 'c3-answer-on-page')
    const rec = await readRecord(request, SEND_SESSION)
    expect(rec.threadAnchors ?? []).toHaveLength(1)
    expect((rec.threadAnchors ?? [])[0].quote?.exact).toContain(PHRASE)
    const head = (rec.threadAnchors ?? [])[0].msgId
    expect((rec.threadMeta ?? []).some((m) => m.headId === head && m.status === 'open')).toBe(true)
    const writes = patches.filter((b) => 'thread_anchors' in b || 'thread_meta' in b)
    expect(writes, 'one write for the first send').toHaveLength(1)
    expect(Object.keys(writes[0]).sort()).toEqual(expect.arrayContaining(['thread_anchors', 'thread_meta']))
    const sentMeta = writes[0].thread_meta as Array<{ headId: string; status: string; titleState?: string }>
    expect(sentMeta.find((m) => m.headId === head)).toMatchObject({ status: 'open', titleState: 'pending' })

    // C41: a follow-up the mock answers after 5s; Esc straight away.
    await send(panel, 'slow:5000 and phase three')
    await expect(history).toContainText('and phase three')
    await page.keyboard.press('Escape')
    await expectDepth(panel, 0)
    // Root never shows the question's rows or its answers.
    await expect(history).not.toContainText('what does phase two cost')
    await expect(history).not.toContainText('processed your message')
    const row = askedRows(panel).first()
    await expect(row.locator('.thread-asked-state')).toHaveText(/Waiting…|Answering…/)
    // Map C21: the question's dot says it is being answered, live.
    await expect((await mapEntry(panel)).entry).toHaveAttribute('data-status', /queued|answering/)
    await shot(page, 'c41-answering-at-root')
    // C82: the answer finishes while he is on root: an unread dot with its age.
    const dot = row.locator('.thread-status-dot[data-status="unread"]')
    await expect(dot).toBeVisible({ timeout: 60_000 })
    await expect(row).toHaveAttribute('title', /^Answered /)
    await expect(row.locator('.thread-asked-state')).toHaveCount(0)
    // Map C20 / C21: the map carries the same unread dot, and the live state is over.
    await expectMapUnread(panel, true)
    await expect((await mapEntry(panel)).entry).not.toHaveAttribute('data-status', /queued|answering/)
    await shot(page, 'c82-unread-at-root')
    // Back on the page, the answer is complete; leaving clears the dot.
    await row.click()
    await expectDepth(panel, 1)
    await expect(history).toContainText('processed your message: and phase three')
    await page.keyboard.press('Escape')
    await expectDepth(panel, 0)
    await expect(askedRows(panel).first().locator('.thread-status-dot[data-status="unread"]')).toHaveCount(0)
    await expectMapUnread(panel, false)
    // No reload here: the mock CLI's resumed turns never reach this fixture's saved
    // history (the app says so in a toast), so after a reload the question's rows
    // are gone. The seen-time survives reloads through thread-stack-persist
    // (unit tested).
  })

  test('the same passage again goes to its page; a partial overlap opens a new one', async ({ page, request }) => {
    await boot(page)
    const panel = await openThreadsSession(page, SEND_SESSION, SEND_TASK, READY)
    await askAbout(page, panel, PHRASE, 'is the rewrite atomic')
    await expect(panel.locator('.session-history')).toContainText('processed your message', { timeout: 60_000 })
    await page.keyboard.press('Escape')
    await expectDepth(panel, 0)
    const anchors = (await readRecord(request, SEND_SESSION)).threadAnchors ?? []
    expect(anchors).toHaveLength(1)

    // C59: the same words, selected again, open the existing page.
    await askAbout(page, panel, PHRASE)
    await expect(panel.locator('.thread-same-passage')).toHaveText('You already asked about this passage.')
    // N35: the composer names the question it posts into.
    await expect(composer(panel)).toHaveAttribute('placeholder', /^Reply in “.+”…$/)
    const pageTitle = (await panel.locator('.thread-stack-header .thread-stack-title').textContent()) ?? ''
    expect(await composer(panel).getAttribute('placeholder')).toContain(pageTitle.slice(0, 20))
    await expect(panel.locator('.session-history')).toContainText('is the rewrite atomic')
    await send(panel, 'and if it fails halfway')
    await expect.poll(async () => ((await readRecord(request, SEND_SESSION)).threadAnchors ?? []).length).toBe(2)
    await page.keyboard.press('Escape')
    await expectDepth(panel, 0)
    await expect(askedRows(panel)).toHaveCount(1)
    await expect(modePill(panel)).toBeVisible()

    // A selection that only overlaps opens a new, unwritten page.
    await askAbout(page, panel, 'rewrites the index')
    await expect(panel.locator('.thread-same-passage')).toHaveCount(0)
    await expect(panel.locator('.thread-quote-head')).toContainText('rewrites the index')
    await expect(composer(panel)).toHaveAttribute('placeholder', 'Ask about this passage…')
    await page.keyboard.press('Escape')
    await expectDepth(panel, 0)
    expect(((await readRecord(request, SEND_SESSION)).threadAnchors ?? []).length).toBe(2)
  })

  test('a send names where it goes back to, right after the previous send, before history catches up (C58)', async ({ page }) => {
    await boot(page)
    const panel = await openThreadsSession(page, SEND_SESSION, SEND_TASK, READY)
    const history = panel.locator('.session-history')
    await askAbout(page, panel, PHRASE, 'orientation question one')
    await expect(history).toContainText('processed your message', { timeout: 60_000 })
    await page.keyboard.press('Escape')
    await expectDepth(panel, 0)
    // Root after a dive: the main-conversation line leads.
    await send(panel, 'root after the dive')
    await expect(history).toContainText('(Back to the main conversation)')
    await expect(history).toContainText('processed your message: root after the dive', { timeout: 60_000 })
    // At once back on the question: the newest turn is root's (only the
    // optimistic row says so yet), so the follow-up names its question.
    await askedRows(panel).first().click()
    await expectDepth(panel, 1)
    await send(panel, 'follow up check one')
    await expect(history).toContainText('(Back to the earlier question about “', { timeout: 60_000 })
    await expect(history).toContainText('follow up check one')
    // The newest turn is now this page: no line.
    await expect(history).toContainText('processed your message: follow up check one', { timeout: 60_000 })
    await send(panel, 'follow up check two')
    await expect(history).toContainText('processed your message: follow up check two', { timeout: 60_000 })
    await page.keyboard.press('Escape')
    await expectDepth(panel, 0)
  })

  test('every page keeps its own draft; an unsent page with text leaves a draft row that leads back', async ({ page }) => {
    // Drafts never touch the server, so the dense fixture (with a real drawer) is safe here.
    await boot(page)
    let panel = await openThreadsSession(page, DENSE_SESSION, DENSE_TASK, DENSE_READY)
    await composer(panel).click()
    await composer(panel).fill('half a root thought')
    // Part of an asked passage: a partial overlap opens a new, unwritten page.
    const phrase = densePassage('Q9').slice(0, 26)
    await centreText(page, panel, phrase)
    await selectPassage(page, panel, phrase)
    await pressAsk(page, panel)
    await switchView(panel, 'stack')
    await expectDepth(panel, 1)
    // C60: the pending page starts empty; the root draft is untouched.
    await expect(composer(panel)).toHaveValue('')
    await composer(panel).fill('a pending question draft')
    await panel.locator('.thread-stack-back').click()
    await expectDepth(panel, 0)
    await expect(composer(panel)).toHaveValue('half a root thought')
    const draftRow = panel.locator('.thread-asked-row.is-draft')
    await expect(draftRow).toHaveText(/New question \(draft\)/)
    await openQuestionList(page, panel)
    await expect(panel.locator('.thread-drawer .thread-tree-row[data-kind="draft"]')).toHaveCount(1)
    await page.keyboard.press('Escape')
    await expect(panel.locator('.thread-drawer')).toBeHidden()
    await shot(page, 'c60-draft-row')
    // A reload keeps both drafts (ChatInput's own persistence plus the stack's).
    await page.waitForTimeout(800)
    await page.reload()
    await page.waitForLoadState('networkidle')
    panel = await openThreadsSession(page, DENSE_SESSION, DENSE_TASK, DENSE_READY)
    await expect(composer(panel)).toHaveValue('half a root thought')
    const row = panel.locator('.thread-asked-row.is-draft')
    await expect(row).toBeVisible()
    await centreText(page, panel, phrase)
    await row.click()
    await expectDepth(panel, 1)
    await expect(panel.locator('.thread-quote-head')).toContainText(phrase)
    await expect(composer(panel)).toHaveValue('a pending question draft')
    // Cleared, the page leaves nothing behind.
    await composer(panel).fill('')
    await page.waitForTimeout(400)
    await panel.locator('.thread-stack-back').click()
    await expectDepth(panel, 0)
    await expect(panel.locator('.thread-asked-row.is-draft')).toHaveCount(0)
    await composer(panel).fill('')
  })

  test('a parked follow-up files under its question, which reads failed; each failed page offers one Retry (N3, N4, N41, C68)', async ({ page }) => {
    await boot(page)
    const panel = await openThreadsSession(page, FAILED_SESSION, FAILED_TASK, FAILED_PASSAGES[1])
    const history = panel.locator('.session-history')
    const rows = askedRows(panel)
    await expect(rows).toHaveCount(2)
    // N3: the parked row is the second question's follow-up, so root never shows
    // it (nor its Retry / Discard), and that question derives failed (spec 5.10).
    await expect(rows.nth(1)).toHaveAttribute('data-status', 'failed')
    await expect(rows.nth(1).locator('.thread-asked-state--failed')).toHaveText(/No answer · Retry/)
    // Ring + error dot on both failed rows (spec 5.10), not only in the drawer.
    await expect(rows.nth(0).locator('.thread-status-dot-error')).toHaveCount(1)
    await expect(rows.nth(1).locator('.thread-status-dot-error')).toHaveCount(1)
    await expect(history).not.toContainText(PARKED_FOLLOW_UP)
    await expect(history.locator('.session-msg-retry-btn')).toHaveCount(0)
    await rows.nth(1).click()
    await expectDepth(panel, 1)
    await expect(history).toContainText(PARKED_FOLLOW_UP)
    await expect(history.locator('.session-msg-failed .session-msg-retry-btn')).toHaveCount(1)
    // N41: one Retry for the one undelivered message (the row's), and the strip
    // says what happened: it was never sent, no turn ended. No em dash either.
    const parkedStrip = panel.locator('[data-thread-strip="parked"]')
    await expect(parkedStrip).toContainText('Not sent yet')
    await expect(parkedStrip).not.toContainText('The last turn ended')
    await expect(panel.locator('button', { hasText: /^Retry$/ })).toHaveCount(1)
    await expect(panel.locator('.session-msg-failed-badge')).not.toContainText('\u2014')
    await shot(page, 'n3-parked-on-its-page')
    await panel.locator('.thread-stack-back').click()
    await expectDepth(panel, 0)
    // N4: the errored question's own page carries Retry and the failed-turn hint.
    await rows.nth(0).click()
    await expectDepth(panel, 1)
    await expect(history).toContainText(FAILED_ERROR_TEXT)
    const strip = panel.locator('[data-thread-strip="failed"]')
    await expect(strip).toContainText('No answer')
    await expect(strip).toContainText('The last turn ended before an answer arrived.')
    await expect(strip.locator('.thread-strip-btn', { hasText: 'Retry' })).toBeVisible()
    await shot(page, 'n4-in-page-retry')
    await panel.locator('.thread-stack-back').click()
    await expectDepth(panel, 0)
  })

  test('a turn that ended in an error reads "No answer · Retry"; Retry asks again on the same question', async ({ page, request }) => {
    await boot(page)
    const panel = await openThreadsSession(page, FAILED_SESSION, FAILED_TASK, FAILED_PASSAGES[1])
    const rows = askedRows(panel)
    await expect(rows).toHaveCount(2)
    // C68: the turn that ended in an error reads as not answered (the parked
    // follow-up's question is pinned by the test above).
    await expect(rows.nth(0).locator('.thread-asked-state--failed')).toHaveText(/No answer · Retry/)
    await expect(rows.nth(0)).toHaveAttribute('data-status', 'failed')
    await openQuestionList(page, panel)
    const failedTreeRows = panel.locator('.thread-drawer .thread-tree-row[data-status="failed"]')
    await expect(failedTreeRows.first()).toBeVisible()
    await expect(failedTreeRows.first().locator('.thread-status-dot-error')).toHaveCount(1)
    await page.keyboard.press('Escape')
    await shot(page, 'c68-no-answer')
    const anchorsBefore = ((await readRecord(request, FAILED_SESSION)).threadAnchors ?? []).length
    await rows.first().locator('.thread-asked-inline-btn', { hasText: 'Retry' }).click()
    await expect.poll(async () => ((await readRecord(request, FAILED_SESSION)).threadAnchors ?? []).length).toBe(anchorsBefore + 1)
    await expect(rows.first()).not.toHaveAttribute('data-status', 'failed', { timeout: 60_000 })
    await rows.first().click()
    await expectDepth(panel, 1)
    await expect(panel.locator('.thread-quote-head')).toContainText(FAILED_PASSAGES[0])
    await expect(panel.locator('.session-history')).toContainText('processed your message', { timeout: 60_000 })
    await shot(page, 'c68-retried')
  })

  /** C49: three questions asked while a 35s root answer is still coming; back on
   *  root once they are all out. */
  async function askThreeDuringRoot(page: Page, request: APIRequestContext, tag: string): Promise<{ panel: Locator; history: Locator }> {
    await boot(page)
    const panel = await openThreadsSession(page, SEND_SESSION, SEND_TASK, READY)
    const history = panel.locator('.session-history')
    // C49: a root turn the mock answers after 35s; three questions go out meanwhile.
    // (15s was not enough under machine load: the three Asks took 17s, so the root
    // answer ended first and the questions never met a running turn.) The long-turn
    // mode keeps the process alive after it, as the real CLI does; the plain mock
    // exits after each turn, and the lines it held go back to the queue for the next.
    await send(panel, 'snapshot-long-turn:35000:root turn')
    await expect(history).toContainText('root turn')
    const phrases = ['The migration runs in three phases', PHRASE, 'only verifies checksums']
    // Each question's own turn takes 3s, so the order the CLI runs them in can be read
    // off the queue. The mock strips the prefix: the answer is "processed your message:
    // queued question N".
    // Tagged per test: a test before this one may leave its own questions queued
    // on the same session, and a row is found by its words.
    const asks = [1, 2, 3].map((n) => `slow:3000 queued question ${n} ${tag}`)
    const t0 = Date.now()
    for (let i = 0; i < 3; i++) {
      // The first is sent from its card (no question yet, so no mode pill).
      if (i === 0) await askAbout(page, panel, phrases[i], asks[i])
      else {
        await askAbout(page, panel, phrases[i])
        await send(panel, asks[i])
      }
      if (i < 2) { await page.keyboard.press('Escape'); await expectDepth(panel, 0) }
    }
    test.info().annotations.push({ type: 'three asks took', description: `${Date.now() - t0}ms` })
    // A question row is never held back from a running turn (2026-10-23): each line
    // goes to the CLI at once and the CLI queues it. So all three are out (written
    // under their line's uuid, none held) while the root answer is still coming,
    // and each row stays until the CLI takes its line (the first one too: Claude
    // Code's init declares that it reports its queue).
    const rowOf = (rows: QueueRow[], n: number) => rows.find((r) => r.message.includes(`queued question ${n} ${tag}`))
    const stateOf = (rows: QueueRow[], n: number) => { const r = rowOf(rows, n); return r ? `${r.status}:${!!r.lineUuid && !r.heldReason}` : 'missing' }
    await expect.poll(async () => {
      const rows = await queueRows(request)
      return [1, 2, 3].map((n) => stateOf(rows, n)).join(' ')
    }, { timeout: 15_000 }).toBe('processing:true processing:true processing:true')
    await expect(history, 'all three went out while the root answer was still coming').not.toContainText('ran to completion')
    await shot(page, 'c49-all-sent')
    // Three questions, three user lines under their own uuids: the uuid each row
    // went out with is the head of its question.
    const sent = await queueRows(request)
    const uuids = [1, 2, 3].map((n) => rowOf(sent, n)?.userUuid ?? '')
    expect(new Set(uuids).size, `uuids ${uuids.join(',')}`).toBe(3)
    expect(uuids.every((u) => u.length > 0)).toBe(true)
    await expect.poll(async () => ((await readRecord(request, SEND_SESSION)).threadAnchors ?? []).length).toBe(3)
    const heads = ((await readRecord(request, SEND_SESSION)).threadAnchors ?? []).map((a) => a.msgId)
    expect([...heads].sort()).toEqual([...uuids].sort())
    // Back on root: the root answer lands here.
    await page.keyboard.press('Escape')
    await expectDepth(panel, 0)
    await expect(askedRows(panel)).toHaveCount(3)
    return { panel, history }
  }

  test('three Asks during one answer: all three reach the CLI at once, under their own uuids', async ({ page, request }) => {
    await askThreeDuringRoot(page, request, 'at-once')
  })

  test('three Asks during one answer are answered in order, after the answer they waited behind', async ({ page, request }) => {
    const { panel } = await askThreeDuringRoot(page, request, 'in-order')
    // Every row leaves the queue and every question is answered. Two can leave in
    // one poll: the mock runs a queued line without its slow: delay and exits after
    // it, and the next process takes the rest at once.
    const keys = [1, 2, 3].map((n) => `queued question ${n} in-order`)
    const rowStatus = (i: number) => askedRows(panel).nth(i).getAttribute('data-status')
    await expect.poll(async () => {
      const rows = await queueRows(request)
      const queued = keys.filter((k) => rows.some((r) => r.message.includes(k)))
      const open: number[] = []
      for (let i = 0; i < 3; i++) {
        const st = await rowStatus(i)
        if (st === 'queued' || st === 'answering') open.push(i + 1)
      }
      return `queued: ${queued.join(', ') || 'none'} | unanswered: ${open.join(', ') || 'none'}`
    }, { timeout: 120_000, intervals: [250] }).toBe('queued: none | unanswered: none')
    // The order is the CLI's own: its output, in the session's stream capture, has
    // the root answer, then questions 1, 2 and 3, across every process it took.
    const { fixtureRoot } = await discoverBrowserFixture(TEST_PORT)
    const tmpBase = fixtureRoot.replace(/\/ps-fixture$/, '')
    const streams = [`${tmpBase}/daemon/streams/${SEND_SESSION}.jsonl`, `${tmpBase}/daemon-streams/${SEND_SESSION}.jsonl`]
    const stream = (await Promise.all(streams.map((f) => fs.readFile(f, 'utf8').catch(() => '')))).join('\n')
    // The capture holds every turn on this session, the test before this one's
    // too (its lines are tagged at-once). The CLI writes no user line there, so
    // this test's root answer is the last one before question 1's answer, after
    // anything of the test before.
    const before = Math.max(-1, ...[1, 2, 3].map((n) => stream.lastIndexOf(`queued question ${n} at-once`)))
    const answers = keys.map((k) => stream.indexOf(`processed your message: ${k}`))
    const at = [stream.lastIndexOf('ran to completion', answers[0]), ...answers]
    expect(at.every((i) => i > before), `found in the stream at ${at.join(', ')}, after ${before}`).toBe(true)
    expect([...at].sort((a, b) => a - b), 'root, then questions 1, 2 and 3').toEqual(at)
    // Which page each answer lands on is not checked here: this session's history
    // is its seeded transcript, and the mock files no turn in it, so a finished
    // answer is in no history row. Placement by the line's uuid, the whole turn
    // with it, is tests/web/thread-tree.test.ts.
  })
})
