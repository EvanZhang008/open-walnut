/**
 * Playwright browser tests for the memory page and the notification panel.
 *
 * Tests cover:
 * 1. Notification panel has no Embedding/Search Index card
 * 2. Memory page shows seeded files in tree
 *
 * Test data is seeded in test-server.ts: the memory/ directory.
 */
import { test, expect } from '@playwright/test'

// ── 1. Notification panel has no Embedding/Search Index card ──

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

// ── 2. Memory page shows seeded files in tree ──

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
