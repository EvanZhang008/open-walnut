/**
 * Playwright browser tests for Memory v2 search and memory page.
 *
 * Tests cover:
 * 1. Search for known task content via keyword
 * 2. Search for known memory content (QMD-dependent — soft assertion)
 * 3. Search returns both tasks and memory (QMD-dependent — soft assertion)
 * 4. Notification panel has no Embedding/Search Index card
 * 5. Memory page shows seeded files in tree
 *
 * Test data is seeded in test-server.ts — tasks.json and memory/ directory.
 * QMD semantic search may not be available in ephemeral mode (no embedding model),
 * so memory search assertions are made conditional where needed.
 */
import { test, expect } from '@playwright/test'

const API = 'http://localhost:3457'

// ── 1. Search for known task content ──

test('search for task content shows TASKS results', async ({ page }) => {
  await page.goto('/search')
  await page.waitForLoadState('networkidle')

  // Type a query that matches the seeded task title "Playwright test task"
  const searchInput = page.locator('.search-bar-input')
  await expect(searchInput).toBeVisible({ timeout: 5000 })
  await searchInput.fill('Playwright test task')

  // Wait for search results to appear (debounce is 300ms)
  const taskGroup = page.locator('.search-group', { hasText: 'Tasks' })
  await expect(taskGroup).toBeVisible({ timeout: 10000 })

  // Verify the group title includes count
  const groupTitle = taskGroup.locator('.search-group-title')
  await expect(groupTitle).toContainText('Tasks')

  // Verify at least one task result item exists
  const taskItem = taskGroup.locator('.search-result-item')
  await expect(taskItem.first()).toBeVisible()

  // Verify the matched task title is shown
  await expect(taskGroup).toContainText('Playwright test task')
})

// ── 2. Search for known memory content ──

test('search for memory content shows MEMORY results if QMD available', async ({ page }) => {
  // First check if memory search returns results via API
  const apiRes = await fetch(`${API}/api/search?q=search+architecture&types=memory`)
  const apiBody = await apiRes.json() as { results: unknown[] }
  const hasMemoryResults = apiBody.results.length > 0

  if (!hasMemoryResults) {
    // QMD not available in ephemeral mode — skip gracefully
    test.skip(true, 'QMD memory search not available in ephemeral test server (no embedding model)')
    return
  }

  await page.goto('/search')
  await page.waitForLoadState('networkidle')

  const searchInput = page.locator('.search-bar-input')
  await searchInput.fill('search architecture')

  // Wait for memory results
  const memoryGroup = page.locator('.search-group', { hasText: 'Memory' })
  await expect(memoryGroup).toBeVisible({ timeout: 10000 })

  // Verify the group title
  const groupTitle = memoryGroup.locator('.search-group-title')
  await expect(groupTitle).toContainText('Memory')

  // Verify at least one memory result item with the "Memory" badge
  const memoryBadge = memoryGroup.locator('.badge', { hasText: 'Memory' })
  await expect(memoryBadge.first()).toBeVisible()
})

// ── 3. Search returns both tasks and memory ──

test('search returns both task and memory sections if QMD available', async ({ page }) => {
  // Check if memory search works at all
  const apiRes = await fetch(`${API}/api/search?q=walnut`)
  const apiBody = await apiRes.json() as { results: Array<{ type: string }> }
  const hasTaskResults = apiBody.results.some(r => r.type === 'task')
  const hasMemoryResults = apiBody.results.some(r => r.type === 'memory')

  if (!hasTaskResults) {
    test.skip(true, 'No task results for "walnut" — unexpected seeding issue')
    return
  }

  await page.goto('/search')
  await page.waitForLoadState('networkidle')

  // "walnut" should match tasks (seeded project: "Walnut") and potentially memory
  const searchInput = page.locator('.search-bar-input')
  await searchInput.fill('walnut')

  // Tasks section should always appear (BM25 keyword match)
  const taskGroup = page.locator('.search-group', { hasText: 'Tasks' })
  await expect(taskGroup).toBeVisible({ timeout: 10000 })

  if (hasMemoryResults) {
    // Memory section should also appear
    const memoryGroup = page.locator('.search-group', { hasText: 'Memory' })
    await expect(memoryGroup).toBeVisible({ timeout: 10000 })
  }

  // Verify search results container exists with at least one result
  const searchResults = page.locator('.search-results')
  await expect(searchResults).toBeVisible()
  const resultItems = searchResults.locator('.search-result-item')
  expect(await resultItems.count()).toBeGreaterThan(0)
})

// ── 4. Notification panel has no Embedding/Search Index card ──

test('notification panel does not contain Embedding or Search Index card', async ({ page }) => {
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  // Click the notification bell button in the sidebar
  const bellBtn = page.locator('button[aria-label="Notifications"]')
  await expect(bellBtn).toBeVisible({ timeout: 5000 })
  await bellBtn.click()

  // Wait for notification panel to appear
  const panel = page.locator('.notification-panel')
  await expect(panel).toBeVisible({ timeout: 5000 })

  // Verify the panel header says "Notifications"
  const panelTitle = panel.locator('.notification-panel-title')
  await expect(panelTitle).toContainText('Notifications')

  // The Embedding Search health card lives behind the System rail tab now —
  // the DEFAULT view (what this test pins) must not surface it.
  const panelBody = panel.locator('.nfc-body')
  await expect(panelBody).toBeVisible()
  const bodyText = await panelBody.textContent()

  expect(bodyText).not.toContain('Embedding')
  expect(bodyText).not.toContain('Search Index')
  expect(bodyText).not.toContain('search index')
  expect(bodyText).not.toContain('embedding')

  // Close the panel
  const closeBtn = panel.locator('button[aria-label="Close"]')
  await closeBtn.click()
  await expect(panel).toBeHidden({ timeout: 3000 })
})

// ── 5. Memory page shows seeded files in tree ──

test('memory page shows seeded files in tree', async ({ page }) => {
  await page.goto('/memory')
  await page.waitForLoadState('networkidle')

  // Verify the memory tree panel is visible
  const treePanel = page.locator('.memory-tree-panel')
  await expect(treePanel).toBeVisible({ timeout: 10000 })

  // Verify the header says "Memory"
  const treeHeader = treePanel.locator('.memory-tree-header-title')
  await expect(treeHeader).toContainText('Memory')

  // Verify tree sections exist — Global section with MEMORY.md
  const globalSection = treePanel.locator('.memory-tree-section', { hasText: 'Global' })
  await expect(globalSection).toBeVisible({ timeout: 5000 })

  // Verify MEMORY.md item under Global
  const globalItem = globalSection.locator('.memory-tree-item', { hasText: 'MEMORY.md' })
  await expect(globalItem).toBeVisible()

  // Verify Daily Logs section exists
  const dailySection = treePanel.locator('.memory-tree-section', { hasText: 'Daily Logs' })
  await expect(dailySection).toBeVisible()

  // Verify today's daily log entry is shown
  const todayKey = new Date().toISOString().slice(0, 10)
  const dailyItem = dailySection.locator('.memory-tree-item', { hasText: todayKey })
  await expect(dailyItem).toBeVisible()

  // Verify Projects section exists
  const projectsSection = treePanel.locator('.memory-tree-section', { hasText: 'Projects' })
  await expect(projectsSection).toBeVisible()

  // Verify Knowledge section exists
  const knowledgeSection = treePanel.locator('.memory-tree-section', { hasText: 'Knowledge' })
  await expect(knowledgeSection).toBeVisible()

  // Verify knowledge file is listed
  const knowledgeItem = knowledgeSection.locator('.memory-tree-item', { hasText: 'Testing Guide' })
  await expect(knowledgeItem).toBeVisible()

  // Click on MEMORY.md to verify content panel loads
  await globalItem.click()

  // Verify content panel shows the file content
  const contentPanel = page.locator('.memory-detail-pane')
  await expect(contentPanel).toBeVisible({ timeout: 5000 })
  await expect(contentPanel).toContainText('Global Memory')
})
