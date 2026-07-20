import fs from 'node:fs/promises'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { discoverBrowserFixture, installBrowserAudit } from './codex-test-audit'

const SCREENSHOT_DIR = '/tmp/codex-status-regression'
const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const BASE_PROMPT = 'codex status parity baseline'
const BASE_REPLY = `hello from mock-acp (you said: ${BASE_PROMPT})`
const SLOW_PROMPT = 'status-slow-tool active status parity'
const FIRST_QUEUED = 'status parity queued first'
const SECOND_QUEUED = 'status parity queued second'
const FIRST_REPLY = `hello from mock-acp (you said: ${FIRST_QUEUED})`
const SECOND_REPLY = `hello from mock-acp (you said: ${SECOND_QUEUED})`
const TOOL_NAME = 'Status slow subprocess'

let fixtureRoot = ''
let walnutHome = ''

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  ;({ fixtureRoot, walnutHome } = await discoverBrowserFixture(TEST_PORT))
  await fs.mkdir(SCREENSHOT_DIR, { recursive: true })
})

async function openCodexQuickStart(page: Page): Promise<void> {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.locator('.quick-access-pill', { hasText: 'Quick session' }).click()
  await expect(page.locator('.session-path-selector')).toBeVisible()
  const localTab = page.locator('.sps-host-tab', { hasText: 'Local' })
  if (await localTab.isVisible()) await localTab.click()
  await page.locator('.sps-engine-toggle .sps-engine-btn', { hasText: 'Codex' }).click()
  await page.locator('.sps-search-input').fill(`${fixtureRoot}/projects/walnut`)
  await page.locator('.sps-search-input').press('Shift+Enter')
}

async function navigateToSessions(page: Page): Promise<void> {
  const other = page.getByRole('button', { name: /Other/i })
  if (await other.getAttribute('aria-expanded') !== 'true') await other.click()
  await page.locator('a[href="/sessions"]').click()
  await expect(page).toHaveURL(/\/sessions$/)
  await expect(page.locator('.session-tree-panel')).toBeVisible()
}

async function navigateToTasks(page: Page): Promise<void> {
  const other = page.getByRole('button', { name: /Other/i })
  if (await other.getAttribute('aria-expanded') !== 'true') await other.click()
  await page.locator('a[href="/tasks"]').click()
  await expect(page).toHaveURL(/\/tasks$/)
  await expect(page.locator('.task-list')).toBeVisible()
}

async function processStatus(page: Page, sessionId: string): Promise<string> {
  const response = await page.request.get(`/api/sessions/${sessionId}`)
  return ((await response.json()) as {
    session: { process_status: string }
  }).session.process_status
}

async function expectQueued(surface: Locator, message: string): Promise<void> {
  const bubble = surface.locator('.session-msg-received', { hasText: message })
  await expect(bubble.getByText('Queued', { exact: true })).toBeVisible()
}

test('broadcasts active Codex status across Home, Sessions, task pill, and reload', async ({ page }) => {
  test.setTimeout(60_000)
  const audit = await installBrowserAudit(page, walnutHome)

  await openCodexQuickStart(page)
  const quickStartResponse = page.waitForResponse((response) =>
    response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/sessions/quick-start')
  const quickInput = page.locator('.main-page-chat .chat-input-textarea')
  await quickInput.fill(BASE_PROMPT)
  await quickInput.press('Enter')
  const quickStart = await quickStartResponse
  expect(quickStart.status()).toBe(200)
  const { taskId } = await quickStart.json() as { taskId: string }

  const homePanel = page.locator('.session-panel:not(.pending-session-panel)')
  await expect(homePanel).toBeVisible({ timeout: 15_000 })
  await expect(homePanel.getByText(BASE_REPLY, { exact: true }))
    .toHaveCount(1, { timeout: 20_000 })
  await expect(homePanel.locator('.session-panel-badge', { hasText: 'Idle' }))
    .toHaveCount(1)

  let sessionId = ''
  await expect.poll(async () => {
    const response = await page.request.get(`/api/sessions/task/${taskId}`)
    const sessions = ((await response.json()) as {
      sessions: Array<{ claudeSessionId: string; process_status: string }>
    }).sessions
    sessionId = sessions[0]?.claudeSessionId ?? ''
    return sessions[0]?.process_status
  }, { timeout: 15_000 }).toBe('idle')

  const panelInput = homePanel.locator('.chat-input-textarea')
  await panelInput.fill(SLOW_PROMPT)
  await panelInput.press('Enter')
  await expect.poll(() => processStatus(page, sessionId), { timeout: 10_000 })
    .toBe('running')
  await expect(homePanel.locator('.session-panel-badge', { hasText: 'Running' }))
    .toHaveCount(1, { timeout: 2_000 })
  const activeTool = homePanel.locator('.chat-tool-block').filter({ hasText: TOOL_NAME })
  await expect(activeTool).toBeVisible({ timeout: 10_000 })
  await expect(activeTool).not.toHaveClass(/chat-tool-block-done/)

  await panelInput.fill(FIRST_QUEUED)
  await panelInput.press('Enter')
  await panelInput.fill(SECOND_QUEUED)
  await panelInput.press('Enter')
  await expectQueued(homePanel, FIRST_QUEUED)
  await expectQueued(homePanel, SECOND_QUEUED)
  await expect(homePanel.locator('.session-panel-badge', { hasText: 'Running' }))
    .toHaveCount(1)
  await page.screenshot({
    path: `${SCREENSHOT_DIR}/home-running-tool-queued.png`,
    fullPage: true,
  })

  await navigateToTasks(page)
  await page.getByLabel('Filter by status').selectOption('')
  const activeTaskCard = page.locator(`.task-card[data-task-id="${taskId}"]`)
  await expect(activeTaskCard).toBeVisible()
  await expect(activeTaskCard.locator('.task-session-pill')).toContainText('Running')
  await page.screenshot({
    path: `${SCREENSHOT_DIR}/tasks-running-pill.png`,
    fullPage: true,
  })

  await navigateToSessions(page)
  const search = page.getByRole('searchbox', { name: 'Search sessions' })
  await search.fill(sessionId)
  const sessionRow = page.locator(`.session-tree-session[data-session-id="${sessionId}"]`)
  await expect(sessionRow).toBeVisible()
  await sessionRow.click()
  const detail = page.locator('.sessions-detail-pane')
  await expect(detail.locator('.session-detail-badge', { hasText: 'Running' }))
    .toHaveCount(1)
  await expect(detail.locator('.chat-tool-block-calling').filter({ hasText: TOOL_NAME }))
    .toBeVisible()
  await expectQueued(detail, FIRST_QUEUED)
  await expectQueued(detail, SECOND_QUEUED)
  expect(await processStatus(page, sessionId)).toBe('running')

  await expect(detail.getByText(FIRST_REPLY, { exact: true }))
    .toHaveCount(1, { timeout: 25_000 })
  await expect(detail.getByText(SECOND_REPLY, { exact: true }))
    .toHaveCount(1, { timeout: 25_000 })
  await expect.poll(() => processStatus(page, sessionId), { timeout: 15_000 })
    .toBe('idle')
  await expect(detail.locator('.session-detail-badge', { hasText: 'Idle' }))
    .toHaveCount(1)

  await page.reload()
  const reloadedDetail = page.locator('.sessions-detail-pane')
  await expect(reloadedDetail.locator('.session-detail-badge', { hasText: 'Idle' }))
    .toHaveCount(1)
  await expect(reloadedDetail.getByText(SLOW_PROMPT, { exact: true })).toHaveCount(1)
  await expect(reloadedDetail.getByText(FIRST_QUEUED, { exact: true })).toHaveCount(1)
  await expect(reloadedDetail.getByText(SECOND_QUEUED, { exact: true })).toHaveCount(1)
  await expect(reloadedDetail.locator('.chat-tool-block-done').filter({ hasText: TOOL_NAME }))
    .toHaveClass(/chat-tool-block-done/)

  await navigateToTasks(page)
  await page.getByLabel('Filter by status').selectOption('')
  const finalTaskCard = page.locator(`.task-card[data-task-id="${taskId}"]`)
  await expect(finalTaskCard).toBeVisible()
  await expect(finalTaskCard.locator('.task-session-pill')).toContainText('Idle')

  await page.getByRole('link', { name: 'Home', exact: true }).click()
  await expect(page).toHaveURL(/\/$/)
  await page.locator('.todo-search-input').fill(sessionId)
  const finalTaskRow = page.locator(`.todo-panel-item[data-task-id="${taskId}"]`).last()
  await expect(finalTaskRow).toBeVisible()
  await finalTaskRow.locator('.todo-item-title').click()
  const finalHomePanel = page.locator('.session-panel:not(.pending-session-panel)')
  await expect(finalHomePanel.locator('.session-panel-badge', { hasText: 'Idle' }))
    .toHaveCount(1)
  await expect(finalHomePanel.getByText(SECOND_REPLY, { exact: true })).toHaveCount(1)
  await page.screenshot({
    path: `${SCREENSHOT_DIR}/reloaded-idle-parity.png`,
    fullPage: true,
  })

  await audit.assertClean({
    requestFailure: (failure) => {
      const url = new URL(failure.url)
      return failure.method === 'PUT'
        && failure.errorText === 'net::ERR_ABORTED'
        && url.pathname === '/api/ui-prefs'
    },
  })
})
