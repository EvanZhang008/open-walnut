import fs from 'node:fs/promises'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { discoverBrowserFixture, installBrowserAudit } from './codex-test-audit'
import { REAL_PANEL, openDraftOnCwd } from './draft-helpers'

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

/**
 * Land on the Homepage and open a Codex draft session column on the fixture repo.
 * "+" grows the draft; the SAME picker (all `.sps-*` selectors) now lives inside
 * it, so ./draft-helpers owns the route in. Returns the draft panel — the first
 * message is composed in ITS composer, which is what launches the session.
 */
async function openCodexQuickStart(page: Page): Promise<Locator> {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  return openDraftOnCwd(page, `${fixtureRoot}/projects/walnut`, { engine: 'Codex' })
}

test('interrupt and send leaves one boundary and one replacement turn', async ({ page }) => {
  const audit = await installBrowserAudit(page, walnutHome)

  const draft = await openCodexQuickStart(page)
  const quickStartResponse = page.waitForResponse((response) =>
    response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/sessions/quick-start')
  const input = draft.locator('.chat-input-textarea')
  await input.fill(SLOW_PROMPT)
  await input.press('Enter')
  const quickStart = await quickStartResponse
  expect(quickStart.status()).toBe(200)
  const { taskId } = await quickStart.json() as { taskId: string }

  const panel = page.locator(REAL_PANEL)
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
