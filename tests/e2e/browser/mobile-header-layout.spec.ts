import fs from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from '@playwright/test'

const SCREENSHOT_DIR = '/tmp/codex-customer-matrix-gap-final'

test('mobile sidebar toggle does not overlap task search at 390px', async ({ page }) => {
  await fs.mkdir(SCREENSHOT_DIR, { recursive: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  const sidebarToggle = page.getByRole('button', { name: 'Toggle sidebar' })
  const searchInput = page.locator('.todo-search-input')
  await expect(sidebarToggle).toBeVisible()
  await expect(searchInput).toBeVisible()

  const toggleBox = await sidebarToggle.boundingBox()
  const searchBox = await searchInput.boundingBox()
  expect(toggleBox).not.toBeNull()
  expect(searchBox).not.toBeNull()

  const screenshotName = process.env.HEADER_SCREENSHOT_NAME ?? 'after-mobile-header.png'
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, screenshotName),
    fullPage: true,
  })

  const intersects = toggleBox!.x < searchBox!.x + searchBox!.width
    && toggleBox!.x + toggleBox!.width > searchBox!.x
    && toggleBox!.y < searchBox!.y + searchBox!.height
    && toggleBox!.y + toggleBox!.height > searchBox!.y

  expect(intersects, {
    message: `sidebar toggle ${JSON.stringify(toggleBox)} intersects task search ${JSON.stringify(searchBox)}`,
  }).toBe(false)
})
