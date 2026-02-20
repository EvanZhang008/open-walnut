/**
 * Playwright browser test: Model Switch UI (/model command).
 *
 * Tests the ModelPicker UI flow:
 *  1. /model command appears in session command palette with Control badge
 *  2. Selecting /model opens the ModelPicker drawer
 *  3. Model cards render correctly (3 options, active state)
 *  4. Selecting a model closes the picker
 *
 * Requires seed data in test-server.ts:
 *  - Task: pw-task-model-switch (in_progress, with running session)
 *  - Session: pw-model-switch-session (running, bypass mode)
 */
import { test, expect } from '@playwright/test'

/**
 * Opens the SessionPanel for the model-switch test task.
 *
 * Flow: home page → "All" tab → click task to focus → click session item
 * in TaskDetailPane → SessionPanel appears in the middle panel.
 */
async function openSessionPanel(page: import('@playwright/test').Page) {
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  // Click "All" category tab to show all tasks (default may be starred)
  const allTab = page.locator('.todo-panel-tab', { hasText: 'All' })
  await expect(allTab).toBeVisible({ timeout: 5000 })
  await allTab.click()
  await page.waitForTimeout(300)

  // Focus the task to open TaskDetailPane.
  // Use keyboard Enter — clicking the title triggers inline editing,
  // and clicking the status/priority buttons have their own handlers.
  const taskItem = page.locator('.todo-panel-item', { hasText: 'Model switch test task' })
  await expect(taskItem).toBeVisible({ timeout: 5000 })
  await taskItem.focus()
  await taskItem.press('Enter')
  await page.waitForTimeout(500)

  // In the TaskDetailPane, click the session item to open the SessionPanel
  const sessionItem = page.locator('.todo-detail-session-item', { hasText: 'model switch test session' })
  await expect(sessionItem).toBeVisible({ timeout: 5000 })
  await sessionItem.click()
  await page.waitForTimeout(500)

  // Verify the SessionPanel is open with its chat input
  const sessionPanelInput = page.locator('.session-panel .chat-input-textarea')
  await expect(sessionPanelInput).toBeVisible({ timeout: 5000 })

  return sessionPanelInput
}

/**
 * Types /m in the session chat input and selects the /model command from the palette.
 * Returns after the ModelPicker is visible.
 */
async function openModelPicker(page: import('@playwright/test').Page, input: import('@playwright/test').Locator) {
  // Type /m to trigger the command palette
  await input.focus()
  await input.fill('/m')
  await page.waitForTimeout(300)

  // Wait for command palette to appear (scoped to session panel)
  const palette = page.locator('.session-panel .command-palette')
  await expect(palette).toBeVisible({ timeout: 3000 })

  // Find the /model palette item and click it
  const modelItem = palette.locator('.command-palette-item', { hasText: 'model' })
  await expect(modelItem).toBeVisible({ timeout: 3000 })
  // Use mousedown (CommandPalette uses onMouseDown, not onClick)
  await modelItem.dispatchEvent('mousedown')
  await page.waitForTimeout(300)

  // Verify ModelPicker is visible
  const modelPicker = page.locator('.session-panel .model-picker')
  await expect(modelPicker).toBeVisible({ timeout: 3000 })

  return modelPicker
}

// ── Tests ──

test.describe('Model Switch UI', () => {
  test('opens ModelPicker via /model command', async ({ page }) => {
    const input = await openSessionPanel(page)

    // Type /m to trigger the command palette
    await input.focus()
    await input.fill('/m')
    await page.waitForTimeout(300)

    // Command palette should appear (scoped to session panel)
    const palette = page.locator('.session-panel .command-palette')
    await expect(palette).toBeVisible({ timeout: 3000 })

    // Verify /model entry exists with correct description
    const modelItem = palette.locator('.command-palette-item', { hasText: 'model' })
    await expect(modelItem).toBeVisible({ timeout: 3000 })
    await expect(modelItem).toContainText('Switch model')
    await expect(modelItem).toContainText('opus / sonnet / haiku')

    // Verify Control badge on /model entry
    const controlBadge = modelItem.locator('.command-palette-source-control')
    await expect(controlBadge).toBeVisible()
    await expect(controlBadge).toHaveText('Control')

    // Click /model to open the picker
    await modelItem.dispatchEvent('mousedown')
    await page.waitForTimeout(300)

    // ModelPicker should be visible
    const modelPicker = page.locator('.session-panel .model-picker')
    await expect(modelPicker).toBeVisible({ timeout: 3000 })

    // Input should be cleared (control command resets input)
    await expect(input).toHaveValue('')
  })

  test('renders model cards correctly', async ({ page }) => {
    const input = await openSessionPanel(page)
    const picker = await openModelPicker(page, input)

    // Should have exactly 3 model options
    const options = picker.locator('.model-picker-option')
    await expect(options).toHaveCount(3)

    // Check option labels
    const names = picker.locator('.model-picker-option-name')
    await expect(names.nth(0)).toHaveText('Opus')
    await expect(names.nth(1)).toHaveText('Sonnet')
    await expect(names.nth(2)).toHaveText('Haiku')

    // Check option descriptions
    const descs = picker.locator('.model-picker-option-desc')
    await expect(descs.nth(0)).toHaveText('Most capable')
    await expect(descs.nth(1)).toHaveText('Balanced')
    await expect(descs.nth(2)).toHaveText('Fastest')

    // Opus should be the active model (default)
    const activeOption = picker.locator('.model-picker-option-active')
    await expect(activeOption).toHaveCount(1)
    await expect(activeOption.locator('.model-picker-option-name')).toHaveText('Opus')
    await expect(activeOption.locator('.model-picker-option-badge')).toHaveText('Active')

    // Non-active options should have "Next turn" and "Now" buttons
    const sonnetOption = picker.locator('.model-picker-option', { hasText: 'Sonnet' })
    await expect(sonnetOption.locator('.model-picker-btn')).toBeVisible()
    await expect(sonnetOption.locator('.model-picker-btn')).toHaveText('Next turn')
    await expect(sonnetOption.locator('.model-picker-btn-immediate')).toBeVisible()
    await expect(sonnetOption.locator('.model-picker-btn-immediate')).toHaveText('Now')

    const haikuOption = picker.locator('.model-picker-option', { hasText: 'Haiku' })
    await expect(haikuOption.locator('.model-picker-btn')).toBeVisible()
    await expect(haikuOption.locator('.model-picker-btn-immediate')).toBeVisible()
  })

  test('selecting model closes picker', async ({ page }) => {
    const input = await openSessionPanel(page)
    const picker = await openModelPicker(page, input)

    // Click "Next turn" on the Sonnet option
    const sonnetOption = picker.locator('.model-picker-option', { hasText: 'Sonnet' })
    await sonnetOption.locator('.model-picker-btn').click()

    // ModelPicker should close
    await expect(picker).toBeHidden({ timeout: 3000 })
  })

  test('shows Control badge styling on /model', async ({ page }) => {
    const input = await openSessionPanel(page)

    // Type /m to show the palette
    await input.focus()
    await input.fill('/m')
    await page.waitForTimeout(300)

    const palette = page.locator('.session-panel .command-palette')
    await expect(palette).toBeVisible({ timeout: 3000 })

    // Find the /model item
    const modelItem = palette.locator('.command-palette-item', { hasText: 'model' })
    await expect(modelItem).toBeVisible()

    // Verify the Control badge element exists with correct class
    const badge = modelItem.locator('.command-palette-source-control')
    await expect(badge).toBeVisible()
    await expect(badge).toHaveText('Control')

    // Verify the badge has the source-specific class (command-palette-source-control)
    // which applies amber styling
    await expect(badge).toHaveClass(/command-palette-source-control/)
  })
})
