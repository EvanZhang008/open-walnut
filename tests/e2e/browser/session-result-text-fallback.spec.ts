/**
 * Playwright browser test: a turn that answers on the `result` line ALONE must
 * still render its text (port of upstream ACP fix #858 / issue #453).
 *
 * The failure mode this pins:
 *   A cache-replayed turn generates zero output tokens and some backends then
 *   skip streaming entirely — no `stream_event` deltas, no consolidated
 *   `assistant` message, the answer only on `result`. Walnut's UI treats
 *   session:result as a pure TURN BOUNDARY and never renders its text, and
 *   history parsing keeps only user/assistant roles, so the answer was lost in
 *   BOTH surfaces and the turn rendered EMPTY.
 *
 * Driven through the real UI (quick-start → composer → home session column),
 * against the real server + mock CLI's `replayed-turn` scenario, which emits
 * exactly that JSONL shape. Reverting the fallback in
 * src/providers/claude-code-session.ts makes the reply assertion fail.
 */
import fs from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { REAL_PANEL, draftComposer, openDraftOnCwd } from './draft-helpers'

const SCREENSHOT_DIR = '/tmp/session-result-text-fallback'
const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)

/** Answer the mock CLI puts on the `result` line and nowhere else. */
const REPLAYED_ANSWER = 'This answer arrived on the result line only.'
const REPLAYED_PROMPT = `replayed-turn:${REPLAYED_ANSWER}`
/** A normal streaming turn — the double-emit control. */
const NORMAL_PROMPT = 'result-fallback normal control'

let fixtureRoot = ''

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  ;({ fixtureRoot } = await discoverBrowserFixture(TEST_PORT))
  await fs.mkdir(SCREENSHOT_DIR, { recursive: true })
})

/**
 * Open a draft session column on a real fixture cwd (Claude engine).
 *
 * The launcher moved: "+" grows a draft column and its cwd pill hosts the same
 * folder picker. The draft morphs into the pending → real column in place, so
 * the home-column assertions below are untouched.
 */
async function openQuickStart(page: Page): Promise<void> {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await openDraftOnCwd(page, `${fixtureRoot}/projects/walnut`)
}

/** Send a prompt through the draft's composer and return the created task id. */
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

test('a turn whose answer is only on the result line renders that text exactly once', async ({ page }) => {
  test.setTimeout(60_000)

  await openQuickStart(page)
  const taskId = await sendQuickStart(page, REPLAYED_PROMPT)

  const panel = page.locator(REAL_PANEL)
  await expect(panel).toBeVisible({ timeout: 20_000 })

  // THE ASSERTION THIS SPEC EXISTS FOR: without the fallback the turn renders
  // empty — the answer exists only on a `result` line that no surface shows.
  await expect(panel.getByText(REPLAYED_ANSWER, { exact: true }))
    .toHaveCount(1, { timeout: 25_000 })

  await page.screenshot({ path: `${SCREENSHOT_DIR}/replayed-turn-rendered.png`, fullPage: true })

  // Turn actually completed (not stuck "streaming") — the fallback rides the
  // normal delta path and must not disturb the turn-over lifecycle.
  const sessionId = await sessionIdForTask(page, taskId)
  await expect.poll(async () => {
    const response = await page.request.get(`/api/sessions/${sessionId}`)
    return ((await response.json()) as {
      session: { process_status: string }
    }).session.process_status
  }, { timeout: 20_000 }).toMatch(/idle|stopped/)

  // NOT asserted here: survival across a reload. The forwarded text is a
  // streaming block, and the server clears the stream buffer 2s after a result,
  // so on reload the UI rebuilds the turn from persisted history — which cannot
  // contain this answer: canonical JSONL (~/.claude/projects/…) records
  // user/assistant/system lines and NEVER `result` lines, and a replayed turn by
  // definition wrote no assistant message. Making the forwarded text durable is a
  // separate, larger change (a synthetic assistant line in the streams file, which
  // is only read when canonical is unavailable) and is deliberately out of scope
  // for this port — upstream #858's contract is "deliver the text to the client",
  // which is what the assertion above pins.
})

test('a normal streaming turn still renders its reply exactly once (no double-emit)', async ({ page }) => {
  test.setTimeout(60_000)

  // The guard that makes the fallback safe: a turn that already streamed its
  // answer must NOT have the trailing `result` copy emitted a second time.
  await openQuickStart(page)
  await sendQuickStart(page, NORMAL_PROMPT)

  const panel = page.locator(REAL_PANEL)
  await expect(panel).toBeVisible({ timeout: 20_000 })

  // mock-claude echoes the prompt back as streamed assistant text, then repeats
  // it verbatim on the `result` line — exactly the shape that a fallback without
  // the delivered-text guard would render twice. Substring match: the mock
  // appends run-dependent suffixes (cwd / model / effort) to the same message.
  const reply = panel.getByText(`I processed your message: ${NORMAL_PROMPT}`)
  await expect(reply).toHaveCount(1, { timeout: 25_000 })

  await page.screenshot({ path: `${SCREENSHOT_DIR}/normal-turn-single-reply.png`, fullPage: true })
})
