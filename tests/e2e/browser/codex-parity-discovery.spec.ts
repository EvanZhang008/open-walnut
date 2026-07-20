import fs from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import { discoverBrowserFixture, installBrowserAudit } from './codex-test-audit'

const SCREENSHOT_DIR = '/tmp/codex-customer-matrix-ui-final'
const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const SESSION_ID = 'pw-codex-customer-session'
const TASK_ID = 'pw-task-codex-customer'
const TASK_TITLE = 'Playwright Codex customer task'
const RECENT_TASK_TITLE = 'Playwright test task'
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

async function navigateToSessions(page: Page): Promise<void> {
  const other = page.getByRole('button', { name: /Other/i })
  if (await other.getAttribute('aria-expanded') !== 'true') await other.click()
  await page.locator('a[href="/sessions"]').click()
  await expect(page.locator('.session-tree-panel')).toBeVisible()
}

async function expectTranscript(panel: ReturnType<Page['locator']>): Promise<void> {
  await expect(panel.getByText(USER_TEXT, { exact: true })).toHaveCount(1)
  await expect(panel.getByText(ASSISTANT_TEXT, { exact: true })).toHaveCount(1)
  await expect(panel.locator('.session-msg-role').filter({ hasText: /^Codex$/ }).first()).toBeVisible()
  await expect(panel.locator('.session-msg-role').filter({ hasText: /^Walnut$/ })).toHaveCount(0)
}

test('bounded discovery, exact search, and Homepage/dedicated parity', async ({ page }) => {
  await fs.mkdir(SCREENSHOT_DIR, { recursive: true })
  const audit = await installBrowserAudit(page, walnutHome)

  await page.goto('/')
  await page.waitForLoadState('networkidle')

  await openHomepageSession(page)
  const homePanel = page.locator('.main-page-session-column .session-panel')
  await expect(homePanel.locator('.session-panel-title')).toHaveText(TASK_TITLE)
  await expect(homePanel.getByText('Stopped', { exact: true })).toHaveCount(1)
  await expect(homePanel.getByText('2 turns', { exact: true })).toHaveCount(1)
  await expect(homePanel.locator('.session-detail-model-pill', { hasText: 'Codex' })).toBeVisible()
  await expectTranscript(homePanel)
  const homeFork = homePanel.getByRole('button', { name: /Fork is unavailable/ })
  await expect(homeFork).toBeDisabled()
  await expect(homeFork).toHaveAttribute(
    'title',
    'Fork is unavailable because this Codex adapter does not support session forking',
  )
  await homeFork.evaluate((button: HTMLButtonElement) => button.click())
  await page.screenshot({ path: `${SCREENSHOT_DIR}/desktop-homepage-codex-parity.png`, fullPage: true })

  await homePanel.locator('.session-panel-close').click()
  await navigateToSessions(page)

  const tree = page.getByRole('tree', { name: 'Sessions' })
  await expect(tree).toBeVisible()
  // The customer session is deliberately older than the 500-row discovery
  // cap. Exercise keyboard semantics on a recent task before proving the old
  // target is absent and recoverable only through exact ID search.
  const taskHeader = page.getByRole('treeitem', { name: new RegExp(RECENT_TASK_TITLE) })
  await expect(taskHeader).toBeVisible()
  await expect(taskHeader).toHaveAttribute('aria-expanded', 'false')
  await taskHeader.focus()
  await taskHeader.press('Space')
  await expect(taskHeader).toHaveAttribute('aria-expanded', 'true')
  await taskHeader.press('ArrowDown')
  await expect(page.locator('[role="treeitem"]:focus')).toHaveCount(1)
  const otherTaskHeaders = page.locator('.session-tree-task-header[aria-expanded="false"]')
  while (await otherTaskHeaders.count()) await otherTaskHeaders.first().click()
  await expect(page.locator('.session-tree-session')).toHaveCount(100)
  const total = Number(await page.locator('.session-tree-header > .session-tree-count').textContent())
  expect(total).toBeGreaterThan(500)

  // Client-side filters reduce visible rows, but the server-page remainder must
  // still be based on the raw loaded prefix.
  const initialLoadMoreName = 'Load more (400 remaining)'
  await expect(page.getByRole('button', { name: initialLoadMoreName })).toBeVisible()
  await page.getByRole('button', { name: 'Error', exact: true }).click()
  expect(await page.locator('.session-tree-session').count()).toBeLessThan(100)
  await expect(page.getByRole('button', { name: initialLoadMoreName })).toBeVisible()
  await page.getByRole('button', { name: 'All', exact: true }).click()

  let requestedLimit = 200
  let finalPage: { limit: number; total: number; remaining: number; hasMore: boolean } | null = null
  while (await page.locator('.session-tree-load-more button').count()) {
    const responsePromise = page.waitForResponse((response) => {
      const url = new URL(response.url())
      return url.pathname === '/api/sessions/tree'
        && url.searchParams.get('limit') === String(requestedLimit)
    })
    await page.locator('.session-tree-load-more button').click()
    const response = await responsePromise
    expect(response.status()).toBe(200)
    finalPage = await response.json() as {
      limit: number
      total: number
      remaining: number
      hasMore: boolean
    }
    expect(finalPage.remaining).toBe(Math.max(0, 500 - finalPage.limit))
    requestedLimit += 100
  }
  expect(finalPage).toEqual(expect.objectContaining({
    limit: 500,
    total,
    remaining: 0,
    hasMore: false,
  }))
  expect(requestedLimit).toBe(600)
  while (await otherTaskHeaders.count()) await otherTaskHeaders.first().click()
  await expect(page.locator('.session-tree-session')).toHaveCount(500)
  await expect(page.locator('.session-tree-load-more button')).toHaveCount(0)
  await expect(page.locator(`.session-tree-session[data-session-id="${SESSION_ID}"]`)).toHaveCount(0)

  const search = page.getByRole('searchbox', { name: 'Search sessions' })
  await search.fill(SESSION_ID)
  const targetRow = page.locator(`.session-tree-session[data-session-id="${SESSION_ID}"]`)
  await expect(targetRow).toBeVisible()
  await expect(page.locator('.session-tree-session')).toHaveCount(1)
  await expect(targetRow.locator('.session-tree-codex-badge')).toHaveText('Codex')

  const detail = page.locator('.sessions-detail-pane')
  await expect(detail.locator('.session-detail-title')).toHaveText(TASK_TITLE)
  await expect(detail.getByText('Stopped', { exact: true })).toHaveCount(1)
  await expect(detail.getByText('2 turns', { exact: true })).toHaveCount(1)
  await expectTranscript(detail)
  const detailFork = detail.getByRole('button', { name: /Fork is unavailable/ })
  await expect(detailFork).toBeDisabled()
  await detailFork.evaluate((button: HTMLButtonElement) => button.click())

  const tasksBefore = await (await page.request.get('/api/tasks')).json() as { tasks: Array<{ id: string }> }
  const sessionsBefore = await (await page.request.get('/api/sessions')).json() as {
    sessions: Array<{ claudeSessionId: string }>
  }
  const forkResponse = await page.request.post(`/api/sessions/${SESSION_ID}/fork`, {
    data: { create_child_task: true, message: 'unsupported browser fork probe' },
  })
  expect(forkResponse.status()).toBe(409)
  expect(await forkResponse.json()).toEqual(expect.objectContaining({ code: 'ACP_FORK_UNSUPPORTED' }))
  const tasksAfter = await (await page.request.get('/api/tasks')).json() as { tasks: Array<{ id: string }> }
  const sessionsAfter = await (await page.request.get('/api/sessions')).json() as {
    sessions: Array<{ claudeSessionId: string }>
  }
  expect(tasksAfter.tasks.map((task) => task.id).sort()).toEqual(tasksBefore.tasks.map((task) => task.id).sort())
  expect(sessionsAfter.sessions.map((session) => session.claudeSessionId).sort())
    .toEqual(sessionsBefore.sessions.map((session) => session.claudeSessionId).sort())

  await page.evaluate((taskTitle) => {
    const state = window as unknown as {
      __codexTitleLosses: string[]
      __codexTitleObserver?: MutationObserver
    }
    state.__codexTitleLosses = []
    const detailPane = document.querySelector('.sessions-detail-pane')
    state.__codexTitleObserver = new MutationObserver(() => {
      const title = document.querySelector('.sessions-detail-title')?.textContent?.trim()
      if (title !== taskTitle) state.__codexTitleLosses.push(title ?? '<missing>')
    })
    if (detailPane) state.__codexTitleObserver.observe(detailPane, { childList: true, subtree: true })
  }, TASK_TITLE)
  const clearResponse = page.waitForResponse((response) => {
    const url = new URL(response.url())
    return url.pathname === '/api/sessions/tree'
      && !url.searchParams.has('q')
      && url.searchParams.get('limit') === '100'
  })
  await page.getByRole('button', { name: 'Clear session search' }).click()
  expect((await clearResponse).status()).toBe(200)
  await expect(search).toHaveValue('')
  await expect(detail.locator('.session-detail-title')).toHaveText(TASK_TITLE)
  await expectTranscript(detail)
  await page.waitForTimeout(250)
  const titleLosses = await page.evaluate(() => {
    const state = window as unknown as {
      __codexTitleLosses: string[]
      __codexTitleObserver?: MutationObserver
    }
    state.__codexTitleObserver?.disconnect()
    return state.__codexTitleLosses
  })
  expect(titleLosses).toEqual([])
  await page.screenshot({ path: `${SCREENSHOT_DIR}/desktop-sessions-codex-parity.png`, fullPage: true })

  await audit.assertClean({
    http: (response) =>
      response.status === 409 && new URL(response.url).pathname.endsWith(`/${SESSION_ID}/fork`),
  })
})
