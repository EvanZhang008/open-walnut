/**
 * Playwright specs for the Codex engine option in Quick Start.
 *
 * Real UI clicks only (no page.goto beyond initial load): open a draft session
 * column from the Homepage "+", open its folder picker, flip the engine toggle
 * to Codex in the MetaFooter, confirm a path, send a message — then verify the
 * request body carries engine:'codex' and (in the live flow) the mock-acp-agent
 * streams a reply into the session panel with the Codex pill visible.
 *
 * The launcher route moved with the one verb "New" work: "+" grows an empty
 * draft column and the SAME SessionPathSelector now lives inside it (all `.sps-*`
 * selectors unchanged), so the composed first message is typed into that column's
 * composer instead of the main chat's. ./draft-helpers owns the route in.
 *
 * Server side: test-server.ts wires sessionRunner.setTestAcpArtifacts with the
 * real acp-worker bundle + tests/providers/mock-acp-agent.mjs, and MockDaemon
 * embeds the real createAcpDaemon supervision module.
 */
import fs from 'node:fs/promises'
import { test, expect, type Locator, type Page } from '@playwright/test'
import { discoverBrowserFixture, installBrowserAudit } from './codex-test-audit'
import { REAL_PANEL, openDraft, openDraftOnCwd } from './draft-helpers'

const SCREENSHOT_DIR = '/tmp/codex-customer-matrix-ui-final'
const ENGINE_LABEL_SCREENSHOT_DIR = '/tmp/session-engine-labels'
const MODEL_PICKER_SCREENSHOT_DIR = '/tmp/codex-model-picker'
const SESSION_CONTROLS_SCREENSHOT_DIR = '/tmp/codex-session-controls'
const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
let fixtureRoot = ''
let walnutHome = ''

test.beforeAll(async () => {
  ;({ fixtureRoot, walnutHome } = await discoverBrowserFixture(TEST_PORT))
})

/**
 * Open ONLY the picker (no path confirmed): "+" → the draft column's cwd pill.
 * Both locators are scoped to that draft panel, because a picker can be mounted
 * in every open column at once. Use this when a test asserts on picker state
 * BEFORE a path is confirmed; otherwise use `openCodexDraft`.
 *
 * The working-dirs response is STUBBED, and that is load-bearing for the two
 * "Claude is the default engine" assertions in this file. Launch memory is
 * per-directory and lives on the SERVER (`frequent-directories.json`
 * `lastLaunch`), written by every quick-start: the Codex tests here launch on
 * `<fixture>/projects/walnut` with engine codex, so that row comes back carrying
 * `lastLaunch:{engine:'codex'}` and the picker — correctly — previews Codex for
 * the highlighted row. Asserting "Claude" against a directory the user last ran
 * Codex in would be asserting a bug. Stubbing with a memory-free directory keeps
 * the claim honest (a fresh dir defaults to Claude) and makes it independent of
 * whatever the other tests in the run have launched. Only the LIST is faked; the
 * picker, the toggle and every downstream launch stay real.
 */
async function openPicker(page: Page): Promise<{ panel: Locator; picker: Locator }> {
  await page.route('**/api/sessions/working-dirs', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        dirs: [{
          cwd: `${fixtureRoot}/projects/walnut`,
          host: null,
          project: 'Walnut',
          count: 5,
          lastUsed: new Date().toISOString(),
        }],
        hosts: [],
      }),
    })
  })
  await page.goto('/')
  await expect(page.locator('.main-page')).toBeVisible()
  const panel = await openDraft(page)
  await panel.locator('.draft-composer-bar .session-action-chip').first().click()
  const picker = page.locator('.session-path-selector')
  await expect(picker).toBeVisible()
  return { panel, picker }
}

/** "+" → draft column pointed at the fixture repo with the Codex engine picked.
 *  Returns the draft panel; its composer is where the first message goes. */
async function openCodexDraft(page: Page): Promise<Locator> {
  await page.goto('/')
  await expect(page.locator('.main-page')).toBeVisible()
  return openDraftOnCwd(page, `${fixtureRoot}/projects/walnut`, { engine: 'Codex' })
}

async function sessionIdForTask(page: Page, taskId: string): Promise<string> {
  let sessionId = ''
  await expect.poll(async () => {
    const response = await page.request.get(`/api/sessions/task/${taskId}`)
    const body = await response.json() as {
      sessions: Array<{ claudeSessionId: string }>
    }
    sessionId = body.sessions[0]?.claudeSessionId ?? ''
    return sessionId
  }, { timeout: 15_000 }).not.toBe('')
  return sessionId
}

test('engine toggle renders in the footer; Codex click hides the Claude model select', async ({ page }) => {
  const audit = await installBrowserAudit(page, walnutHome)
  const { picker } = await openPicker(page)

  const toggle = picker.locator('.sps-engine-toggle')
  await expect(toggle).toBeVisible()
  // Claude is the default active engine
  await expect(toggle.locator('.sps-engine-btn', { hasText: 'Claude' })).toHaveClass(/active/)

  // Model select visible for Claude…
  await expect(picker.locator('.sps-meta-model-select')).toBeVisible()

  // …flip to Codex → model select disappears (codex models are discovered at
  // session start; we hide the Claude control instead of emulating it).
  await toggle.locator('.sps-engine-btn', { hasText: 'Codex' }).click()
  await expect(toggle.locator('.sps-engine-btn', { hasText: 'Codex' })).toHaveClass(/active/)
  await expect(picker.locator('.sps-meta-model-select')).not.toBeVisible()
  await audit.assertClean()
})

test('quick-start with Codex engine sends engine:codex and shows the Codex chip', async ({ page }) => {
  const audit = await installBrowserAudit(page, walnutHome)
  // Engine is picked BEFORE the path is confirmed (the footer lives in the picker).
  const panel = await openCodexDraft(page)

  // The engine choice STUCK to this draft. The collapsed Quick Start bar's Codex
  // chip was the old proof of that, but the chat bar is not on this route — the
  // draft holds the launch meta itself, so re-open its picker and read the
  // toggle back (same fact: the confirm did not reset the engine to Claude).
  await panel.locator('.draft-composer-bar .session-action-chip').first().click()
  const reopened = page.locator('.session-path-selector')
  await expect(reopened).toBeVisible()
  await expect(reopened.locator('.sps-engine-btn', { hasText: 'Codex' })).toHaveClass(/active/)
  // Esc twice = edit mode → browse → closed. Deliberately NOT an outside click:
  // dismissing with a path typed re-confirms it, and closing must not be the
  // thing that keeps the cwd alive here.
  const reopenedInput = reopened.locator('.sps-search-input')
  await reopenedInput.press('Escape')
  await reopenedInput.press('Escape')
  await expect(reopened).toBeHidden()

  // Observe the real quick-start request body. Letting it reach the test server
  // keeps this spec on the same real route/runner path as the live-flow spec.
  let capturedBody: Record<string, unknown> | null = null
  page.on('request', (request) => {
    if (request.method() === 'POST'
      && new URL(request.url()).pathname === '/api/sessions/quick-start') {
      capturedBody = request.postDataJSON() as Record<string, unknown>
    }
  })

  const quickStartResponse = page.waitForResponse((response) =>
    response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/sessions/quick-start')
  const chatInput = panel.locator('.chat-input-textarea')
  await chatInput.fill('codex request contract from playwright')
  await chatInput.press('Enter')

  expect((await quickStartResponse).status()).toBe(200)
  await expect.poll(() => capturedBody, { timeout: 5000 }).not.toBeNull()
  expect(capturedBody!.engine).toBe('codex')
  expect(capturedBody!.model).toBeUndefined()
  await audit.assertClean()
})

test('live Codex session: quick-start streams the mock-acp reply into the session panel', async ({ page }) => {
  const audit = await installBrowserAudit(page, walnutHome)
  const draft = await openCodexDraft(page)

  // NO route mock — the real POST goes through SessionRunner → AcpSession →
  // MockDaemon(createAcpDaemon) → acp-worker → mock-acp-agent.
  const chatInput = draft.locator('.chat-input-textarea')
  await chatInput.fill('live codex stream test')
  await chatInput.press('Enter')

  // The session panel opens for the pending quick-start and the mock agent's
  // echo reply streams in. REAL_PANEL excludes the pending placeholder and the
  // outgoing draft — all three carry `.session-panel`, and the strip's
  // auto-animate keeps the leaving draft one extra paint (see draft-helpers).
  const panel = page.locator(REAL_PANEL)
  await expect(panel).toBeVisible({ timeout: 15_000 })
  await expect(
    panel.getByText('hello from mock-acp (you said: live codex stream test)', { exact: true }),
  ).toHaveCount(1, { timeout: 20_000 })

  // ACP discovery replaces the generic Codex label with the current short model name.
  await expect(panel.locator('.session-detail-model-pill', { hasText: 'GPT Best' })).toBeVisible({ timeout: 10_000 })
  await expect(panel.locator('.session-msg-role')).toHaveCount(0)
  await expect(panel.getByText('Walnut', { exact: true })).toHaveCount(0)
  await expect(panel).toBeInViewport()
  await fs.mkdir(SCREENSHOT_DIR, { recursive: true })
  await page.screenshot({
    path: `${SCREENSHOT_DIR}/live-codex-exact-single-frame.png`,
    fullPage: true,
  })
  await audit.assertClean()
})

test('Codex session controls cycle on Homepage', async ({ page }) => {
  test.setTimeout(60_000)
  const audit = await installBrowserAudit(page, walnutHome)
  const draft = await openCodexDraft(page)

  const quickStartResponse = page.waitForResponse((response) =>
    response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/sessions/quick-start')
  const chatInput = draft.locator('.chat-input-textarea')
  await chatInput.fill('codex session controls browser test')
  await chatInput.press('Enter')
  const response = await quickStartResponse
  expect(response.status()).toBe(200)
  const { taskId } = await response.json() as { taskId: string }
  const sessionId = await sessionIdForTask(page, taskId)

  const panel = page.locator(REAL_PANEL)
  await expect(panel).toBeVisible({ timeout: 15_000 })
  // ONE pill since the SessionControlPills rework (7fda772b): the mode pill
  // opens a menu holding the approval options AND the plan-mode toggle. The
  // old standalone "Default" collaboration pill no longer exists; plan mode
  // surfaces as its own amber pill only while ON.
  const modePill = panel.locator('.mode-toggle-pill').filter({ hasText: 'Agent' })
  await expect(modePill).toBeVisible({ timeout: 15_000 })

  const clickModeResponse = page.waitForResponse((candidate) =>
    candidate.request().method() === 'POST'
      && new URL(candidate.url()).pathname === `/api/sessions/${sessionId}/controls`)
  await modePill.click()
  await panel.locator('.session-control-option', { hasText: 'Agent full access' }).click()
  expect((await clickModeResponse).status()).toBe(200)
  await expect(panel.locator('.mode-toggle-pill').filter({ hasText: 'Agent full access' })).toBeVisible()

  const shortcutResponse = page.waitForResponse((candidate) =>
    candidate.request().method() === 'POST'
      && new URL(candidate.url()).pathname === `/api/sessions/${sessionId}/controls`)
  await panel.locator('.chat-input-textarea').press('Shift+Tab')
  expect((await shortcutResponse).status()).toBe(200)
  await expect(panel.locator('.mode-toggle-pill').filter({ hasText: 'Read only' })).toBeVisible()

  const collaborationResponse = page.waitForResponse((candidate) =>
    candidate.request().method() === 'POST'
      && new URL(candidate.url()).pathname === `/api/sessions/${sessionId}/controls`)
  await panel.locator('.mode-toggle-pill').first().click()
  await panel.locator('.session-control-option', { hasText: 'Plan mode' }).click()
  expect((await collaborationResponse).status()).toBe(200)
  await expect(panel.locator('.mode-toggle-pill.plan-active')).toBeVisible()

  await fs.mkdir(SESSION_CONTROLS_SCREENSHOT_DIR, { recursive: true })
  await page.screenshot({
    path: `${SESSION_CONTROLS_SCREENSHOT_DIR}/homepage-controls.png`,
    fullPage: true,
  })
  const expectedMissingPlan = (url: string) =>
    new URL(url).pathname === `/api/sessions/${sessionId}/plan`
  await audit.assertClean({
    http: ({ status, method, url }) =>
      status === 404 && method === 'GET' && expectedMissingPlan(url),
    consoleError: (message) =>
      message === 'Failed to load resource: the server responded with a status of 404 (Not Found)'
      || new RegExp(`^\\[api\\] GET /api/sessions/${sessionId}/plan → 404 .*: No plan content found for this session$`)
        .test(message),
  })
})

test('Codex model picker switches models on Homepage', async ({ page }) => {
  test.setTimeout(60_000)
  const audit = await installBrowserAudit(page, walnutHome)
  const draft = await openCodexDraft(page)

  const quickStartResponse = page.waitForResponse((response) =>
    response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/sessions/quick-start')
  const chatInput = draft.locator('.chat-input-textarea')
  await chatInput.fill('codex model picker browser test')
  await chatInput.press('Enter')
  const response = await quickStartResponse
  expect(response.status()).toBe(200)
  const { taskId } = await response.json() as { taskId: string }
  const sessionId = await sessionIdForTask(page, taskId)

  const panel = page.locator(REAL_PANEL)
  await expect(panel).toBeVisible({ timeout: 15_000 })
  const homePill = panel.getByRole('button', { name: /GPT Best/ })
  await expect(homePill).toBeVisible({ timeout: 15_000 })
  await homePill.click()
  // The shared two-pane picker: provider rail (Claude greyed+locked — a live
  // codex session can't switch engines in place) | the ACP model rows.
  const homeMenu = panel.locator('.model-picker')
  await expect(homeMenu).toBeVisible()
  await expect(homeMenu.locator('.provider-rail-item[data-provider="codex"]')).toHaveClass(/provider-rail-item-active/)
  await expect(homeMenu.locator('.provider-rail-item[data-provider="claude"]')).toHaveClass(/provider-rail-item-locked/)
  const homeSwitchResponse = page.waitForResponse((candidate) =>
    candidate.request().method() === 'POST'
      && new URL(candidate.url()).pathname === `/api/sessions/${sessionId}/model`)
  await homeMenu.locator('.model-picker-row', { hasText: 'Mock GPT Fast' }).click()
  expect((await homeSwitchResponse).status()).toBe(200)
  const switchedPill = panel.getByRole('button', { name: /GPT Fast/ })
  await expect(switchedPill).toBeVisible()

  // Re-open the picker and confirm the switched model is marked active.
  await switchedPill.click()
  const reopenedMenu = panel.locator('.model-picker')
  await expect(reopenedMenu).toBeVisible()
  await expect(reopenedMenu.locator('.model-picker-row', { hasText: 'Mock GPT Fast' }))
    .toHaveClass(/model-picker-row-active/)
  await page.keyboard.press('Escape')

  await fs.mkdir(MODEL_PICKER_SCREENSHOT_DIR, { recursive: true })
  await page.screenshot({
    path: `${MODEL_PICKER_SCREENSHOT_DIR}/homepage-selected-fast.png`,
    fullPage: true,
  })
  await audit.assertClean()
})

test('live Claude Code session uses its engine name on Homepage', async ({ page }) => {
  test.setTimeout(90_000)
  const audit = await installBrowserAudit(page, walnutHome)
  const { panel: draft, picker } = await openPicker(page)
  const localTab = picker.locator('.sps-host-tab', { hasText: 'Local' })
  if (await localTab.isVisible()) await localTab.click()

  // Keep the default Claude engine selected — asserted BEFORE the confirm, which
  // is why this one drives the picker by hand instead of using openDraftOnCwd.
  await expect(picker.locator('.sps-engine-btn', { hasText: 'Claude' })).toHaveClass(/active/)
  const pickerInput = picker.locator('.sps-search-input')
  await pickerInput.fill(`${fixtureRoot}/projects/walnut`)
  await pickerInput.press('Shift+Enter')
  await expect(picker).toBeHidden()

  const quickStartResponse = page.waitForResponse((response) =>
    response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/sessions/quick-start')
  const chatInput = draft.locator('.chat-input-textarea')
  await chatInput.fill('live claude engine label test')
  await chatInput.press('Enter')
  const response = await quickStartResponse
  expect(response.status()).toBe(200)
  const { taskId } = await response.json() as { taskId: string }

  const panel = page.locator(REAL_PANEL)
  await expect(panel).toBeVisible({ timeout: 15_000 })
  await expect(panel.locator('.session-msg-role')).toHaveCount(0, { timeout: 20_000 })
  await expect(panel.getByText('Walnut', { exact: true })).toHaveCount(0)
  await sessionIdForTask(page, taskId) // session is registered for the task

  await fs.mkdir(ENGINE_LABEL_SCREENSHOT_DIR, { recursive: true })
  await page.screenshot({
    path: `${ENGINE_LABEL_SCREENSHOT_DIR}/claude-code-dedicated-session.png`,
    fullPage: true,
  })
  await audit.assertClean()
})

test('persisted Codex session uses its engine name on Homepage', async ({ page }) => {
  test.setTimeout(60_000)
  const audit = await installBrowserAudit(page, walnutHome)
  const sessionId = 'pw-codex-customer-session'

  await page.goto('/')
  await expect(page.locator('.main-page')).toBeVisible()
  await page.locator('.todo-search-input').fill(sessionId)
  const task = page.locator('.todo-panel-item[data-task-id="pw-task-codex-customer"]')
  await expect(task).toBeVisible()
  await task.locator('.todo-item-title').click()

  const panel = page.locator('.main-page-session-column .session-panel')
  await expect(panel.locator('.session-msg-role')).toHaveCount(0, { timeout: 15_000 })
  await expect(panel.getByText('Walnut', { exact: true })).toHaveCount(0)

  await fs.mkdir(ENGINE_LABEL_SCREENSHOT_DIR, { recursive: true })
  await page.screenshot({
    path: `${ENGINE_LABEL_SCREENSHOT_DIR}/codex-dedicated-session.png`,
    fullPage: true,
  })
  await audit.assertClean()
})
