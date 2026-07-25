import fs from 'node:fs/promises'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { discoverBrowserFixture, installBrowserAudit } from './codex-test-audit'

const SCREENSHOT_DIR = '/tmp/codex-customer-matrix-gap-final'
const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const SESSION_ID = 'pw-codex-order-session'
const TASK_ID = 'pw-task-codex-order'
const PROMPT = 'ordered-tool homepage transcript order'
const BEFORE_TOOL = 'before tool'
const TOOL_NAME = 'Ordered tool'
const TOOL_RESULT = 'ordered result'
const AFTER_TOOL = 'after tool'

let walnutHome = ''

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  ;({ walnutHome } = await discoverBrowserFixture(TEST_PORT))
  await fs.mkdir(SCREENSHOT_DIR, { recursive: true })
})

async function expectOrderedTranscript(surface: Locator): Promise<void> {
  const before = surface.getByText(BEFORE_TOOL, { exact: true })
  const after = surface.getByText(AFTER_TOOL, { exact: true })

  // Persisted generic tools render collapsed into a muted run row
  // ("Used a tool ›") — expand it to reach the tool card.
  const runRow = surface.locator('.tool-run-row')
  await expect(runRow).toHaveCount(1)
  await runRow.locator('.tool-run-toggle').click()
  const tool = surface.locator('.chat-tool-block').filter({ hasText: TOOL_NAME })

  await expect(before).toHaveCount(1)
  await expect(tool).toHaveCount(1)
  await expect(tool).toHaveClass(/chat-tool-block-done/)
  await expect(after).toHaveCount(1)
  const beforeBox = await before.boundingBox()
  const toolBox = await tool.boundingBox()
  const afterBox = await after.boundingBox()
  expect(beforeBox).not.toBeNull()
  expect(toolBox).not.toBeNull()
  expect(afterBox).not.toBeNull()
  expect(beforeBox!.y).toBeLessThan(toolBox!.y)
  expect(toolBox!.y).toBeLessThan(afterBox!.y)

  await tool.locator('.chat-tool-block-header').click()
  await expect(tool.getByText(TOOL_RESULT, { exact: true })).toBeVisible()
}

async function expectSurfaceGeometry(
  page: Page,
  surface: Locator,
  input: Locator,
): Promise<void> {
  const viewport = page.viewportSize()
  const surfaceBox = await surface.boundingBox()
  const inputBox = await input.boundingBox()
  expect(viewport).toEqual({ width: 1024, height: 768 })
  expect(surfaceBox).not.toBeNull()
  expect(inputBox).not.toBeNull()
  expect(surfaceBox!.width).toBeGreaterThan(280)
  expect(surfaceBox!.height).toBeGreaterThan(500)
  expect(surfaceBox!.x).toBeGreaterThanOrEqual(0)
  expect(surfaceBox!.x + surfaceBox!.width).toBeLessThanOrEqual(viewport!.width + 1)
  expect(surfaceBox!.y + surfaceBox!.height).toBeLessThanOrEqual(viewport!.height + 1)
  expect(inputBox!.x).toBeGreaterThanOrEqual(surfaceBox!.x)
  expect(inputBox!.x + inputBox!.width).toBeLessThanOrEqual(surfaceBox!.x + surfaceBox!.width)
  expect(inputBox!.y).toBeGreaterThan(surfaceBox!.y)
  expect(inputBox!.y + inputBox!.height).toBeLessThanOrEqual(surfaceBox!.y + surfaceBox!.height)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
}

test('keeps mixed tool/text order on the Homepage at 1024x768', async ({ page }) => {
  test.setTimeout(45_000)
  await page.setViewportSize({ width: 1024, height: 768 })
  const audit = await installBrowserAudit(page, walnutHome)

  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.locator('.todo-search-input').fill(SESSION_ID)
  const task = page.locator(`.todo-panel-item[data-task-id="${TASK_ID}"]`)
  await expect(task).toBeVisible()
  await task.locator('.todo-item-title').click()

  const homePanel = page.locator('.main-page-session-column .session-panel')
  const homeInput = homePanel.locator('.chat-input-textarea')
  await expect(homePanel).toBeVisible()
  await expect(homeInput).toBeVisible()
  await homeInput.click()
  await expect(homeInput).toBeFocused()
  await page.keyboard.type(PROMPT)
  await page.keyboard.press('Enter')

  await expect(homePanel.getByText(PROMPT, { exact: true })).toHaveCount(1)
  await expect(homePanel.getByText(AFTER_TOOL, { exact: true }))
    .toHaveCount(1, { timeout: 20_000 })
  await expectOrderedTranscript(homePanel)
  await expectSurfaceGeometry(page, homePanel, homeInput)
  await page.screenshot({
    path: `${SCREENSHOT_DIR}/order-parity-home-1024x768.png`,
  })

  await audit.assertClean()
})
