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
  await page.locator('.quick-access-pill', { hasText: /Quick session|\+ Session/ }).click()
  await expect(page.locator('.session-path-selector')).toBeVisible()
  const localTab = page.locator('.sps-host-tab', { hasText: 'Local' })
  if (await localTab.isVisible()) await localTab.click()
  await page.locator('.sps-engine-toggle .sps-engine-btn', { hasText: 'Codex' }).click()
  await page.locator('.sps-search-input').fill(`${fixtureRoot}/projects/walnut`)
  await page.locator('.sps-search-input').press('Shift+Enter')
}

async function navigateToTasks(page: Page): Promise<void> {
  const other = page.getByRole('button', { name: /Other/i })
  if (await other.getAttribute('aria-expanded') !== 'true') await other.click()
  await page.locator('a[href="/tasks"]').click()
  await expect(page).toHaveURL(/\/tasks$/)
  await expect(page.getByTestId('tasks-table')).toBeVisible()
}

/** Show every status on the /tasks table (Todo on by default; turn Done on too). */
async function showAllStatusesOnTasksPage(page: Page): Promise<void> {
  const doneChip = page.locator('.tp-chip', { hasText: 'Done' })
  if (!/\bon\b/.test((await doneChip.getAttribute('class')) ?? '')) await doneChip.click()
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

test('broadcasts active Codex status across Home, task pill, and reload', async ({ page }) => {
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
  await showAllStatusesOnTasksPage(page)
  const activeTaskRow = page.locator(`.tp-row[data-task-id="${taskId}"]`)
  await expect(activeTaskRow).toBeVisible()
  await expect(activeTaskRow.locator('.task-session-pill')).toContainText('Running')
  await page.screenshot({
    path: `${SCREENSHOT_DIR}/tasks-running-pill.png`,
    fullPage: true,
  })

  await page.getByRole('link', { name: 'Home', exact: true }).click()
  await expect(page).toHaveURL(/\/$/)
  await page.locator('.todo-search-input').fill(sessionId)
  const finalTaskRow = page.locator(`.todo-panel-item[data-task-id="${taskId}"]`).last()
  await expect(finalTaskRow).toBeVisible()
  await finalTaskRow.locator('.todo-item-title').click()
  const finalHomePanel = page.locator('.session-panel:not(.pending-session-panel)')
  await expect(finalHomePanel).toBeVisible({ timeout: 15_000 })
  await expect(finalHomePanel.getByText(FIRST_REPLY, { exact: true }))
    .toHaveCount(1, { timeout: 25_000 })
  await expect(finalHomePanel.getByText(SECOND_REPLY, { exact: true }))
    .toHaveCount(1, { timeout: 25_000 })
  await expect.poll(() => processStatus(page, sessionId), { timeout: 15_000 })
    .toBe('idle')
  await expect(finalHomePanel.locator('.session-panel-badge', { hasText: 'Idle' }))
    .toHaveCount(1)

  await page.reload()
  const reloadedPanel = page.locator('.session-panel:not(.pending-session-panel)')
  await expect(reloadedPanel).toBeVisible({ timeout: 15_000 })
  await expect(reloadedPanel.locator('.session-panel-badge', { hasText: 'Idle' }))
    .toHaveCount(1)
  await expect(reloadedPanel.getByText(SLOW_PROMPT, { exact: true })).toHaveCount(1)
  await expect(reloadedPanel.getByText(FIRST_QUEUED, { exact: true })).toHaveCount(1)
  await expect(reloadedPanel.getByText(SECOND_QUEUED, { exact: true })).toHaveCount(1)
  // After reload the completed tool renders collapsed into a muted run row —
  // expand it to reach the tool card and verify the done state persisted.
  await reloadedPanel.locator('.tool-run-toggle').first().click()
  await expect(reloadedPanel.locator('.chat-tool-block-done').filter({ hasText: TOOL_NAME }))
    .toHaveClass(/chat-tool-block-done/)
  await page.screenshot({
    path: `${SCREENSHOT_DIR}/reloaded-idle-parity.png`,
    fullPage: true,
  })

  await navigateToTasks(page)
  await showAllStatusesOnTasksPage(page)
  const finalTaskRow = page.locator(`.tp-row[data-task-id="${taskId}"]`)
  await expect(finalTaskRow).toBeVisible()
  await expect(finalTaskRow.locator('.task-session-pill')).toContainText('Idle')

  await audit.assertClean({
    requestFailure: (failure) => {
      const url = new URL(failure.url)
      return failure.method === 'PUT'
        && failure.errorText === 'net::ERR_ABORTED'
        && url.pathname === '/api/ui-prefs'
    },
  })
})
