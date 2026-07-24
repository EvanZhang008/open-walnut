import fs from 'node:fs/promises'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { discoverBrowserFixture, installBrowserAudit } from './codex-test-audit'

const SCREENSHOT_DIR = '/tmp/session-status-store'
const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const BASE_PROMPT = 'versioned status store baseline'
const BASE_REPLY = `hello from mock-acp (you said: ${BASE_PROMPT})`
const DESKTOP_SLOW_PROMPT = 'status-slow-tool-long version race desktop'
const MOBILE_SLOW_PROMPT = 'status-slow-tool-long version race mobile'
const TOOL_NAME = 'Status slow subprocess'

interface StatusSnapshot {
  sessionId: string
  taskId: string
  process_status: 'running' | 'idle' | 'stopped' | 'error'
  statusRevision: number
}

let fixtureRoot = ''
let walnutHome = ''
let taskId = ''
let sessionId = ''

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

async function statusFor(page: Page, id: string): Promise<StatusSnapshot> {
  const response = await page.request.get(`/api/sessions/status?ids=${encodeURIComponent(id)}`)
  expect(response.status()).toBe(200)
  const body = await response.json() as { statuses: Record<string, StatusSnapshot> }
  const snapshot = body.statuses[id]
  if (!snapshot) throw new Error(`Missing status snapshot for ${id}`)
  return snapshot
}

async function sessionForTask(page: Page, id: string): Promise<string> {
  let providerId = ''
  await expect.poll(async () => {
    const response = await page.request.get(`/api/sessions/task/${id}`)
    const body = await response.json() as {
      sessions: Array<{ claudeSessionId: string }>
    }
    providerId = body.sessions[0]?.claudeSessionId ?? ''
    return providerId
  }, { timeout: 15_000 }).not.toBe('')
  return providerId
}

async function storeStatus(page: Page, id: string): Promise<{
  sessionId: string | null
  processStatus: string | null
  revision: number | null
}> {
  return page.evaluate(async (providerId) => {
    const modulePath = '/src/stores/session-status-store.ts'
    const module = await import(/* @vite-ignore */ modulePath)
    const snapshot = module.sessionStatusStore.getStatus(providerId)
    return {
      sessionId: snapshot?.sessionId ?? null,
      processStatus: snapshot?.process_status ?? null,
      revision: snapshot?.statusRevision ?? null,
    }
  }, id)
}

async function startStatusHydration(page: Page, id: string): Promise<void> {
  await page.evaluate((providerId) => {
    const result = window as typeof window & {
      __statusHydrationDone?: boolean
      __statusHydrationError?: string
    }
    result.__statusHydrationDone = false
    delete result.__statusHydrationError
    const modulePath = '/src/api/sessions.ts'
    void import(/* @vite-ignore */ modulePath)
      .then((module) => module.hydrateSessionStatuses([providerId]))
      .then(() => { result.__statusHydrationDone = true })
      .catch((error) => {
        result.__statusHydrationError = String(error)
        result.__statusHydrationDone = true
      })
  }, id)
}

async function expectHydrationDone(page: Page): Promise<void> {
  await page.waitForFunction(() =>
    (window as typeof window & { __statusHydrationDone?: boolean }).__statusHydrationDone === true)
  expect(await page.evaluate(() =>
    (window as typeof window & { __statusHydrationError?: string }).__statusHydrationError),
  ).toBeUndefined()
}

async function findHomeTask(page: Page, id: string): Promise<Locator> {
  await page.locator('.todo-search-input').fill(id)
  const task = page.locator(`.todo-panel-item[data-task-id="${id}"]:visible`).first()
  await expect(task).toBeVisible({ timeout: 10_000 })
  return task
}

function recentTaskCard(page: Page, id: string): Locator {
  return page.locator(`.todo-pinned-list-recent .todo-pinned-card[data-task-id="${id}"]`)
}

function focusTaskCard(page: Page, id: string): Locator {
  return page.locator(`.todo-focus-card[data-task-id="${id}"]`)
}

async function expectNoTaskPill(container: Locator): Promise<void> {
  await expect(container.locator('.task-session-pill')).toHaveCount(0)
}

async function expectTaskMenuStatus(
  page: Page,
  container: Locator,
  status: 'AI is working...' | 'Needs your attention',
): Promise<void> {
  const moreActions = container.getByRole('button', { name: 'More actions' })
  await moreActions.click()
  const menu = page.locator('.task-kebab-menu:visible')
  await expect(menu.getByText(status, { exact: true })).toBeVisible()
  await page.locator('.main-page-chat').click({ position: { x: 8, y: 8 } })
  await expect(menu).toHaveCount(0)
}

async function focusDockCard(page: Page, task: Locator): Promise<Locator> {
  const id = await task.getAttribute('data-task-id')
  if (!id) throw new Error('Focused task is missing data-task-id')
  return page.locator(`.dock-task-card[data-task-id="${id}"]`)
}

async function pinTaskToFocus(page: Page, task: Locator): Promise<Locator> {
  await task.getByRole('button', { name: 'More actions' }).click()
  const focus = page.locator('.task-kebab-tier-btn[title="Focus"]')
  if (await focus.isVisible()) await focus.click()
  const dock = await focusDockCard(page, task)
  await expect(dock).toBeVisible({ timeout: 10_000 })
  return dock
}

async function openTaskDetail(page: Page, task: Locator): Promise<Locator> {
  await task.getByRole('button', { name: 'More actions' }).click()
  await page.locator('.task-kebab-menu').getByText('Details', { exact: true }).click()
  const modal = page.locator('.task-detail-modal')
  await expect(modal).toBeVisible()
  return modal
}

async function navigateToSessions(page: Page, mobile = false): Promise<void> {
  if (mobile) await page.getByRole('button', { name: 'Toggle sidebar' }).click()
  const other = page.getByRole('button', { name: /Other/i })
  if (await other.getAttribute('aria-expanded') !== 'true') await other.click()
  await page.locator('a[href="/sessions"]').click()
  await expect(page).toHaveURL(/\/sessions$/)
  if (mobile) {
    await expect(page.locator('.sidebar-overlay')).toHaveCount(0)
    await expect(page.locator('.sidebar')).not.toHaveClass(/\bopen\b/)
  }
  await expect(page.locator('.session-tree-panel')).toBeVisible()
}

async function navigateToTasks(page: Page, mobile = false): Promise<void> {
  if (mobile) await page.getByRole('button', { name: 'Toggle sidebar' }).click()
  const other = page.getByRole('button', { name: /Other/i })
  if (await other.getAttribute('aria-expanded') !== 'true') await other.click()
  await page.locator('a[href="/tasks"]').click()
  await expect(page).toHaveURL(/\/tasks$/)
  if (mobile) {
    await expect(page.locator('.sidebar-overlay')).toHaveCount(0)
    await expect(page.locator('.sidebar')).not.toHaveClass(/\bopen\b/)
  }
  await expect(page.locator('.task-list')).toBeVisible()
}

async function selectSession(page: Page, id: string): Promise<{
  row: Locator
  detail: Locator
}> {
  await page.getByRole('searchbox', { name: 'Search sessions' }).fill(id)
  const row = page.locator(`.session-tree-session[data-session-id="${id}"]`)
  const detail = page.locator('.sessions-detail-pane')
  if (await row.isVisible()) await row.click()
  await expect(detail).toBeVisible()
  return { row, detail }
}

test('rejects delayed REST N after WS N+1 across every desktop status surface', async ({ page }) => {
  test.setTimeout(120_000)
  await page.addInitScript(() => {
    localStorage.setItem('open-walnut-focus-dock-visible', 'true')
  })
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
  ;({ taskId } = await quickStart.json() as { taskId: string })
  sessionId = await sessionForTask(page, taskId)

  const panel = page.locator(`.session-panel[data-session-id="${sessionId}"]`)
  await expect(panel.getByText(BASE_REPLY, { exact: true })).toHaveCount(1, {
    timeout: 20_000,
  })
  await expect.poll(
    async () => (await statusFor(page, sessionId)).process_status,
    { timeout: 15_000 },
  ).toBe('idle')
  const baseline = await statusFor(page, sessionId)

  const task = await findHomeTask(page, taskId)
  await expectNoTaskPill(task)
  await expectTaskMenuStatus(page, task, 'Needs your attention')
  const recent = recentTaskCard(page, taskId)
  await expectNoTaskPill(recent)
  const dock = await pinTaskToFocus(page, task)
  const focus = focusTaskCard(page, taskId)
  await expectNoTaskPill(focus)
  const idleModal = await openTaskDetail(page, task)
  await expectNoTaskPill(idleModal)
  await idleModal.getByRole('button', { name: 'Close detail panel' }).click()

  let releaseStale!: () => void
  const staleGate = new Promise<void>((resolve) => { releaseStale = resolve })
  let captureStale!: (snapshot: StatusSnapshot) => void
  const staleCaptured = new Promise<StatusSnapshot>((resolve) => { captureStale = resolve })
  let intercepted = false
  await page.route('**/api/sessions/status?*', async (route) => {
    const ids = new URL(route.request().url()).searchParams.get('ids')?.split(',') ?? []
    if (intercepted || !ids.includes(sessionId)) {
      await route.continue()
      return
    }
    intercepted = true
    const response = await route.fetch()
    const body = await response.json() as { statuses: Record<string, StatusSnapshot> }
    captureStale(body.statuses[sessionId])
    await staleGate
    await route.fulfill({ response })
  })

  await startStatusHydration(page, sessionId)
  const stale = await staleCaptured
  expect(stale).toMatchObject({
    sessionId,
    process_status: 'idle',
    statusRevision: baseline.statusRevision,
  })

  const input = panel.locator('.chat-input-textarea')
  await input.fill(DESKTOP_SLOW_PROMPT)
  await input.press('Enter')
  await expect.poll(
    async () => (await statusFor(page, sessionId)).process_status,
    { timeout: 15_000 },
  ).toBe('running')
  const running = await statusFor(page, sessionId)
  expect(running.statusRevision).toBeGreaterThan(baseline.statusRevision)
  await expect(panel.locator('.session-panel-badge', { hasText: 'Running' })).toHaveCount(1)
  await expect(panel.locator('.chat-tool-block-calling').filter({ hasText: TOOL_NAME }))
    .toBeVisible({ timeout: 10_000 })

  releaseStale()
  await expectHydrationDone(page)
  expect(await storeStatus(page, sessionId)).toEqual({
    sessionId,
    processStatus: 'running',
    revision: running.statusRevision,
  })
  await expect(panel.locator('.session-panel-badge', { hasText: 'Running' })).toHaveCount(1)
  await expect(dock.locator('.dock-task-phase-badge'))
    .toHaveClass(/dock-task-phase-streaming/)
  await expect(panel.locator('.chat-tool-block-calling').filter({ hasText: TOOL_NAME }))
    .toBeVisible()

  const currentTask = await findHomeTask(page, taskId)
  await expectNoTaskPill(currentTask)
  await expectTaskMenuStatus(page, currentTask, 'AI is working...')
  await expectNoTaskPill(recentTaskCard(page, taskId))
  await expectNoTaskPill(focusTaskCard(page, taskId))
  const modal = await openTaskDetail(page, currentTask)
  await expectNoTaskPill(modal)
  const detailSession = modal.locator(`.todo-detail-session-item[title="${sessionId}"]`)
  await expect(detailSession).toBeVisible()
  await expect(detailSession.locator('.todo-detail-session-dot'))
    .toHaveAttribute('style', /var\(--success\)/)
  await page.screenshot({
    path: `${SCREENSHOT_DIR}/desktop-stale-rest-rejected.png`,
    fullPage: true,
  })
  await modal.getByRole('button', { name: 'Close detail panel' }).click()

  await navigateToTasks(page)
  await page.getByLabel('Filter by status').selectOption('')
  const taskCard = page.locator(`.task-card[data-task-id="${taskId}"]`)
  await expect(taskCard).toBeVisible()
  await expect(taskCard.locator('.task-session-pill')).toContainText('Running')

  await page.getByRole('link', { name: 'Home', exact: true }).click()
  await expect(page).toHaveURL(/\/$/)
  const restoredPanel = page.locator(`.session-panel[data-session-id="${sessionId}"]`)
  await expect(restoredPanel.locator('.session-panel-badge', { hasText: 'Running' }))
    .toHaveCount(1)
  await page.reload()
  const reloadedPanel = page.locator(`.session-panel[data-session-id="${sessionId}"]`)
  await expect(reloadedPanel).toBeVisible({ timeout: 15_000 })
  await expect(reloadedPanel.locator('.session-panel-badge', { hasText: 'Running' }))
    .toHaveCount(1)
  expect(await storeStatus(page, sessionId)).toEqual({
    sessionId,
    processStatus: 'running',
    revision: running.statusRevision,
  })
  await expect(reloadedPanel.locator('.chat-tool-block-calling').filter({ hasText: TOOL_NAME }))
    .toBeVisible()
  const reloadedTask = await findHomeTask(page, taskId)
  await expectNoTaskPill(reloadedTask)
  await expectTaskMenuStatus(page, reloadedTask, 'AI is working...')
  await expectNoTaskPill(recentTaskCard(page, taskId))
  await expectNoTaskPill(focusTaskCard(page, taskId))
  const reloadedModal = await openTaskDetail(page, reloadedTask)
  await expectNoTaskPill(reloadedModal)
  await reloadedModal.getByRole('button', { name: 'Close detail panel' }).click()

  await navigateToSessions(page)
  const { row, detail } = await selectSession(page, sessionId)
  await expect(row.locator('.session-status-dot'))
    .toHaveCSS('background-color', 'rgb(245, 158, 11)')
  await expect(detail.locator('.session-detail-badge', { hasText: 'Running' })).toHaveCount(1)
  await expect(detail.locator('.chat-tool-block-calling').filter({ hasText: TOOL_NAME }))
    .toBeVisible()

  await expect.poll(
    async () => (await statusFor(page, sessionId)).process_status,
    { timeout: 30_000 },
  ).toBe('idle')
  const completed = await statusFor(page, sessionId)
  expect(completed.statusRevision).toBeGreaterThan(running.statusRevision)
  await expect(detail.locator('.session-detail-badge', { hasText: 'Idle' })).toHaveCount(1)

  await page.getByRole('link', { name: 'Home', exact: true }).click()
  await expect(page).toHaveURL(/\/$/)
  const idleTask = await findHomeTask(page, taskId)
  await expectNoTaskPill(idleTask)
  await expectTaskMenuStatus(page, idleTask, 'Needs your attention')
  await expectNoTaskPill(recentTaskCard(page, taskId))
  await expectNoTaskPill(focusTaskCard(page, taskId))
  const completedModal = await openTaskDetail(page, idleTask)
  await expectNoTaskPill(completedModal)
  await page.screenshot({
    path: `${SCREENSHOT_DIR}/desktop-home-idle-all-task-surfaces.png`,
    fullPage: true,
  })
  await completedModal.getByRole('button', { name: 'Close detail panel' }).click()
  await page.screenshot({
    path: `${SCREENSHOT_DIR}/desktop-home-idle-task-cards.png`,
    fullPage: true,
  })

  await page.reload()
  const idleReloadedTask = await findHomeTask(page, taskId)
  await expectNoTaskPill(idleReloadedTask)
  await expectTaskMenuStatus(page, idleReloadedTask, 'Needs your attention')
  await expectNoTaskPill(recentTaskCard(page, taskId))
  await expectNoTaskPill(focusTaskCard(page, taskId))
  const idleReloadedModal = await openTaskDetail(page, idleReloadedTask)
  await expectNoTaskPill(idleReloadedModal)
  await idleReloadedModal.getByRole('button', { name: 'Close detail panel' }).click()

  const taskWithoutSession = await findHomeTask(page, 'pw-task-local')
  await expect(taskWithoutSession.locator('.task-session-pill')).toHaveCount(0)
  await expect(recentTaskCard(page, 'pw-task-local').locator('.task-session-pill')).toHaveCount(0)

  await audit.assertClean({
    requestFailure: (failure) =>
      failure.method === 'PUT'
        && failure.errorText === 'net::ERR_ABORTED'
        && new URL(failure.url).pathname === '/api/ui-prefs',
  })
})

test('keeps the same provider identity and running state on mobile surfaces', async ({ page }) => {
  test.setTimeout(90_000)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.addInitScript(() => {
    localStorage.setItem('open-walnut-focus-dock-visible', 'true')
  })
  const audit = await installBrowserAudit(page, walnutHome)
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  const task = await findHomeTask(page, taskId)
  await task.click()
  const panel = page.locator(
    `.main-page-session-column.is-mobile-active .session-panel[data-session-id="${sessionId}"]`,
  )
  await expect(panel).toBeVisible({ timeout: 15_000 })
  const before = await statusFor(page, sessionId)
  const input = panel.locator('.chat-input-textarea')
  await input.fill(MOBILE_SLOW_PROMPT)
  await input.press('Enter')
  await expect.poll(
    async () => (await statusFor(page, sessionId)).process_status,
    { timeout: 15_000 },
  ).toBe('running')
  const running = await statusFor(page, sessionId)
  expect(running.statusRevision).toBeGreaterThan(before.statusRevision)
  await expect(panel.locator('.session-panel-badge', { hasText: 'Running' })).toHaveCount(1)
  await expect(panel.locator('.chat-tool-block-calling').filter({ hasText: TOOL_NAME }))
    .toBeVisible({ timeout: 10_000 })

  await page.reload()
  const reloadedPanel = page.locator(
    `.main-page-session-column.is-mobile-active .session-panel[data-session-id="${sessionId}"]`,
  )
  await expect(reloadedPanel.locator('.session-panel-badge', { hasText: 'Running' }))
    .toHaveCount(1, { timeout: 15_000 })
  expect(await storeStatus(page, sessionId)).toMatchObject({
    sessionId,
    processStatus: 'running',
  })

  await reloadedPanel.getByRole('button', { name: 'Close session panel' }).click()
  const reloadedTask = await findHomeTask(page, taskId)
  const dock = await focusDockCard(page, reloadedTask)
  await expect(dock.locator('.dock-task-phase-badge'))
    .toHaveClass(/dock-task-phase-streaming/)
  const modal = await openTaskDetail(page, reloadedTask)
  const detailSession = modal.locator(`.todo-detail-session-item[title="${sessionId}"]`)
  await expect(detailSession.locator('.todo-detail-session-dot'))
    .toHaveAttribute('style', /var\(--success\)/)
  await modal.getByRole('button', { name: 'Close detail panel' }).click()

  await navigateToTasks(page, true)
  await page.getByLabel('Filter by status').selectOption('')
  const taskCard = page.locator(`.task-card[data-task-id="${taskId}"]`)
  await expect(taskCard).toBeVisible()
  await expect(taskCard.locator('.task-session-pill')).toContainText('Running')

  await navigateToSessions(page, true)
  const { detail } = await selectSession(page, sessionId)
  await expect(detail.locator('.session-detail-badge', { hasText: 'Running' })).toHaveCount(1)
  await expect(detail.locator('.chat-tool-block-calling').filter({ hasText: TOOL_NAME }))
    .toBeVisible()
  await page.screenshot({
    path: `${SCREENSHOT_DIR}/mobile-running-parity.png`,
    fullPage: true,
  })

  await expect.poll(
    async () => (await statusFor(page, sessionId)).process_status,
    { timeout: 30_000 },
  ).toBe('idle')
  const completed = await statusFor(page, sessionId)
  expect(completed.statusRevision).toBeGreaterThan(running.statusRevision)
  await expect(detail.locator('.session-detail-badge', { hasText: 'Idle' })).toHaveCount(1)
  await audit.assertClean()
})
