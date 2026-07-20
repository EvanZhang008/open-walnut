/**
 * Playwright specs for the Codex engine option in Quick Start.
 *
 * Real UI clicks only (no page.goto beyond initial load): open the session
 * path picker from the Homepage, flip the engine toggle to Codex in the
 * MetaFooter, confirm a path, send a message — then verify the request body
 * carries engine:'codex' and (in the live flow) the mock-acp-agent streams a
 * reply into the session panel with the Codex pill visible.
 *
 * Server side: test-server.ts wires sessionRunner.setTestAcpArtifacts with the
 * real acp-worker bundle + tests/providers/mock-acp-agent.mjs, and MockDaemon
 * embeds the real createAcpDaemon supervision module.
 */
import fs from 'node:fs/promises'
import { test, expect, type Page } from '@playwright/test'
import { discoverBrowserFixture, installBrowserAudit } from './codex-test-audit'

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

async function openPicker(page: Page): Promise<void> {
  await page.goto('/')
  await expect(page.locator('.main-page')).toBeVisible()
  await page.locator('.quick-access-pill', { hasText: 'Quick session' }).click()
  await expect(page.locator('.session-path-selector')).toBeVisible()
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

async function navigateToSession(page: Page, sessionId: string): Promise<void> {
  const other = page.getByRole('button', { name: /Other/i })
  if (await other.getAttribute('aria-expanded') !== 'true') await other.click()
  await page.locator('a[href="/sessions"]').click()
  await expect(page.locator('.session-tree-panel')).toBeVisible()
  await page.getByRole('searchbox', { name: 'Search sessions' }).fill(sessionId)
  const row = page.locator(`.session-tree-session[data-session-id="${sessionId}"]`)
  await expect(row).toBeVisible()
  await row.click()
}

test('engine toggle renders in the footer; Codex click hides the Claude model select', async ({ page }) => {
  const audit = await installBrowserAudit(page, walnutHome)
  await openPicker(page)

  const toggle = page.locator('.sps-engine-toggle')
  await expect(toggle).toBeVisible()
  // Claude is the default active engine
  await expect(toggle.locator('.sps-engine-btn', { hasText: 'Claude' })).toHaveClass(/active/)

  // Model select visible for Claude…
  await expect(page.locator('.sps-meta-model-select')).toBeVisible()

  // …flip to Codex → model select disappears (codex models are discovered at
  // session start; we hide the Claude control instead of emulating it).
  await toggle.locator('.sps-engine-btn', { hasText: 'Codex' }).click()
  await expect(toggle.locator('.sps-engine-btn', { hasText: 'Codex' })).toHaveClass(/active/)
  await expect(page.locator('.sps-meta-model-select')).not.toBeVisible()
  await audit.assertClean()
})

test('quick-start with Codex engine sends engine:codex and shows the Codex chip', async ({ page }) => {
  const audit = await installBrowserAudit(page, walnutHome)
  await openPicker(page)
  const localTab = page.locator('.sps-host-tab', { hasText: 'Local' })
  if (await localTab.isVisible()) await localTab.click()

  // Pick engine BEFORE confirming the path (footer lives in the picker).
  await page.locator('.sps-engine-toggle .sps-engine-btn', { hasText: 'Codex' }).click()

  // Confirm an existing dir via Shift+Enter
  await page.locator('.sps-search-input').fill(`${fixtureRoot}/projects/walnut`)
  await page.locator('.sps-search-input').press('Shift+Enter')

  // Collapsed Quick Start bar shows the Codex chip (engine replaces the model label)
  await expect(page.locator('.qsb-model-chip')).toContainText('Codex')

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
  const chatInput = page.locator('.main-page-chat .chat-input-textarea')
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
  await openPicker(page)
  const localTab = page.locator('.sps-host-tab', { hasText: 'Local' })
  if (await localTab.isVisible()) await localTab.click()

  await page.locator('.sps-engine-toggle .sps-engine-btn', { hasText: 'Codex' }).click()
  await page.locator('.sps-search-input').fill(`${fixtureRoot}/projects/walnut`)
  await page.locator('.sps-search-input').press('Shift+Enter')

  // NO route mock — the real POST goes through SessionRunner → AcpSession →
  // MockDaemon(createAcpDaemon) → acp-worker → mock-acp-agent.
  const chatInput = page.locator('.main-page-chat .chat-input-textarea')
  await chatInput.fill('live codex stream test')
  await chatInput.press('Enter')

  // The session panel opens for the pending quick-start and the mock agent's
  // echo reply streams in. Exclude the transient pending-session-panel — both
  // carry .session-panel and strict mode rejects the ambiguity.
  const panel = page.locator('.session-panel:not(.pending-session-panel)')
  await expect(panel).toBeVisible({ timeout: 15_000 })
  await expect(
    panel.getByText('hello from mock-acp (you said: live codex stream test)', { exact: true }),
  ).toHaveCount(1, { timeout: 20_000 })

  // ACP discovery replaces the generic Codex label with the current short model name.
  await expect(panel.locator('.session-detail-model-pill', { hasText: 'GPT Best' })).toBeVisible({ timeout: 10_000 })
  await expect(panel.locator('.session-msg-role').filter({ hasText: /^Codex$/ }).first()).toBeVisible()
  await expect(panel.locator('.session-msg-role').filter({ hasText: /^Walnut$/ })).toHaveCount(0)
  await expect(panel).toBeInViewport()
  await fs.mkdir(SCREENSHOT_DIR, { recursive: true })
  await page.screenshot({
    path: `${SCREENSHOT_DIR}/live-codex-exact-single-frame.png`,
    fullPage: true,
  })
  await audit.assertClean()
})

test('Codex session controls cycle on Homepage and stay in sync on Sessions', async ({ page }) => {
  test.setTimeout(60_000)
  const audit = await installBrowserAudit(page, walnutHome)
  await openPicker(page)
  const localTab = page.locator('.sps-host-tab', { hasText: 'Local' })
  if (await localTab.isVisible()) await localTab.click()

  await page.locator('.sps-engine-toggle .sps-engine-btn', { hasText: 'Codex' }).click()
  await page.locator('.sps-search-input').fill(`${fixtureRoot}/projects/walnut`)
  await page.locator('.sps-search-input').press('Shift+Enter')

  const quickStartResponse = page.waitForResponse((response) =>
    response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/sessions/quick-start')
  const chatInput = page.locator('.main-page-chat .chat-input-textarea')
  await chatInput.fill('codex session controls browser test')
  await chatInput.press('Enter')
  const response = await quickStartResponse
  expect(response.status()).toBe(200)
  const { taskId } = await response.json() as { taskId: string }
  const sessionId = await sessionIdForTask(page, taskId)

  const panel = page.locator('.session-panel:not(.pending-session-panel)')
  await expect(panel).toBeVisible({ timeout: 15_000 })
  const modePill = panel.locator('.mode-toggle-pill').filter({ hasText: 'Agent' })
  const collaborationPill = panel.locator('.mode-toggle-pill').filter({ hasText: 'Default' })
  await expect(modePill).toBeVisible({ timeout: 15_000 })
  await expect(collaborationPill).toBeVisible()

  const clickModeResponse = page.waitForResponse((candidate) =>
    candidate.request().method() === 'POST'
      && new URL(candidate.url()).pathname === `/api/sessions/${sessionId}/controls`)
  await modePill.click()
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
  await collaborationPill.click()
  expect((await collaborationResponse).status()).toBe(200)
  await expect(panel.locator('.mode-toggle-pill').filter({ hasText: 'Plan' })).toBeVisible()

  await navigateToSession(page, sessionId)
  const detail = page.locator('.sessions-detail-pane')
  await expect(detail.locator('.mode-toggle-pill').filter({ hasText: 'Read only' })).toBeVisible({ timeout: 15_000 })
  await expect(detail.locator('.mode-toggle-pill').filter({ hasText: 'Plan' })).toBeVisible()

  const detailShortcutResponse = page.waitForResponse((candidate) =>
    candidate.request().method() === 'POST'
      && new URL(candidate.url()).pathname === `/api/sessions/${sessionId}/controls`)
  await page.locator('.session-chat-input-wrapper .chat-input-textarea').press('Shift+Tab')
  expect((await detailShortcutResponse).status()).toBe(200)
  await expect(detail.locator('.mode-toggle-pill').filter({ hasText: 'Agent' })).toBeVisible()

  await fs.mkdir(SESSION_CONTROLS_SCREENSHOT_DIR, { recursive: true })
  await page.screenshot({
    path: `${SESSION_CONTROLS_SCREENSHOT_DIR}/sessions-controls.png`,
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

test('Codex model picker switches models identically on Homepage and Sessions', async ({ page }) => {
  test.setTimeout(60_000)
  const audit = await installBrowserAudit(page, walnutHome)
  await openPicker(page)
  const localTab = page.locator('.sps-host-tab', { hasText: 'Local' })
  if (await localTab.isVisible()) await localTab.click()

  await page.locator('.sps-engine-toggle .sps-engine-btn', { hasText: 'Codex' }).click()
  await page.locator('.sps-search-input').fill(`${fixtureRoot}/projects/walnut`)
  await page.locator('.sps-search-input').press('Shift+Enter')

  const quickStartResponse = page.waitForResponse((response) =>
    response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/sessions/quick-start')
  const chatInput = page.locator('.main-page-chat .chat-input-textarea')
  await chatInput.fill('codex model picker browser test')
  await chatInput.press('Enter')
  const response = await quickStartResponse
  expect(response.status()).toBe(200)
  const { taskId } = await response.json() as { taskId: string }
  const sessionId = await sessionIdForTask(page, taskId)

  const panel = page.locator('.session-panel:not(.pending-session-panel)')
  await expect(panel).toBeVisible({ timeout: 15_000 })
  const homePill = panel.getByRole('button', { name: /GPT Best/ })
  await expect(homePill).toBeVisible({ timeout: 15_000 })
  await homePill.click()
  const homeMenu = panel.getByRole('listbox', { name: 'Codex models' })
  await expect(homeMenu).toBeVisible()
  const homeSwitchResponse = page.waitForResponse((candidate) =>
    candidate.request().method() === 'POST'
      && new URL(candidate.url()).pathname === `/api/sessions/${sessionId}/model`)
  await homeMenu.getByRole('option', { name: /Mock GPT Fast/ }).click()
  expect((await homeSwitchResponse).status()).toBe(200)
  await expect(panel.getByRole('button', { name: /GPT Fast/ })).toBeVisible()

  await fs.mkdir(MODEL_PICKER_SCREENSHOT_DIR, { recursive: true })
  await page.screenshot({
    path: `${MODEL_PICKER_SCREENSHOT_DIR}/homepage-selected-fast.png`,
    fullPage: true,
  })

  await navigateToSession(page, sessionId)
  const detail = page.locator('.sessions-detail-pane')
  const detailPill = detail.getByRole('button', { name: /GPT Fast/ })
  await expect(detailPill).toBeVisible({ timeout: 15_000 })
  await detailPill.click()
  const detailMenu = detail.getByRole('listbox', { name: 'Codex models' })
  await expect(detailMenu).toBeVisible()
  await expect(detailMenu.getByRole('option', { name: /Mock GPT Fast/ }))
    .toHaveAttribute('aria-selected', 'true')
  const detailSwitchResponse = page.waitForResponse((candidate) =>
    candidate.request().method() === 'POST'
      && new URL(candidate.url()).pathname === `/api/sessions/${sessionId}/model`)
  await detailMenu.getByRole('option', { name: /Mock GPT Best/ }).click()
  expect((await detailSwitchResponse).status()).toBe(200)
  await expect(detail.getByRole('button', { name: /GPT Best/ })).toBeVisible()
  await page.screenshot({
    path: `${MODEL_PICKER_SCREENSHOT_DIR}/sessions-selected-best.png`,
    fullPage: true,
  })
  await audit.assertClean()
})

test('live Claude Code session uses its engine name on Homepage and Sessions', async ({ page }) => {
  test.setTimeout(90_000)
  const audit = await installBrowserAudit(page, walnutHome)
  await openPicker(page)
  const localTab = page.locator('.sps-host-tab', { hasText: 'Local' })
  if (await localTab.isVisible()) await localTab.click()

  // Keep the default Claude engine selected.
  await expect(page.locator('.sps-engine-btn', { hasText: 'Claude' })).toHaveClass(/active/)
  await page.locator('.sps-search-input').fill(`${fixtureRoot}/projects/walnut`)
  await page.locator('.sps-search-input').press('Shift+Enter')

  const quickStartResponse = page.waitForResponse((response) =>
    response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/sessions/quick-start')
  const chatInput = page.locator('.main-page-chat .chat-input-textarea')
  await chatInput.fill('live claude engine label test')
  await chatInput.press('Enter')
  const response = await quickStartResponse
  expect(response.status()).toBe(200)
  const { taskId } = await response.json() as { taskId: string }

  const panel = page.locator('.session-panel:not(.pending-session-panel)')
  await expect(panel).toBeVisible({ timeout: 15_000 })
  await expect(panel.locator('.session-msg-role').filter({ hasText: /^Claude Code$/ }).first())
    .toBeVisible({ timeout: 20_000 })
  await expect(panel.locator('.session-msg-role').filter({ hasText: /^Walnut$/ })).toHaveCount(0)

  const sessionId = await sessionIdForTask(page, taskId)
  await navigateToSession(page, sessionId)
  const detail = page.locator('.sessions-detail-pane')
  await expect(detail.locator('.session-msg-role').filter({ hasText: /^Claude Code$/ }).first())
    .toBeVisible({ timeout: 10_000 })
  await expect(detail.locator('.session-msg-role').filter({ hasText: /^Walnut$/ })).toHaveCount(0)

  await fs.mkdir(ENGINE_LABEL_SCREENSHOT_DIR, { recursive: true })
  await page.screenshot({
    path: `${ENGINE_LABEL_SCREENSHOT_DIR}/claude-code-dedicated-session.png`,
    fullPage: true,
  })
  await audit.assertClean()
})

test('persisted Codex session uses its engine name on Homepage and Sessions', async ({ page }) => {
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
  await expect(panel.locator('.session-msg-role').filter({ hasText: /^Codex$/ }).first())
    .toBeVisible({ timeout: 15_000 })
  await expect(panel.locator('.session-msg-role').filter({ hasText: /^Walnut$/ })).toHaveCount(0)

  await navigateToSession(page, sessionId)
  const detail = page.locator('.sessions-detail-pane')
  await expect(detail.locator('.session-msg-role').filter({ hasText: /^Codex$/ }).first())
    .toBeVisible({ timeout: 15_000 })
  await expect(detail.locator('.session-msg-role').filter({ hasText: /^Walnut$/ })).toHaveCount(0)

  await fs.mkdir(ENGINE_LABEL_SCREENSHOT_DIR, { recursive: true })
  await page.screenshot({
    path: `${ENGINE_LABEL_SCREENSHOT_DIR}/codex-dedicated-session.png`,
    fullPage: true,
  })
  await audit.assertClean()
})
