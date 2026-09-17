/**
 * A pending AskUserQuestion must be answerable the moment its session opens,
 * however long ago it was asked.
 *
 * 2026-09-16: a session asked a question at 20:13; the user opened it at 22:00
 * from the notification and saw only the `✓ AskUserQuestion` history row, and no
 * card, nothing to click. The card came back ~50s later, when the server's
 * 60-second re-emit re-added it. Two layers had agreed to hide it:
 *   · session:stream-subscribe treats a `running` record older than 5 min as
 *     stale and answers isStreaming=false: right for an orphaned turn, wrong
 *     for one blocked on the human;
 *   · with no live turn the render filter's live-tail guard drops away, the
 *     window around the card is fully matched by history (the tool_use row
 *     persisted before the ask), and the card was reclaimed as "pure UI".
 *
 * The fixture (test-server.ts, STALE_QUESTION) reproduces the exact state: a
 * processless session whose record has been `running` for 10 minutes with a
 * durable pendingPermission, a JSONL holding the text + tool_use twins, and a
 * stream buffer still marked streaming with the pending card last. There is no
 * CLI behind it, so nothing re-emits the request: a reclaimed card stays gone,
 * and the assertions below cannot pass by waiting.
 */
import fs from 'node:fs/promises'
import { test, expect, type Page } from '@playwright/test'
import { showEverything } from './todo-panel-helpers'

const SESSION_ID = 'pw-question-stale-session'
const REQUEST_ID = 'req-question-stale'
const SCREENSHOT_DIR = '/tmp/ask-user-question-stale-open'

const TASK_ID = 'pw-task-question-stale'
const PANEL = `.main-page-session-column .session-panel[data-session-id="${SESSION_ID}"]`

/** Open the session column with a plain click on the task ROW (a task with a
 *  live session opens it). Not the title: its first click focuses, its second
 *  enters rename mode, so a reopen would land in an editor. Not the kebab: in
 *  WebKit the ⋮ button does not take focus and the row's scroll-into-view eats
 *  the click. The click is dispatched on the row element itself so it cannot
 *  land on a child with its own handler. Open columns persist across a reload,
 *  in which case the panel is already there. */
async function openSession(page: Page): Promise<void> {
  if (await page.locator(PANEL).count() > 0) return
  await page.locator('.todo-search-input').fill(SESSION_ID)
  const task = page.locator(`.todo-panel-item[data-task-id="${TASK_ID}"]`)
  await expect(task).toBeVisible({ timeout: 15_000 })
  await task.dispatchEvent('click')
  await page.locator('.todo-search-input').fill('')
}

/** The card, its history row, and nothing doubled. */
async function expectQuestionCard(page: Page): Promise<void> {
  const panel = page.locator(PANEL)
  await expect(panel).toBeVisible({ timeout: 15_000 })
  const card = panel.locator('.ask-user-question-card')
  // Well under the 60s re-emit the old code leaned on; the fixture has none anyway.
  await expect(card).toBeVisible({ timeout: 8_000 })
  await expect(card).toContainText('Which accent colour?')
  await expect(card.getByRole('button', { name: /Teal/ })).toBeVisible()
  await expect(card.getByRole('button', { name: /Amber/ })).toBeVisible()
  await expect(card).toHaveCount(1)
  // ...and it STAYS: the history refetches that follow a subscribe (turn-prompt,
  // batch) re-run the render filter, and a card that shows for one frame and is
  // then reclaimed is the bug wearing a different timing. Sample for 2s.
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(100)
    expect(await card.isVisible(), `card hidden ${(i + 1) * 100}ms after first showing`).toBe(true)
  }
  // The persisted tool row renders next to the card, not instead of it (a
  // single tool sits in a collapsible "Used a tool ›" run; either form counts).
  const toolRow = panel.locator('.chat-tool-block-name', { hasText: 'AskUserQuestion' })
    .or(panel.getByText(/Used a tool/))
  await expect(toolRow.first()).toBeVisible()
  // The intro text is on screen exactly once (history absorbed the streamed copy).
  await expect(panel.getByText('Before I change the theme, one question.')).toHaveCount(1)
}

test('a question asked >5 min ago is on screen the moment the session opens, and survives reopen + reload', async ({ page }, testInfo) => {
  test.setTimeout(90_000)
  let submittedBody: Record<string, unknown> | undefined
  await page.route(`**/api/sessions/${SESSION_ID}/permission`, async (route) => {
    submittedBody = route.request().postDataJSON() as Record<string, unknown>
    await route.fulfill({ json: { status: 'resolved', requestId: REQUEST_ID, allow: true } })
  })

  const consoleErrors: string[] = []
  // The stream/status trail is the evidence when the card is missing: which
  // snapshot was adopted, what the status store believed, whether the REST
  // fallback retired the card as a zombie. Attached to the report either way.
  const trail: string[] = []
  const stamp = () => new Date().toISOString().slice(11, 23)
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text())
    const t = m.text()
    if (t.includes(SESSION_ID) && /\[stream\]|\[session-status\]|render-filter|permission|\[session-history\]|\[session-cache\]/.test(t)) {
      trail.push(`${stamp()} ${t.slice(0, 400)}`)
    }
  })
  // What the server told this page about the session: the REST fallback keys
  // its zombie sweep off process_status and pendingPermissions.
  page.on('response', async (r) => {
    const u = new URL(r.url())
    if (u.pathname !== `/api/sessions/${SESSION_ID}` && u.pathname !== '/api/sessions/status') return
    try {
      const j = await r.json() as { session?: { process_status?: string }; pendingPermissions?: unknown[]; statuses?: Record<string, { process_status?: string }> }
      const ps = j.session?.process_status ?? j.statuses?.[SESSION_ID]?.process_status
      trail.push(`${stamp()} REST ${u.pathname} → ${r.status()} process_status=${ps} pending=${j.pendingPermissions?.length ?? '-'}`)
    } catch { /* non-JSON or aborted */ }
  })

  try {
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    await showEverything(page)

    // 1. First open: the cold path (no cache): server snapshot + REST fallback.
    await openSession(page)
    await expectQuestionCard(page)
    await fs.mkdir(SCREENSHOT_DIR, { recursive: true })
    await page.locator(PANEL).screenshot({ path: `${SCREENSHOT_DIR}/01-first-open.png` })

    // 2. Close and reopen, twice: the warm path (session-cache) must not have GC'd it.
    for (let i = 0; i < 2; i++) {
      await page.locator(PANEL).getByRole('button', { name: 'Close session panel' }).click()
      await expect(page.locator(PANEL)).toHaveCount(0)
      await openSession(page)
      await expectQuestionCard(page)
    }
    await page.locator(PANEL).screenshot({ path: `${SCREENSHOT_DIR}/02-after-reopen.png` })

    // 3. Full reload: fresh subscribe against the same server state.
    await page.reload()
    await page.waitForLoadState('networkidle')
    await expectQuestionCard(page)

    // The run spans at least one health-monitor tick (30s). The fixture record
    // must still be the one under test: a processless `running` row gets
    // stopped by the orphan dead-pool, and a stopped session's card is retired
    // by design, which is a fixture failure, not the bug this spec pins.
    const rec = await page.evaluate(async (sid) => {
      const r = await fetch(`/api/sessions/${sid}`)
      const j = await r.json() as { session?: { process_status?: string; status_reason?: string }; pendingPermissions?: unknown[] }
      return { ps: j.session?.process_status, reason: j.session?.status_reason, pending: j.pendingPermissions?.length }
    }, SESSION_ID)
    expect(rec, 'fixture session still running with its question pending').toMatchObject({ ps: 'running', pending: 1 })

    // 4. Answer it: the real card submits the chosen label as `answers`.
    const card = page.locator(PANEL).locator('.ask-user-question-card')
    await card.getByRole('button', { name: /Teal/ }).click()
    await card.getByRole('button', { name: 'Submit' }).click()
    await expect(page.locator(PANEL).locator('.permission-request-resolved--allowed')).toContainText('Which accent colour?')
    expect(submittedBody).toMatchObject({
      requestId: REQUEST_ID,
      allow: true,
      answers: { 'Which accent colour?': 'Teal' },
    })
    await page.locator(PANEL).screenshot({ path: `${SCREENSHOT_DIR}/03-answered.png` })

    // The search box we type the session id into also asks /api/search/agent,
    // which the fixture answers 503 (WALNUT_DISABLE_SEARCH=1): expected noise.
    expect(consoleErrors.filter((t) => !/favicon|net::ERR_ABORTED|Failed to load resource.*503/.test(t))).toEqual([])
  } finally {
    // Header badge + block inventory at exit: what the reader would have seen.
    try {
      const badge = await page.locator(PANEL).locator('.session-panel-header, .session-header').first().innerText({ timeout: 1000 }).catch(() => '(no header)')
      const cards = await page.locator(PANEL).locator('.ask-user-question-card, .permission-request-card').count()
      trail.push(`${stamp()} EXIT header="${badge.replace(/\s+/g, ' ').slice(0, 200)}" permissionCards=${cards}`)
    } catch { /* page gone */ }
    const body = trail.join('\n')
    await testInfo.attach('browser-trail', { body, contentType: 'text/plain' })
    // test-results/ is shared machine-wide and wiped by every run; keep a copy
    // where a later run cannot take it away.
    await fs.mkdir(SCREENSHOT_DIR, { recursive: true })
    await fs.writeFile(`${SCREENSHOT_DIR}/trail-${testInfo.project.name}-${Date.now()}.txt`, body)
  }
})
