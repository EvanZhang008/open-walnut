/**
 * Playwright browser test: a COMPLETED task that gets a new message goes back to
 * IN_PROGRESS instead of staying "done" while its agent works (2026-09-23 user
 * call: "if a completed task gets re-messaged it should go back to in progress").
 *
 * Real UI, real server, mock CLI. The flow a user actually performs:
 *   1. start a session from the draft column → the turn ends → the task is red
 *      (handed back);
 *   2. click "Mark complete" on the task card → green check, CLI stopped;
 *   3. type a follow-up in the SAME session column (still on screen) → the task
 *      must leave "done" the moment the message is accepted, and be handed back
 *      (red) again when the reopened turn ends;
 *   4. do it a second time — the reopen is not a one-shot.
 *
 * Before the fix the card kept its green check through steps 3-4 and the new
 * output was never announced (no red row, no unread dot).
 */
import fs from 'node:fs/promises'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { REAL_PANEL, draftComposer, openDraftOnCwd } from './draft-helpers'
import { selectSection } from './todo-panel-helpers'
import { sessionResultPhase } from '../../../src/core/phase'

const SCREENSHOT_DIR = process.env.PW_SCREENSHOT_DIR ?? '/tmp/task-reopen'
const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const HANDBACK_PHASE = sessionResultPhase('IN_PROGRESS')!

let fixtureRoot = ''

test.describe.configure({ mode: 'serial' })
test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })

test.beforeAll(async () => {
  ;({ fixtureRoot } = await discoverBrowserFixture(TEST_PORT))
  await fs.mkdir(SCREENSHOT_DIR, { recursive: true })
})

async function openHome(page: Page): Promise<void> {
  await page.setContent(`<a href="http://localhost:${TEST_PORT}/">Open Walnut</a>`)
  await page.getByRole('link', { name: 'Open Walnut', exact: true }).click()
  // Cold Vite transform of the whole SPA on a loaded machine takes well over the
  // default 5s expect budget (runs died here at load ~20 with nothing wrong).
  await expect(page.locator('.main-page')).toBeVisible({ timeout: 90_000 })
}

async function sendQuickStart(page: Page, prompt: string): Promise<string> {
  const quickStartResponse = page.waitForResponse((response) =>
    response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/sessions/quick-start')
  const input = draftComposer(page)
  await input.fill(prompt)
  await input.press('Enter')
  const quickStart = await quickStartResponse
  expect(quickStart.status()).toBe(200)
  const { taskId } = await quickStart.json() as { taskId: string }
  return taskId
}

async function sessionIdForTask(page: Page, taskId: string): Promise<string> {
  let sessions: Array<{ claudeSessionId: string }> = []
  await expect.poll(async () => {
    const response = await page.request.get(`/api/sessions/task/${taskId}`)
    sessions = ((await response.json()) as { sessions: typeof sessions }).sessions
    return sessions.length
  }, { timeout: 20_000 }).toBe(1)
  return sessions[0].claudeSessionId
}

interface TaskRow { phase: string; status: string; completed_at?: string; unread?: boolean; focus_tier?: string }

async function readTask(page: Page, taskId: string): Promise<TaskRow> {
  const response = await page.request.get(`/api/tasks/${taskId}`)
  expect(response.ok()).toBe(true)
  return ((await response.json()) as { task: TaskRow }).task
}

async function readSession(page: Page, sessionId: string): Promise<{ process_status: string; pid?: number | null }> {
  const response = await page.request.get(`/api/sessions/${sessionId}`)
  expect(response.ok()).toBe(true)
  return ((await response.json()) as { session: { process_status: string; pid?: number | null } }).session
}

/** One reopen round: complete the task on its card, then message the session. */
async function completeThenMessage(
  page: Page, card: Locator, panel: Locator, taskId: string, sessionId: string, round: number, shot: string,
): Promise<void> {
  // ── Human marks it done on the task card ──
  await card.getByRole('button', { name: 'Mark complete', exact: true }).click()
  await expect(card).toHaveClass(/todo-pinned-card-done/)
  const done = await readTask(page, taskId)
  expect(done.phase).toBe('COMPLETE')
  expect(done.status).toBe('done')
  expect(typeof done.completed_at).toBe('string')
  // Completing kills the CLI, so the follow-up below is a genuine cold resume —
  // the shape a real user hits, not a warm FIFO write.
  await expect.poll(async () => (await readSession(page, sessionId)).process_status, { timeout: 20_000 })
    .not.toBe('running')
  await page.screenshot({ path: `${SCREENSHOT_DIR}/${shot}-round${round}-completed.png` })

  // ── Human types into the still-visible session column ──
  const reply = `Reopened round ${round} handled`
  const composer = panel.locator('.chat-input-textarea')
  await expect(composer).toBeEnabled()
  await composer.fill(`slow:1500 snapshot-clean-turn:${reply}`)
  await composer.press('Enter')

  // The task leaves "done" as soon as the message is accepted (send time), not
  // when the turn ends: the card drops its green check while the CLI boots.
  await expect(card).not.toHaveClass(/todo-pinned-card-done/, { timeout: 15_000 })
  await expect(card).not.toHaveClass(/todo-pinned-card-needs-action/)
  const reopened = await readTask(page, taskId)
  expect(reopened.phase).toBe('IN_PROGRESS')
  expect(reopened.status).toBe('in_progress')
  expect(reopened.completed_at).toBeUndefined()
  await page.screenshot({ path: `${SCREENSHOT_DIR}/${shot}-round${round}-reopened.png` })

  // The reopened turn ends → handed back the normal way: red row + unread dot,
  // and the session badge settles to Idle.
  await expect.poll(async () => (await readTask(page, taskId)).phase, { timeout: 20_000 }).toBe(HANDBACK_PHASE)
  await expect(card).toHaveClass(/todo-pinned-card-needs-action/)
  await expect(panel.locator('.session-panel-badge')).toContainText('Idle')
  const handedBack = await readTask(page, taskId)
  expect(handedBack.unread).toBe(true)
  expect(handedBack.completed_at).toBeUndefined()
  // The reply text itself is NOT asserted: the fixture's mock daemon starts the
  // resumed incarnation on an empty stream file, so the reopened turn's text
  // does not reach the panel here even though the server saw the result (this
  // spec pins the TASK state; transcript fidelity after a kill is the real
  // daemon's, verified elsewhere). Recorded for the evidence file only.
  replyRendered.push(await panel.getByText(reply, { exact: true }).count())
  await page.screenshot({ path: `${SCREENSHOT_DIR}/${shot}-round${round}-handed-back.png` })
}

const replyRendered: number[] = []

test('a completed task returns to in progress when its session is messaged again', async ({ page }, testInfo) => {
  test.setTimeout(150_000)
  const errors: string[] = []
  const failedResponses: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('response', response => {
    if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`)
  })

  await openHome(page)
  await openDraftOnCwd(page, `${fixtureRoot}/projects/walnut`)
  const taskId = await sendQuickStart(page, 'snapshot-clean-turn:First turn finished')
  const sessionId = await sessionIdForTask(page, taskId)
  const panel = page.locator(`${REAL_PANEL}[data-session-id="${sessionId}"]`)
  await expect(panel).toBeVisible()

  // First turn ends → handed back (the state a user completes FROM).
  await expect(panel.getByText('First turn finished', { exact: true }).first()).toBeVisible({ timeout: 20_000 })
  await expect.poll(async () => (await readTask(page, taskId)).phase, { timeout: 20_000 }).toBe(HANDBACK_PHASE)
  const task = await readTask(page, taskId)
  await selectSection(page, task.focus_tier === 'focus' ? 'Focus' : 'Satellite')
  const card = page.locator(`.todo-pinned-section:not(.todo-pinned-section-recent) [data-task-id="${taskId}"]`)
  await expect(card).toBeVisible()
  await expect(card).toHaveClass(/todo-pinned-card-needs-action/)
  await page.screenshot({ path: `${SCREENSHOT_DIR}/${testInfo.project.name}-round0-handed-back.png` })

  // Round 1 and round 2: complete → message → back in progress → handed back.
  await completeThenMessage(page, card, panel, taskId, sessionId, 1, testInfo.project.name)
  await completeThenMessage(page, card, panel, taskId, sessionId, 2, testInfo.project.name)

  // Second reopen must have restarted the clock: still exactly one session, and
  // the task still points at it (the column never changed).
  const sessions = await page.request.get(`/api/sessions/task/${taskId}`)
  expect(((await sessions.json()) as { sessions: unknown[] }).sessions).toHaveLength(1)

  const evidence = { taskId, sessionId, final: await readTask(page, taskId), replyRendered, failedResponses, errors }
  await fs.writeFile(`${SCREENSHOT_DIR}/${testInfo.project.name}-evidence.json`, JSON.stringify(evidence, null, 2))
  expect(errors).toEqual([])
  // Only API failures matter to this flow; a Vite dev-module 500 for a file some
  // other in-flight change broke is noise here, not a task-state defect.
  expect(failedResponses.filter((line) => /\/api\//.test(line) && !/\/api\/notes|\/api\/mail/.test(line))).toEqual([])
})
