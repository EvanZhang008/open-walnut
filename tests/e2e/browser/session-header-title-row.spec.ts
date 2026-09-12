/**
 * Session panel header layout (2026-07-27).
 *
 * The header is two rows and the split is load-bearing:
 *   row 1 (.session-meta-row-2)       = tool chips + time + EVERY icon button
 *                                       (locate / lock / popout / expand / close)
 *   row 2 (.session-panel-header-top)  = the TITLE on its own full-width line,
 *                                       with only the status badge and ⋮ kebab
 *
 * Regression guarded: the title used to share one row with five icon buttons and
 * the status pill, so a long title collapsed to ~105px ("Fork of ek…") in a
 * normal 3-column layout, and hovering it showed only "Click to rename task"
 * instead of the full text.
 */
import { expect, test, type Page } from '@playwright/test'
import { openAskWalnutDrawer } from './draft-helpers'
import { isolateUiPrefs, presetPanelView } from './todo-panel-helpers'

const SESSION_ID = 'pw-vscode-session'
const TASK_ID = 'pw-task-vscode'
const LONG_TITLE = 'Fork of eks investigation ticket skill deep dive with a deliberately long title'

async function openHomepageSession(page: Page) {
  await page.locator('.todo-search-input').fill(SESSION_ID)
  const task = page.locator(`.todo-panel-item[data-task-id="${TASK_ID}"]`)
  await expect(task).toBeVisible()
  // Click the row's title: the task menu has no open-session row.
  await task.locator('.todo-item-title').click()
  const panel = page.locator(`.session-panel[data-session-id="${SESSION_ID}"]`)
  await expect(panel).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Locate task', exact: true })).toBeVisible()
  return panel
}

async function openHome(page: Page) {
  await isolateUiPrefs(page)
  await presetPanelView(page)
  await page.setContent(`<a href="${test.info().project.use.baseURL}/">Open Walnut</a>`)
  await page.getByRole('link', { name: 'Open Walnut' }).click()
  await expect(page.locator('.main-page')).toBeVisible()
}

const CLOCK = new Date('2026-01-15T18:00:00Z')
const SIX_HOURS_EARLIER = '2026-01-15T12:00:00Z'

async function setSessionTime(page: Page, timestamp?: string, sessionId = SESSION_ID) {
  await page.clock.setFixedTime(CLOCK)
  await page.route(`**/api/sessions/${sessionId}`, async (route) => {
    const response = await route.fetch()
    if (!response.ok()) {
      await route.fulfill({ response })
      return
    }
    const body = await response.json()
    body.session.lastActiveAt = timestamp
    await route.fulfill({ response, json: body })
  })
}

for (const width of [1280, 820]) {
  test(`activity time only appears in the expanded panel at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 800 })
    await setSessionTime(page, SIX_HOURS_EARLIER)
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await openHome(page)
    const panel = await openHomepageSession(page)
    const time = panel.locator('.session-panel-time')
    const draft = panel.getByPlaceholder('Send a message to this session...')
    await draft.fill('Keep this draft while checking the activity time')
    await expect(time).toHaveCount(0)
    await panel.locator('.session-panel-header').screenshot({
      animations: 'disabled', scale: 'css',
      path: `/tmp/session-time-compact/${testInfo.project.name}-${width}-collapsed.png`,
    })

    for (const close of ['Collapse session', 'Exit full screen', 'Escape']) {
      await panel.getByRole('button', { name: 'Expand session to full screen', exact: true }).click()
      await expect(time).toHaveText('6h')
      await expect(time).toHaveAttribute('datetime', SIX_HOURS_EARLIER)
      const exactTime = await page.evaluate((timestamp) => new Date(timestamp).toLocaleString(), SIX_HOURS_EARLIER)
      await expect(time).toHaveAttribute('title', `Last active: ${exactTime}`)
      const box = (await time.boundingBox())!
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width).toBeLessThanOrEqual(width)
      if (close === 'Collapse session') {
        await panel.locator('.session-panel-header').screenshot({
          animations: 'disabled', scale: 'css',
          path: `/tmp/session-time-compact/${testInfo.project.name}-${width}-expanded.png`,
        })
      }
      if (close === 'Escape') await page.keyboard.press('Escape')
      else await panel.getByRole('button', { name: close, exact: true }).click()
      await expect(time).toHaveCount(0)
      await expect(panel).not.toHaveClass(/open-walnut-fullscreen/)
      await expect(draft).toHaveValue('Keep this draft while checking the activity time')
    }
    expect(errors).toEqual([])
  })
}

for (const sample of [
  { name: 'missing', timestamp: undefined, label: '' },
  { name: 'invalid', timestamp: 'not-a-date', label: '' },
  { name: 'recent', timestamp: '2026-01-15T17:59:45Z', label: 'just now' },
  { name: 'minutes', timestamp: '2026-01-15T17:45:00Z', label: '15m' },
  { name: 'days', timestamp: '2026-01-13T18:00:00Z', label: '2d' },
  { name: 'future', timestamp: '2026-01-15T19:00:00Z', label: 'just now' },
]) {
  test(`expanded activity time handles ${sample.name} timestamps`, async ({ page }) => {
    await setSessionTime(page, sample.timestamp)
    await openHome(page)
    const panel = await openHomepageSession(page)
    await expect(panel.locator('.session-panel-time')).toHaveCount(0)
    await panel.getByRole('button', { name: 'Expand session to full screen', exact: true }).click()
    await expect(panel).toHaveClass(/open-walnut-fullscreen/)
    const time = panel.locator('.session-panel-time')
    if (sample.label) {
      await expect(time).toHaveText(sample.label)
      await expect(time).toHaveAttribute('datetime', sample.timestamp!)
    } else await expect(time).toHaveCount(0)
  })
}

test('the embedded Ask Walnut panel keeps compact activity time across task updates', async ({ page, request }) => {
  const started = await request.post('/api/sessions/quick-start', {
    data: { walnutAgent: true, message: 'Check the expanded activity time' },
  })
  expect(started.ok(), await started.text()).toBe(true)
  const { taskId, sessionId } = await started.json() as { taskId: string; sessionId: string }
  expect(taskId).toBeTruthy()
  expect(sessionId).toBeTruthy()
  await setSessionTime(page, SIX_HOURS_EARLIER, sessionId)
  await openHome(page)
  const drawer = await openAskWalnutDrawer(page)
  await drawer.locator(`[data-testid="ask-walnut-drawer-item"][data-task-id="${taskId}"]`).click()
  const panel = page.getByTestId('ask-walnut-session').locator(`.session-panel[data-session-id="${sessionId}"]`)
  await expect(panel.getByRole('button', { name: 'Locate task', exact: true })).toBeVisible()
  await expect(panel.locator('.session-panel-time')).toHaveCount(0)
  await panel.getByRole('button', { name: 'Expand session to full screen', exact: true }).click()
  await expect(panel.locator('.session-panel-time')).toHaveText('6h')
  const renamed = await request.patch(`/api/tasks/${taskId}`, { data: { title: 'Updated activity check' } })
  expect(renamed.ok()).toBe(true)
  await expect(panel.locator('.session-panel-title')).toHaveText('Updated activity check')
  await expect(panel.locator('.session-panel-time')).toHaveText('6h')
  await panel.getByRole('button', { name: 'Collapse session', exact: true }).click()
  await expect(panel).not.toHaveClass(/open-walnut-fullscreen/)
  await expect(panel.locator('.session-panel-time')).toHaveCount(0)
})

test('the session title owns the second header row and reveals its full text on hover', async ({ page, request }) => {
  // Long title so truncation pressure is real — the fixture title is short.
  const renamed = await request.patch(`/api/tasks/${TASK_ID}`, { data: { title: LONG_TITLE } })
  expect(renamed.ok()).toBe(true)

  await openHome(page)
  const panel = await openHomepageSession(page)

  const toolsRow = panel.locator('.session-meta-row-2')
  const titleRow = panel.locator('.session-panel-header-top')
  const title = panel.locator('.session-panel-title')
  await expect(title).toHaveText(LONG_TITLE)

  // 1. Every icon button is on row 1; the title row sits BELOW it.
  const toolsBox = (await toolsRow.boundingBox())!
  const titleBox = (await titleRow.boundingBox())!
  expect(titleBox.y).toBeGreaterThan(toolsBox.y)
  const controls = toolsRow.locator('.session-panel-window-controls')
  for (const cls of ['locate', 'lock', 'popout', 'expand', 'close']) {
    await expect(controls.locator(`.session-panel-${cls}`)).toHaveCount(1)
  }
  await expect(toolsRow.getByRole('button', { name: 'Changed' })).toHaveCount(1)

  // 2. ONLY the status badge and the kebab share the title row.
  await expect(titleRow.locator('.session-panel-title-meta .task-kebab-btn')).toHaveCount(1)
  for (const cls of ['locate', 'lock', 'popout', 'expand', 'close', 'vscode']) {
    await expect(titleRow.locator(`.session-panel-${cls}`)).toHaveCount(0)
  }

  // 3. The title actually gets the line: >60% of the header width. Before the fix
  //    it was ~30% of a 3-column panel.
  const headerBox = (await panel.locator('.session-panel-header').boundingBox())!
  const titleTextBox = (await title.boundingBox())!
  expect(titleTextBox.width / headerBox.width).toBeGreaterThan(0.6)

  // 3b. Title font stays at the compact 13px (bigger fits fewer characters).
  const fontSize = await title.evaluate((el) => getComputedStyle(el).fontSize)
  expect(fontSize).toBe('13px')

  // 4. Hover reveals the FULL title (tooltip leads with it, rename hint follows).
  const tooltip = await title.getAttribute('title')
  expect(tooltip).toContain(LONG_TITLE)
  expect(tooltip!.startsWith(LONG_TITLE)).toBe(true)
  expect(tooltip).toContain('rename')
})
