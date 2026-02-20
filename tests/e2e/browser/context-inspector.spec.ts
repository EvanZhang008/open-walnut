/**
 * Playwright browser tests for the Context Inspector panel.
 *
 * Tests the full user-facing workflow:
 * - Context button is visible in the chat header
 * - Clicking it opens the inspector panel with all sections
 * - Each section is collapsible/expandable
 * - Token counts are displayed
 * - Tools are listed with expandable schemas
 * - Panel closes when clicking the button again
 * - Chat remains usable while inspector is open
 */
import { test, expect } from '@playwright/test'

// ── Context button exists ──

test('Context button is visible in the chat header', async ({ page }) => {
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  const contextBtn = page.locator('button', { hasText: 'Context' })
  await expect(contextBtn).toBeVisible()
})

// ── Open and close ──

test('clicking Context button opens the inspector panel', async ({ page }) => {
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  // Panel should not be visible initially
  await expect(page.locator('.context-inspector')).toBeHidden()

  // Click Context button
  await page.locator('button', { hasText: 'Context' }).click()

  // Panel should appear
  const inspector = page.locator('.context-inspector')
  await expect(inspector).toBeVisible({ timeout: 5000 })

  // Should show the title
  await expect(inspector.locator('.context-inspector-title')).toContainText('Agent Context Inspector')
})

test('clicking Context button again closes the panel', async ({ page }) => {
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  const contextBtn = page.locator('button', { hasText: 'Context' })

  // Open
  await contextBtn.click()
  await expect(page.locator('.context-inspector')).toBeVisible({ timeout: 5000 })

  // Close
  await contextBtn.click()
  await expect(page.locator('.context-inspector')).toBeHidden()
})

// ── Sections ──

test('inspector shows all 9 sections', async ({ page }) => {
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  await page.locator('button', { hasText: 'Context' }).click()
  await expect(page.locator('.context-inspector')).toBeVisible({ timeout: 5000 })

  const sections = page.locator('.context-section')
  await expect(sections).toHaveCount(9)
})

test('sections show token badges', async ({ page }) => {
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  await page.locator('button', { hasText: 'Context' }).click()
  await expect(page.locator('.context-inspector')).toBeVisible({ timeout: 5000 })

  // Every section header should have a token badge
  const badges = page.locator('.context-token-badge')
  const count = await badges.count()
  // 9 section badges + 1 total badge in the header = at least 10
  expect(count).toBeGreaterThanOrEqual(10)

  // Total token badge should be visible
  const totalBadge = page.locator('.context-token-badge-total')
  await expect(totalBadge).toBeVisible()
  const totalText = await totalBadge.textContent()
  expect(totalText).toMatch(/Total: ~[\d,]+ tokens/)
})

// ── Collapsible sections ──

test('section expands and collapses on click', async ({ page }) => {
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  await page.locator('button', { hasText: 'Context' }).click()
  await expect(page.locator('.context-inspector')).toBeVisible({ timeout: 5000 })

  // Find "Role & Rules" section header
  const roleHeader = page.locator('.context-section-header', { hasText: 'Role & Rules' })
  await expect(roleHeader).toBeVisible()

  // Initially collapsed — content should not be visible
  const roleContent = roleHeader.locator('..').locator('.context-section-content')
  await expect(roleContent).toBeHidden()

  // Click to expand
  await roleHeader.click()
  await expect(roleContent).toBeVisible()

  // Should contain the Walnut identity text
  await expect(roleContent).toContainText('Walnut')

  // Click again to collapse
  await roleHeader.click()
  await expect(roleContent).toBeHidden()
})

// ── Tools section ──

test('tools section shows tool cards with names', async ({ page }) => {
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  await page.locator('button', { hasText: 'Context' }).click()
  await expect(page.locator('.context-inspector')).toBeVisible({ timeout: 5000 })

  // Expand the Tools section
  const toolsHeader = page.locator('.context-section-header', { hasText: 'Tools' })
  await toolsHeader.click()

  // Should show tool cards
  const toolCards = page.locator('.context-tool-card')
  const count = await toolCards.count()
  expect(count).toBeGreaterThan(0)

  // Known tools should be present
  await expect(page.locator('.context-tool-name', { hasText: 'query_tasks' })).toBeVisible()
  await expect(page.locator('.context-tool-name', { hasText: 'search' })).toBeVisible()
  await expect(page.locator('.context-tool-name', { hasText: 'memory' })).toBeVisible()
})

test('tool card expands to show JSON schema', async ({ page }) => {
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  await page.locator('button', { hasText: 'Context' }).click()
  await expect(page.locator('.context-inspector')).toBeVisible({ timeout: 5000 })

  // Expand Tools section
  await page.locator('.context-section-header', { hasText: 'Tools' }).click()

  // Click on the first tool card to expand its schema
  const firstTool = page.locator('.context-tool-header').first()
  await firstTool.click()

  // JSON schema pre block should appear
  const schemaPre = page.locator('.context-tool-card .context-pre').first()
  await expect(schemaPre).toBeVisible()
})

// ── Model config ──

test('model config section shows model name', async ({ page }) => {
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  await page.locator('button', { hasText: 'Context' }).click()
  await expect(page.locator('.context-inspector')).toBeVisible({ timeout: 5000 })

  // Expand Model Config
  await page.locator('.context-section-header', { hasText: 'Model Config' }).click()

  // Should show the model name
  await expect(page.locator('.context-section-content').first()).toContainText('claude-opus-4-6')
})

// ── Chat remains usable ──

test('chat input remains usable with inspector open', async ({ page }) => {
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  // Open inspector
  await page.locator('button', { hasText: 'Context' }).click()
  await expect(page.locator('.context-inspector')).toBeVisible({ timeout: 5000 })

  // Chat input should still be visible and enabled
  const chatInput = page.locator('.chat-input-textarea')
  await expect(chatInput).toBeVisible()
  await expect(chatInput).toBeEnabled()

  // Should be able to type in the chat input
  await chatInput.fill('Test message while inspector is open')
  await expect(chatInput).toHaveValue('Test message while inspector is open')
})

// ── Refresh button ──

test('refresh button re-fetches context data', async ({ page }) => {
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  await page.locator('button', { hasText: 'Context' }).click()
  await expect(page.locator('.context-inspector')).toBeVisible({ timeout: 5000 })

  // Click Refresh
  const refreshBtn = page.locator('.context-inspector-header .btn', { hasText: 'Refresh' })
  await expect(refreshBtn).toBeVisible()
  await refreshBtn.click()

  // Panel should still be visible with data after refresh
  await expect(page.locator('.context-inspector-title')).toContainText('Agent Context Inspector')
  // Token count should still be visible
  await expect(page.locator('.context-token-badge-total')).toBeVisible()
})

// ── API verification ──

test('GET /api/context returns valid data', async ({ request }) => {
  const res = await request.get('/api/context')
  expect(res.ok()).toBeTruthy()

  const body = await res.json()
  expect(body).toHaveProperty('sections')
  expect(body).toHaveProperty('totalTokens')
  expect(body.totalTokens).toBeGreaterThan(0)

  // Verify all 9 sections
  const sectionNames = Object.keys(body.sections)
  expect(sectionNames).toHaveLength(9)
  expect(sectionNames).toContain('modelConfig')
  expect(sectionNames).toContain('roleAndRules')
  expect(sectionNames).toContain('tools')
  expect(sectionNames).toContain('apiMessages')
})
