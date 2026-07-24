import fs from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import { discoverBrowserFixture, installBrowserAudit } from './codex-test-audit'

const SCREENSHOT_DIR = '/tmp/codex-customer-matrix-ui-final'
const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const FIRST_PROMPT = 'codex conversation fresh exact'
const FIRST_REPLY = `hello from mock-acp (you said: ${FIRST_PROMPT})`
const WARM_PROMPT = 'codex conversation warm exact'
const WARM_REPLY = `hello from mock-acp (you said: ${WARM_PROMPT})`

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

async function sessionForTask(page: Page, taskId: string): Promise<{
  claudeSessionId: string
  messageCount: number
  process_status: string
}> {
  let sessions: Array<{
    claudeSessionId: string
    messageCount: number
    process_status: string
  }> = []
  await expect.poll(async () => {
    const response = await page.request.get(`/api/sessions/task/${taskId}`)
    sessions = ((await response.json()) as { sessions: typeof sessions }).sessions
    return sessions.length
  }, { timeout: 15_000 }).toBe(1)
  return sessions[0]
}

test('fresh and warm Codex turns render once and agree with history on both surfaces', async ({ page }) => {
  test.setTimeout(45_000)
  const audit = await installBrowserAudit(page, walnutHome)

  await openCodexQuickStart(page)
  const quickStartResponse = page.waitForResponse((response) =>
    response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/sessions/quick-start')
  const input = page.locator('.main-page-chat .chat-input-textarea')
  await input.fill(FIRST_PROMPT)
  await input.press('Enter')
  const quickStart = await quickStartResponse
  expect(quickStart.status()).toBe(200)
  const { taskId } = await quickStart.json() as { taskId: string }

  const panel = page.locator('.session-panel:not(.pending-session-panel)')
  await expect(panel).toBeVisible({ timeout: 15_000 })
  await expect(panel.getByText(FIRST_PROMPT, { exact: true })).toHaveCount(1)
  await expect(panel.getByText(FIRST_REPLY, { exact: true })).toHaveCount(1, { timeout: 20_000 })

  const initial = await sessionForTask(page, taskId)
  await expect.poll(async () => {
    const response = await page.request.get(`/api/sessions/${initial.claudeSessionId}`)
    const body = await response.json() as {
      session: { messageCount: number; process_status: string }
    }
    return `${body.session.messageCount}:${body.session.process_status}`
  }, { timeout: 15_000 }).toBe('1:idle')

  await expect.poll(async () => {
    const response = await page.request.get(`/api/sessions/${initial.claudeSessionId}`)
    const session = ((await response.json()) as {
      session: { summary?: string; recap?: string }
    }).session
    return `${session.summary ?? ''}|${session.recap ?? ''}`
  }, { timeout: 15_000 }).toBe(
    'Codex browser session completed and persisted its latest work.|Verified persisted Codex history and recovery.',
  )
  const summarizedTask = await (await page.request.get(`/api/tasks/${taskId}`)).json() as {
    task: { summary?: string; note?: string }
  }
  expect(summarizedTask.task.summary).toBe('Codex browser session completed and persisted its latest work.')
  expect(summarizedTask.task.note).toContain('## Executive Summary')

  const terminate = await page.request.post(`/api/sessions/${initial.claudeSessionId}/terminate`)
  expect(terminate.status()).toBe(200)
  await expect.poll(async () => {
    const response = await page.request.get(`/api/sessions/${initial.claudeSessionId}`)
    return ((await response.json()) as { session: { process_status: string } }).session.process_status
  }).toBe('stopped')

  // Reload the stopped, real-created session and prove persisted history is
  // visible before a recovery send.
  await page.reload()
  const reloadedPanel = page.locator('.session-panel:not(.pending-session-panel)')
  await expect(reloadedPanel).toBeVisible({ timeout: 10_000 })
  await expect(reloadedPanel.getByText(FIRST_PROMPT, { exact: true })).toHaveCount(1)
  await expect(reloadedPanel.getByText(FIRST_REPLY, { exact: true })).toHaveCount(1)
  await expect(reloadedPanel.getByText('Stopped', { exact: true })).toHaveCount(1)
  await expect(reloadedPanel.getByText('Verified persisted Codex history and recovery.', { exact: true }))
    .toHaveCount(1)

  const panelInput = reloadedPanel.locator('.chat-input-textarea')
  await panelInput.fill(WARM_PROMPT)
  await panelInput.press('Enter')
  await expect(reloadedPanel.getByText(WARM_PROMPT, { exact: true })).toHaveCount(1)
  await expect(reloadedPanel.getByText(WARM_REPLY, { exact: true })).toHaveCount(1, { timeout: 20_000 })
  await expect(reloadedPanel.getByText(FIRST_REPLY, { exact: true })).toHaveCount(1)

  let history: Array<{ role: string; text: string }> = []
  await expect.poll(async () => {
    const response = await page.request.get(`/api/sessions/${initial.claudeSessionId}/history`)
    history = ((await response.json()) as { messages: typeof history }).messages
    return history.map((message) => `${message.role}:${message.text}`)
  }, { timeout: 15_000 }).toEqual([
    `user:${FIRST_PROMPT}`,
    `assistant:${FIRST_REPLY}`,
    `user:${WARM_PROMPT}`,
    `assistant:${WARM_REPLY}`,
  ])
  await expect.poll(async () => {
    const response = await page.request.get(`/api/sessions/${initial.claudeSessionId}`)
    const body = await response.json() as {
      session: { messageCount: number; process_status: string }
    }
    return `${body.session.messageCount}:${body.session.process_status}`
  }, { timeout: 15_000 }).toBe('2:idle')
  await expect(reloadedPanel.getByText('2 turns', { exact: true })).toHaveCount(1)
  await page.screenshot({
    path: `${SCREENSHOT_DIR}/conversation-homepage-fresh-warm-exact.png`,
    fullPage: true,
  })

  const other = page.getByRole('button', { name: /Other/i })
  if (await other.getAttribute('aria-expanded') !== 'true') await other.click()
  await page.locator('a[href="/sessions"]').click()
  await expect(page.locator('.session-tree-panel')).toBeVisible()
  const search = page.getByRole('searchbox', { name: 'Search sessions' })
  const exactTreeResponse = page.waitForResponse((response) => {
    const url = new URL(response.url())
    return response.request().method() === 'GET'
      && url.pathname === '/api/sessions/tree'
      && url.searchParams.get('q') === initial.claudeSessionId
      && url.searchParams.get('limit') === '100'
  })
  await search.fill(initial.claudeSessionId)
  await page.locator(`.session-tree-session[data-session-id="${initial.claudeSessionId}"]`).click()

  const detail = page.locator('.sessions-detail-pane')
  await expect(detail.getByText(FIRST_PROMPT, { exact: true })).toHaveCount(1)
  await expect(detail.getByText(FIRST_REPLY, { exact: true })).toHaveCount(1)
  await expect(detail.getByText(WARM_PROMPT, { exact: true })).toHaveCount(1)
  await expect(detail.getByText(WARM_REPLY, { exact: true })).toHaveCount(1)
  await expect(detail.getByText('2 turns', { exact: true })).toHaveCount(1)
  const timelineText = await detail.locator('.session-history').innerText()
  expect(timelineText.indexOf(FIRST_PROMPT)).toBeLessThan(timelineText.indexOf(FIRST_REPLY))
  expect(timelineText.indexOf(FIRST_REPLY)).toBeLessThan(timelineText.indexOf(WARM_PROMPT))
  expect(timelineText.indexOf(WARM_PROMPT)).toBeLessThan(timelineText.indexOf(WARM_REPLY))
  await page.screenshot({
    path: `${SCREENSHOT_DIR}/conversation-sessions-parity-exact.png`,
    fullPage: true,
  })

  // Let the exact-search tree request settle before reloading. Otherwise the
  // reload itself can cancel healthy tree or persisted-selection requests and
  // muddy the audit.
  await exactTreeResponse
  await page.waitForLoadState('networkidle')
  await page.reload()
  await expect(page.locator('.sessions-detail-pane').getByText(FIRST_PROMPT, { exact: true })).toHaveCount(1)
  await expect(page.locator('.sessions-detail-pane').getByText(FIRST_REPLY, { exact: true })).toHaveCount(1)
  await expect(page.locator('.sessions-detail-pane').getByText(WARM_PROMPT, { exact: true })).toHaveCount(1)
  await expect(page.locator('.sessions-detail-pane').getByText(WARM_REPLY, { exact: true })).toHaveCount(1)

  await audit.assertClean({
    requestFailure: (failure) => {
      const url = new URL(failure.url)
      return failure.method === 'PUT'
        && failure.errorText === 'net::ERR_ABORTED'
        && url.pathname === '/api/ui-prefs'
    },
  })
})
