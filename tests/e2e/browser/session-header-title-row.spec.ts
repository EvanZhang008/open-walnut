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

const SESSION_ID = 'pw-vscode-session'
const TASK_ID = 'pw-task-vscode'
const LONG_TITLE = 'Fork of eks investigation ticket skill deep dive with a deliberately long title'

async function openHomepageSession(page: Page) {
  await page.locator('.todo-search-input').fill(SESSION_ID)
  const task = page.locator(`.todo-panel-item[data-task-id="${TASK_ID}"]`)
  await expect(task).toBeVisible()
  await task.getByRole('button', { name: 'More actions' }).click()
  await page.locator('.task-kebab-menu:visible').getByText('Session idle', { exact: true }).click()
  const panel = page.locator(`.session-panel[data-session-id="${SESSION_ID}"]`)
  await expect(panel).toBeVisible()
  return panel
}

test('the session title owns the second header row and reveals its full text on hover', async ({ page, request }) => {
  // Long title so truncation pressure is real — the fixture title is short.
  const renamed = await request.patch(`/api/tasks/${TASK_ID}`, { data: { title: LONG_TITLE } })
  expect(renamed.ok()).toBe(true)

  await page.goto('/')
  await page.waitForLoadState('networkidle')
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
