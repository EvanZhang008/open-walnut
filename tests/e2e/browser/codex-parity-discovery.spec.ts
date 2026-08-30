import fs from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import { discoverBrowserFixture, installBrowserAudit } from './codex-test-audit'

const SCREENSHOT_DIR = '/tmp/codex-customer-matrix-ui-final'
const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const SESSION_ID = 'pw-codex-customer-session'
const TASK_ID = 'pw-task-codex-customer'
const TASK_TITLE = 'Playwright Codex customer task'
const USER_TEXT = 'CODEX-PARITY-USER-UNIQUE'
const ASSISTANT_TEXT = 'CODEX-PARITY-ASSISTANT-UNIQUE'
let walnutHome = ''

test.beforeAll(async () => {
  ;({ walnutHome } = await discoverBrowserFixture(TEST_PORT))
})

async function openHomepageSession(page: Page): Promise<void> {
  await page.locator('.todo-search-input').fill(SESSION_ID)
  const task = page.locator(`.todo-panel-item[data-task-id="${TASK_ID}"]`)
  await expect(task).toBeVisible()
  await task.locator('.todo-item-title').click()
  await expect(page.locator('.main-page-session-column .session-panel')).toBeVisible()
}

async function expectTranscript(panel: ReturnType<Page['locator']>): Promise<void> {
  await expect(panel.getByText(USER_TEXT, { exact: true })).toHaveCount(1)
  await expect(panel.getByText(ASSISTANT_TEXT, { exact: true })).toHaveCount(1)
  await expect(panel.locator('.session-msg-role')).toHaveCount(0)
  await expect(panel.getByText('Walnut', { exact: true })).toHaveCount(0)
}

test('Homepage renders the persisted Codex session and blocks unsupported forks', async ({ page }) => {
  await fs.mkdir(SCREENSHOT_DIR, { recursive: true })
  const audit = await installBrowserAudit(page, walnutHome)

  await page.goto('/')
  await page.waitForLoadState('networkidle')

  await openHomepageSession(page)
  const homePanel = page.locator('.main-page-session-column .session-panel')
  await expect(homePanel.locator('.session-panel-title')).toHaveText(TASK_TITLE)
  // Seeded as stopped; opening the panel may attach the mock ACP runtime and
  // reconcile the badge to Idle — both are valid settled states for the fixture.
  await expect(homePanel.getByText(/^(Stopped|Idle)$/).first()).toBeVisible()
  // (The header's "N turns" badge was removed in 732b9196 — the transcript
  // check below is what proves the 2 parity + 2 mobile messages loaded.)
  // Pill shows the engine name ("Codex") for a cold record, or the resolved
  // model label ("GPT Best") once the mock ACP runtime attaches on open.
  await expect(homePanel.locator('.session-detail-model-pill', { hasText: /Codex|GPT Best/ })).toBeVisible()
  await expectTranscript(homePanel)
  const homeFork = homePanel.getByRole('button', { name: /Fork is unavailable/ })
  await expect(homeFork).toBeDisabled()
  await expect(homeFork).toHaveAttribute(
    'title',
    'Fork is unavailable because this Codex adapter does not support session forking',
  )
  await homeFork.evaluate((button: HTMLButtonElement) => button.click())
  await page.screenshot({ path: `${SCREENSHOT_DIR}/desktop-homepage-codex-parity.png`, fullPage: true })

  // The disabled button is only cosmetic protection — the API itself must
  // refuse unsupported forks without creating any task or session.
  //
  // This fixture server is shared with the other browser specs, which create
  // their own tasks/sessions concurrently, so a global before/after list
  // comparison is inherently flaky (a sibling spec's quick-start lands a task
  // between the two snapshots). Assert the fork ADDED NO ATTRIBUTABLE artifact
  // instead: a successful fork of this task would appear as a "Fork of <source>"
  // task, and the ACP guard is proven (in session-controls.ts) to fire before
  // any task/session write — so that task must be absent, and nothing that
  // existed before the call may have been removed.
  const tasksBefore = await (await page.request.get('/api/tasks')).json() as {
    tasks: Array<{ id: string; title: string }>
  }
  const sessionsBefore = await (await page.request.get('/api/sessions')).json() as {
    sessions: Array<{ claudeSessionId: string }>
  }
  const forkResponse = await page.request.post(`/api/sessions/${SESSION_ID}/fork`, {
    data: { create_child_task: true, message: 'unsupported browser fork probe' },
  })
  expect(forkResponse.status()).toBe(409)
  expect(await forkResponse.json()).toEqual(expect.objectContaining({ code: 'ACP_FORK_UNSUPPORTED' }))
  const tasksAfter = await (await page.request.get('/api/tasks')).json() as {
    tasks: Array<{ id: string; title: string }>
  }
  const sessionsAfter = await (await page.request.get('/api/sessions')).json() as {
    sessions: Array<{ claudeSessionId: string }>
  }
  const taskIdsAfter = new Set(tasksAfter.tasks.map((task) => task.id))
  for (const task of tasksBefore.tasks) {
    expect(taskIdsAfter.has(task.id), `task ${task.id} must survive a rejected fork`).toBe(true)
  }
  const sessionIdsAfter = new Set(sessionsAfter.sessions.map((session) => session.claudeSessionId))
  for (const session of sessionsBefore.sessions) {
    expect(
      sessionIdsAfter.has(session.claudeSessionId),
      `session ${session.claudeSessionId} must survive a rejected fork`,
    ).toBe(true)
  }
  expect(tasksAfter.tasks.some((task) => new RegExp(`fork of ${TASK_TITLE}`, 'i').test(task.title)))
    .toBe(false)

  await audit.assertClean({
    http: (response) =>
      response.status === 409 && new URL(response.url).pathname.endsWith(`/${SESSION_ID}/fork`),
  })
})
