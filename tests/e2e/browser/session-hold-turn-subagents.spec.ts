/**
 * Playwright browser test: a turn that launches a background subagent must stay
 * OPEN until the subagent finishes, and the followup summary must surface as
 * the turn's answer (port of upstream ACP fix #870 / issues #864-#866).
 *
 * The failure mode this pins:
 *   The CLI emits the user turn's terminal `result` — and its trailing idle —
 *   IMMEDIATELY, while the launched subagent is still running (real-CLI-verified
 *   cycle). Settling there marks the session idle/AGENT_COMPLETE, so the
 *   subagent's later output and the model's promised followup summary land
 *   outside any turn and the "done" state lies.
 *
 * Driven through the real UI against the real server + mock CLI's
 * `hold-turn-test` scenario, which emits exactly that lifecycle INCLUDING the
 * early trailing idle and, deliberately, NO idle after the followup result —
 * so it also pins the followup-result settle lane (a lost trailing idle must
 * not wedge the hold). Reverting the #870 port in
 * src/providers/claude-code-session.ts makes the mid-hold status assertion fail
 * (session flips idle while the subagent is live).
 */
import fs from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'

const SCREENSHOT_DIR = '/tmp/session-hold-turn-subagents'
const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)

/** The followup summary the mock CLI streams AFTER the early result+idle. */
const FOLLOWUP_SUMMARY = 'The background agent finished its verification pass.'
const HOLD_PROMPT = `hold-turn-test:${FOLLOWUP_SUMMARY}`

let fixtureRoot = ''

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  ;({ fixtureRoot } = await discoverBrowserFixture(TEST_PORT))
  await fs.mkdir(SCREENSHOT_DIR, { recursive: true })
})

/** Open the quick-session path selector on a real fixture cwd (Claude engine). */
async function openQuickStart(page: Page): Promise<void> {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.locator('.quick-access-pill', { hasText: /Quick session|\+ Session/ }).click()
  await expect(page.locator('.session-path-selector')).toBeVisible()
  const localTab = page.locator('.sps-host-tab', { hasText: 'Local' })
  if (await localTab.isVisible()) await localTab.click()
  await page.locator('.sps-search-input').fill(`${fixtureRoot}/projects/walnut`)
  await page.locator('.sps-search-input').press('Shift+Enter')
}

/** Send a prompt through the composer and return the created session's task id. */
async function sendQuickStart(page: Page, prompt: string): Promise<string> {
  const quickStartResponse = page.waitForResponse((response) =>
    response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/sessions/quick-start')
  const input = page.locator('.main-page-chat .chat-input-textarea')
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

async function processStatus(page: Page, sessionId: string): Promise<string> {
  const response = await page.request.get(`/api/sessions/${sessionId}`)
  return ((await response.json()) as { session: { process_status: string } }).session.process_status
}

test('turn stays open across the early result+idle and completes with the followup summary', async ({ page }) => {
  test.setTimeout(90_000)

  await openQuickStart(page)
  const taskId = await sendQuickStart(page, HOLD_PROMPT)
  const sessionId = await sessionIdForTask(page, taskId)

  // Phase 1 — the mock emitted the user result AND its trailing idle in the
  // first batch, with the subagent still live. THE ASSERTION THIS SPEC EXISTS
  // FOR: the session must NOT settle there. Pre-#870 the idle handler (or the
  // result handler) would flip process_status to idle here.
  // The launch text streams immediately; wait for it so we know the first
  // batch (assistant + result + idle) has been processed before judging.
  const panel = page.locator('.session-panel:not(.pending-session-panel)')
  await expect(panel).toBeVisible({ timeout: 20_000 })
  await expect(panel.getByText('Launching a background agent', { exact: false }).first())
    .toBeVisible({ timeout: 20_000 })
  expect(await processStatus(page, sessionId)).toBe('running')
  await page.screenshot({ path: `${SCREENSHOT_DIR}/held-open-mid-subagent.png`, fullPage: true })

  // Phase 2 — subagent terminal + followup summary + followup result (NO
  // trailing idle after it). The turn must complete WITH the summary visible.
  await expect(panel.getByText(FOLLOWUP_SUMMARY, { exact: false }).first())
    .toBeVisible({ timeout: 30_000 })
  await expect.poll(() => processStatus(page, sessionId), { timeout: 20_000 })
    .toMatch(/idle|stopped/)
  await page.screenshot({ path: `${SCREENSHOT_DIR}/completed-with-summary.png`, fullPage: true })
})

test('a plain turn with no subagents still completes instantly (no added latency)', async ({ page }) => {
  test.setTimeout(60_000)

  // Upstream's no-regression check: turns that spawned nothing settle at their
  // result — the hold must never tax a normal prompt.
  await openQuickStart(page)
  const taskId = await sendQuickStart(page, 'plain hold-port control message')
  const sessionId = await sessionIdForTask(page, taskId)

  const panel = page.locator('.session-panel:not(.pending-session-panel)')
  await expect(panel).toBeVisible({ timeout: 20_000 })
  await expect(panel.getByText('I processed your message', { exact: false }).first())
    .toBeVisible({ timeout: 25_000 })
  await expect.poll(() => processStatus(page, sessionId), { timeout: 20_000 })
    .toMatch(/idle|stopped/)
  await page.screenshot({ path: `${SCREENSHOT_DIR}/plain-turn-control.png`, fullPage: true })
})
