import fs from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import { discoverBrowserFixture, installBrowserAudit } from './codex-test-audit'

const SCREENSHOT_DIR = '/tmp/codex-customer-matrix-ui-final'
const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const SLOW_PROMPT = 'lifecycle-slow active turn'
const REPLACEMENT_PROMPT = 'codex lifecycle replacement'
const REPLACEMENT_REPLY = `hello from mock-acp (you said: ${REPLACEMENT_PROMPT})`

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

test('interrupt and send leaves one boundary and one replacement turn', async ({ page }) => {
  const audit = await installBrowserAudit(page, walnutHome)

  await openCodexQuickStart(page)
  const quickStartResponse = page.waitForResponse((response) =>
    response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/sessions/quick-start')
  const input = page.locator('.main-page-chat .chat-input-textarea')
  await input.fill(SLOW_PROMPT)
  await input.press('Enter')
  const quickStart = await quickStartResponse
  expect(quickStart.status()).toBe(200)
  const { taskId } = await quickStart.json() as { taskId: string }

  const panel = page.locator('.session-panel:not(.pending-session-panel)')
  await expect(panel).toBeVisible({ timeout: 15_000 })
  await expect(panel.getByText('thinking...', { exact: true })).toHaveCount(1, { timeout: 15_000 })

  let sessionId = ''
  await expect.poll(async () => {
    const response = await page.request.get(`/api/sessions/task/${taskId}`)
    const body = await response.json() as {
      sessions: Array<{ claudeSessionId: string; messageCount: number; process_status: string }>
    }
    sessionId = body.sessions[0]?.claudeSessionId ?? ''
    return body.sessions[0] ? `${body.sessions[0].messageCount}:${body.sessions[0].process_status}` : ''
  }, { timeout: 15_000 }).toBe('1:running')

  const panelInput = panel.locator('.chat-input-textarea')
  await panelInput.fill(REPLACEMENT_PROMPT)
  await panel.getByRole('button', { name: 'More send options' }).click()
  await panel.getByRole('menuitem', { name: 'Interrupt & send' }).click()

  await expect(panel.getByText('Turn interrupted by user.', { exact: true }))
    .toHaveCount(1, { timeout: 20_000 })
  await expect(panel.getByText(REPLACEMENT_PROMPT, { exact: true })).toHaveCount(1)
  await expect(panel.getByText(REPLACEMENT_REPLY, { exact: true }))
    .toHaveCount(1, { timeout: 20_000 })

  let history: Array<{ role: string; text: string }> = []
  await expect.poll(async () => {
    const response = await page.request.get(`/api/sessions/${sessionId}/history`)
    history = ((await response.json()) as { messages: typeof history }).messages
    return history.filter((message) => message.text === 'Turn interrupted by user.').length
  }, { timeout: 15_000 }).toBe(1)
  expect(history.filter((message) => message.text === REPLACEMENT_PROMPT)).toHaveLength(1)
  expect(history.filter((message) => message.text === REPLACEMENT_REPLY)).toHaveLength(1)
  expect(history.findIndex((message) => message.text === 'Turn interrupted by user.'))
    .toBeLessThan(history.findIndex((message) => message.text === REPLACEMENT_PROMPT))

  await expect.poll(async () => {
    const response = await page.request.get(`/api/sessions/${sessionId}`)
    const body = await response.json() as {
      session: { messageCount: number; process_status: string }
    }
    return `${body.session.messageCount}:${body.session.process_status}`
  }, { timeout: 15_000 }).toBe('2:idle')
  await expect(panel.getByText('2 turns', { exact: true })).toHaveCount(1)
  await page.screenshot({
    path: `${SCREENSHOT_DIR}/lifecycle-interrupt-single-boundary.png`,
    fullPage: true,
  })

  await audit.assertClean()
})
